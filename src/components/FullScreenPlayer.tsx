import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  FlatList,
  GestureResponderEvent,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useMusicPlayerStore } from '../store/musicPlayerStore';
import { isPlayableHost, MusicEngine } from '../services/musicPlayer';
import { lyricIndexAt, lyricTimeForIndex } from '../utils/lyrics';
import CoverArt from './CoverArt';
import { usePalette, radii, spacing, motion } from '../theme';
import { typography } from '../theme/typography';
import { useI18n } from '../i18n';
import { joinMeta } from '../utils/format';
import { useVinylSpin } from '../hooks/useVinylSpin';

const ANIM_DURATION = 300;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface FullScreenPlayerInnerProps {
  // Injected data from parent selectors (hooks always called in parent)
  track: any;
  isPlaying: boolean;
  progress: number;
  duration: number;
  position: number;
  playMode: string;
  lyrics: any[];
  favorites: string[];
  toggleFavorite: (id: string, track?: any) => void;
  currentIndex: number;
  queue: any[];
  onClose: () => void;
}

function FullScreenPlayerInner({
  onClose,
  track,
  isPlaying,
  progress,
  duration,
  position,
  playMode,
  lyrics,
  favorites,
  toggleFavorite,
  currentIndex,
  queue,
}: FullScreenPlayerInnerProps) {
  const { t } = useI18n();
  const palette = usePalette();
  const { width: screenWidth } = useWindowDimensions();
  const screenWidthRef = useRef(screenWidth);
  screenWidthRef.current = screenWidth;
  const trackFavId = track ? String(track.musicId || track.id || '') : '';
  const isFav = trackFavId ? useMusicPlayerStore.getState().isFavorite(trackFavId, track) : false;
  const rawCover = (track?.coverUrl || track?.cover || track?.thumbPath || '') as string;
  const coverUri = rawCover ? (rawCover.startsWith('http') ? rawCover : `https://source.48.cn${rawCover.startsWith('/') ? rawCover : '/' + rawCover}`) : '';

  const lrcIdx = lyricIndexAt(lyrics, position);
  const progRef2 = useRef<View>(null);
  const progW2 = useRef(0);
  const progX2 = useRef(0); // 进度条在屏幕上的绝对 X（拖动换算用）
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const dragRatioRef = useRef<number>(0);
  const gestureActive = useRef(false);
  // 松手后的保持目标：播放器位置追上之前进度不回落（去「双击回退/回弹」）
  const [heldRatio, setHeldRatio] = useState<number | null>(null);
  const heldRatioRef = useRef<number | null>(null);
  const heldTimeRef = useRef(0);
  const [showQueue, setShowQueue] = useState(false);

  // 用 pageX - 条起点换算：locationX 在 Android 上相对「事件目标视图」，
  // 手指滑出条身（滑到两侧时间文字上）会突变到 0 → 进度闪回 0:00 再回来
  const ratioFromX = (pageX: number): number | null => {
    const w = progW2.current;
    if (!w || w < 2) return null;
    return Math.max(0, Math.min(1, (pageX - progX2.current) / w));
  };
  // 拖动跟手优化：move 事件（~60-120Hz）不全量 setState——rAF 限帧 1 次/帧 + 最小跳变 0.4% 才触发渲染，
  // 视觉仍贴手（全屏页含歌词等高成本子树，逐事件渲染是卡顿源）
  const progRaf = useRef(0);
  const pendingRatio = useRef(0);
  const onProgGrant = (e: any) => {
    const r = ratioFromX(e.nativeEvent.pageX);
    if (r == null) { gestureActive.current = false; return; }
    gestureActive.current = true;
    if (progRaf.current) cancelAnimationFrame(progRaf.current);
    progRaf.current = 0;
    heldRatioRef.current = null;
    setHeldRatio(null);
    dragRatioRef.current = r;
    pendingRatio.current = r;
    setDragRatio(r);
  };
  const onProgMove = (e: any) => {
    const r = ratioFromX(e.nativeEvent.pageX);
    if (r == null) return;
    pendingRatio.current = r;
    if (progRaf.current) return;
    progRaf.current = requestAnimationFrame(() => {
      progRaf.current = 0;
      const nr = pendingRatio.current;
      if (Math.abs(nr - dragRatioRef.current) < 0.004) return; // 0.4% 内不重渲染
      dragRatioRef.current = nr;
      setDragRatio(nr);
    });
  };
  const onProgRelease = () => {
    if (progRaf.current) cancelAnimationFrame(progRaf.current);
    progRaf.current = 0;
    const r = dragRatioRef.current;
    if (gestureActive.current && duration > 0) {
      useMusicPlayerStore.getState().setSeekTarget(r * duration);
      // 松手后保持目标进度直到播放器追上，避免进度条回弹
      heldRatioRef.current = r;
      heldTimeRef.current = Date.now();
      setHeldRatio(r);
    }
    gestureActive.current = false;
    dragRatioRef.current = 0;
    pendingRatio.current = 0;
    setDragRatio(null);
  };
  // 播放器追上目标（或 2.5s 超时）后释放保持
  useEffect(() => {
    if (heldRatio == null) return;
    if (Math.abs(progress - heldRatio) < 0.012 || Date.now() - heldTimeRef.current > 2500) {
      heldRatioRef.current = null;
      setHeldRatio(null);
    }
  }, [progress, heldRatio]);
  const shownRatio = dragRatio ?? heldRatio ?? progress;

  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricSize, setLyricSize] = useState(17);
  const [spacerH, setSpacerH] = useState(160);
  const slideAnim = useRef(new Animated.Value(0)).current;
  const lyricScrollRef = useRef<ScrollView>(null);
  const lrcScrollH = useRef(400);
  const lineYOffsets = useRef<number[]>([]);

  useEffect(() => { lineYOffsets.current = new Array(lyrics.length).fill(0); }, [lyrics]);

  // 唱片旋转：模块级单例（见 useVinylSpin）——跨详情页重进有记忆，切歌归零，暂停冻结。
  const spinValue = useVinylSpin(track?.id, isPlaying);
  const spin = spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 下拉关闭：手势方向（dy）与动画方向（translateY）一致
  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 15,
    onPanResponderMove: (_, gs) => { if (Math.abs(gs.dy) > 15) slideAnim.setValue(gs.dy); },
    onPanResponderRelease: (_, gs) => {
      if (gs.dy > 60) {
        Animated.timing(slideAnim, { toValue: screenWidthRef.current, duration: motion.duration.fast, easing: Easing.inOut(Easing.ease), useNativeDriver: true }).start(() => onCloseRef.current());
      } else {
        Animated.spring(slideAnim, { toValue: 0, ...motion.spring.bouncy, useNativeDriver: true }).start();
      }
    },
  })).current;

  useEffect(() => {
    if (lrcIdx < 0 || !showLyrics || !lyricScrollRef.current) return;
    const y = lineYOffsets.current[lrcIdx] ?? 0;
    const lineH = lyricSize * 1.6 + 16;
    const timer = setTimeout(() => {
      const target = Math.max(0, y - lrcScrollH.current / 2 + lineH / 2);
      lyricScrollRef.current?.scrollTo?.({ y: target, animated: true });
    }, 30);
    return () => clearTimeout(timer);
  }, [lrcIdx, showLyrics, lyricSize, lyrics]);

  const iconSecondary = palette.labelSecondary;
  const iconStrong = palette.label;

  return (
    <View style={styles.root}>
      <View style={[styles.backdrop, { backgroundColor: palette.background }]} />
      <Animated.View style={[styles.page, { transform: [{ translateY: slideAnim }] }]} {...panResponder.panHandlers}>
        <View style={styles.topBar}>
          <Pressable onPress={onClose} style={({ pressed }) => [styles.topBtn, pressed && { opacity: 0.6 }]}>
            <Text style={[styles.topBtnT, { color: palette.label }]}>▾</Text>
          </Pressable>
          <View style={styles.topCenter}>
            <Text style={[typography.headline, { color: palette.label }]} numberOfLines={1}>{track.title || t('未知')}</Text>
            <Text style={[typography.caption1, { color: palette.labelTertiary, marginTop: 2 }]} numberOfLines={1}>
              {joinMeta([track.groupLabel, track.artist, track.album]) || t('官方音乐')}
            </Text>
          </View>
          <View style={styles.topBtn} />
        </View>

        {showLyrics ? (
          <>
            <View style={styles.lyricToolRow}>
              <Pressable onPress={() => setLyricSize((s) => Math.max(13, s - 2))} style={({ pressed }) => [styles.lyricToolBtn, { backgroundColor: palette.fill2 }, pressed && { opacity: 0.6 }]}>
                <Text style={[styles.lyricToolT, { color: palette.labelSecondary }]}>A-</Text>
              </Pressable>
              <Pressable onPress={() => setLyricSize((s) => Math.min(24, s + 2))} style={({ pressed }) => [styles.lyricToolBtn, { backgroundColor: palette.fill2 }, pressed && { opacity: 0.6 }]}>
                <Text style={[styles.lyricToolT, { color: palette.labelSecondary }]}>A+</Text>
              </Pressable>
            </View>
            <ScrollView ref={lyricScrollRef} style={styles.lyricScroll} showsVerticalScrollIndicator={false}
              onLayout={e => { lrcScrollH.current = e.nativeEvent.layout.height; setSpacerH(Math.max(120, lrcScrollH.current / 2)); }}>
              <View style={{ height: spacerH }} />
              {lyrics.length > 0 ? lyrics.map((l, i) => (
                <Pressable
                  key={i}
                  onLayout={e => { lineYOffsets.current[i] = e.nativeEvent.layout.y; }}
                  onPress={() => { const time = lyricTimeForIndex(lyrics, i); if (time >= 0) useMusicPlayerStore.getState().setSeekTarget(time); }}
                >
                  <Text
                    style={[
                      styles.lyricLine,
                      { fontSize: lyricSize, lineHeight: lyricSize * 1.6, color: palette.labelTertiary },
                      i === lrcIdx && { color: palette.tint, fontWeight: '900', textShadowColor: palette.tintSoft, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8 },
                    ]}
                  >
                    {l.text}
                  </Text>
                </Pressable>
              )) : <Text style={[styles.lyricLine, { color: palette.labelTertiary }]}>{t('暂无歌词')}</Text>}
              <View style={{ height: spacerH }} />
            </ScrollView>
          </>
        ) : (
          <View style={styles.discWrap}>
            <Animated.View style={[styles.disc, { transform: [{ rotate: spin }] }]}>
              <CoverArt key={coverUri || track.title || '♪'} uri={coverUri || undefined} title={track.title || '♪'} size={240} round />
            </Animated.View>
          </View>
        )}

        <View style={styles.ctrlWrap}>
          <View style={styles.progressRow}>
            <Text style={[styles.progTime, { color: palette.labelTertiary }]}>{formatTime(position)}</Text>
            <View
              ref={progRef2}
              style={styles.progBg}
              onLayout={e => { progW2.current = e.nativeEvent.layout.width; progRef2.current?.measureInWindow?.((x) => { progX2.current = x; }); }}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={onProgGrant}
              onResponderMove={onProgMove}
              onResponderRelease={onProgRelease}
              onResponderTerminate={onProgRelease}
            >
              <View style={[styles.progTrack, { backgroundColor: palette.fill3 }]} />
              <View style={[styles.progFg, { width: `${shownRatio * 100}%` as any, backgroundColor: palette.tint }]} />
              <View style={[styles.progThumb, { left: `${shownRatio * 100}%` as any, backgroundColor: palette.tint, borderColor: palette.background }]} />
            </View>
            <Text style={[styles.progTime, { color: palette.labelTertiary }]}>{formatTime(duration)}</Text>
          </View>
          <View style={styles.btnRow}>
            <Pressable
              onPress={() => { if (trackFavId) toggleFavorite(trackFavId, track); }}
              style={({ pressed }) => [styles.sideBtn, isFav && { backgroundColor: palette.tintSoft }, pressed && { opacity: 0.6 }]}
            >
              <Icon name={isFav ? 'heart' : 'heart-outline'} size={22} color={isFav ? palette.danger : iconSecondary} />
            </Pressable>
            <Pressable onPress={() => { MusicEngine.cycleMode(); }} style={({ pressed }) => [styles.sideBtn, pressed && { opacity: 0.6 }]}>
              <Icon name={playMode === 'single' ? 'repeat-once' : playMode === 'random' ? 'shuffle-variant' : 'repeat'} size={22} color={iconSecondary} />
            </Pressable>
            <Pressable onPress={() => { MusicEngine.prev(); }} style={({ pressed }) => [styles.sideBtn, pressed && { opacity: 0.6 }]}>
              <Icon name="skip-previous" size={30} color={iconStrong} />
            </Pressable>
            <Pressable onPress={() => { MusicEngine.togglePause(); }} style={({ pressed }) => [styles.playBtn, { backgroundColor: palette.tint }, pressed && { transform: [{ scale: 0.94 }] }]}>
              <Icon name={isPlaying ? 'pause' : 'play'} size={38} color={palette.onTint} />
            </Pressable>
            <Pressable onPress={() => { MusicEngine.next(); }} style={({ pressed }) => [styles.sideBtn, pressed && { opacity: 0.6 }]}>
              <Icon name="skip-next" size={30} color={iconStrong} />
            </Pressable>
            <Pressable onPress={() => setShowLyrics(!showLyrics)} style={({ pressed }) => [styles.sideBtn, showLyrics && { backgroundColor: palette.tintSoft }, pressed && { opacity: 0.6 }]}>
              <Text style={[typography.callout, { fontWeight: '800', color: showLyrics ? palette.tint : iconSecondary }]}>{t('词')}</Text>
            </Pressable>
            <Pressable onPress={() => setShowQueue(true)} style={({ pressed }) => [styles.sideBtn, pressed && { opacity: 0.6 }]}>
              <Icon name="playlist-music" size={22} color={iconSecondary} />
            </Pressable>
          </View>
        </View>
      </Animated.View>
      <Modal visible={showQueue} transparent animationType="slide" onRequestClose={() => setShowQueue(false)}>
        <TouchableOpacity style={styles.queueMask} activeOpacity={1} onPress={() => setShowQueue(false)}>
          <View
            style={[
              styles.queueSheet,
              {
                backgroundColor: palette.surface,
                borderTopLeftRadius: radii.sheet,
                borderTopRightRadius: radii.sheet,
              },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <View style={[styles.queueHandle, { backgroundColor: palette.fill3 }]} />
            <View style={styles.queueHeader}>
              <Text style={[typography.headline, { color: palette.label }]}>{t('播放列表（{count}）', { count: queue.length })}</Text>
              <TouchableOpacity onPress={() => setShowQueue(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.6}>
                <Icon name="close" size={20} color={iconSecondary} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={queue}
              keyExtractor={(t, i) => String(t.musicId || t.id || i)}
              initialNumToRender={12}
              renderItem={({ item, index }) => {
                const active = index === currentIndex;
                const id = String(item.musicId || item.id || index);
                const cu = (item.coverUrl || item.cover || item.thumbPath || '') as string;
                const uri = cu ? (cu.startsWith('http') ? cu : `https://source.48.cn${cu.startsWith('/') ? cu : '/' + cu}`) : undefined;
                return (
                  <View style={styles.queueItemRow}>
                    <TouchableOpacity
                      style={[
                        styles.queueItem,
                        active && { backgroundColor: palette.tintSoft },
                      ]}
                      onPress={() => { MusicEngine.playAt(index); setShowQueue(false); }}
                      activeOpacity={0.7}
                    >
                      <CoverArt uri={uri} title={item.title || '♪'} size={42} round active={active} />
                      <View style={styles.queueInfo}>
                        <Text style={[typography.subhead, { color: palette.label, fontWeight: '700' }]} numberOfLines={1}>{item.title || t('未知')}</Text>
                        <Text style={[typography.caption1, { color: palette.labelTertiary, marginTop: 2 }]} numberOfLines={1}>
                          {joinMeta([item.groupLabel, item.artist, item.album]) || t('官方音乐')}
                        </Text>
                      </View>
                      {active ? <Icon name="volume-high" size={18} color={palette.tint} /> : null}
                    </TouchableOpacity>
                    {/* 从播放列表移除（不关闭弹层） */}
                    <Pressable
                      onPress={() => { MusicEngine.removeFromQueue(id).catch(() => {}); }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={({ pressed }) => [styles.queueRemove, pressed && { opacity: 0.5 }]}
                    >
                      <Icon name="trash-can-outline" size={17} color={palette.labelTertiary} />
                    </Pressable>
                  </View>
                );
              }}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function FullScreenPlayer({ visible, onClose }: Props) {
  const currentIndex = useMusicPlayerStore((s) => s.currentIndex);
  const queue = useMusicPlayerStore((s) => s.queue);
  const playbackState = useMusicPlayerStore((s) => s.playbackState);
  const playMode = useMusicPlayerStore((s) => s.playMode);
  const duration = useMusicPlayerStore((s) => s.duration);
  const position = useMusicPlayerStore((s) => s.position);
  const lyrics = useMusicPlayerStore((s) => s.lyrics);
  const favorites = useMusicPlayerStore((s) => s.favorites);
  const toggleFavorite = useMusicPlayerStore((s) => s.toggleFavorite);

  const track = queue[currentIndex] || null;
  const isPlaying = playbackState === 'playing';
  const progress = duration > 0 ? position / duration : 0;

  // Conditional render BEFORE inner component hooks
  if (!visible || !track) return null;

  return (
    <FullScreenPlayerInner
      onClose={onClose}
      track={track}
      isPlaying={isPlaying}
      progress={progress}
      duration={duration}
      position={position}
      playMode={playMode}
      lyrics={lyrics}
      favorites={favorites}
      toggleFavorite={toggleFavorite}
      currentIndex={currentIndex}
      queue={queue}
    />
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 999, elevation: 999 },
  backdrop: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  page: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 48, paddingBottom: 8 },
  topBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  topBtnT: { fontSize: 22 },
  topCenter: { flex: 1, alignItems: 'center' },
  discWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  disc: {
    width: 240, height: 240, borderRadius: 120,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 8, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 16, elevation: 8,
  },
  lyricScroll: { flex: 1 },
  lyricToolRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, paddingVertical: 6 },
  lyricToolBtn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: radii.sm },
  lyricToolT: { fontSize: 12, fontWeight: '700' },
  lyricLine: { textAlign: 'center', paddingVertical: 8 },
  ctrlWrap: { paddingHorizontal: 20, paddingBottom: 32 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  progTime: { fontSize: 10, width: 40, textAlign: 'center' },
  progBg: { flex: 1, height: 28, justifyContent: 'center' },
  progTrack: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2 },
  progFg: { position: 'absolute', left: 0, height: 4, borderRadius: 2 },
  progThumb: { position: 'absolute', top: 7, width: 14, height: 14, borderRadius: 7, borderWidth: 2, transform: [{ translateX: -7 }] },
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  sideBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  playBtn: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  queueMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  queueSheet: { maxHeight: '82%', paddingBottom: 18 },
  queueHandle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 4 },
  queueHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: 10 },
  queueItemRow: { flexDirection: 'row', alignItems: 'center' },
  queueItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: spacing.md, paddingVertical: 10 },
  queueRemove: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginRight: spacing.xs },
  queueInfo: { flex: 1, minWidth: 0 },
});
