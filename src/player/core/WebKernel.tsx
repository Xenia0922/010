import React, { forwardRef, useImperativeHandle, useRef } from 'react';
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

export interface WebKernelHandle {
  seek: (t: number) => void;
  setRate: (r: number) => void;
}

/**
 * Web 内核（flv.js + hls.js）：RTMP 不可达/原生失败时的兜底播放器。
 * 与 RN 控制层经 postMessage 双向通信：进度上报/结束/错误；
 * 控制层经 forwardRef 下发 seek / 倍速（网页内核录播也能拖动与变速）。
 */
export const WebKernel = forwardRef<WebKernelHandle, Props>(function WebKernel(
  { source, resumeAt, onProgress, onEnded, onError },
  ref,
) {
  const webRef = useRef<WebView>(null);

  useImperativeHandle(ref, () => ({
    seek: (t: number) => {
      webRef.current?.postMessage(JSON.stringify({ type: 'seek', time: Math.max(0, t) }));
    },
    setRate: (r: number) => {
      webRef.current?.postMessage(JSON.stringify({ type: 'rate', rate: r }));
    },
  }));

  return (
    <WebView
      ref={webRef}
      source={{ html: getPlayerHtml(source.url, undefined, resumeAt || 0, source.kind !== 'live', (source.headers || {}) as any) }}
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
});

export default WebKernel;
