import React, { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
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
  /** 画面真实开始（撤掉加载转圈；网页无 native firstFrame，靠 html started 消息） */
  onFirstFrame?: () => void;
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
  { source, resumeAt, onProgress, onEnded, onError, onFirstFrame },
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

  // ⚠️ 修复「反复刷新直播流」：父层每 2s 上报 progress → PlayerCore 重渲染 →
  // 若每次重算 html 字符串，WebView 视作新页面整页 reload（直播无限重载）。
  // 钉死为 URL+headers 级稳定；续播位置只在首次挂载取一次。
  const resumeOnce = useRef<number>(resumeAt || 0);
  const html = useMemo(
    () => getPlayerHtml(source.url, undefined, resumeOnce.current || 0, source.kind !== 'live', (source.headers || {}) as any, Number(source.volumeBoost) || 1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.url, source.headers],
  );

  return (
    <WebView
      ref={webRef}
      source={{ html }}
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
          } else if (data.type === 'started') {
            onFirstFrame?.();
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
