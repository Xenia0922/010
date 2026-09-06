/**
 * 应用内悬浮小窗播放器（In-App Mini Player）：
 *  - 右下角悬浮，可拖动（PanResponder，零依赖）
 *  - 独立 Video 实例续播（交棒时 seek 到原位置）
 *  - 交互：右上角「返回全屏」常显按钮（回放全屏播放器）；左上角「关闭」；
 *    点画面唤出/隐藏控件组（暂停、标题，3s 无操作自动隐藏）
 *  - 容器宽高按视频内容比例自适应（竖屏内容竖着小窗，不再裁剪变形）
 *  - 与系统 PiP 并存：App 前台用小窗，切后台由 MainActivity 自动进系统悬浮窗
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  DeviceEventEmitter,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Video from 'react-native-video';
import { WebView } from 'react-native-webview';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import { useSettingsStore } from '../store';
import { usePalette } from '../theme';
import { setPipPlaying, setPipAspect } from '../utils/pip';
import { useI18n } from '../i18n';
import { LiveExoView } from '../native/LivePlayer';
import { getPlayerHtml } from './media/player';

const W = 180;
/** 高度按内容比例计算（竖屏内容窄条 -> 高条；横屏内容 16:9） */
const H_MIN = 104;
/** 小窗缩放档位：1 = 默认，1.18 = 放大，0.74 = 缩小（循环切换） */
const SCALE_SMALL = 0.74;
const SCALE_LARGE = 1.18;
/** 拖动/点击判定阈值：位移小于该值视为点击 */
const TAP_SLOP = 10;
/** 控件自动隐藏时长（ms） */
const CONTROLS_HIDE_MS = 3000;

export function MiniPlayer() {
  const { t } = useI18n();
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const { width: winW, height: winH } = useWindowDimensions();
  const info = useMiniPlayerStore((s) => s.info);
  const visible = useMiniPlayerStore((s) => s.visible);
  const playing = useMiniPlayerStore((s) => s.playing);
  const setPlaying = useMiniPlayerStore((s) => s.setPlaying);
  const close = useMiniPlayerStore((s) => s.close);
  const pipAuto = useSettingsStore((s) => !!s.settings?.pip_auto);
  const videoRef = useRef<any>(null);
  const seekedRef = useRef(false);
  // 小窗高度（按视频内容比例自适应）
  const [boxH, setBoxH] = useState(H_MIN);
  const boxHRef = useRef(H_MIN);
  // 缩小档位（1 默认 / SCALE_SMALL 缩小）：宽高等比缩放
  const [scale, setScale] = useState(1);
  // 是否拿到内容比例：拿到 -> contain + 自适应容器（无黑边）；拿不到 -> cover 填满（无黑边）
  const [hasNatural, setHasNatural] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  // 小窗播放错误：onError 不再静默 close，显示在小窗上让用户能看到
  const [errorMsg, setErrorMsg] = useState('');
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 实际渲染尺寸（等比缩放）
  const boxW = Math.round(W * scale);
  const boxHNow = Math.max(H_MIN, Math.round(boxH * scale));
  const boxHNowRef = useRef(boxHNow);
  boxHNowRef.current = boxHNow;

  // 初始位置：右下角，避开底部 tab dock
  const pos = useRef(new Animated.ValueXY({ x: winW - W - 12, y: winH - H_MIN - 90 })).current;
  const basePos = useRef({ x: winW - W - 12, y: winH - H_MIN - 90 });

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    // 每次 visible 翻 true（新开/重开）重置错误消息 + seek 标记，确保新开小窗能正常报错
    if (visible) {
      setErrorMsg('');
      seekedRef.current = false;
    }
    showControls();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [showControls, visible]);

  /** 回放全屏：关闭小窗并跳转播放器 */
  const backToFull = useCallback(() => {
    if (!info) return;
    close();
    (navigation as any).navigate('Media', {
      mode: info.backTo.mode,
      playUrl: info.backTo.playUrl,
      playTitle: info.backTo.playTitle,
      playCover: info.backTo.playCover,
      playNonce: Date.now(),
      // 小窗 → 大窗续播：传当前播放位置（仅录播）
      ...(info.backTo.mode !== 'live' ? { playPosition: useMiniPlayerStore.getState().currentPos } : {}),
    });
  }, [info, close, navigation]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
        onPanResponderMove: (_e, g) => {
          pos.setValue({ x: basePos.current.x + g.dx, y: basePos.current.y + g.dy });
        },
        onPanResponderRelease: (_e, g) => {
          // 几乎没动 → 视为点击：唤出/隐藏控件组（不再直接回放，避免误触）
          if (Math.abs(g.dx) < TAP_SLOP && Math.abs(g.dy) < TAP_SLOP) {
            setControlsVisible((v) => {
              const next = !v;
              if (next) showControls();
              return next;
            });
            return;
          }
          // 拖动：夹紧在屏幕内（用当前小窗实际尺寸，含缩放）
          const w = boxW;
          const h = boxHNowRef.current;
          const nx = Math.max(6, Math.min(winW - w - 6, basePos.current.x + g.dx));
          const ny = Math.max(6, Math.min(winH - h - 6, basePos.current.y + g.dy));
          basePos.current = { x: nx, y: ny };
          pos.setValue({ x: nx, y: ny });
          showControls();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info, winW, winH, navigation, showControls, boxW],
  );

  // 是否已渲染为"后台 PiP 盖层"（全屏纯媒体，盖住页面其它 UI，保证系统悬浮窗画面干净）
  const [pipCover, setPipCover] = useState(false);
  // 播放状态 → PiP 标志（小窗切后台自动进系统悬浮窗）
  useEffect(() => {
    setPipPlaying(visible && playing && !!info?.url);
  }, [visible, playing, info]);

  // 切后台兜底：强制置 PiP 标志（防主播放器关闭时把标志覆盖成 false，导致小窗切后台不进悬浮窗）
  // + 同步渲染"全屏媒体盖层"：系统 PiP 的画面 = 整个 Activity 窗口快照，若不把页面盖住，
  //   悬浮窗里会看到「列表页 + 右下角小窗」的脏画面；全屏化后悬浮窗=纯媒体。
  // ⚠️ AppState 在 PiP 下不切 background（仍为 active），不能驱动此处的盖层；
  //    改用 MainActivity.onPictureInPictureModeChanged → DeviceEvent 'PipEnteredChanged' 通知。
  useEffect(() => {
    const active = visible && playing && !!info?.url;
    const sub = DeviceEventEmitter.addListener('PipEnteredChanged', (entered: boolean) => {
      // 只在「进 PiP」方向兜底置位 videoPlaying；退出方向**不动**——
      // 否则：用户点 PiP 展开回 app → entered=false → videoPlaying 被误清为 false →
      // 之后再按 Home 时 onUserLeaveHint 看到 videoPlaying=false 直接 return，悬浮窗不弹。
      // videoPlaying 标志只应由真实播放态（上方 147 行 effect）管，不该被退出事件踩掉。
      if (entered && active) setPipPlaying(true);
      // 仅 pip_auto 开启（会真正进系统 PiP）时才全屏盖层
      setPipCover(entered && active && pipAuto);
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, playing, info, pipAuto]);

  // 系统 PiP ⏯ 点击（PipToggleBridge 经 store 发信号）→ 与小窗暂停键同逻辑切换当前小窗内容
  const sysToggleSeq = useMiniPlayerStore((s) => s.sysToggleSeq);
  useEffect(() => {
    if (sysToggleSeq === 0) return;
    const cur = useMiniPlayerStore.getState();
    if (!cur.visible || !cur.info?.url) return; // 小窗未接管：交统一播放器分支处理
    const next = !cur.playing;
    cur.setPlaying(next);
    if (useWebMini) {
      try { webMiniRef.current?.postMessage(JSON.stringify({ type: next ? 'play' : 'pause' })); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sysToggleSeq]);

  // ⚠️ 所有 hooks 必须在下方 `if (!visible || !info) return null` 之前：
  // return 若夹在 hooks 中间，每次小窗开/关(visible 翻转) hooks 数量变化 → "Rendered more hooks" 崩溃
  const lowerUrl = String(info?.url || '').toLowerCase();
  const isNativeLive = !!info?.isLive && !!info?.url && (lowerUrl.startsWith('rtmp://') || lowerUrl.includes('.flv')) && !!LiveExoView;
  const NativeLiveView = (LiveExoView || null) as React.ComponentType<{ style?: any; url: string; onSize?: (e: any) => void }> | null;
  // 公演/B站直播小窗：网页内核（无 LIVE 标、带 WebAudio 增益与防盗链 headers，音量与大屏一致）
  const useWebMini = !!info?.web && !!info?.isLive && /^https?:\/\//i.test(lowerUrl);
  const webMiniRef = useRef<WebView>(null);
  const webMiniHtml = useMemo(
    () => (useWebMini
      ? getPlayerHtml(info.url, undefined, 0, false, (info.web?.headers || {}) as any, Number(info.web?.volumeBoost) || 1)
      : ''),
    [useWebMini, (info && info.url) || ''],
  );
  const handlePlayToggle = () => {
    const cur = useMiniPlayerStore.getState().playing;
    const next = !cur;
    useMiniPlayerStore.getState().setPlaying(next);
    if (useWebMini) {
      try { webMiniRef.current?.postMessage(JSON.stringify({ type: next ? 'play' : 'pause' })); } catch {}
    }
  };
  // 缩放档位循环：默认 1 → 放大 1.18 → 缩小 0.74 → 1
  const cycleScale = () => setScale((sv) => (sv >= 1.1 ? SCALE_SMALL : sv < 0.9 ? 1 : SCALE_LARGE));
  // 缩放后夹紧在屏内（放大时不超出右/下边缘）
  useEffect(() => {
    const maxX = Math.max(6, winW - boxW - 6);
    const maxY = Math.max(6, winH - boxHNow - 6);
    const bx = Math.min(Math.max(6, basePos.current.x), maxX);
    const by = Math.min(Math.max(6, basePos.current.y), maxY);
    basePos.current = { x: bx, y: by };
    pos.setValue({ x: bx, y: by });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  // 最后一个 hooks 结束于此；其后不允许再出现任何 hook（早退点）
  if (!visible || !info) return null;

  return (
    <>
      {/* 容器（视觉层）：Video/LiveExoView + 透明拖动层（elevation 盖过 SurfaceView 接收触摸） */}
      <Animated.View
        style={[
          styles.wrap,
          pipCover && styles.wrapPiPFull,
          {
            left: pipCover ? 0 : (pos.x as any),
            top: pipCover ? 0 : (pos.y as any),
            width: pipCover ? winW : boxW,
            height: pipCover ? winH : boxHNow,
            backgroundColor: '#000',
            borderColor: palette.hairline,
          },
        ]}
      >
        {useWebMini ? (
          <WebView
            ref={webMiniRef}
            key={info.url}
            source={{ html: webMiniHtml }}
            style={StyleSheet.absoluteFill}
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            originWhitelist={['*']}
            mixedContentMode="always"
          />
        ) : isNativeLive && NativeLiveView ? (
          /* RTMP/FLV 直播流：ExoPlayer 不支持，必须用原生 LiveExoView（与大播放器一致） */
          <NativeLiveView
            key={info.url}
            style={StyleSheet.absoluteFill}
            url={info.url}
            onSize={(e) => {
              // 原生 onVideoSizeChanged 回调：按视频实际宽高自适应小窗容器（横屏 16:9 / 竖屏 9:16）
              const w = e.nativeEvent?.width;
              const h = e.nativeEvent?.height;
              if (w > 0 && h > 0) {
                const rawH = Math.round((W * h) / w);
                if (rawH > 420) {
                  boxHRef.current = H_MIN;
                  setBoxH(H_MIN);
                  setHasNatural(false);
                } else {
                  const hh = Math.max(H_MIN, rawH);
                  boxHRef.current = hh;
                  setBoxH(hh);
                  setHasNatural(true);
                }
                setPipAspect(w, h);
              }
            }}
          />
        ) : (
        <Video
          ref={videoRef}
          key={`${info.url}-${info.position || 0}`}
          source={{
            uri: info.url,
            // 口袋48 直播流防盗链校验 Referer/UA/Origin——与大播放器 playerSource 一致
            headers: {
              'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
              Referer: 'https://h5.48.cn/',
              Origin: 'https://h5.48.cn',
            },
          }}
          style={StyleSheet.absoluteFill}
          resizeMode={hasNatural ? 'contain' : 'cover'}
          paused={!playing}
          playInBackground
          playWhenInactive
          ignoreSilentSwitch="ignore"
          onLoad={(e) => {
            // 按内容比例自适应小窗高度：竖屏内容竖着小窗、横屏 16:9，比例完全贴合 → contain 无黑边
            const ns = e?.naturalSize;
            if (ns && Number(ns.width) > 0 && Number(ns.height) > 0) {
              const rawH = Math.round((W * Number(ns.height)) / Number(ns.width));
              if (rawH > 420) {
                // 超长内容（极高宽比）：cover 填满默认容器，避免小窗过高遮挡
                boxHRef.current = H_MIN;
                setBoxH(H_MIN);
                setHasNatural(false);
              } else {
                const h = Math.max(H_MIN, rawH);
                boxHRef.current = h;
                setBoxH(h);
                setHasNatural(true);
              }
              // 同步 PiP 窗口比例（切后台的系统悬浮窗也跟随内容方向）
              setPipAspect(ns.width, ns.height);
            } else {
              // 拿不到内容比例：cover 填满容器（无黑边），高度退回默认
              setHasNatural(false);
            }
            // 续播到交棒位置（仅录播）
            const t = Number(info.position) || 0;
            // 仅录播续播：HLS 直播 seek 到过去位置会黑屏/错误，直播从 LIVE edge 播
            if (t > 1 && !seekedRef.current && !info.isLive && videoRef.current?.seek) {
              seekedRef.current = true;
              videoRef.current.seek(t);
            }
          }}
          // 记录小窗实时进度（回大窗续播；仅录播）
          onProgress={(e: any) => {
            const t = Number(e?.currentTime) || 0;
            if (!info.isLive && t > 0) useMiniPlayerStore.getState().setCurrentPos(t);
          }}
          onEnd={() => setPlaying(false)}
          onError={(event) => {
            // 不再静默 close：把错误显示在小窗里，用户截图/反馈能直接看到原因
            setErrorMsg(t('小窗播放失败：{detail}', { detail: JSON.stringify(event?.error || event).slice(0, 160) }));
          }}
        />
        )}
        {errorMsg ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 8 }]} pointerEvents="none">
            <MaterialCommunityIcons name="alert-circle-outline" size={20} color="#ff6b6b" />
            <Text style={{ color: '#fff', fontSize: 10, marginTop: 4, textAlign: 'center' }}>{errorMsg}</Text>
          </View>
        ) : null}
        {/* 透明拖动/点击层：elevation 让此 JS 层盖过 Android SurfaceView 接收触摸（否则 Video 消费触摸无法拖动） */}
        <Animated.View
          {...pan.panHandlers}
          style={styles.dragLayer}
        />
        {/* 底部标题（随控件显隐；PiP 盖层时隐藏，保证悬浮窗纯画面） */}
        {controlsVisible && !pipCover ? (
          <View style={styles.titleBar} pointerEvents="none">
            <Text style={styles.title} numberOfLines={1}>{info.title}</Text>
          </View>
        ) : null}
      </Animated.View>

      {/* 按钮层：返回全屏/关闭/缩小/暂停 全部随控件显隐（3s 自动隐藏，点画面唤出） */}
      <Animated.View
        pointerEvents={pipCover ? 'none' : 'box-none'}
        style={[
          StyleSheet.absoluteFill,
          pipCover
            ? { left: 0, top: 0, width: winW, height: winH, zIndex: 9999, elevation: 9999 }
            : { left: pos.x, top: pos.y, width: boxW, height: boxHNow, zIndex: 1002, elevation: 24 },
        ]}
      >
        {controlsVisible && !pipCover ? (
          <>
            {/* 返回全屏（右上角） */}
            <TouchableOpacity
              style={styles.expandBtn}
              onPress={backToFull}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialCommunityIcons name="arrow-expand" size={15} color="#fff" />
            </TouchableOpacity>
            {/* 关闭（左上角） */}
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={close}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialCommunityIcons name="close" size={14} color="#fff" />
            </TouchableOpacity>
            {/* 缩小/还原（右上角第二颗，循环切换尺寸档位） */}
            <TouchableOpacity
              style={styles.shrinkBtn}
              onPress={cycleScale}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialCommunityIcons name={scale > 1 ? 'arrow-collapse' : scale < 1 ? 'arrow-expand-all' : 'arrow-expand'} size={14} color="#fff" />
            </TouchableOpacity>
            {/* 暂停/继续（右下角） */}
            <TouchableOpacity
              style={styles.playBtn}
              onPress={handlePlayToggle}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialCommunityIcons name={playing ? 'pause' : 'play'} size={14} color="#fff" />
            </TouchableOpacity>
          </>
        ) : null}
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
    zIndex: 999,
  },
  // PiP 盖层：铺满整窗盖住页面其它 UI（系统 PiP 画面=整窗快照，需保证悬浮窗里只有媒体）
  wrapPiPFull: {
    borderRadius: 0,
    borderWidth: 0,
    elevation: 9999,
    zIndex: 9999,
  },
  // 透明拖动层：高 elevation 使其盖过 Android WebView/Video 的硬件渲染层（它们可能无视
  // zIndex 按 elevation 排 Z 序），触摸才能稳定到 PanResponder（网页小窗拖动/点画面唤控件修复）
  dragLayer: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    elevation: 16,
    zIndex: 6,
    backgroundColor: 'transparent',
  },
  titleBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 8,
    paddingTop: 14,
    paddingBottom: 4,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  title: { color: '#fff', fontSize: 10, fontWeight: '700' },
  expandBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shrinkBtn: {
    position: 'absolute',
    top: 4,
    right: 28,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    position: 'absolute',
    bottom: 18,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
