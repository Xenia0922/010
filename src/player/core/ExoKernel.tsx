import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { LiveExoView } from '../../native/LivePlayer';
import { PlayerSource } from '../types';

interface Props {
  source: PlayerSource;
  onError: (message: string) => void;
}

/**
 * 原生 ExoKernel（LiveExoView）：RTMP/http-flv 流专用。
 * 原生侧自带 5 次自动重试（1.6s 间隔），重试耗尽经 onError 事件桥通知 JS。
 */
export function ExoKernel({ source, onError }: Props) {
  if (Platform.OS !== 'android' || !LiveExoView) {
    return null;
  }
  return (
    <LiveExoView
      style={StyleSheet.absoluteFill}
      url={source.url}
      audioOnly={source.audioOnly}
      onError={(e) => {
        onError(String(e?.nativeEvent?.message || '').slice(0, 160) || '无法连接直播源');
      }}
    />
  );
}

export default ExoKernel;
