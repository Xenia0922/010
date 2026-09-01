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
import { MusicEngine, mediaUrl as buildMediaUrl, isPlayableHost } from '../services/musicPlayer';
import { errorMessage } from '../utils/data';
import { logError } from '../utils/runtimeLog';
import { formatTimestamp, joinMeta } from '../utils/format';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import CoverArt from '../components/CoverArt';
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
const GROUP_TABS = ['ALL', 'SNH48', 'GNZ48', 'BEJ48', 'AKB48', 'CKG48', 'CGT48', 'SHY48', 'TSH48', 'TPE48', '7SENSES', 'FAV'];
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
  const currentIndex = useMusicPlayerStore((s) => s.currentIndex);
  const queue = useMusicPlayerStore((s) => s.queue);
  const playMode = useMusicPlayerStore((s) => s.playMode);
  const favorites = useMusicPlayerStore((s) => s.favorites);
  const toggleFavorite = useMusicPlayerStore((s) => s.toggleFavorite);
  const seekTarget = useMusicPlayerStore((s) => s.seekTarget);
  const [songs, setSongs] = useState<any[]>([]);
  // 搜索词 / 分团：纯 local state（不再镜像到 store，避免双写）。
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('ALL');
  const onQueryChange = (q: string) => { setQuery(q); };
  const onGroupChange = (g: string) => { setGroup(g); };
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadingRef = useRef(false);
  const videoRef = useRef<any>(null);

  const filteredSongs = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    let list = songs;
    if (group === 'FAV') list = list.filter(item => useMusicPlayerStore.getState().isFavorite(String(item.musicId || item.id || '')));
    else if (group !== 'ALL') list = list.filter(item => (item.groupLabel || '') === group);
    if (keyword) list = list.filter(item => [item.title, item.artist, item.album, item.groupLabel].filter(Boolean).join(' ').toLowerCase().includes(keyword));
    return list;
  }, [query, songs, group, favorites]);

  // 双源合并：官方源（口袋48官网静态 JS）+ R2 音乐库（music.gnz.hk 公演音频，1559 首）。
  // 去重键 title|artist（官方源优先）；任一源失败不阻塞另一源，合并结果为空才报错。
  const loadAll = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
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
      // 官方源优先：title+artist+album 同键时保留官方曲目，R2 仅补充官方缺失的。
      // B6：去重键加 album —— 同一首歌的不同专辑/公演版本（官方版 vs R2 公演版）不再被吞
      const seen = new Set<string>();
      const merged: any[] = [];
      official.forEach((t: any) => {
        const key = `${String(t.title || '').trim()}|${String(t.artist || '').trim()}|${String(t.album || '').trim()}`;
        seen.add(key);
        merged.push(t);
      });
      r2.forEach((t: any) => {
        const key = `${String(t.title || '').trim()}|${String(t.artist || '').trim()}|${String(t.album || '').trim()}`;
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(t);
      });
      setSongs(merged);
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
  useEffect(() => {
    if (seekTarget > 0 && mediaReady && videoRef.current && typeof videoRef.current.seek === 'function') {
      try {
        videoRef.current.seek(seekTarget);
      } catch (err) {
        console.warn('[MusicLibraryScreen] seekTarget error:', err);
      }
      useMusicPlayerStore.getState().setSeekTarget(0);
    }
  }, [seekTarget, mediaReady]);

  const playSong = (item: any) => {
    const st = useMusicPlayerStore.getState();
    const cur = st.queue[st.currentIndex];
    const sameAsCurrent = !!cur && (cur.musicId || cur.id) === (item.musicId || item.id);
    if (sameAsCurrent && st.playbackState === 'playing') {
      useMusicPlayerStore.getState().setFullscreenVisible(true);
      return;
    }
    // 同一首（记忆恢复/暂停中）：走 resume 保留进度续播，而不是 playTrack 从 0 开始
    if (sameAsCurrent && st.position > 0) {
      MusicEngine.resume();
      useMusicPlayerStore.getState().setFullscreenVisible(true);
      return;
    }
    // 克隆队列：播放器 store 与列表 songs 解耦，避免共享同一批对象引用时，
    // 任何播放态写入（或 FlatList 复用）反噬列表渲染。
    MusicEngine.playTrack(item, filteredSongs.map((t) => ({ ...t })));
    useMusicPlayerStore.getState().setFullscreenVisible(true);
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
      </View>
      {/* 横向标签栏：使用 flex:1 的 ScrollView + flexDirection: row，配合固定宽度 chip，
           彻底避免 Yoga 在屏幕外 item 重新测量导致的拉伸问题。 */}
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
                {g === 'FAV' ? t('收藏{count}', { count: favorites.length ? `(${favorites.length})` : '' }) : t(GROUP_LABELS[g] || g)}
              </Text>
            </ScalePressable>
          ))}
        </ScrollView>
      </View>
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
          <EmptyState icon="music-off" title={t('暂无音乐')} hint={t('点击右上角刷新，拉取官方曲库')} />
        </View>
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
                      if (fid) toggleFavorite(fid);
                    }}
                  >
                    <MaterialCommunityIcons
                      name={favorites.includes(String(item.musicId || item.id || '')) ? 'heart' : 'heart-outline'}
                      size={20}
                      color={favorites.includes(String(item.musicId || item.id || '')) ? palette.danger : palette.onTint}
                    />
                  </ScalePressable>
                </View>
                <View style={styles.songInfo}>
                  <Text style={[styles.songTitle, { color: palette.label }]} numberOfLines={2}>{item.title || t('无标题')}</Text>
                  <View style={styles.songMetaLine}>
                    <Text style={[styles.songArtist, { color: palette.labelSecondary }]} numberOfLines={1}>
                      {joinMeta([item.album, item.artist, item.groupLabel]) || t('官方音乐')}
                    </Text>
                    {item.ctime ? (
                      <Text style={[styles.dateText, { color: palette.labelTertiary }]}>
                        {formatTimestamp(item.ctime).slice(0, 10)}
                      </Text>
                    ) : null}
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
        source={{ uri: playUrl || '', headers: { 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)', Referer: 'https://h5.48.cn/' } }}
        style={styles.tinyPlayer}
        paused={playbackState !== 'playing'}
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
            const dur = e.duration || 0;
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
            if (playMode === 'single') {
              useMusicPlayerStore.getState().setPosition(0);
              useMusicPlayerStore.getState().setPlaybackState('playing');
              // 单曲循环必须显式 seek(0)：ended 后仅翻转 paused 不会重播
              // （seekTarget effect 要求 >0，seek(0) 走不到，这里直接调用）
              if (videoRef.current && typeof videoRef.current.seek === 'function') {
                try { videoRef.current.seek(0); } catch (err) { console.warn('[MusicLibraryScreen] loop seek error:', err); }
              }
              // B4 兜底：部分 ROM ended 态 seek(0) 后不自动恢复播放 → 800ms 后仍停在起点则暂停/恢复翻转一次
              setTimeout(() => {
                const st = useMusicPlayerStore.getState();
                if (st.playbackState === 'playing' && st.position <= 0.5) {
                  st.setPlaybackState('paused');
                  setTimeout(() => st.setPlaybackState('playing'), 60);
                }
              }, 800);
            } else {
              MusicEngine.next();
            }
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
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