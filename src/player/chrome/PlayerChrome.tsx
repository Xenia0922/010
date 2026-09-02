import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, Modal, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
  const [moreVisible, setMoreVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 进度条拖动：比例 → seek（录播定位；进度条触控区加高避免误触）
  const progTrackRef = useRef<View>(null);
  const progW = useRef(0);
  const progX = useRef(0);
  const dragRatioRef = useRef<number | null>(null);
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
      const s = usePlayerStore.getState();
      if (!s.fullscreen) s.toggleControls(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    showControls();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [showControls, source?.url]);

  if (!source) return null;

  const playing = state === 'playing';
  const isLive = source.kind === 'live';
  const progRatio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;

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

  const cycleRate = () => {
    const cur = usePlayerStore.getState().rate;
    const next = cur === 1 ? 1.5 : cur === 1.5 ? 2 : 1;
    usePlayerStore.getState().setRate(next);
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
    usePlayerStore.getState().setPosition(r * dur); // 拖动即跟手预览
  };
  const onProgMove = (pageX: number) => {
    if (dragRatioRef.current == null) return;
    const r = ratioFromX(pageX);
    if (r == null) return;
    dragRatioRef.current = r;
    const dur = usePlayerStore.getState().duration;
    if (dur > 0) usePlayerStore.getState().setPosition(r * dur);
  };
  const onProgUp = () => {
    const r = dragRatioRef.current;
    dragRatioRef.current = null;
    if (r != null) {
      const dur = usePlayerStore.getState().duration;
      if (dur > 0) seekTo(r * dur);
    }
  };

  return (
    <>
      {/* 顶栏（内嵌模式不显示）：顶部渐变遮罩保证白字可读 */}
      {!inline ? (
        <View style={[styles.topWrap, { opacity: controlsVisible ? 1 : 0 }]} pointerEvents={controlsVisible ? 'auto' : 'none'}>
          <LinearGradient colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)']} style={StyleSheet.absoluteFill} />
          <TouchableOpacity style={styles.topBtn} onPress={() => { if (onClose) onClose(); else usePlayerStore.getState().close(); }}>
            <MaterialCommunityIcons name="chevron-down" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={styles.titleWrap}>
            <Text style={styles.titleText} numberOfLines={1}>{meta.title}</Text>
            {isLive ? (
              <View style={styles.liveTag}>
                <View style={styles.liveDot} />
                <Text style={styles.liveTagText}>{t('直播')}</Text>
              </View>
            ) : null}
          </View>
          <TouchableOpacity style={styles.topBtn} onPress={() => setMoreVisible(true)}>
            <MaterialCommunityIcons name="dots-horizontal" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
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

      {/* 底部控制坞：底部渐变压暗层 + 两行（进度行 / 控制行）。
          唤出层始终可点（控制条隐藏后点屏幕任意处唤出）；渐变/坞内容按 controlsVisible 显隐 */}
      <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={showControls} />
      <View style={StyleSheet.absoluteFill} pointerEvents={controlsVisible ? 'box-none' : 'none'}>
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.68)']}
          style={[styles.bottomShade, { opacity: controlsVisible ? 1 : 0 }]}
        />
        <View style={styles.dockWrap} pointerEvents="box-none">
          {/* 进度行：当前时间 —— 可拖进度 —— 总时间（直播仅显示 直播） */}
          <View style={styles.progressRow}>
            {!isLive ? <Text style={styles.timeText}>{formatPlayTime(position)}</Text> : null}
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
                <View style={[styles.progressFill, { width: `${progRatio * 100}%` }]} />
              </View>
              <View style={[styles.progressThumb, { left: `${progRatio * 100}%` }]} />
            </View>
            {!isLive ? <Text style={styles.timeText}>{formatPlayTime(duration)}</Text> : <Text style={styles.timeText}>{t('直播')}</Text>}
          </View>
          {/* 控制行：播放/暂停（主按钮）+ 右侧功能 */}
          <View style={styles.ctrlRow}>
            <TouchableOpacity style={styles.playBtn} onPress={togglePlay} activeOpacity={0.85}>
              <MaterialCommunityIcons name={playing ? 'pause' : 'play'} size={26} color="#fff" style={!playing ? { marginLeft: 2 } : undefined} />
            </TouchableOpacity>
            <Text style={styles.ctrlHintText} numberOfLines={1}>
              {source.audioOnly ? t('纯音频') : ''}
            </Text>
            <View style={{ flex: 1 }} />
            {features.rate && !isLive && !useWebKernel ? (
              <TouchableOpacity style={styles.ctrlBtn} onPress={cycleRate} activeOpacity={0.75}>
                <Text style={styles.rateText}>{rate}x</Text>
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
            {!inline ? (
              <TouchableOpacity style={styles.ctrlBtn} onPress={toggleFullscreen} activeOpacity={0.75}>
                <MaterialCommunityIcons name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={21} color="rgba(255,255,255,0.92)" />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </View>

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
    paddingTop: 40, paddingBottom: 20, paddingHorizontal: 6,
  },
  topBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
  },
  titleWrap: { flex: 1, marginHorizontal: 6, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  titleText: { color: '#fff', fontSize: 15, fontWeight: '700', flexShrink: 1 },
  liveTag: {
    flexDirection: 'row', alignItems: 'center', marginLeft: 8,
    backgroundColor: 'rgba(255,111,145,0.22)', borderRadius: 9, paddingHorizontal: 7, paddingVertical: 2,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: TINT, marginRight: 4 },
  liveTagText: { color: '#ffd3dd', fontSize: 10, fontWeight: '700' },
  bottomShade: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: 190,
  },
  dockWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 31,
    paddingHorizontal: 14, paddingBottom: 12,
  },
  progressRow: { flexDirection: 'row', alignItems: 'center' },
  timeText: { color: 'rgba(255,255,255,0.9)', fontSize: 11, fontVariant: ['tabular-nums'], marginHorizontal: 6, minWidth: 34, textAlign: 'center' },
  progressTouch: {
    flex: 1, height: 26, justifyContent: 'center', marginHorizontal: 2,
  },
  progressTrackBg: { height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: TINT },
  progressThumb: {
    position: 'absolute', top: 9, width: 8, height: 8, borderRadius: 4,
    marginLeft: -4, backgroundColor: '#fff',
  },
  ctrlRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  playBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  ctrlHintText: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginLeft: 8, flexShrink: 1 },
  ctrlBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  rateText: { color: '#fff', fontSize: 13, fontWeight: '800' },
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
