import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, Modal, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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

/**
 * 唯一播放器控制层（重写核心）：B站风格顶栏 + 悬浮底坞 + 更多面板。
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
  // 进度条拖动：比例 → seek（进度条此前为纯展示不可拖——录播无法拖动定位）
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

  const st = usePlayerStore.getState();
  const playing = state === 'playing';
  const isLive = source.kind === 'live';

  const togglePlay = () => {
    const s = usePlayerStore.getState();
    if (s.state === 'playing') s.setState('paused');
    else if (s.state === 'paused') s.setState('playing');
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

  const toggleDanmaku = () => {
    usePlayerStore.getState().toggleDanmaku();
    showControls();
  };

  return (
    <>
      {/* 顶栏（内嵌模式不显示） */}
      {!inline ? (
        <View style={[styles.topBar, { opacity: controlsVisible ? 1 : 0 }]} pointerEvents={controlsVisible ? 'auto' : 'none'}>
          <TouchableOpacity style={styles.navBtn} onPress={() => { if (onClose) onClose(); else usePlayerStore.getState().close(); }}>
            <MaterialCommunityIcons name="chevron-down" size={22} color="#fff" />
          </TouchableOpacity>
          <View style={styles.titleWrap}>
            <Text style={styles.titleText} numberOfLines={1}>{meta.title}</Text>
          </View>
          <TouchableOpacity style={styles.navBtn} onPress={() => setMoreVisible(true)}>
            <MaterialCommunityIcons name="dots-horizontal" size={20} color="#fff" />
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

      {/* 底部控制坞 */}
      <TouchableOpacity
        activeOpacity={1}
        style={[StyleSheet.absoluteFill, { opacity: controlsVisible ? 1 : 0 }]}
        onPress={showControls}
      >
        <View style={[styles.bottomDock, { opacity: controlsVisible ? 1 : 0 }]} pointerEvents="box-none">
          <TouchableOpacity style={styles.dockBtn} onPress={togglePlay}>
            <MaterialCommunityIcons name={playing ? 'pause' : 'play'} size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.timeText}>{formatPlayTime(position)}</Text>
          <View
            ref={progTrackRef}
            style={styles.progressTrack}
            onLayout={(e) => {
              progW.current = e.nativeEvent.layout.width;
              progTrackRef.current?.measureInWindow?.((x) => { progX.current = x; });
            }}
            {...progPan.panHandlers}
          >
            <View style={[styles.progressFill, { width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%` }]} />
          </View>
          <Text style={styles.timeText}>{isLive ? t('直播') : formatPlayTime(duration)}</Text>
          {features.rate && !isLive && !useWebKernel ? (
            <TouchableOpacity style={styles.dockBtn} onPress={cycleRate}>
              <Text style={styles.rateText}>{rate}x</Text>
            </TouchableOpacity>
          ) : null}
          {features.danmaku && !useWebKernel ? (
            <TouchableOpacity style={styles.dockBtn} onPress={toggleDanmaku}>
              <MaterialCommunityIcons name={danmakuOn ? 'comment-text' : 'comment-text-outline'} size={20} color={danmakuOn ? '#ff6f91' : '#fff'} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.dockBtn} onPress={toggleFullscreen}>
            <MaterialCommunityIcons name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>

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
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 44, paddingBottom: 14, paddingHorizontal: 10,
    backgroundColor: 'rgba(0,0,0,0.34)',
  },
  navBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  titleWrap: { flex: 1, marginHorizontal: 10, justifyContent: 'center' },
  titleText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  bottomDock: {
    position: 'absolute', left: 8, right: 8, bottom: 8, zIndex: 30,
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 6, paddingHorizontal: 6,
    borderRadius: 22, backgroundColor: 'rgba(16,16,18,0.62)',
  },
  dockBtn: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
  },
  timeText: { color: 'rgba(255,255,255,0.85)', fontSize: 10, marginHorizontal: 4 },
  progressTrack: {
    flex: 1, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden',
  },
  progressFill: { height: 3, backgroundColor: '#ff6f91' },
  rateText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  errorWrap: {
    position: 'absolute', left: 24, right: 24, top: '42%', zIndex: 40,
    alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 12, padding: 14,
  },
  errorText: { color: '#fff', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  errorBtn: {
    marginTop: 10, paddingHorizontal: 18, paddingVertical: 7, borderRadius: 16,
    backgroundColor: '#ff6f91',
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
