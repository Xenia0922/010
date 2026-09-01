/**
 * MiniPlayerBar · iOS 26 Liquid Glass 浮层
 *  - 玻璃感悬浮胶囊（顶部浮出 + 阴影）
 *  - 圆角 28，大封面旋转动画
 *  - 进度条可拖动
 *  - 上下手势：下滑隐藏、上滑复位
 *  - 弹簧按压反馈
 *  - 所有音乐控制逻辑（play/pause/next/mode/seek）保持原状
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  GestureResponderEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useMusicPlayerStore } from '../store/musicPlayerStore';
import { usePalette, motion, makeShadows } from '../theme';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { typography } from '../theme/typography';
import { isPlayableHost, MusicEngine } from '../services/musicPlayer';
import CoverArt from './CoverArt';
import { useI18n } from '../i18n';
import { joinMeta } from '../utils/format';
import { useVinylSpin } from '../hooks/useVinylSpin';

interface Props {
  onOpenFullScreen?: () => void;
}

export default function MiniPlayerBar({ onOpenFullScreen }: Props) {
  const palette = usePalette();
  const shadows = makeShadows(palette.name === 'dark');
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const currentIndex = useMusicPlayerStore((s) => s.currentIndex);
  const queue = useMusicPlayerStore((s) => s.queue);
  const playbackState = useMusicPlayerStore((s) => s.playbackState);
  const playMode = useMusicPlayerStore((s) => s.playMode);
  const duration = useMusicPlayerStore((s) => s.duration);
  const position = useMusicPlayerStore((s) => s.position);
  const playUrl = useMusicPlayerStore((s) => s.url);

  const track = queue[currentIndex] || null;
  const isPlaying = playbackState === 'playing';
  const progress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;

  const progRef = useRef<View>(null);
  const translateY = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  // 展示进度：跟随播放位置平滑移动（快进/拖动后不再「弹一下」跳变）
  const [progWidth, setProgWidth] = useState(0);
  const progWidthRef = useRef(0);
  const progXRef = useRef(0); // 进度条在屏幕上的绝对 X（拖动换算用）
  const displayPos = useRef(new Animated.Value(0)).current;
  // 拖动/点击后的保持目标：播放器位置追上之前不回落（去「松手回弹」）
  const [heldRatio, setHeldRatio] = useState<number | null>(null);
  const heldRef = useRef<number | null>(null);
  const lastSeekAt = useRef(0);
  const displayTarget = heldRatio ?? progress;
  useEffect(() => {
    Animated.timing(displayPos, {
      toValue: displayTarget,
      duration: 180,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [displayTarget, displayPos]);
  // 播放器上报追上目标（或 2.5s 超时）后释放保持，恢复跟随实时进度
  useEffect(() => {
    if (heldRatio == null) return;
    if (Math.abs(progress - heldRatio) < 0.012 || Date.now() - lastSeekAt.current > 2500) {
      heldRef.current = null;
      setHeldRatio(null);
    }
  }, [progress, heldRatio]);
  const thumbX = displayPos.interpolate({
    inputRange: [0, 1],
    outputRange: [0, Math.max(0, progWidth - 12)],
  });

  // 拖动手势只更新展示位置，松手才真正 seek（避免拖动过程反复 seek 造成进度条乱弹）。
  // 用 pageX - 条起点换算：locationX 在 Android 上相对「事件目标视图」，
  // 手指滑出条身（滑到时间/封面上）会突变，导致进度闪回 0:00。
  const ratioAt = (pageX: number): number | null => {
    const w = progWidthRef.current;
    if (!w || w < 2) return null;
    return Math.max(0, Math.min(1, (pageX - progXRef.current) / w));
  };
  const onProgGrant = (px: number) => {
    if (useMusicPlayerStore.getState().duration <= 0) return;
    const ratio = ratioAt(px);
    if (ratio == null) return;
    heldRef.current = ratio;
    setHeldRatio(ratio);
  };
  const onProgMove = (px: number) => {
    const ratio = ratioAt(px);
    if (ratio == null) return;
    heldRef.current = ratio;
    setHeldRatio(ratio);
  };
  const onProgRelease = () => {
    const ratio = heldRef.current;
    const dur = useMusicPlayerStore.getState().duration;
    if (ratio != null && dur > 0) {
      lastSeekAt.current = Date.now();
      useMusicPlayerStore.getState().setSeekTarget(ratio * dur);
    }
  };

  const progPanMini = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e: GestureResponderEvent) => onProgGrant(e.nativeEvent.pageX),
      onPanResponderMove: (e: GestureResponderEvent) => onProgMove(e.nativeEvent.pageX),
      onPanResponderRelease: () => onProgRelease(),
      onPanResponderTerminate: () => onProgRelease(),
    })
  ).current;

  // 唱片旋转：模块级单例（见 useVinylSpin）——跨详情页重进有记忆，切歌归零，暂停冻结。
  const spinValue = useVinylSpin(track?.id, isPlaying);
  const spin = spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dy) > 8,
      onPanResponderMove: (_, gs) => { if (Math.abs(gs.dy) > 8) translateY.setValue(gs.dy); },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > 60) {
          Animated.timing(translateY, { toValue: 220, duration: motion.duration.fast, easing: Easing.inOut(Easing.ease), useNativeDriver: true }).start();
        } else {
          Animated.spring(translateY, { toValue: 0, ...motion.spring.bouncy, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  const pressIn = () => Animated.spring(scaleAnim, { toValue: 0.94, ...motion.spring.bouncy, useNativeDriver: true }).start();
  const pressOut = () => Animated.spring(scaleAnim, { toValue: 1, ...motion.spring.bouncy, useNativeDriver: true }).start();

  const rawCover = (track?.coverUrl || track?.cover || track?.thumbPath || '') as string;
  const coverUri = rawCover ? (rawCover.startsWith('http') ? rawCover : `https://source.48.cn${rawCover.startsWith('/') ? rawCover : '/' + rawCover}`) : '';

  const handleToggle = useCallback(() => {
    try {
      if (!isPlayableHost(playUrl)) return;
      MusicEngine.togglePause();
    } catch {}
  }, [playUrl]);

  const handleNext = useCallback(() => { try { MusicEngine.next(); } catch {} }, []);
  const handleMode = useCallback(() => { try { MusicEngine.cycleMode(); } catch {} }, []);

  // B3 修复：显隐仅由「有曲目且非 idle」决定——url 未就绪（R2 FLAC 解析慢/记忆恢复）
  // 时 bar 保持可见（按钮由 handleToggle 内的 isPlayableHost 保护），不再闪烁消失
  if (!track || playbackState === 'idle') return null;

  return (
    <Animated.View
      style={[
        styles.bar,
        shadows.md,
        {
          backgroundColor: palette.surfaceGlassStrong,
          borderColor: palette.innerStroke,
          transform: [{ translateY }],
          // 音乐页为栈页面（无悬浮 TabBar），贴底悬浮；覆盖 shadows.md 的 elevation（过高会渲染深色边缘）
          // 位置修正：insets.bottom 是硬编码的系统栏估算，直接贴底（与 dock 一致，不再浮高）
          bottom: Math.max(10, insets.bottom - 32),
          elevation: 3,
        },
      ]}
      {...panResponder.panHandlers}
    >
      <View
        ref={progRef}
        style={styles.progressBar}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          setProgWidth(w);
          progWidthRef.current = w;
          progRef.current?.measureInWindow?.((x) => { progXRef.current = x; });
        }}
        {...progPanMini.panHandlers}
      >
        <View style={[styles.progressTrack, { backgroundColor: palette.fill3 }]} />
        <Animated.View
          style={[
            styles.progressFill,
            { backgroundColor: palette.tint, transform: [{ scaleX: displayPos }], transformOrigin: 'left' },
          ]}
        />
        <Animated.View style={[styles.progressThumbWrap, { transform: [{ translateX: thumbX }] }]}>
          <View
            style={[
              styles.progressThumb,
              { backgroundColor: palette.tint, borderColor: palette.surfaceGlassStrong },
            ]}
          />
        </Animated.View>
      </View>

      <Pressable onPress={onOpenFullScreen} style={styles.row}>
        <Animated.View style={[styles.cover, { transform: [{ rotate: spin }] }]}>
          <CoverArt uri={coverUri || undefined} title={track.title || '♪'} size={48} round />
        </Animated.View>
        <View style={styles.info}>
          <Text
            numberOfLines={1}
            style={[typography.subhead, { color: palette.label, fontWeight: '700', lineHeight: 20 }]}
          >
            {track.title || t('未知')}
          </Text>
          <Text
            numberOfLines={1}
            style={[typography.caption1, { color: palette.labelTertiary, lineHeight: 14, marginTop: 2 }]}
          >
            {joinMeta([track.joinMemberNames, track.subTitle, track.albumName]) || t('官方音乐')}
          </Text>
        </View>
        <View style={styles.actions}>
          <Pressable onPress={handleMode} onPressIn={pressIn} onPressOut={pressOut} style={styles.modeBtn}>
            <Icon
              name={playMode === 'single' ? 'repeat-once' : playMode === 'random' ? 'shuffle-variant' : 'repeat'}
              size={18}
              color={palette.labelSecondary}
            />
          </Pressable>
          <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
            <Pressable onPress={handleToggle} onPressIn={pressIn} onPressOut={pressOut} style={styles.playBtn}>
              <Icon name={isPlaying ? 'pause-circle' : 'play-circle'} size={36} color={palette.tint} />
            </Pressable>
          </Animated.View>
          <Pressable onPress={handleNext} onPressIn={pressIn} onPressOut={pressOut} style={styles.playBtn}>
            <Icon name="skip-next-circle" size={32} color={palette.tint} />
          </Pressable>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 12,
    right: 12,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    paddingBottom: 8,
    paddingHorizontal: 8,
    overflow: 'hidden',
  },
  progressBar: { height: 22, justifyContent: 'center', paddingHorizontal: 4 },
  // track/fill/thumb 垂直中心对齐（容器 22、track 3、thumb 12 → 中心 11）
  progressTrack: { position: 'absolute', left: 4, right: 4, top: 9.5, height: 3, borderRadius: 2 },
  progressFill: { position: 'absolute', left: 4, right: 4, top: 9.5, height: 3, borderRadius: 2 },
  progressThumbWrap: { position: 'absolute', left: 4, top: 5, width: 12, height: 12 },
  progressThumb: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 4, paddingRight: 4 },
  cover: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#1a1a1a', overflow: 'hidden' },
  info: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  playBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  modeBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
});
