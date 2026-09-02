/**
 * HomeScreen · 内容仪表盘 v2.6 布局重做
 * - 问候区（大标题 + 副标题，区块标题统一「4×18 tint 竖条 + headline」）
 * - 未登录提示卡
 * - 正在直播 banner 轮播（crossfade/位移动画 + 指示点随动）+ 直播行列表（52 封面圆角12 + 标题/昵称/chevron）
 * - 快捷入口 4 格胶囊
 * - 最近播放续播卡
 * - 工具 chips 横向滚动
 * - 首屏加载 Skeleton 占位
 * 业务逻辑 / API / 数据流 / 路由 / i18n 原文一律不动，仅重组布局结构。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { CompositeNavigationProp } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { StackNavigationProp } from '@react-navigation/stack';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { RootStackParamList, TabParamList } from '../navigation/types';
import { useSettingsStore } from '../store';
import { useMusicPlayerStore } from '../store/musicPlayerStore';
import { MusicEngine } from '../services/musicPlayer';
import { usePalette, spacing, usePageBackground } from '../theme';
import { makeShadows } from '../theme/shadows';
import { typography } from '../theme/typography';
import ScreenHeader from '../components/ScreenHeader';
import { GlassCard } from '../components/GlassCard';
import { Pill } from '../components/Pill';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { FadeInView, ScalePressable } from '../components/Motion';
import { NetworkImage } from '../components/NetworkImage';
import { useI18n } from '../i18n';
import { pocketApi } from '../api/pocket48';
import { externalApi } from '../api/external';
import bilibiliApi from '../api/bilibili';
import { BilibiliLiveRoom } from '../types';
import { normalizeUrl, pickText, unwrapList } from '../utils/data';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

type HomeNavProp = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList, 'Home'>,
  StackNavigationProp<RootStackParamList>
>;

interface NavItem {
  title: string;
  desc: string;
  route: string;
  params?: any;
  icon: string;
}

/** MaterialCommunityIcons 图标（统一视觉语言，替代 emoji） */
const ICONS: Record<string, string> = {
  LiveRoom: 'video', Vod: 'play-box-multiple', RoomRadio: 'radio', Bilibili: 'broadcast',
  Rooms: 'message-text', PrivateMessages: 'email-outline', RoomAlbum: 'image-multiple', OpenLive: 'theater',
  FlipSend: 'comment-question-outline', FlipHistory: 'history', Analysis: 'chart-bar',
  Profile: 'account', MemberDynamic: 'star-circle', MemberWeibo: 'web', Trip: 'briefcase',
  VideoLibrary: 'play-box', MusicLibrary: 'music-note', AudioPrograms: 'podcast',
  MeleeRank: 'trophy', Database: 'database', Login: 'key-variant', Download: 'download', Invoice: 'file-document-outline', Settings: 'cog',
  Community: 'forum', OnMic: 'microphone',
};

const QUICK: NavItem[] = [
  { title: '直播', desc: '', route: 'Media', params: { mode: 'live' }, icon: ICONS.LiveRoom },
  { title: '回放', desc: '', route: 'Media', params: { mode: 'vod' }, icon: ICONS.Vod },
  { title: '音乐', desc: '', route: 'MusicLibraryScreen', icon: ICONS.MusicLibrary },
  { title: '私信', desc: '', route: 'PrivateMessagesScreen', icon: ICONS.PrivateMessages },
];

/** 工具：单行横向 chips（翻牌/统计/下载/账号/设置…） */
const TOOL_CHIPS: NavItem[] = [
  { title: '翻牌', desc: '', route: 'FlipScreen', icon: ICONS.FlipSend },
  { title: '上麦', desc: '', route: 'OnMicScreen', icon: ICONS.OnMic },
  { title: '统计', desc: '', route: 'AnalysisScreen', icon: ICONS.Analysis },
  { title: '社区', desc: '', route: 'CommunityScreen', icon: ICONS.Community },
  { title: '下载', desc: '', route: 'DownloadScreen', icon: ICONS.Download },
  { title: '账号', desc: '', route: 'LoginScreen', icon: ICONS.Login },
  { title: '设置', desc: '', route: 'Settings', icon: ICONS.Settings },
  { title: '相册', desc: '', route: 'RoomAlbumScreen', icon: ICONS.RoomAlbum },
  { title: '公演', desc: '', route: 'OpenLiveScreen', icon: ICONS.OpenLive },
  { title: 'B站', desc: '', route: 'BilibiliLiveScreen', icon: ICONS.Bilibili },
  { title: '微博', desc: '', route: 'MemberWeiboScreen', icon: ICONS.MemberWeibo },
  { title: '行程', desc: '', route: 'TripScreen', icon: ICONS.Trip },
  { title: '鸡腿榜', desc: '', route: 'MeleeRankScreen', icon: ICONS.MeleeRank },
  { title: '数据库', desc: '', route: 'DatabaseScreen', icon: ICONS.Database },
  { title: '发票', desc: '', route: 'InvoiceScreen', icon: ICONS.Invoice },
];

interface LiveCardItem {
  liveId: string;
  title: string;
  nickname: string;
  cover: string;
  /** 主播用户 id（用于关注/置顶优先排序；接口字段多态） */
  userId: string;
}

/** 成员直播排序：已关注+置顶 → 已关注未置顶 → 其他（保持原顺序） */
function sortLivesByPreference(list: LiveCardItem[], followedIds: Set<string>, pinnedIds: string[]) {
  if (!followedIds.size && !pinnedIds.length) return list;
  const pinSet = new Set(pinnedIds);
  const rank = (it: LiveCardItem) => {
    if (followedIds.has(it.userId)) return pinSet.has(it.userId) ? 0 : 1;
    return 2;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** 首页直播列表缓存（stale-while-revalidate：冷启动秒显上次内容） */
const LIVES_CACHE_KEY = 'yaya_home_lives_cache_v1';

/** 公演直播（B站开播状态）缓存：B站接口不稳定，冷启动秒显上次检测结果，后台刷新 */
const GONGYAN_CACHE_KEY = 'yaya_home_gongyan_cache_v1';

/** B站单请求短超时：开播检测只需状态，6s 未回视为失败，避免拖慢首页骨架 */
const BILI_FAST_TIMEOUT = 6000;

/** Promise 竞速超时：返回 null 表示超时（不 abort，仅放弃等待） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function normalizeLiveList(res: any): LiveCardItem[] {
  const source = unwrapList(res, [
    'content.liveList', 'content.list', 'content.data', 'content.records',
    'data.liveList', 'liveList', 'list', 'data',
  ]);
  return source
    .map((raw: any, index: number) => ({
      liveId: String(pickText(raw, ['liveId', 'id', 'live_id', 'roomId'], String(index))),
      title: pickText(raw, ['title', 'liveTitle', 'liveRoomTitle', 'roomName', 'subject'], ''),
      nickname: pickText(raw, ['nickname', 'nickName', 'userInfo.nickname', 'userInfo.nickName', 'ownerName'], ''),
      cover: normalizeUrl(pickText(raw, ['liveCover', 'coverPath', 'cover', 'coverUrl', 'picPath', 'picturePath', 'imageUrl', 'poster', 'thumb', 'userInfo.avatar'], '')),
      userId: String(pickText(raw, ['userId', 'ownerId', 'memberId', 'hostId', 'account', 'userInfo.userId', 'userInfo.id', 'owner.userId', 'memberInfo.userId', 'user.userId'], '')),
    }))
    .filter((item: LiveCardItem) => item.title)
    .slice(0, 8);
}

/** 区块标题：4×18 tint 竖条 + headline 标题 + 可选「全部 ›」 */
function SectionHeader({ title, action_label, onAction }: { title: string; action_label?: string; onAction?: () => void }) {
  const palette = usePalette();
  return (
    <View style={styles.sectionHead}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={[styles.sectionDot, { backgroundColor: palette.tint }]} />
        <Text style={[typography.headline, { color: palette.label, marginLeft: 8 }]}>{title}</Text>
      </View>
      {action_label && onAction ? (
        <ScalePressable onPress={onAction} pressedScale={0.94}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[typography.footnote, { color: palette.tint, fontWeight: '700' }]}>{action_label}</Text>
            <MaterialCommunityIcons name="chevron-right" color={palette.tint} size={16} />
          </View>
        </ScalePressable>
      ) : null}
    </View>
  );
}

/** 首页全宽沉浸直播 banner（16:9）：渐变 + 白字上浮 + 直播中红标 */
function LiveBanner({ item, onPress }: { item: LiveCardItem; onPress: () => void }) {
  const { t } = useI18n();
  const palette = usePalette();
  const [broken, setBroken] = useState(false);
  const retriedRef = useRef(false);
  // B3 修复：封面失败 3s 后自动重试一次（封面 URL 偶发 403/超时），再次失败才保持兜底
  const handleCoverError = () => {
    if (!retriedRef.current) {
      retriedRef.current = true;
      setBroken(true);
      setTimeout(() => setBroken(false), 3000);
    } else {
      setBroken(true);
    }
  };
  return (
    <ScalePressable style={styles.liveBanner} onPress={onPress} pressedScale={0.98}>
      <View style={[styles.liveBannerWrap, { backgroundColor: palette.fill3, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
        {!broken && item.cover ? (
          <NetworkImage
            source={{ uri: item.cover }}
            style={styles.liveBannerCover}
            resizeMode="cover"
            fallback={false}
            onError={handleCoverError}
          />
        ) : (
          <View style={styles.liveBannerFallback}>
            <MaterialCommunityIcons name="video" color={palette.labelTertiary} size={44} />
          </View>
        )}
        {/* 底部平滑渐变（顶部透明 → 底部 0.68 黑），替代多层色阶遮罩；0.68 保证浅色封面下白字可读 */}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.68)']}
          style={styles.liveBannerShade}
        />
        <View style={[styles.liveBadge, styles.liveBannerBadge]}>
          <Text style={styles.liveBadgeText}>{t('直播中')}</Text>
        </View>
        <View style={styles.liveBannerInfo}>
          <Text style={styles.liveBannerTitle} numberOfLines={2}>{item.title}</Text>
          <Text style={styles.liveBannerNick} numberOfLines={1}>{item.nickname}</Text>
        </View>
      </View>
    </ScalePressable>
  );
}

export default function HomeScreen() {
  const navigation = useNavigation<HomeNavProp>();
  const settings = useSettingsStore((state) => state.settings);
  const palette = usePalette();
  const shadows = makeShadows(palette.name === 'dark');
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const token = settings.p48Token;
  // 屏幕宽度驱动快捷入口像素宽度：横竖屏切换（如 B 站直播自动横屏后返回）时立即重算，
  // 避免 flexBasis 百分比在旋转后残留横屏宽度（按钮被拉长不恢复）
  const { width: winW } = useWindowDimensions();
  const quickCellW = (winW - spacing.md * 2 - 24) / 4;

  const [lives, setLives] = useState<LiveCardItem[]>([]);
  const [livesOk, setLivesOk] = useState(false);
  const [livesError, setLivesError] = useState('');
  const [bannerIndex, setBannerIndex] = useState(0);
  const fetchedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const livesRetryRef = useRef(0);

  // 公演直播：B站直播间开播检测（仅五个团 SNH48/GNZ48/BEJ48/CGT48/CKG48，其余直播间不展示）
  const GONGYAN_ROOMS = useMemo(
    () => ['SNH48', 'GNZ48', 'BEJ48', 'CGT48', 'CKG48'],
    [],
  );
  const [gongyanRooms, setGongyanRooms] = useState<BilibiliLiveRoom[]>([]);
  const [gongyanLive, setGongyanLive] = useState<Record<string, boolean>>({});
  const [gongyanInfo, setGongyanInfo] = useState<Record<string, { title: string; cover: string }>>({});
  const [gongyanOk, setGongyanOk] = useState(false);
  const [gongyanError, setGongyanError] = useState('');
  const gongyanTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const gongyanRetryRef = useRef(0);
  const gongyanHasDataRef = useRef(false);

  const fetchGongyanStatus = useCallback(async () => {
    try {
      const rooms = await externalApi.fetchBilibiliConfig();
      const filtered = rooms.filter((room) => GONGYAN_ROOMS.includes(String(room.name || '').trim()));
      // 并行检测开播状态（每请求 6s 竞速超时：B站接口不稳，单请求挂起不应拖住整个公演区）
      const results = await Promise.allSettled(
        filtered.map((room) => withTimeout(bilibiliApi.getRoomInit(room.roomId), BILI_FAST_TIMEOUT)),
      );
      const next: Record<string, boolean> = {};
      filtered.forEach((room, index) => {
        const r = results[index];
        next[room.roomId] = r.status === 'fulfilled' && !!r.value && Number(r.value?.data?.live_status) === 1;
      });
      setGongyanLive(next);
      // 在播房间并行抓取封面 + 直播标题（公演行展示真实封面与场次标题；6s 竞速超时）
      const liveIds = filtered.filter((room) => next[room.roomId]).map((room) => room.roomId);
      const infoResults = await Promise.allSettled(liveIds.map((id) => withTimeout(bilibiliApi.getRoomInfo(id), BILI_FAST_TIMEOUT)));
      const infoMap: Record<string, { title: string; cover: string }> = {};
      infoResults.forEach((r, index) => {
        if (r.status === 'fulfilled' && r.value) {
          const d = r.value;
          infoMap[liveIds[index]] = {
            title: String(d.title || ''),
            cover: normalizeUrl(String(d.cover || d.user_cover || '')),
          };
        }
      });
      setGongyanInfo(infoMap);
      setGongyanRooms(filtered);
      setGongyanOk(true);
      setGongyanError('');
      gongyanRetryRef.current = 0;
      gongyanHasDataRef.current = true;
      // 持久化成功结果：冷启动秒显上次开播状态（B站接口慢时骨架不空转）
      AsyncStorage.setItem(
        GONGYAN_CACHE_KEY,
        JSON.stringify({ rooms: filtered, live: next, info: infoMap }),
      ).catch(() => {});
    } catch (e: any) {
      // 刷新失败：保留旧数据继续展示（不闪骨架）；完全无数据时才记错误态
      if (!gongyanHasDataRef.current) setGongyanError(e?.message || String(e));
      // 初次失败 5s 后自动重试（最多 2 次），不必干等 60s 轮询
      if (gongyanRetryRef.current < 2) {
        gongyanRetryRef.current += 1;
        setTimeout(() => {
          if (!mountedRef.current) return;
          if (AppState.currentState === 'active') fetchGongyanStatus();
        }, 5000);
      }
    }
  }, [GONGYAN_ROOMS]);

  // 冷启动秒显公演缓存（stale-while-revalidate）
  useEffect(() => {
    AsyncStorage.getItem(GONGYAN_CACHE_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const cached = JSON.parse(raw);
          if (Array.isArray(cached?.rooms) && cached.rooms.length) {
            setGongyanRooms(cached.rooms);
            setGongyanLive(cached.live || {});
            setGongyanInfo(cached.info || {});
            setGongyanOk(true);
            gongyanHasDataRef.current = true;
          }
        } catch { /* ignore */ }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchGongyanStatus();
    gongyanTimer.current = setInterval(() => {
      // 切到后台时暂停轮询，回前台立即补一次（省电 + 不占后台网络）
      if (AppState.currentState !== 'active') return;
      fetchGongyanStatus();
    }, 60 * 1000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchGongyanStatus();
    });
    return () => {
      if (gongyanTimer.current) clearInterval(gongyanTimer.current);
      sub.remove();
    };
  }, [fetchGongyanStatus]);

  const liveGongyanRooms = useMemo(
    () => gongyanRooms.filter((room) => !!gongyanLive[room.roomId]),
    [gongyanRooms, gongyanLive],
  );

  // banner crossfade 位移动画
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  // 成员直播排序偏好：已关注（getFollowedIds）+ 置顶（yaya_pinned_rooms）优先
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  useEffect(() => {
    AsyncStorage.getItem('yaya_pinned_rooms')
      .then((v) => { try { const a = JSON.parse(v || '[]'); if (Array.isArray(a)) setPinnedIds(a.map(String)); } catch { /* ignore */ } })
      .catch(() => {});
    if (!token) return;
    pocketApi.getFollowedIds()
      .then((res: any) => {
        const ids = unwrapList(res, ['content.data', 'content', 'data', 'list']).map(String);
        setFollowedIds(new Set(ids));
      })
      .catch(() => {});
  }, [token]);

  const fetchLives = useCallback(() => {
    // 秒显上次缓存（stale-while-revalidate）：冷启动立即有内容，后台刷新
    AsyncStorage.getItem(LIVES_CACHE_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const cached = JSON.parse(raw);
          if (Array.isArray(cached) && cached.length && !fetchedRef.current) {
            setLives(sortLivesByPreference(cached, followedIds, pinnedIds));
            setLivesOk(true);
          }
        } catch { /* ignore */ }
      })
      .catch(() => {});
    withTimeout(
      pocketApi.getLiveList({ groupId: 0, liveType: 0, next: 0, record: false }),
      10000,
    )
      .then((res: any) => {
        if (!res) throw new Error('timeout');
        const list = sortLivesByPreference(normalizeLiveList(res), followedIds, pinnedIds);
        setLives(list);
        setLivesOk(true);
        setLivesError('');
        livesRetryRef.current = 0;
        if (list.length) {
          AsyncStorage.setItem(LIVES_CACHE_KEY, JSON.stringify(list)).catch(() => {});
        }
      })
      .catch((e: any) => {
        // 有缓存时网络失败不打断展示（保留缓存内容，仅静默）；
        // 无缓存时：记错误态 + 5s 后自动重试（最多 3 次，网络抖动自愈，不必等手动点重试）
        if (!fetchedRef.current) {
          setLivesError(e?.message || String(e));
          if (livesRetryRef.current < 3) {
            livesRetryRef.current += 1;
            setTimeout(() => {
              if (!mountedRef.current) return;
              if (AppState.currentState === 'active') fetchLives();
            }, 5000);
          }
        }
      });
  }, [followedIds, pinnedIds]);

  // 关注/置顶数据到达后：已有列表立即按新偏好重排（不重新请求，幂等）
  useEffect(() => {
    setLives((prev) => (prev.length ? sortLivesByPreference(prev, followedIds, pinnedIds) : prev));
  }, [followedIds, pinnedIds]);

  // 首屏拉取（fetchedRef 防重复）
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchLives();
  }, [fetchLives]);

  // 成员直播 60s 轮询 + 回前台立即刷新：避免「启动时网络差失败后永久骨架/错误态，只能手动重试」
  useEffect(() => {
    const id = setInterval(() => {
      if (AppState.currentState === 'active') fetchLives();
    }, 60 * 1000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchLives();
    });
    return () => { clearInterval(id); sub.remove(); };
  }, [fetchLives]);

  // banner 轮播：2.5s 自动切换下一条（最多轮前 4 条），切换带 crossfade + 位移动画。
  // B1 修复：与直播/公演 60s 轮询一致，仅前台运行时切换（后台不跑动画/不空转，回前台立即恢复）。
  const bannerCount = Math.min(4, lives.length);
  useEffect(() => {
    if (bannerCount <= 1) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const startLoop = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (AppState.currentState !== 'active') return;
        // 退场再入场
        Animated.sequence([
          Animated.parallel([
            Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
            Animated.timing(slideAnim, { toValue: 10, duration: 150, useNativeDriver: true }),
          ]),
          Animated.timing(fadeAnim, { toValue: 1, duration: 240, useNativeDriver: true }),
        ]).start();
        Animated.spring(slideAnim, { toValue: 0, speed: 26, bounciness: 5, useNativeDriver: true }).start();
        setBannerIndex((i) => (i + 1) % bannerCount);
      }, 2500);
    };
    const stopLoop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    startLoop();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') startLoop();
      else stopLoop();
    });
    return () => { sub.remove(); stopLoop(); };
  }, [bannerCount, fadeAnim, slideAnim]);

  // B2 修复：lives 数量变化（60s 轮询）后 bannerIndex 收敛到有效范围，避免 banner 突然消失
  useEffect(() => {
    if (bannerCount > 0) {
      setBannerIndex((i) => Math.min(i, bannerCount - 1));
    }
  }, [bannerCount]);

  // 原子化订阅：queue 引用仅在队列变化时更新，position 高频写入不触发首页重渲染
  const musicQueue = useMusicPlayerStore((s) => s.queue);
  const musicIndex = useMusicPlayerStore((s) => s.currentIndex);
  const musicPlaybackState = useMusicPlayerStore((s) => s.playbackState);
  const currentTrack = musicQueue[musicIndex] || null;

  const handleNav = useCallback((item: NavItem) => {
    if (item.params) (navigation as any).navigate(item.route, item.params);
    else (navigation as any).navigate(item.route);
  }, [navigation]);

  /**
   * 继续播放：走 MusicEngine.resume() —— 保留记忆进度（position→seekTarget，
   * Video onLoad 后 seek 回去续播），重新解析 URL 并播放。
   * 之前直接 s.play() 会把 position/seekTarget 清零，永远从 0 开始，记忆形同虚设。
   */
  const handleResumeMusic = useCallback(() => {
    const s = useMusicPlayerStore.getState();
    if (!s.queue[s.currentIndex]) return;
    MusicEngine.resume();
    handleNav({ title: '', desc: '', route: 'MusicLibraryScreen', icon: '' });
  }, [handleNav]);

  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? t('夜深了') : hour < 11 ? t('早上好') : hour < 14 ? t('中午好') : hour < 18 ? t('下午好') : t('晚上好');

  const quick = QUICK.map((i) => ({ ...i, title: t(i.title) }));
  const toolChips = TOOL_CHIPS.map((i) => ({ ...i, title: t(i.title) }));

  const banner = lives[bannerIndex];
  const trackTitle = currentTrack?.title || '';
  const trackArtist = currentTrack?.artist || currentTrack?.joinMemberNames || '';
  // F3 修复：续播卡随播放状态显示「播放中/加载中/继续播放」，R2 曲目 URL 异步解析时用户有反馈
  const resumeLabel = musicPlaybackState === 'playing'
    ? t('播放中')
    : musicPlaybackState === 'loading'
      ? t('加载中')
      : t('继续播放');

  const openLive = useCallback((item: LiveCardItem) => {
    (navigation as any).navigate('Media', {
      mode: 'live',
      playLiveId: item.liveId,
      playTitle: item.title,
      playCover: item.cover,
      playNonce: Date.now(),
    });
  }, [navigation]);

  return (
    <View style={[styles.outer, { backgroundColor: usePageBackground() }]}>
      {/* 顶栏与全站统一：大标题 24/800 左对齐、无返回键（tab 根页） */}
      <ScreenHeader title={t('牙牙消息')} hideBack />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: 4,
          // 底部滚动空间：让 footer 可滚动到悬浮 dock 上方完全可见
          paddingBottom: 92 + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* 问候区：一行问候 */}
        <View style={{ paddingHorizontal: spacing.md }}>
          {/* 问候：随手机当前时间变化（v2.7 字号缩小） */}
          <Text style={[typography.footnote, { color: palette.labelSecondary, marginBottom: spacing.md }]}>
            {greeting}
          </Text>

          {!token ? (
            <ScalePressable style={{ marginBottom: spacing.xl }} onPress={() => handleNav({ title: '', desc: '', route: 'LoginScreen', icon: '' })} pressedScale={0.98}>
              <GlassCard strong padding={14} radius={20} style={{ borderColor: palette.danger }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={[styles.loginBadge, { backgroundColor: palette.tintSoft }]}>
                    <MaterialCommunityIcons name="key-variant" color={palette.tint} size={20} />
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={[typography.headline, { color: palette.label }]}>{t('未登录口袋账号')}</Text>
                    <Text style={[typography.footnote, { color: palette.labelSecondary, marginTop: 3, lineHeight: 18 }]}>
                      {t('消息、私信、翻牌需要登录；点此粘贴 token')}
                    </Text>
                  </View>
                  <MaterialCommunityIcons name="chevron-right" color={palette.labelTertiary} size={20} />
                </View>
              </GlassCard>
            </ScalePressable>
          ) : null}
        </View>

        {/* 正在直播：首条全宽 banner 轮播 + 其余直播行 */}
        <View style={styles.sectionOuter}>
          <SectionHeader
            title={t('成员直播')}
            action_label={t('全部')}
            onAction={() => handleNav({ title: '', desc: '', route: 'Media', icon: '' })}
          />

          {!livesOk && !livesError ? null : livesError && !livesOk ? (
            <View style={[styles.liveStateCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
              <MaterialCommunityIcons name="wifi-off" size={20} color={palette.labelTertiary} />
              <Text style={[styles.liveStateText, { color: palette.labelSecondary }]} numberOfLines={2}>
                {t('直播列表加载失败')}
              </Text>
              <Button title={t('重试')} variant="tinted" size="sm" onPress={fetchLives} />
            </View>
          ) : livesOk && lives.length === 0 ? (
            <View style={[styles.liveStateCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
              <MaterialCommunityIcons name="video-off" size={20} color={palette.labelTertiary} />
              <Text style={[styles.liveStateText, { color: palette.labelSecondary }]}>{t('此时段暂无成员直播')}</Text>
            </View>
          ) : livesOk ? (
            <FadeInView delay={80} duration={320}>
              {banner ? (
                <View style={{ marginBottom: 12 }}>
                  {/* crossfade + 位移动画包裹 banner */}
                  <Animated.View style={{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] }}>
                    <LiveBanner
                      key={banner.liveId}
                      item={banner}
                      onPress={() => openLive(banner)}
                    />
                  </Animated.View>
                  {bannerCount > 1 ? (
                    <View style={styles.bannerDots}>
                      {lives.slice(0, bannerCount).map((live, i) => (
                        <AnimatedDots
                          key={live.liveId}
                          active={i === bannerIndex}
                          color={palette.tint}
                          idle={palette.fill3}
                          onPress={() => setBannerIndex(i)}
                        />
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : null}
            </FadeInView>
          ) : null}
        </View>

        {/* 公演直播：B站直播间开播检测（在播才显示） */}
        <View style={styles.sectionOuter}>
          <SectionHeader
            title={t('公演直播')}
            action_label={t('全部')}
            onAction={() => handleNav({ title: '', desc: '', route: 'BilibiliLiveScreen', icon: '' })}
          />
          {!gongyanOk && !gongyanError ? null : gongyanError && !gongyanOk ? (
            <FadeInView delay={80} duration={300}>
              <View style={[styles.liveStateCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                <MaterialCommunityIcons name="wifi-off" size={20} color={palette.labelTertiary} />
                <Text style={[styles.liveStateText, { color: palette.labelSecondary }]} numberOfLines={2}>
                  {t('公演直播加载失败')}
                </Text>
                <Button title={t('重试')} variant="tinted" size="sm" onPress={() => { setGongyanError(''); fetchGongyanStatus(); }} />
              </View>
            </FadeInView>
          ) : liveGongyanRooms.length === 0 ? (
            <FadeInView delay={80} duration={320}>
              <View style={[styles.liveStateCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                <MaterialCommunityIcons name="broadcast-off" size={20} color={palette.labelTertiary} />
                <Text style={[styles.liveStateText, { color: palette.labelSecondary }]}>{t('此时段暂无公演直播')}</Text>
              </View>
            </FadeInView>
          ) : (
            <FadeInView delay={80} duration={320}>
              {liveGongyanRooms.map((room, index) => (
                <FadeInView key={room.roomId} delay={index < 12 ? 60 + index * 25 : 0} duration={300} distance={10}>
                  <ScalePressable
                    onPress={() => (navigation as any).navigate('BilibiliLiveScreen', { roomId: room.roomId, roomName: room.name })}
                    pressedScale={0.97}
                    style={[styles.liveRow, shadows.xs, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth, marginBottom: 8 }]}
                  >
                    <View style={[styles.liveRowThumb, { backgroundColor: palette.tintSoft }]}>
                      {gongyanInfo[room.roomId]?.cover ? (
                        <NetworkImage
                          source={{ uri: gongyanInfo[room.roomId].cover }}
                          style={styles.liveRowThumb}
                          resizeMode="cover"
                        />
                      ) : (
                        <MaterialCommunityIcons name="television-classic" color={palette.tint} size={22} />
                      )}
                    </View>
                    <View style={{ flex: 1, marginLeft: 12, minWidth: 0 }}>
                      <Text style={[styles.liveRowTitle, { color: palette.label }]} numberOfLines={1}>
                        {gongyanInfo[room.roomId]?.title || room.name || t('房间号：{id}', { id: room.roomId })}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                        <View style={[styles.gongyanDotWrap, { backgroundColor: palette.success }]}>
                          <View style={[styles.gongyanDot, { backgroundColor: palette.success }]} />
                        </View>
                        <Text style={[styles.liveRowNick, { color: palette.success, marginTop: 0, marginLeft: 5 }]}>{t('直播中')}</Text>
                        {room.name ? (
                          <Text style={[styles.liveRowNick, { color: palette.labelTertiary, marginTop: 0, marginLeft: 8 }]} numberOfLines={1}>
                            {room.name}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    <MaterialCommunityIcons name="chevron-right" color={palette.labelTertiary} size={18} />
                  </ScalePressable>
                </FadeInView>
              ))}
            </FadeInView>
          )}
        </View>

        {/* 快捷入口：单行 4 个胶囊 */}
        <View style={styles.sectionOuter}>
          <SectionHeader title={t('快捷入口')} />
          <View style={styles.quickRow}>
            {quick.map((item, index) => (
              <FadeInView key={item.title} delay={index < 12 ? 60 + index * 25 : 0} duration={280} distance={8} style={[styles.quickCell, { width: quickCellW }]}>
                <ScalePressable
                  onPress={() => handleNav(item)}
                  pressedScale={0.94}
                  style={styles.quickCellInner}
                >
                    <View
                      style={[
                        styles.chip,
                        shadows.xs,
                        {
                          backgroundColor: palette.surfaceGlassStrong,
                          borderColor: palette.innerStroke,
                        },
                      ]}
                    >
                      <View style={[styles.chipIcon, { backgroundColor: palette.tintSoft }]}>
                        <MaterialCommunityIcons name={item.icon} color={palette.tint} size={16} />
                      </View>
                      <Text style={[typography.footnote, { color: palette.label, fontWeight: '600' }]} numberOfLines={1}>{item.title}</Text>
                    </View>
                  </ScalePressable>
                </FadeInView>
              ))}
            </View>
        </View>

        {/* 最近播放 */}
        {currentTrack && trackTitle ? (
          <View style={styles.sectionOuter}>
            <SectionHeader title={t('最近播放')} />
            <FadeInView delay={150} duration={320}>
              <ScalePressable onPress={handleResumeMusic} pressedScale={0.97}>
                <GlassCard strong padding={12} radius={20}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={[styles.musicCover, { backgroundColor: palette.tintSoft }]}>
                      {currentTrack?.coverUrl || currentTrack?.cover ? (
                        <NetworkImage
                          source={{ uri: (currentTrack.coverUrl || currentTrack.cover || '') as string }}
                          style={styles.musicCover}
                          resizeMode="cover"
                        />
                      ) : (
                        <MaterialCommunityIcons name="music-note" color={palette.tint} size={24} />
                      )}
                    </View>
                    <View style={{ flex: 1, marginHorizontal: 12, minWidth: 0 }}>
                      <Text style={[typography.headline, { color: palette.label }]} numberOfLines={1}>{trackTitle}</Text>
                      {trackArtist ? (
                        <Text style={[typography.footnote, { color: palette.labelSecondary, marginTop: 2 }]} numberOfLines={1}>
                          {trackArtist}
                        </Text>
                      ) : null}
                    </View>
                    <Pill label={resumeLabel} accent onPress={handleResumeMusic} />
                  </View>
                </GlassCard>
              </ScalePressable>
            </FadeInView>
          </View>
        ) : null}

        {/* 工具：单行横向 chips */}
        <View style={styles.sectionOuter}>
          <SectionHeader title={t('工具')} />
          <FadeInView delay={190} duration={320}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.toolChipsContent}
              style={{ marginHorizontal: -spacing.md }}
            >
              {toolChips.map((item) => (
                <ScalePressable
                  key={item.title}
                  onPress={() => handleNav(item)}
                  pressedScale={0.94}
                  style={[styles.toolChip, shadows.xs, { backgroundColor: palette.surfaceGlassStrong, borderColor: palette.innerStroke }]}
                >
                  <View style={[styles.toolChipIcon, { backgroundColor: palette.tintSoft }]}>
                    <MaterialCommunityIcons name={item.icon} color={palette.tint} size={16} />
                  </View>
                  <Text style={[typography.footnote, { color: palette.label, fontWeight: '600' }]} numberOfLines={1}>{item.title}</Text>
                </ScalePressable>
              ))}
            </ScrollView>
          </FadeInView>
        </View>

        <Text
          style={[
            typography.caption1,
            { color: palette.labelTertiary, textAlign: 'center', marginTop: spacing.xl, marginBottom: 24 },
          ]}
        >
          {t('Presented by Xenia')}
        </Text>
      </ScrollView>
    </View>
  );
}

/** 指示点随动动画：膨胀 + 变色。
 *  外层固定等宽槽位（16）居中，保证 active 横条与其它小点的中心距均匀对齐；
 *  宽度动画用 JS driver（width 不支持 native driver，否则横竖屏/轮播切换时宽度错乱）。 */
function AnimatedDots({ active, color, idle, onPress }: { active: boolean; color: string; idle: string; onPress?: () => void }) {
  const w = useRef(new Animated.Value(active ? 16 : 6)).current;
  const c = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(w, { toValue: active ? 16 : 6, duration: 220, useNativeDriver: false }).start();
    // 颜色不逐帧动画（JS driver 开销），直接切换；宽度脉冲已提供动效反馈
    c.setValue(active ? 1 : 0);
  }, [active, w, c]);
  return (
    <ScalePressable style={styles.dotSlot} onPress={onPress} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} pressedScale={0.85} activeOpacity={0.7}>
      <Animated.View
        style={{
          height: 6,
          borderRadius: 3,
          width: w,
          backgroundColor: c.interpolate({
            inputRange: [0, 1],
            outputRange: [idle, color],
          }),
        }}
      />
    </ScalePressable>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1 },
  /** 区块外层：统一水平留白 + 区块间距 16（v2.7 压缩，原 24 偏宽） */
  sectionOuter: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionDot: { width: 4, height: 18, borderRadius: 2 },
  loginBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
    gap: 4,
  },
  liveBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  // 首页全宽直播 banner（16:9 沉浸）
  liveBanner: { width: '100%' },
  liveBannerWrap: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
    elevation: 4,
  },
  liveBannerCover: { width: '100%', height: '100%' },
  liveBannerFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  liveBannerShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '58%' },
  liveBannerBadge: { top: 12, left: 12 },
  liveBannerInfo: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingBottom: 12 },
  liveBannerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '800', lineHeight: 24, textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  liveBannerNick: { color: 'rgba(255,255,255,0.88)', fontSize: 12, marginTop: 3, textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  bannerDots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 8 },
  /** 指示点等宽槽位：active 横条与小点中心距均匀（防止横条与相邻点视觉错位） */
  dotSlot: { width: 16, alignItems: 'center' },
  liveList: { gap: 8 },
  /** 直播行卡：surface + hairline 圆角 16 */
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  liveRowThumb: {
    width: 52,
    height: 52,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveRowThumbFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  liveRowTitle: { fontSize: 14, fontWeight: '700', lineHeight: 18 },
  liveRowNick: { fontSize: 12, marginTop: 3, lineHeight: 16 },
  // 公演直播：呼吸状态点（直播中 success 呼吸）
  gongyanDotWrap: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gongyanDot: { width: 8, height: 8, borderRadius: 4 },
  liveStateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  liveStateText: { flex: 1, fontSize: 13, lineHeight: 18 },
  // 快捷入口胶囊
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingRight: 12,
    paddingVertical: 7,
  },
  quickRow: { flexDirection: 'row', gap: 8 },
  quickCell: {},
  quickCellInner: { width: '100%' },
  chipIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginLeft: 6,
  },
  musicCover: { width: 52, height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  toolChipsContent: {
    paddingRight: 8,
    gap: 8,
    paddingHorizontal: spacing.md,
    // 防横向 ScrollView 高度塌缩：显式 minHeight + 垂直居中，保证图标不被截断
    alignItems: 'center',
    minHeight: 46,
  },
  toolChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolChipIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
});
