import React, { ReactNode, useEffect, useRef } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { usePlayerStore } from './store/playerStore';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import { PlayerCore } from './core/PlayerCore';
import { PlayerChrome } from './chrome/PlayerChrome';
import { FullscreenManager } from './chrome/FullscreenManager';
import { PlayerScreenProps } from './types';
import { logInfo } from '../utils/runtimeLog';
import { Text, Platform } from 'react-native';

interface Props extends PlayerScreenProps {
  /** 弹幕 overlay 等附加层插槽（由页面挂 DanmakuOverlay） */
  children?: ReactNode;
  /** 页面是否常驻（false = 打开时挂载，关闭时卸载） */
  persistent?: boolean;
  /** 内嵌模式：容器透明由外部定高，Chrome 无顶栏；点全屏 → Modal 全屏呈现 */
  inline?: boolean;
  /** 视频实际尺寸回调（气泡/列表按内容比例自适应容器） */
  onVideoSize?: (w: number, h: number) => void;
  /** 外部续播位置（秒；如 MediaScreen 的 webResumeTime），优先于内部 position */
  resumeAt?: number;
  /** 错误重试回调（直播流地址时效：页面重新解析而非重播同 URL） */
  onRetry?: () => void;
}

/**
 * 统一播放器页（重写核心）：页面只声明「播什么、带哪些功能」，
 * 内核路由/控制层/全屏/续播/内核切换全部内部完成。
 *
 * 用法：
 * <PlayerScreen
 *   source={{ kind:'live'|'vod'|'audio', url, urls, liveId, needsNativeExo, headers, audioOnly }}
 *   meta={{ title, cover }}
 *   danmaku={{ type:'poll'|'lrc'|'ws'|'none', ... }}
 *   features={{ rate, danmaku, gift, rank, quality, resume, kernelSwitch }}
 *   extraActions={[{ key:'gift', icon:'gift', label:'礼物', onPress }]}
 *   onClose={() => ...}
 * />
 */
export function PlayerScreen({ source, meta, danmaku = { type: 'none' }, features = {}, extraActions = [], onClose, children, persistent = false, inline = false, onVideoSize, resumeAt, onRetry }: Props) {
  // R4: 把页面 onClose 注册进 playerStore，硬件返回键经 FullscreenManager 调它（清理页面状态）
  useEffect(() => {
    if (!onClose) return;
    const prev = usePlayerStore.getState().onClose;
    usePlayerStore.getState().setOnClose(onClose);
    return () => {
      // 仅当自己仍是注册者时才清空（避免覆盖后续挂载的播放器）
      if (usePlayerStore.getState().onClose === onClose) {
        usePlayerStore.getState().setOnClose(prev);
      }
    };
  }, [onClose]);
  const openedFor = useRef('');
  const sourceUrl = source.url || '';
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const rotateDeg = usePlayerStore((s) => s.rotateDeg);
  const mirrorMode = usePlayerStore((s) => s.mirrorMode);
  // 画面旋转/镜像 transform（桌面 DPlayer 对齐：竖屏视频旋转 90° 等）
  const mediaTransform: any = [];
  if (mirrorMode === 'horizontal') mediaTransform.push({ scaleX: -1 });
  if (mirrorMode === 'vertical') mediaTransform.push({ scaleY: -1 });
  if (rotateDeg) mediaTransform.push({ rotate: `${rotateDeg}deg` });

  useEffect(() => {
    if (openedFor.current === sourceUrl) return;
    openedFor.current = sourceUrl;
    // 开大播放器前收起悬浮小窗（独立 store 无互斥 → 否则双路声音）
    const mp = useMiniPlayerStore.getState();
    if (mp && mp.visible) mp.close();
    usePlayerStore.getState().open(source, meta, danmaku);
    try { logInfo(`[player] PlayerScreen open kind=${source.kind} url=${String(source.url).slice(0, 90)}`, 'player.screen'); } catch {}
    return () => {
      // 卸载时若全局播放器仍指向本页打开的源 → 关闭（persistent 页面关闭也应清干净，
      // 否则陈旧 source/state 残留可能干扰二次进入播放（首次能进、之后卡首帧））
      const st = usePlayerStore.getState();
      if (openedFor.current === sourceUrl && (!st.source || st.source.url === sourceUrl || !st.source.url)) {
        if (st.source && st.source.url === sourceUrl) st.close();
      }
      openedFor.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl]);

  // 跨页播放互斥：全局播放器同一时刻只播一路。本播放器打开的源被其它页面
  // 的新播放器顶替（store.url ≠ 本组件声明的源）→ 本页自动退出播放器
  //（如 Media tab 后台直播被房间点播顶掉，Media 页自动停止播放态）。
  const storeUrl = usePlayerStore((s) => s.source?.url);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!sourceUrl || !storeUrl) return;
    if (openedFor.current === sourceUrl && storeUrl !== sourceUrl && onCloseRef.current) {
      openedFor.current = '';
      onCloseRef.current();
    }
  }, [storeUrl, sourceUrl]);

  const _dbgSrc = usePlayerStore.getState().source;
  const _dbgState = usePlayerStore.getState().state;
  const _dbgActive = usePlayerStore.getState().activeKernel;
  const _dbgUrl = String((_dbgSrc && _dbgSrc.url) || '').toLowerCase();
  const _dbgIsLive = !!_dbgSrc && (String(((_dbgSrc.kind as any) || '')) === 'live' || _dbgUrl.startsWith('rtmp://') || _dbgUrl.startsWith('rtmps://') || _dbgUrl.includes('.flv'));
  const _dbgShort = _dbgUrl.length > 56 ? (_dbgUrl.slice(0, 56) + '…') : _dbgUrl;
  const debugBar = (
    <View pointerEvents="none" style={{ position: 'absolute', top: Platform.OS === 'android' ? 6 : 28, left: 0, right: 0, zIndex: 9999, alignItems: 'center' }}>
      <View style={{ backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 }}>
        <Text style={{ color: '#ff5566', fontSize: 11, fontFamily: 'monospace' }}>
          {`K=${_dbgActive} L=${_dbgIsLive ? 1 : 0} S=${_dbgState} U=${_dbgShort}`}
        </Text>
      </View>
    </View>
  );
  const content = (
    <View style={[styles.container, inline && !fullscreen ? styles.inline : null]}>
      {debugBar}
      {/* 画面层：旋转/镜像 transform 仅作用于视频（弹幕/控制层不转） */}
      <View style={StyleSheet.absoluteFill}>
        <View style={[StyleSheet.absoluteFill, { transform: mediaTransform }]}>
          <PlayerCore onVideoSize={onVideoSize} resumeAt={resumeAt} />
        </View>
      </View>
      {children}
      <PlayerChrome features={features} extraActions={extraActions} onClose={onClose} inline={inline} onRetry={onRetry} />
      <FullscreenManager />
    </View>
  );

  // 内嵌模式全屏：Modal 覆盖整个屏幕（保留横屏/沉浸管理）
  if (inline && fullscreen) {
    return (
      <Modal visible animationType="fade" onRequestClose={() => usePlayerStore.getState().setFullscreen(false)}>
        <View style={styles.container}>{content}</View>
      </Modal>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  inline: { backgroundColor: 'transparent' },
});

export default PlayerScreen;
