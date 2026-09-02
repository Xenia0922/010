import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { LiveExoView } from '../../native/LivePlayer';
import { usePlayerStore } from '../store/playerStore';
import { PlayerSource } from '../types';

interface Props {
  source: PlayerSource;
  onError: (message: string) => void;
}

/**
 * 原生 ExoKernel（LiveExoView）：RTMP/http-flv 流专用。
 * - 原生侧自带 5 次自动重试（1.6s 间隔），重试耗尽经 onError 事件桥通知 JS；
 * - onSize（首帧画面尺寸）→ 置 playing：此前画面已在播但 state 一直 loading，
 *   导致「画面播放却永远转圈+加载时间较长」的误报；
 * - paused 从 store 同步 → 控制条播放/暂停真实控原生。
 */
export function ExoKernel({ source, onError }: Props) {
  const paused = usePlayerStore((s) => s.state !== 'playing');
  if (Platform.OS !== 'android' || !LiveExoView) {
    return null;
  }
  return (
    <LiveExoView
      style={StyleSheet.absoluteFill}
      url={source.url}
      audioOnly={source.audioOnly}
      paused={paused}
      onSize={() => {
        // 首帧画面尺寸 = 已开始播放 → 结束 loading
        usePlayerStore.getState().setState('playing');
      }}
      onError={(e) => {
        onError(String(e?.nativeEvent?.message || '').slice(0, 160) || '无法连接直播源');
      }}
    />
  );
}

export default ExoKernel;
