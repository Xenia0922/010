import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { getPlayerHtml } from '../../components/media/player';
import { PlayerSource } from '../types';

interface Props {
  source: PlayerSource;
  resumeAt?: number;
  onProgress: (t: number) => void;
  onEnded: () => void;
  onError: (message: string) => void;
}

/**
 * Web 内核（flv.js + hls.js）：RTMP 不可达/原生失败时的兜底播放器。
 * 与 RN 控制层经 postMessage 双向通信：进度上报/结束/错误。
 */
export function WebKernel({ source, resumeAt, onProgress, onEnded, onError }: Props) {
  return (
    <WebView
      source={{ html: getPlayerHtml(source.url, undefined, resumeAt || 0, source.kind !== 'live') }}
      style={StyleSheet.absoluteFill}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      originWhitelist={['*']}
      mixedContentMode="always"
      allowsFullscreenVideo
      onMessage={(e) => {
        try {
          const data = JSON.parse(e.nativeEvent.data);
          if (data.type === 'progress') {
            onProgress(Number(data.time) || 0);
          } else if (data.type === 'ended') {
            onEnded();
          } else if (data.type === 'error') {
            onError(String(data.error || '').slice(0, 160) || '网页播放器错误');
          }
        } catch {}
      }}
      onError={(syntheticEvent) => {
        onError(String(syntheticEvent?.nativeEvent?.description || '').slice(0, 160) || '网页播放器加载失败');
      }}
    />
  );
}

export default WebKernel;
