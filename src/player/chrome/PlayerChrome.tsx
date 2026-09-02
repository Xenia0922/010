import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, GestureResponderEvent, Modal, PanResponder, Pressable, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { usePlayerStore } from '../store/playerStore';
import { PlayerFeatures } from '../types';
import { useI18n } from '../../i18n';
import { usePalette } from '../../theme';
import { formatPlayTime } from './FullscreenManager';

interface Props {
  features?: PlayerFeatures;
  extraActions?: Array<{
    key: string;
    icon: string;
    label: string;
    active?: boolean;
    onPress: () => void;
  }>;
  onClose?: () => void;
  /** 内嵌模式：不渲染顶栏（列表页内嵌播放器），仅底坞 + 全屏 */
  inline?: boolean;
  /** 错误重试回调：页面可传「重新解析地址」而非仅重播同 URL（直播流地址有时效） */
  onRetry?: () => void;
}

/** 控制条自动隐藏间隔 */
const CONTROLS_HIDE_MS = 3500;
/** 可用倍速档（点播/回放） */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
/** 触控色（全屏黑底上固定亮色，不随主题） */
const TINT = '#ff6f91';

/**
 * 唯一播放器控制层（重写核心）：渐变遮罩顶栏 + 悬浮底坞（可拖进度/倍速/弹幕/全屏）+ 更多面板。
 * 所有页面共用；能力按 features 声明渲染。
 */
export function PlayerChrome({ features = {}, extraActions = [], onClose, inline = false, onRetry }: Props) {
  const { t } = useI18n();
  const palette = usePalette();
  const meta = usePlayerStore((s) => s.meta);
  const state = usePlayerStore((s) => s.state);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const error = usePlayerStore((s) => s.error);
  const controlsVisible = usePlayerStore((s) => s.controlsVisible);
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const source = usePlayerStore((s) => s.source);
  const useWebKernel = usePlayerStore((s) => s.useWebKernel);
  const danmakuOn = usePlayerStore((s) => s.danmakuOn);
  const rate = usePlayerStore((s) => s.rate);
  const rotateDeg = usePlayerStore((s) => s.rotateDeg);
  const mirrorMode = usePlayerStore((s) => s.mirrorMode);
  const [moreVisible, setMoreVisible] = useState(false);
  const [rateSheetVisible, setRateSheetVisible] = useState(false);
  const { width: screenW } = useWindowDimensions();
  const tapRef = useRef<{ t: number; side: 'l' | 'r' } | null>(null);
  const [seekFlash, setSeekFlash] = useState<number | null>(null);
  const seekFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 控制条淡入淡出
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(controlsOpacity, {
      toValue: controlsVisible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [controlsVisible, controlsOpacity]);
  // 进度条拖动：比例 → seek（录播定位；进度条触控区加高避免误触）
  const progTrackRef = useRef<View>(null);
  const progW = useRef(0);
  const progX = useRef(0);
  const dragRatioRef = useRef<number | null>(null);
  // 拖动中本地预览比例（UI 显示用）；松手才写 store/seek 一次——避免每帧 setPosition
  // 高频触发全局订阅组件渲染风暴（实测拖动导致 ANR/闪退、日志来不及落盘）
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const progPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e: GestureResponderEvent) => onProgDown(e.nativeEvent.pageX),
      onPanResponderMove: (e: GestureResponderEvent) => onProgMove(e.nativeEvent.pageX),
      onPanResponderRelease: () => onProgUp(),
      onPanResponderTerminate: () => onProgUp(),
    }),
  ).current;

  const showControls = useCallback(() => {
    usePlayerStore.getState().toggleControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // 播放中才自动隐藏（全屏同样隐藏）；暂停/缓冲保持显示（用户在操作/看画面）
      const s = usePlayerStore.getState();
      if (s.state === 'playing') s.toggleControls(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    showControls();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [showControls, source?.url]);

  // 双击快进/快退：±10s（点播）；单击唤出/隐藏控制条（延迟 320ms 等双击判定）
  const onVideoTap = useCallback((side: 'l' | 'r') => {
    const now = Date.now();
    const prev = tapRef.current;
    if (prev && now - prev.t < 320 && prev.side === side) {
      tapRef.current = null;
      const s = usePlayerStore.getState();
      if (s.source?.kind !== 'live' && s.duration > 0) {
        const delta = side === 'r' ? 10 : -10;
        const base = s.position;
        seekTo(Math.max(0, Math.min(s.duration, base + delta)));
        setSeekFlash(delta);
        if (seekFlashTimer.current) clearTimeout(seekFlashTimer.current);
        seekFlashTimer.current = setTimeout(() => setSeekFlash(null), 900);
      }
      return;
    }
    tapRef.current = { t: now, side };
    setTimeout(() => {
      if (tapRef.current && tapRef.current.t === now) {
        tapRef.current = null;
        showControls();
      }
    }, 320);
  }, [showControls]);

  if (!source) return null;

  const playing = state === 'playing';
  const isLive = source.kind === 'live';
  // 卡片内嵌态（inline 且未全屏）：不叠任何控制坞，点击即进全屏
  const cardMode = inline && !fullscreen;
  const progRatio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  // 拖动中显示本地预览比例与目标时间（跟手），不依赖高频 store 写入
  const shownRatio = dragRatio != null ? dragRatio : progRatio;
  const shownPos = dragRatio != null && duration > 0 ? dragRatio * duration : position;

  const togglePlay = () => {
    const s = usePlayerStore.getState();
    if (s.state === 'playing') s.setState('paused');
    else if (s.state === 'paused' || s.state === 'error') s.setState('playing');
    showControls();
  };

  const toggleFullscreen = () => {
    usePlayerStore.getState().setFullscreen(!fullscreen);
    showControls();
  };

  const pickRate = (r: number) => {
    usePlayerStore.getState().setRate(r);
    setRateSheetVisible(false);
    showControls();
  };

  const toggleDanmaku = () => {
    usePlayerStore.getState().toggleDanmaku();
    showControls();
  };

  const seekTo = (t: number) => {
    if (isLive) return;
    const s = usePlayerStore.getState();
    s.setPosition(t);
    // seek 指令交给 PlayerCore（内核消费后清零）
    s.setSeekTarget(t);
    showControls();
  };

  const ratioFromX = (pageX: number): number | null => {
    if (!progW.current || progW.current < 2) return null;
    return Math.max(0, Math.min(1, (pageX - progX.current) / progW.current));
  };
  const onProgDown = (pageX: number) => {
    const dur = usePlayerStore.getState().duration;
    if (usePlayerStore.getState().source?.kind === 'live' || dur <= 0) return;
    const r = ratioFromX(pageX);
    if (r == null) return;
    dragRatioRef.current = r;
    setDragRatio(r); // 本地预览（不写 store）
  };
  const onProgMove = (pageX: number) => {
    if (dragRatioRef.current == null) return;
    const r = ratioFromX(pageX);
    if (r == null) return;
    dragRatioRef.current = r;
    setDragRatio(r); // 本地预览
  };
  const onProgUp = () => {
    const r = dragRatioRef.current;
    dragRatioRef.current = null;
    setDragRatio(null);
    if (r != null) {
      const dur = usePlayerStore.getState().duration;
      if (dur > 0) seekTo(r * dur); // 松手一次写入
    }
  };

  return (
    <>
      {/* 顶栏：常规/卡片全屏均显示（卡片全屏必须有返回钮，否则无法退出） */}
      {!inline || fullscreen ? (
        <Animated.View style={[styles.topWrap, { opacity: controlsOpacity }]} pointerEvents={controlsVisible ? 'auto' : 'none'}>
          <LinearGradient colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)']} style={StyleSheet.absoluteFill} />
          <TouchableOpacity
            style={styles.topBtn}
            onPress={() => {
              // 卡片全屏：返回 = 退出全屏回卡片；页面播放器：返回 = 关闭（onClose）
              if (inline && fullscreen) usePlayerStore.getState().setFullscreen(false);
              else if (onClose) onClose();
              else usePlayerStore.getState().close();
            }}
          >
            <MaterialCommunityIcons name={inline ? 'chevron-down' : 'chevron-down'} size={24} color="#fff" />
          </TouchableOpacity>
          <View style={styles.titleWrap}>
            <Text style={styles.titleText} numberOfLines={1}>{meta.title}</Text>
          </View>
          <TouchableOpacity style={styles.topBtn} onPress={() => setMoreVisible(true)}>
            <MaterialCommunityIcons name="dots-horizontal" size={22} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      ) : null}

      {/* 错误浮层 */}
      {error ? (
        <View style={styles.errorWrap} pointerEvents="box-none">
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity
            style={styles.errorBtn}
            onPress={() => {
              // 有 onRetry（页面重新解析）优先；否则仅重播同 URL
              if (onRetry) onRetry();
              else usePlayerStore.getState().clearError();
              showControls();
            }}
          >
            <Text style={styles.errorBtnText}>{t('重试')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* 缓冲/加载中：中央转圈（内核 onLoad 前；仅在非 error 时） */}
      {state === 'loading' && !error ? (
        <View style={styles.loadingWrap} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.loadingText}>{t('加载中…')}</Text>
        </View>
      ) : null}

      {/* 暂停/停止态：中央大播放钮（卡片态暂停也给钮：点 = 进全屏续播） */}
      {!error && !isLive && state !== 'playing' && state !== 'loading' ? (
        <Pressable
          style={styles.centerPlayWrap}
          onPress={() => {
            if (cardMode) usePlayerStore.getState().setFullscreen(true);
            else togglePlay();
          }}
        >
          <View style={styles.centerPlayBtn}>
            <MaterialCommunityIcons name="play" size={26} color="#16181c" style={{ marginLeft: 4 }} />
          </View>
        </Pressable>
      ) : null}

      {/* 双击快进/回退提示 */}
      {seekFlash != null ? (
        <View style={styles.seekFlashWrap} pointerEvents="none">
          <MaterialCommunityIcons name={seekFlash > 0 ? 'fast-forward' : 'rewind'} size={22} color="#fff" />
          <Text style={styles.seekFlashText}>{seekFlash > 0 ? `+${seekFlash}s` : `${seekFlash}s`}</Text>
        </View>
      ) : null}

      {/* 底部控制坞：底部渐变压暗层 + 两行（进度行 / 控制行）。
          唤出层始终可点（控制条隐藏后点屏幕任意处唤出）；渐变/坞内容按 controlsVisible 显隐 */}
      {/* 双击快进/回退 + 单击唤出层。inline 卡片态：点击直接进全屏（卡片不叠控制坞） */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={(e) => {
          if (inline && !fullscreen) {
            // 音频/纯音频源：无画面可全屏——点击即播放/暂停（音频条语义）
            if (source.kind === 'audio' || source.audioOnly) {
              togglePlay();
              return;
            }
            // 视频卡片：点击直接进全屏（卡片态干净无控制坞）
            usePlayerStore.getState().setFullscreen(true);
            return;
          }
          if (inline) { showControls(); return; }
          const x = e.nativeEvent.locationX ?? 0;
          onVideoTap(x < screenW / 2 ? 'l' : 'r');
        }}
      />
      {!cardMode ? (
      <View style={StyleSheet.absoluteFill} pointerEvents={controlsVisible ? 'box-none' : 'none'}>
        <Animated.View pointerEvents="none" style={{ opacity: controlsOpacity }}>
          <LinearGradient
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.68)']}
            style={styles.bottomShade}
          />
        </Animated.View>
        <Animated.View style={[styles.dockWrap, { opacity: controlsOpacity }]} pointerEvents="box-none">
          {/* 进度行：当前时间 —— 可拖进度 —— 总时间（直播仅显示 直播） */}
          <View style={styles.progressRow}>
            {!isLive ? <Text style={styles.timeText}>{formatPlayTime(shownPos)}</Text> : null}
            <View
              ref={progTrackRef}
              style={styles.progressTouch}
              onLayout={(e) => {
                progW.current = e.nativeEvent.layout.width;
                progTrackRef.current?.measureInWindow?.((x) => { progX.current = x; });
              }}
              {...progPan.panHandlers}
            >
              <View style={styles.progressTrackBg}>
                <View style={[styles.progressFill, { width: `${shownRatio * 100}%` }]} />
              </View>
              <View style={[styles.progressThumb, { left: `${shownRatio * 100}%` }]} />
            </View>
            {!isLive ? <Text style={styles.timeText}>{formatPlayTime(duration)}</Text> : <Text style={styles.timeText}>{t('直播')}</Text>}
          </View>
          {/* 控制行：播放/暂停（主按钮）+ 右侧功能 */}
          <View style={styles.ctrlRow}>
            <TouchableOpacity style={styles.playBtn} onPress={togglePlay} activeOpacity={0.85}>
              <MaterialCommunityIcons name={playing ? 'pause' : 'play'} size={24} color="#16181c" style={!playing ? { marginLeft: 3 } : undefined} />
            </TouchableOpacity>
            <Text style={styles.ctrlHintText} numberOfLines={1}>
              {source.audioOnly ? t('纯音频') : ''}
            </Text>
            <View style={{ flex: 1 }} />
            {features.rate && !isLive && !useWebKernel ? (
              <TouchableOpacity style={styles.ctrlBtn} onPress={() => setRateSheetVisible(true)} activeOpacity={0.75}>
                <Text style={[styles.rateText, rate !== 1 && { color: TINT }]}>{rate}x</Text>
              </TouchableOpacity>
            ) : null}
            {features.danmaku && !useWebKernel ? (
              <TouchableOpacity style={styles.ctrlBtn} onPress={toggleDanmaku} activeOpacity={0.75}>
                <MaterialCommunityIcons
                  name={danmakuOn ? 'comment-text-multiple' : 'comment-text-multiple-outline'}
                  size={20}
                  color={danmakuOn ? TINT : 'rgba(255,255,255,0.9)'}
                />
              </TouchableOpacity>
            ) : null}
            {!inline || fullscreen ? (
              <TouchableOpacity style={styles.ctrlBtn} onPress={toggleFullscreen} activeOpacity={0.75}>
                <MaterialCommunityIcons name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={21} color="rgba(255,255,255,0.92)" />
              </TouchableOpacity>
            ) : null}
          </View>
        </Animated.View>
      </View>
      ) : null}

      {/* 倍速抽屉（点播/回放） */}
      <Modal visible={rateSheetVisible} transparent animationType="slide" onRequestClose={() => setRateSheetVisible(false)}>
        <TouchableOpacity activeOpacity={1} style={styles.rateMask} onPress={() => setRateSheetVisible(false)}>
          <View style={[styles.rateSheet, { backgroundColor: palette.surface }]}>
            <Text style={[styles.rateSheetTitle, { color: palette.labelSecondary }]}>{t('播放速度')}</Text>
            <View style={styles.rateGrid}>
              {RATES.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.rateChip, { backgroundColor: rate === r ? palette.tintSoft : palette.fill2, borderColor: rate === r ? palette.tint : 'transparent' }]}
                  onPress={() => pickRate(r)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.rateChipText, { color: rate === r ? palette.tint : palette.label }]}>{r}x</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 更多面板 */}
      <Modal visible={moreVisible} transparent animationType="slide" onRequestClose={() => setMoreVisible(false)}>
        <View style={styles.modalShade}>
          <View style={[styles.morePanel, { backgroundColor: palette.surface }]}>
            <View style={styles.moreHeader}>
              <Text style={[styles.moreTitle, { color: palette.label }]}>{t('播放器功能')}</Text>
              <TouchableOpacity onPress={() => setMoreVisible(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialCommunityIcons name="close" size={20} color={palette.labelSecondary} />
              </TouchableOpacity>
            </View>
            <View style={styles.moreGrid}>
              {/* 画面旋转/镜像（桌面 DPlayer 对齐） */}
              <TouchableOpacity
                style={styles.moreItem}
                onPress={() => {
                  const st = usePlayerStore.getState();
                  st.setRotateDeg((st.rotateDeg + 90) % 360);
                  setMoreVisible(false);
                  showControls();
                }}
              >
                <MaterialCommunityIcons name="sync" size={22} color={palette.labelSecondary} />
                <Text style={[styles.moreLabel, { color: palette.labelSecondary }]}>
                  {rotateDeg ? t('旋转 {deg}°', { deg: rotateDeg }) : t('旋转')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.moreItem}
                onPress={() => {
                  const st = usePlayerStore.getState();
                  const next = st.mirrorMode === 'none' ? 'horizontal' : st.mirrorMode === 'horizontal' ? 'vertical' : 'none';
                  st.setMirrorMode(next);
                  setMoreVisible(false);
                  showControls();
                }}
              >
                <MaterialCommunityIcons name="flip-horizontal" size={22} color={palette.labelSecondary} />
                <Text style={[styles.moreLabel, { color: palette.labelSecondary }]}>
                  {mirrorMode === 'none' ? t('镜像') : mirrorMode === 'horizontal' ? t('水平镜像') : t('垂直镜像')}
                </Text>
              </TouchableOpacity>
              {extraActions.map((action) => (
                <TouchableOpacity
                  key={action.key}
                  style={styles.moreItem}
                  onPress={() => { setMoreVisible(false); action.onPress(); }}
                >
                  <MaterialCommunityIcons name={action.icon as any} size={22} color={action.active ? palette.tint : palette.labelSecondary} />
                  <Text style={[styles.moreLabel, { color: action.active ? palette.tint : palette.labelSecondary }]}>{action.label}</Text>
                </TouchableOpacity>
              ))}
              {features.kernelSwitch ? (
                <TouchableOpacity style={styles.moreItem} onPress={() => {
                  const s = usePlayerStore.getState();
                  s.setUseWebKernel(!s.useWebKernel);
                  s.clearError();
                  setMoreVisible(false);
                }}>
                  <MaterialCommunityIcons name="monitor" size={22} color={palette.labelSecondary} />
                  <Text style={[styles.moreLabel, { color: palette.labelSecondary }]}>
                    {useWebKernel ? t('切回原生播放器') : t('切换网页播放器')}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  topWrap: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 44, paddingBottom: 26, paddingHorizontal: 6,
  },
  topBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,20,24,0.35)',
  },
  titleWrap: { flex: 1, marginHorizontal: 10, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  titleText: {
    color: '#fff', fontSize: 14, fontWeight: '600', flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  bottomShade: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: 200,
  },
  dockWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 31,
    paddingHorizontal: 16, paddingBottom: 16,
  },
  progressRow: { flexDirection: 'row', alignItems: 'center' },
  timeText: { color: 'rgba(255,255,255,0.92)', fontSize: 11, fontVariant: ['tabular-nums'], marginHorizontal: 8, minWidth: 34, textAlign: 'center' },
  progressTouch: {
    flex: 1, height: 30, justifyContent: 'center',
  },
  progressTrackBg: {
    height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.28)',
  },
  progressFill: { height: 2, backgroundColor: '#fff' },
  progressThumb: {
    position: 'absolute', top: 11, width: 6, height: 6, borderRadius: 3,
    marginLeft: -3, backgroundColor: '#fff',
  },
  ctrlRow: { flexDirection: 'row', alignItems: 'center', marginTop: 0 },
  playBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.92)',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  ctrlHintText: { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginLeft: 8, flexShrink: 1 },
  ctrlBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  rateText: { color: '#fff', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  centerPlayWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 15,
    alignItems: 'center', justifyContent: 'center',
  },
  centerPlayBtn: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  seekFlashWrap: {
    position: 'absolute', left: 0, right: 0, top: '38%', zIndex: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  seekFlashText: { color: '#fff', fontSize: 15, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  loadingWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 20,
    alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  loadingText: { color: '#fff', fontSize: 12, opacity: 0.85 },
  rateMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  rateSheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 30, paddingTop: 14, paddingHorizontal: 16 },
  rateSheetTitle: { fontSize: 12, textAlign: 'center', marginBottom: 10 },
  rateGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  rateChip: { width: '30%', paddingVertical: 10, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  rateChipText: { fontSize: 14, fontWeight: '700' },
  errorWrap: {
    position: 'absolute', left: 24, right: 24, top: '42%', zIndex: 40,
    alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 12, padding: 14,
  },
  errorText: { color: '#fff', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  errorBtn: {
    marginTop: 10, paddingHorizontal: 18, paddingVertical: 7, borderRadius: 16,
    backgroundColor: TINT,
  },
  errorBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  modalShade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  morePanel: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 28, paddingTop: 14,
  },
  moreHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingBottom: 10,
  },
  moreTitle: { fontSize: 16, fontWeight: '700' },
  moreGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12 },
  moreItem: { width: '25%', alignItems: 'center', paddingVertical: 12 },
  moreLabel: { fontSize: 11, marginTop: 5, textAlign: 'center' },
});

export default PlayerChrome;
