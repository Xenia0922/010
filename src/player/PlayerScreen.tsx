import React, { ReactNode, useEffect, useRef } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { usePlayerStore } from './store/playerStore';
import { PlayerCore } from './core/PlayerCore';
import { PlayerChrome } from './chrome/PlayerChrome';
import { FullscreenManager } from './chrome/FullscreenManager';
import { PlayerScreenProps } from './types';

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
export function PlayerScreen({ source, meta, danmaku = { type: 'none' }, features = {}, extraActions = [], onClose, children, persistent = false, inline = false, onVideoSize, resumeAt }: Props) {
  const openedFor = useRef('');
  const sourceUrl = source.url || '';
  const fullscreen = usePlayerStore((s) => s.fullscreen);

  useEffect(() => {
    if (openedFor.current === sourceUrl) return;
    openedFor.current = sourceUrl;
    usePlayerStore.getState().open(source, meta, danmaku);
    return () => {
      // 非 persistent：卸载时若仍是当前源则关闭播放器
      if (!persistent && openedFor.current === sourceUrl) {
        usePlayerStore.getState().close();
      }
      openedFor.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl]);

  const content = (
    <View style={[styles.container, inline && !fullscreen ? styles.inline : null]}>
      <PlayerCore onVideoSize={onVideoSize} resumeAt={resumeAt} />
      {children}
      <PlayerChrome features={features} extraActions={extraActions} onClose={onClose} inline={inline} />
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
