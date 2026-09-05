import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Video from 'react-native-video';
import officialMediaApi from '../api/officialMedia';
import { loadOfficialSiteMusic } from '../api/officialSiteMusic';
import { loadR2Music } from '../api/r2Music';
import { useSettingsStore, useUiStore } from '../store';
import { useMusicPlayerStore } from '../store/musicPlayerStore';
import MiniPlayerBar from '../components/MiniPlayerBar';
import FullScreenPlayer from '../components/FullScreenPlayer';
import { MusicEngine, mediaUrl as buildMediaUrl, isPlayableHost } from '../services/musicPlayer';
import { exoPlayTrack, exoControl, subscribeExo, setNativeExoDisabled } from '../native/RadioExo';
import { errorMessage } from '../utils/data';
import { logError } from '../utils/runtimeLog';
import { fetchCoverToFile, normalizeCoverUrl } from '../utils/coverToFile';
import { formatTimestamp, joinMeta } from '../utils/format';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import CoverArt from '../components/CoverArt';
import { NetworkImage } from '../components/NetworkImage';
import { Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/StateViews';
import { FadeInView, ScalePressable } from '../components/Motion';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { usePalette, radii, radiiAlias } from '../theme';
import { useI18n } from '../i18n';

/** 播放中均衡器：三根柱子错峰跳动（Animated loop + native driver） */
function EqualizerBars({ color, size = 13 }: { color: string; size?: number }) {
  const bars = [useRef(new Animated.Value(0.35)).current, useRef(new Animated.Value(0.35)).current, useRef(new Animated.Value(0.35)).current];
  useEffect(() => {
    const loops = bars.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 1, duration: 340 + i * 120, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.35, duration: 340 + i * 120, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: size }}>
      {bars.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: 3,
            height: size,
            borderRadius: 1.5,
            backgroundColor: color,
            transform: [{ scaleY: v }],
          }}
        />
      ))}
    </View>
  );
}

/** 拼接歌曲元信息并去重：专辑/歌手/团体名常重复（如 album=SNH48 + artist=SNH48），只保留一份 */
// 收藏紧跟全部之后（用户要求：放太后面翻不到）；其余按团体排列。
// 7SENSES 是 SNH48 旗下子团（还有 BLUEV/DEMOON/HO2/Color Girls 等），不单列 tab、归入 SNH48 段。
const SNH_FAMILY = new Set(['SNH48', '7SENSES', 'BLUEV', 'DEMOON', 'HO2', 'COLOR GIRLS', 'Color Girls', '塞纳河组合']);
/** 团体 → 主团（子团归一，如 7SENSES→SNH48） */
const groupFamily = (g: string): string => (SNH_FAMILY.has(String(g || '').trim()) ? 'SNH48' : String(g || '').trim());
/** 段序：SNH48 系(含子团) → GNZ48 → BEJ48 → …（用户要求） */
const albumGroupOrder = (g: string): number => {
  const up = groupFamily(g).toUpperCase();
  if (up === 'SNH48') return 0;
  const map: Record<string, number> = { GNZ48: 10, BEJ48: 20, AKB48: 30, CKG48: 40, CGT48: 50, SHY48: 60, TSH48: 70, TPE48: 80 };
  return map[up] ?? 90;
};
const GROUP_TABS = ['ALL', 'FAV', 'SNH48', 'GNZ48', 'BEJ48', 'AKB48', 'CKG48', 'CGT48', 'SHY48', 'TSH48', 'TPE48'];
const GROUP_LABELS: Record<string, string> = {
  ALL: '全部',
  SNH48: 'SNH48',
  GNZ48: 'GNZ48',
  BEJ48: 'BEJ48',
  AKB48: 'AKB48',
  CKG48: 'CKG48',
  CGT48: 'CGT48',
  SHY48: 'SHY48',
  TSH48: 'TSH48',
  TPE48: 'TPE48',
  '7SENSES': '7SENSES',
  FAV: '收藏',
};
// C: 模块级会话缓存——导航进出音乐库（重挂载）直接显示上次列表，不再重复拉取/闪骨架
let songsCache: any[] | null = null;
const CHIP_MIN_WIDTH = 64;
const CHIP_GAP = 8;
const CHIP_FAV_MIN_WIDTH = 92;
const CHIP_HEIGHT = 28;
const TABS_BAR_HEIGHT = 44; // 标签栏总高度（含上下内边距）

export default function MusicLibraryScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((state) => state.showToast);
  const playbackState = useMusicPlayerStore((s) => s.playbackState);
  const playUrl = useMusicPlayerStore((s) => s.url);
  // 音量归一：R2（gnz.hk/music.gnz.hk）母带普遍比 48 官方源响 10-15%，统一压到 0.86；
  // 官方源维持 1.0。后续若 bilibili 等直播源也需对齐，按 host 在此表增补即可。
  const playVolume = useMemo(() => {
    const u = String(playUrl || '').toLowerCase();
    return /(gnz\.hk|gnz-music|music\.gnz)/.test(u) || /\.r2\.|r2-music/i.test(u) ? 0.86 : 1.0;
  }, [playUrl]);
  const currentIndex = useMusicPlayerStore((s) => s.currentIndex);
  const queue = useMusicPlayerStore((s) => s.queue);
  const playMode = useMusicPlayerStore((s) => s.playMode);
  const favorites = useMusicPlayerStore((s) => s.favorites);
  const toggleFavorite = useMusicPlayerStore((s) => s.toggleFavorite);
  const seekTarget = useMusicPlayerStore((s) => s.seekTarget);
  const [songs, setSongs] = useState<any[]>(songsCache ?? []);
  const applySongs = (list: any[]) => { songsCache = list; setSongs(list); };
  // 搜索词 / 分团：纯 local state（不再镜像到 store，避免双写）。
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('ALL');
  // 视图切换：单曲列表 / 专辑分组；albumFilter = 专辑详情过滤（进入专辑曲目视图）
  const [viewMode, setViewMode] = useState<'songs' | 'albums'>('songs');
  const [albumFilter, setAlbumFilter] = useState<{ groupLabel: string; album: string } | null>(null);
  const onQueryChange = (q: string) => { setQuery(q); };
  const onGroupChange = (g: string) => { setGroup(g); };
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadingRef = useRef(false);
  const videoRef = useRef<any>(null);

  // 收藏计数：与 FAV 列表（isFavorite 过滤）一致，避免显示旧 id 键造成的虚高
  // 收藏数 = 收藏版本数（与 FAV 列表一致）
  const favCount = useMemo(
    () => songs.filter((t) => useMusicPlayerStore.getState().isFavorite(String(t.musicId || t.id || ''), t)).length,
    [songs, favorites],
  );
  const filteredSongs = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    let list = songs;
    if (albumFilter) list = list.filter(item => String(item.groupLabel || '') === albumFilter.groupLabel && String(item.album || '') === albumFilter.album);
    else if (group === 'FAV') list = list.filter(item => useMusicPlayerStore.getState().isFavorite(String(item.musicId || item.id || ''), item));
    else if (group !== 'ALL') list = list.filter(item => groupFamily(item.groupLabel) === group);
    if (keyword) list = list.filter(item => [item.title, item.artist, item.album, item.groupLabel].filter(Boolean).join(' ').toLowerCase().includes(keyword));
    return list;
  }, [query, songs, group, favorites, albumFilter]);
  const queueSource = useMemo(() => filteredSongs.map((t) => ({ ...t })), [filteredSongs]);

  // 专辑分组：按 团体+专辑 聚合（封面取组内第一张、统计曲目数与总时长）
  const albums = useMemo(() => {
    const map = new Map<string, { key: string; groupLabel: string; album: string; cover: string; count: number; durationSec: number }>();
    for (const t of filteredSongs) {
      const album = String(t.album || '').trim();
      if (!album) continue;
      const key = `${String(t.groupLabel || '')}|${album}`;
      const entry = map.get(key) || {
        key,
        groupLabel: String(t.groupLabel || ''),
        album,
        cover: '',
        count: 0,
        durationSec: 0,
      };
      entry.count += 1;
      // 时长累加：R2(durationSec) + 官方(duration 秒) 统一
      entry.durationSec += Number(t.durationSec) || Number(t.duration) || 0;
      if (!entry.cover) entry.cover = String(t.coverUrl || t.cover || '');
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => {
      // 段序 SNH48 系(含 7SENSES 等子团) → GNZ48 → BEJ48 → …（用户要求，勿改回字母序）
      const oa = albumGroupOrder(a.groupLabel);
      const ob = albumGroupOrder(b.groupLabel);
      if (oa !== ob) return oa - ob;
      const ga = String(a.groupLabel || '').toLowerCase();
      const gb = String(b.groupLabel || '').toLowerCase();
      if (ga !== gb) return ga < gb ? -1 : 1;
      return String(a.album || '').localeCompare(String(b.album || ''), 'zh');
    });
  }, [filteredSongs]);

  // 双源合并：官方源（口袋48官网静态 JS）+ R2 音乐库（music.gnz.hk 公演音频，1559 首）。
  // 去重键 title|artist（官方源优先）；任一源失败不阻塞另一源，合并结果为空才报错。
  const loadAll = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!songs.length) setLoading(true);
    setStatus('');
    try {
      const [officialRes, r2Res] = await Promise.allSettled([
        loadOfficialSiteMusic(false),
        loadR2Music(false),
      ]);
      const official = officialRes.status === 'fulfilled' ? officialRes.value : [];
      const r2 = r2Res.status === 'fulfilled' ? r2Res.value : [];
      if (officialRes.status === 'rejected' && r2Res.status === 'rejected') {
        const err = (officialRes as PromiseRejectedResult).reason || (r2Res as PromiseRejectedResult).reason;
        throw err instanceof Error ? err : new Error('音乐列表加载失败');
      }
      // 去重键 title|artist|album（同曲不同专辑/公演版本各自保留）；
      // 同名同专辑合并时 **R2 优先**（用户要求：R2 字段完整/时长准；官方同曲只作 R2 缺失时的补充）
      const seen = new Set<string>();
      const merged: any[] = [];
      // 大小写不敏感：SAY NO / Say No 视为同一专辑，避免重复条目
      const dedupKey = (t: any) =>
        `${String(t.title || '').trim().toLowerCase()}|${String(t.artist || '').trim().toLowerCase()}|${String(t.album || '').trim().toLowerCase()}`;
      r2.forEach((t: any) => {
        const key = dedupKey(t);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(t);
      });
      official.forEach((t: any) => {
        const key = dedupKey(t);
        if (seen.has(key)) return; // R2 已有同曲 → 跳过官方版
        seen.add(key);
        merged.push(t);
      });
      // 排序（对齐桌面 sortKey='source' 语义 + 用户要求：SNH48 系子团归 SNH48 段）：
      // 段序 SNH48 系(含 7SENSES/BLUEV/DEMOON/HO2/Color Girls/塞纳河组合) → GNZ → ... ；
      // 同段内按 sourceIndex（官方源小在前，R2 公演源大在后），R2 内再按子团聚合后按标题
      merged.sort((a: any, b: any) => {
        const oa = albumGroupOrder(a.groupLabel);
        const ob = albumGroupOrder(b.groupLabel);
        if (oa !== ob) return oa - ob;
        const sa = Number(a.sourceIndex) || 0;
        const sb = Number(b.sourceIndex) || 0;
        if (sa !== sb) return sa - sb;
        const ga = String(a.groupLabel || '').trim().toLowerCase();
        const gb = String(b.groupLabel || '').trim().toLowerCase();
        if (ga !== gb) return ga < gb ? -1 : 1;
        return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
      });
      applySongs(merged);
      setHasMore(false);
      // 静默提示各源状态（不打扰）：仅当 R2 失败时提示「官方源可用」，双失败已在上面抛错
      if (r2Res.status === 'rejected' && officialRes.status === 'fulfilled') {
        setStatus(t('官方音乐已加载（R2 源暂不可用）'));
      }
    } catch (error) {
      setStatus(t('加载失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  // 注入 URL resolver（供 MusicEngine 使用），避免循环引用
  useEffect(() => {
    loadAll();
    MusicEngine.setUrlResolver(async (track: any) => {
      // 官方源歌曲的 mp3 直链即可播放
      if (track?.mp3 && /^https?:/i.test(String(track.mp3))) {
        const u = String(track.mp3);
        if (!isPlayableHost(u)) throw new Error(t('不支持的播放源'));
        return u;
      }
      // 回退：个别非官网源曲目尝试移动端接口解析地址
      try {
        const res = await officialMediaApi.getMusic(String(track.musicId || track.id));
        const data = res?.content?.data || res?.content || res?.data || {};
        const url = buildMediaUrl(String(data.filePath || data.musicPath || data.playStreamPath || data.audioPath || data.url || ''));
        if (url) {
          if (!isPlayableHost(url)) throw new Error(t('不支持的播放源'));
          return url;
        }
      } catch { /* ignore */ }
      const fb = buildMediaUrl(String((track as any).filePath || (track as any).musicPath || (track as any).playStreamPath || (track as any).audioPath || (track as any).url || ''));
      if (!fb) throw new Error(t('无法解析播放地址'));
      if (!isPlayableHost(fb)) throw new Error(t('不支持的播放源'));
      return fb;
    });
  }, []);

  // 处理 seekTarget：Video 挂载后检测到 seekTarget > 0 即执行 seek 并清零。
  // mediaReady 门控：媒体未就绪时 seek 无效（ExoPlayer 未 prepare），
  // 续播位置在 onLoad 时消费，拖动进度条在就绪后消费。
  const [mediaReady, setMediaReady] = useState(false);
  const [showFullScreen, setShowFullScreen] = useState(false);
  useEffect(() => {
    // Exo 原生接管时跳过 Video seek（Exo seek 由下方 nativeOk 分支的 effect 消费；
    // 若两者都消费 seekTarget，会竞争清零 → 拖进度在原生路径失效）
    if (seekTarget > 0 && nativeOkRef.current) return;
    if (seekTarget > 0 && mediaReady && videoRef.current && typeof videoRef.current.seek === 'function') {
      // 乐观回写本地位置（RNV onProgress 随后校准；消除拖动松手回跳）
      const st0 = useMusicPlayerStore.getState();
      st0.setPosition(seekTarget);
      try {
        videoRef.current.seek(seekTarget);
      } catch (err) {
        console.warn('[MusicLibraryScreen] seekTarget error:', err);
      }
      st0.setSeekTarget(0);
    }
  }, [seekTarget, mediaReady]);

  // ===== M2 原生 Exo 驱动（media3 会话承担系统媒体卡；失败自动降级 RNV Video）=====
  // nativeOk=true：Exo 拥有真实声音（Video 静音暂停占位）。候选期（下发后未确认）即静音，
  // 消除 M2 旧实现的"双音窗口"（旧逻辑等收到 progress 才停 Video，期间两路同响）。
  // 降级：error 事件 或 下发后 4s 无任何 progress/error（服务起不来/异常无事件）→ nativeOk=false
  // 且 nativeDisabled=true（本次 JS 会话不再尝试原生，避免每首歌都等 4s 静音窗）。
  const [nativeOk, setNativeOk] = useState(false);
  const nativeOkRef = useRef(false);
  const nativeDisabledRef = useRef(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armSeqRef = useRef(0);
  const setNativeState = (v: boolean) => { nativeOkRef.current = v; setNativeOk(v); };
  const cancelArmTimer = () => { if (armTimer.current) { clearTimeout(armTimer.current); armTimer.current = null; } };
  /** 已在原生下发的曲目 url（暂停/恢复同曲不重推）；idle/切歌时清空 */
  const armedUrlRef = useRef('');
  /** 最近一次收到原生 progress 的时间戳（判断原生活跃度，失联 >8s 允许重推） */
  const lastProgressTsRef = useRef(0);
  /** cmd(next/prev) 去抖：双监听器都转发切歌命令，300ms 内只认一次 */
  const cmdLastTsRef = useRef(0);
  // ⚠️ 暂停/恢复滞回同步已上移到 App 全局（页面无关）；本页 progress 只做「确认下发 + 降级」

  useEffect(() => subscribeExo((type, p: any) => {
    try {
      const st = useMusicPlayerStore.getState();
      if (type === 'progress') {
        lastProgressTsRef.current = Date.now();
        const playingN = !!p?.playing;
        if (Number(p?.duration) > 0) st.setDuration(Number(p.duration));
        if (typeof p?.position === 'number') st.setPosition(p.position);
        if (playingN) cancelArmTimer(); // Exo 已在原生出声 → 候选确认
        // 播放态回写（系统卡暂停/恢复→App 图标）由 App 全局滞回处理，本页不重复
      } else if (type === 'ended') {
        // 播完（单曲队列）→ 引擎切下一首（顺序/随机在 JS；单曲循环走 REPEAT_MODE_ONE 不触发 ended）。
        // 引擎级节流防与 App 全局 ended 双发连切两首
        if (useMusicPlayerStore.getState().playbackState === 'playing') MusicEngine.next();
      } else if (type === 'cmd') {
        // 系统卡/线控 上一首/下一首（App 全局也处理；本地去抖 + 引擎节流防双发）
        const c = String(p?.cmd || '');
        if (c === 'next' || c === 'prev') {
          const now = Date.now();
          if (cmdLastTsRef.current && now - cmdLastTsRef.current < 300) return;
          cmdLastTsRef.current = now;
          if (c === 'next') MusicEngine.next();
          else MusicEngine.prev();
        }
      } else if (type === 'error') {
        // 原生播放失败 → 本次会话降级 RNV（Video volume/paused 由 nativeOk=false 自动接管）
        if (!nativeDisabledRef.current) {
          nativeDisabledRef.current = true;
          setNativeExoDisabled(true); // 全局同步：App watch/全局 push 也停止尝试原生
          cancelArmTimer();
          armSeqRef.current += 1;
          setNativeState(false);
          try { exoControl('stop'); } catch {}
          // Video 此前全程静音暂停（自身时钟在 0）：降级后从 store 已就绪位置续播
          const stNow = useMusicPlayerStore.getState();
          if (stNow.position > 0) stNow.setSeekTarget(stNow.position);
        }
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // 推当前曲到 Exo：URL/曲目变化或恢复播放（paused→playing）时下发；同曲仍在原生且有心跳则跳过
  // （暂停→恢复走下方 control resume 原位续播，避免 setMediaItems 重缓冲）。
  // 封面先 RN 落盘为 file://（OPPO 唯一可靠），下载限时 1.5s，超时用原 http 直推（声音不等待）。
  useEffect(() => {
    if (!playUrl || playbackState !== 'playing') return;
    if (nativeDisabledRef.current) return; // 已降级：声音全交给 Video
    // 声音权交给 Exo：只要未降级，无论本次是否实际下发，Video 都要静音占位（杜绝 RNV 双放/抢焦点）
    if (!nativeOkRef.current) setNativeState(true);
    if (armedUrlRef.current === playUrl && Date.now() - lastProgressTsRef.current < 8000) return; // 原生仍持有本曲
    const st = useMusicPlayerStore.getState();
    const tr = st.queue[st.currentIndex];
    if (!tr) return;
    const seq = ++armSeqRef.current;
    cancelArmTimer();
    armedUrlRef.current = playUrl;
    const headers = {
      'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
      Referer: 'https://h5.48.cn/',
      Origin: 'https://h5.48.cn',
    };
    const volume = playVolume > 0 ? playVolume : 1;
    const repeat = playMode === 'single' ? 1 : 0;
    const doPush = (art: string) => {
      if (seq !== armSeqRef.current) return;
      const st2 = useMusicPlayerStore.getState();
      if (!st2.url || st2.url !== playUrl || st2.playbackState !== 'playing') return;
      // 起始位置只认 seekTarget：MusicEngine 切歌/点歌会清 0，resume(记忆续播)才写入位置；
      // 不能读 store.position —— 那是「上一首歌」的进度残留，会造成切歌从旧秒数开始（19:15 实测）
      const resumeAt = Number(st2.seekTarget) > 0 ? Number(st2.seekTarget) : 0;
      if (resumeAt > 0) st2.setSeekTarget(0); // 消费续播点（由本次下发承担）
      exoPlayTrack({
        url: playUrl,
        title: String(tr.title || '音乐'),
        artist: String((tr as any).artist || (tr as any).groupLabel || ''),
        album: String((tr as any).album || ''),
        art,
      }, resumeAt, true, headers, volume, repeat);
      // 候选确认超时：Exo 正常 1-3s 内必有 progress；4s 无 → 服务没起来/异常无事件 → 降级
      cancelArmTimer();
      armTimer.current = setTimeout(() => {
        if (!nativeOkRef.current && !nativeDisabledRef.current) {
          nativeDisabledRef.current = true;
          setNativeState(false);
          try { exoControl('stop'); } catch {}
          const stNow = useMusicPlayerStore.getState();
          if (stNow.position > 0) stNow.setSeekTarget(stNow.position);
          showToast(t('已切换兼容播放器'));
        }
      }, 4000);
    };
    const coverRaw = String((tr as any).coverUrl || (tr as any).cover || (tr as any).thumbPath || '') || '';
    if (!coverRaw) { doPush(''); return; }
    (async () => {
      let art = '';
      try {
        art = await Promise.race([
          fetchCoverToFile(normalizeCoverUrl(coverRaw)),
          new Promise<string>((res) => setTimeout(() => res(''), 1500)),
        ]);
      } catch { art = ''; }
      doPush(art || String((tr as any).coverUrl || (tr as any).cover || ''));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playUrl, currentIndex, playbackState, playMode, playVolume]);

  // 播放/暂停同步 Exo（原生路径；Video 路径由 store 自身状态驱动）
  useEffect(() => {
    if (!nativeOkRef.current) return;
    if (playbackState === 'paused') exoControl('pause');
    else if (playbackState === 'playing') exoControl('resume');
  }, [playbackState]);

  // 播放模式（单曲循环）→ 原生 REPEAT_MODE_ONE（其余模式 Exo 播完发 ended 由 JS 引擎切歌）
  useEffect(() => {
    if (!nativeOkRef.current) return;
    exoControl('repeat', playMode === 'single' ? 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playMode, playbackState]);

  // 拖动进度 → Exo seek（消费后清 0）
  useEffect(() => {
    if (seekTarget > 0 && nativeOkRef.current) {
      // 乐观回写本地位置：松手立即停在新位置，不等原生 500ms 心跳校准（去回跳感）
      const st = useMusicPlayerStore.getState();
      st.setPosition(seekTarget);
      exoControl('seek', seekTarget);
      st.setSeekTarget(0);
    }
  }, [seekTarget]);

  // 停止/清除 → Exo stop；清 armed/候选计时；下次播放重新尝试原生（模块 disabled 由 App 全局在 idle 重置）
  useEffect(() => {
    if (playbackState === 'idle') {
      cancelArmTimer();
      armSeqRef.current += 1;
      armedUrlRef.current = '';
      lastProgressTsRef.current = 0;
      nativeDisabledRef.current = false;
      try { exoControl('stop'); } catch {}
    }
  }, [playbackState]);

  const playSong = (item: any) => {
    const st = useMusicPlayerStore.getState();
    const cur = st.queue[st.currentIndex];
    const sameAsCurrent = !!cur && (cur.musicId || cur.id) === (item.musicId || item.id);
    if (sameAsCurrent && st.playbackState === 'playing') {
      setShowFullScreen(true);
      return;
    }
    // 同一首（记忆恢复/暂停中）：走 resume 保留进度续播，而不是 playTrack 从 0 开始
    if (sameAsCurrent && st.position > 0) {
      MusicEngine.resume();
      setShowFullScreen(true);
      return;
    }
    // 克隆队列：播放器 store 与列表 songs 解耦（避免引用共享反噬渲染）。
    // queueSource 由 useMemo 缓存——仅在 filteredSongs 变化时克隆一次，点歌零克隆开销
    MusicEngine.playTrack(item, queueSource);
    setShowFullScreen(true);
  };

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('音乐')} right={
        <HeaderAction label={t('刷新')} onPress={() => loadAll()} loading={loading} disabled={loading} />
      } />
      <View style={[styles.searchBar, { backgroundColor: palette.fill2, borderColor: palette.hairline }]}>
        <MaterialCommunityIcons name="magnify" size={18} color={palette.labelTertiary} />
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder={t('搜索歌曲、成员、专辑')}
          placeholderTextColor={palette.labelTertiary}
          style={[styles.searchInput, { color: palette.label }]}
        />
        {query ? (
          <ScalePressable onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} pressedScale={0.9} activeOpacity={0.6}>
            <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
          </ScalePressable>
        ) : null}
        {/* 单曲/专辑视图切换（专辑详情视图下隐藏） */}
        {!albumFilter ? (
          <ScalePressable
            onPress={() => setViewMode((v) => (v === 'songs' ? 'albums' : 'songs'))}
            pressedScale={0.9}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ marginLeft: 4 }}
          >
            <MaterialCommunityIcons
              name={viewMode === 'songs' ? 'album' : 'playlist-music'}
              size={18}
              color={viewMode === 'songs' ? palette.labelTertiary : palette.tint}
            />
          </ScalePressable>
        ) : null}
      </View>
      {/* 专辑详情条：返回 + 专辑名 + 曲目数 + 播放全部（替代分团 tab 栏） */}
      {albumFilter ? (
        <View style={[styles.tabsBarBase, { borderBottomColor: palette.separator }]}>
          <View style={styles.albumBarRow}>
            <ScalePressable onPress={() => setAlbumFilter(null)} pressedScale={0.9} activeOpacity={0.7} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <MaterialCommunityIcons name="arrow-left" size={18} color={palette.tint} />
            </ScalePressable>
            <View style={{ flex: 1, marginLeft: 8, minWidth: 0 }}>
              <Text numberOfLines={1} style={[styles.gText, { color: palette.label, fontWeight: '800' }]}>{albumFilter.album}</Text>
              <Text numberOfLines={1} style={[styles.gText, { color: palette.labelTertiary, fontSize: 11 }]}>
                {albumFilter.groupLabel || t('未知团体')} · {filteredSongs.length} {t('首')}
              </Text>
            </View>
            <ScalePressable
              onPress={() => {
                // 播放全部：以专辑内曲目为队列
                if (!filteredSongs.length) return;
                MusicEngine.playTrack(filteredSongs[0], filteredSongs.map((x) => ({ ...x })));
                setShowFullScreen(true);
              }}
              pressedScale={0.95}
              activeOpacity={0.8}
              style={[styles.playAllBtn, { backgroundColor: palette.tint }]}
            >
              <MaterialCommunityIcons name="play" size={14} color={palette.onTint} />
              <Text style={[styles.playAllText, { color: palette.onTint }]}>{t('播放全部')}</Text>
            </ScalePressable>
          </View>
        </View>
      ) : (
      /* 横向标签栏：使用 flex:1 的 ScrollView + flexDirection: row，配合固定宽度 chip，
           彻底避免 Yoga 在屏幕外 item 重新测量导致的拉伸问题。 */
      <View style={[styles.tabsBarBase, { borderBottomColor: palette.separator }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          removeClippedSubviews={false}
          collapsable={false}
          contentContainerStyle={styles.tabsContent}
        >
          {GROUP_TABS.map((g, idx) => (
            <ScalePressable
              key={g}
              onPress={() => onGroupChange(g)}
              pressedScale={0.96}
              activeOpacity={0.7}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={[
                styles.gChip,
                { backgroundColor: group === g ? palette.tint : palette.fill2 },
                g === 'FAV' ? styles.gChipFav : styles.gChipBase,
              ]}
            >
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[
                  styles.gText,
                  { color: group === g ? palette.onTint : palette.labelSecondary },
                ]}
              >
                {g === 'FAV' ? t('收藏{count}', { count: favCount ? `(${favCount})` : '' }) : t(GROUP_LABELS[g] || g)}
              </Text>
            </ScalePressable>
          ))}
        </ScrollView>
      </View>
      )}
      {status ? (
        /失败|错误/.test(status) ? (
          <ErrorState title={t('加载失败')} hint={status} onAction={() => loadAll()} />
        ) : (
          <View pointerEvents="none" style={styles.statusInfo}>
            <Text style={[styles.status, { color: palette.tint }]}>{status}</Text>
          </View>
        )
      ) : null}
      {loading && songs.length === 0 ? (
        <View style={{ flex: 1 }}>
          <View style={styles.listContent}>
            {[0, 1, 2].map((row) => (
              <View key={row} style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                <View style={{ flex: 1 }}>
                  <Skeleton width="100%" height={150} radius={16} />
                  <Skeleton width="70%" height={12} radius={6} style={{ marginTop: 8 }} />
                  <Skeleton width="45%" height={10} radius={6} style={{ marginTop: 6 }} />
                </View>
                <View style={{ flex: 1 }}>
                  <Skeleton width="100%" height={150} radius={16} />
                  <Skeleton width="70%" height={12} radius={6} style={{ marginTop: 8 }} />
                  <Skeleton width="45%" height={10} radius={6} style={{ marginTop: 6 }} />
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : !loading && songs.length === 0 && !status ? (
        <View style={styles.emptyWrap}>
          <EmptyState
            icon="music-off"
            title={group === 'FAV' ? t('还没有收藏歌曲') : t('暂无音乐')}
            hint={group === 'FAV' ? t('点歌曲封面右下角的 ♥ 即可收藏') : t('点击右上角刷新，拉取官方曲库')}
          />
        </View>
      ) : !loading && filteredSongs.length === 0 ? (
        <View style={styles.emptyWrap}>
          <EmptyState
            icon="magnify-close"
            title={t('没有匹配的歌曲')}
            hint={t('换个关键词或分团试试')}
          />
        </View>
      ) : viewMode === 'albums' && !albumFilter ? (
        <PerfFlatList
          data={albums}
          keyExtractor={(item) => item.key}
          numColumns={2}
          contentContainerStyle={styles.listContent}
          removeClippedSubviews={false}
          renderItem={({ item, index }) => (
            <FadeInView delay={index < 12 ? 80 + index * 25 : 0} duration={300} style={styles.albumItem}>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setAlbumFilter({ groupLabel: item.groupLabel, album: item.album })}
              >
                <View style={[styles.albumCover, { backgroundColor: palette.fill2 }]}>
                  {item.cover ? (
                    <NetworkImage source={{ uri: item.cover }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  ) : (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                      <MaterialCommunityIcons name="album" size={40} color={palette.labelTertiary} />
                    </View>
                  )}
                  <View style={styles.albumCountPill}>
                    <Text style={styles.albumCountText}>{item.count} {t('首')}</Text>
                  </View>
                </View>
                <Text numberOfLines={1} style={[styles.songTitle, { color: palette.label, marginTop: 6 }]}>{item.album}</Text>
                <Text numberOfLines={1} style={[styles.songArtist, { color: palette.labelTertiary }]}>
                  {item.groupLabel || t('未知团体')}
                  {item.durationSec ? ` · ${Math.floor(item.durationSec / 60)}${t('分钟')}` : ''}
                </Text>
              </TouchableOpacity>
            </FadeInView>
          )}
        />
      ) : (
      <PerfFlatList
          data={filteredSongs}
          // extraData：FlatList 为 PureComponent，data 引用不变时不重渲染 renderItem——
          // 切歌/收藏后 active 高亮与爱心状态需随 currentIndex/favorites 变化刷新
          extraData={`${currentIndex}:${favorites.length}`}
          keyExtractor={(item, index) => `${item.groupKey || ''}-${item.musicId || item.id || ''}-${index}`}
          numColumns={2}
          // 不自定义 columnWrapperStyle（避免 width:'48%' + space-between + aspectRatio:1 的
          // 组合在 Android 上切歌重渲染后左列塌陷的布局 bug——左列整列不可见，含兜底元素）。
          // FlatList 默认等分两列，item 用 flex:1 + 自身内边距即可。
          removeClippedSubviews={false}
          contentContainerStyle={styles.listContent}
          renderItem={({ item, index }) => {
            const id = String(item.musicId || item.id || '');
            const active = queue[currentIndex] && (String(queue[currentIndex].musicId || queue[currentIndex].id) === id);
            const coverUrl = item.coverUrl || item.cover || item.thumbPath || '';
            return (
            <FadeInView delay={index < 12 ? 80 + index * 30 : 0} duration={300} style={{ width: '48.5%' }}>
              <TouchableOpacity
                style={[
                  styles.songItem,
                  { backgroundColor: palette.surface, borderColor: active ? palette.tint : palette.hairline, borderWidth: active ? 2 : StyleSheet.hairlineWidth },
                ]}
                onPress={() => playSong(item)}
                activeOpacity={0.7}
              >
                <View style={styles.coverWrap}>
                  <CoverArt uri={coverUrl || undefined} title={item.title || '♪'} fill active={active} />
                  {/* 正在播放指示：三根均衡器柱错峰跳动 */}
                  {active ? (
                    <View style={[styles.playingBadge, { backgroundColor: palette.tint }]}>
                      <EqualizerBars color={palette.onTint} />
                    </View>
                  ) : null}
                  <ScalePressable
                    style={styles.favBtn}
                    pressedScale={0.85}
                    activeOpacity={0.6}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPress={(e) => {
                      e.stopPropagation();
                      const fid = String(item.musicId || item.id || '');
                      if (fid) toggleFavorite(fid, item);
                    }}
                  >
                    <MaterialCommunityIcons
                      name={useMusicPlayerStore.getState().isFavorite(String(item.musicId || item.id || ''), item) ? 'heart' : 'heart-outline'}
                      size={20}
                      color={useMusicPlayerStore.getState().isFavorite(String(item.musicId || item.id || ''), item) ? palette.danger : palette.onTint}
                    />
                  </ScalePressable>
                </View>
                <View style={styles.songInfo}>
                  <Text style={[styles.songTitle, { color: palette.label }]} numberOfLines={2}>{item.title || t('无标题')}</Text>
                  <View style={styles.songMetaLine}>
                    <Text style={[styles.songArtist, { color: palette.labelSecondary }]} numberOfLines={1}>
                      {/* 团体名优先（用户要求：R2 公演曲显示团体而非专辑），不加来源标记 */}
                      {joinMeta([item.groupLabel, item.artist, item.album]) || t('官方音乐')}
                    </Text>
                    {(() => {
                      const dur = Number(item.durationSec) || Number(item.duration) || 0;
                      if (dur > 0) {
                        const h = Math.floor(dur / 3600);
                        const m = Math.floor((dur % 3600) / 60);
                        const sec = Math.floor(dur % 60);
                        return (
                          <Text style={[styles.dateText, { color: palette.labelTertiary }]}>
                            {h > 0
                              ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
                              : `${m}:${String(sec).padStart(2, '0')}`}
                          </Text>
                        );
                      }
                      // 无时长兜底显示日期
                      return item.ctime ? (
                        <Text style={[styles.dateText, { color: palette.labelTertiary }]}>
                          {formatTimestamp(item.ctime).slice(0, 10)}
                        </Text>
                      ) : null;
                    })()}
                  </View>
                </View>
              </TouchableOpacity>
            </FadeInView>
            );
          }}
        />
      )}
      {/* Video 常驻（width:0 height:0），不做条件卸载，彻底消除 source+paused 同步翻转崩溃 */}
      <Video
        ref={videoRef}
        source={{
          uri: playUrl || '',
          headers: { 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)', Referer: 'https://h5.48.cn/' },
          // AWS 流播放中偶发卡顿（缓冲耗尽 rebuffer）：加大 Exo 缓冲池 + 回看缓冲，
          // 瞬时网络抖动不出进度条回退；backBufferDurationMs 支持后退 30s 不二次缓冲
          bufferConfig: {
            minBufferMs: 15000,
            maxBufferMs: 60000,
            bufferForPlaybackMs: 5000,
            bufferForPlaybackAfterRebufferMs: 10000,
            backBufferDurationMs: 30000,
          },
        }}
        style={styles.tinyPlayer}
        volume={nativeOk ? 0 : playVolume}
        paused={nativeOk ? true : playbackState !== 'playing'}
        // 单曲循环用原生 repeat（无缝、无 seek(0) 重新缓冲的卡顿）；onEnd 仅处理顺序/随机切歌
        repeat={playMode === 'single'}
        ignoreSilentSwitch="ignore" playInBackground playWhenInactive
        onAudioBecomingNoisy={() => {
          // 拔耳机/蓝牙断开：暂停播放，避免外放打扰
          try {
            if (useMusicPlayerStore.getState().playbackState === 'playing') {
              MusicEngine.togglePause();
              showToast(t('耳机已断开，已暂停播放'));
            }
          } catch (err) { logError(err, 'MusicLibrary.onAudioBecomingNoisy'); }
        }}
        onLoad={(e) => {
          try {
            setMediaReady(true);
            // 仅有限正时长才写入：部分 R2 FLAC onLoad 给 0/NaN/Infinity，覆盖会毁掉已就绪时长
            const durRaw = Number((e as any).duration);
            const dur = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : useMusicPlayerStore.getState().duration;
            useMusicPlayerStore.getState().setDuration(dur);
            // 续播回写：rehydrate 恢复的 position 已在 store 转成 seekTarget，
            // 媒体就绪后立即 seek（此后 onProgress 接管进度）
            const st = useMusicPlayerStore.getState();
            if (st.seekTarget > 0 && videoRef.current && typeof videoRef.current.seek === 'function') {
              try {
                videoRef.current.seek(st.seekTarget);
              } catch (err) {
                console.warn('[MusicLibraryScreen] resume seek error:', err);
              }
              useMusicPlayerStore.getState().setSeekTarget(0);
            }
          } catch (err) {
            console.warn('[MusicLibraryScreen] onLoad error:', err);
          }
        }}
        onProgress={(e) => {
          try { useMusicPlayerStore.getState().setPosition(e.currentTime || 0); } catch (err) { logError(err, 'MusicLibrary.onProgress'); }
        }}
        onEnd={() => {
          try {
            // 单曲模式由 repeat 无缝循环（不触发 onEnd）；其余模式自动切下一首
            if (playMode !== 'single') MusicEngine.next();
          } catch (err) {
            console.warn('[MusicLibraryScreen] onEnd error:', err);
          }
        }}
        onError={(err) => {
          try {
            console.warn('[MusicLibraryScreen] onError:', err);
            const track = queue[currentIndex];
            const st = useMusicPlayerStore.getState();
            // single 模式/仅一首：next() 会绕回同曲（nextIndex 返回 current），
            // 无条件 next 会造成无限重试 + toast 刷屏；停在 error 态由用户手动处理
            const canSkip = st.queue.length > 1 && st.playMode !== 'single';
            if (canSkip) {
              showToast(t('《{title}》无法播放，已跳过', { title: track?.title || t('该歌曲') }));
              MusicEngine.next();
            } else {
              const title = track?.title || t('该歌曲');
              st.setError(t('《{title}》无法播放', { title }));
              st.setPlaybackState('error');
              showToast(t('《{title}》无法播放，请尝试其他歌曲', { title }));
            }
          } catch (e) {
            console.error('[MusicLibraryScreen] onError handler crashed:', e);
          }
        }}
      />
      <MiniPlayerBar onOpenFullScreen={() => setShowFullScreen(true)} />
      <FullScreenPlayer visible={showFullScreen} onClose={() => setShowFullScreen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  albumBarRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6 },
  playAllBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
  playAllText: { fontSize: 12, fontWeight: '700' },
  // 显式半宽：flex:1 在 FlatList cell 上会把单张专辑拉伸成整行大图
  albumItem: { width: '48.5%', marginBottom: 12, marginHorizontal: 5 },
  albumCover: { width: '100%', aspectRatio: 1, borderRadius: 14, overflow: 'hidden' },
  albumCountPill: { position: 'absolute', right: 6, bottom: 6, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  albumCountText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  
  // 标签栏容器：固定高度，底部分隔线（颜色在组件里动态切换）
  tabsBarBase: { 
    height: TABS_BAR_HEIGHT, 
    paddingHorizontal: 12, 
    borderBottomWidth: StyleSheet.hairlineWidth, 
  },
  // 内容区：flex row，靠左对齐，gap 由 marginRight 控制
  tabsContent: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'flex-start',
    paddingVertical: (TABS_BAR_HEIGHT - CHIP_HEIGHT) / 2, // 垂直居中
  },
  gChip: { 
    height: CHIP_HEIGHT, 
    paddingHorizontal: 16, 
    borderRadius: radii.pill, 
    alignItems: 'center', 
    justifyContent: 'center', 
    flexShrink: 0, 
    flexGrow: 0, 
    overflow: 'hidden',
    marginRight: CHIP_GAP,
  },
  gChipFav: { minWidth: CHIP_FAV_MIN_WIDTH },
  gChipBase: { minWidth: CHIP_MIN_WIDTH },
  gText: { fontSize: 14, fontWeight: '700' },
  status: { fontSize: 12, fontWeight: '700' },
  statusInfo: { paddingVertical: 16, alignItems: 'center' },
  
  // 列表内容：顶部留出标签栏高度，底部留出迷你播放器空间
  listContent: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 120 },
  emptyWrap: { flex: 1, alignItems: 'stretch' },
  // 去掉 gridRow（width:'48%'+space-between 在 Android FlatList 上切歌后左列塌陷）。
  // 现由 FlatList numColumns=2 默认等分两列，songItem 用 flex:1 + 自身 padding 自适应。
  songItem: {
    flex: 1,
    margin: 5,
    borderRadius: radiiAlias.card,
    overflow: 'hidden',
    // 克制阴影增强浮起感
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  coverWrap: { width: '100%', aspectRatio: 1 },
  playingBadge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  favBtn: { position: 'absolute', top: 6, right: 6, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.32)' },
  songInfo: { padding: 10 },
  songTitle: { fontSize: 15, fontWeight: '800', lineHeight: 20 },
  songMetaLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 6 },
  songArtist: { fontSize: 12, flex: 1 },
  dateText: { fontSize: 11 },
  tinyPlayer: { width: 0, height: 0 },
});