import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet } from 'react-native';
import Video from 'react-native-video';
import { PlayerSource } from '../types';
import { logInfo } from '../../utils/runtimeLog';

export interface NativeKernelHandle {
  seek: (t: number) => void;
}

interface Props {
  source: PlayerSource;
  paused: boolean;
  rate: number;
  /** 音量（B站流响度补偿用，默认 1） */
  volume?: number;
  /** 续播起点（onLoad 后 seek） */
  resumeAt?: number;
  onLoad: (duration: number, naturalSize?: { width: number; height: number }) => void;
  onProgress: (t: number) => void;
  onEnd: () => void;
  onError: (detail: string) => void;
  /** 首帧上屏（诊断 + 结束 loading） */
  onFirstFrame?: () => void;
  /** 缓冲开始/结束（诊断卡顿） */
  onBufferChange?: (buffering: boolean) => void;
}

/** RNV 内核：HLS/mp4/mp3/flac 等 ExoPlayer 支持的流 */
export const NativeKernel = forwardRef<NativeKernelHandle, Props>(function NativeKernel(
  { source, paused, rate, volume = 1, resumeAt, onLoad, onProgress, onEnd, onError, onFirstFrame, onBufferChange },
  ref,
) {
  const videoRef = useRef<any>(null);
  useImperativeHandle(ref, () => ({
    seek: (t: number) => {
      try {
        videoRef.current?.seek?.(t);
      } catch {}
    },
  }));
  return (
    <Video
      ref={videoRef}
      key={source.url}
      source={{
        uri: source.url,
        ...(source.headers ? { headers: source.headers } : {}),
        // AWS/CDN 流播放中偶发缓冲耗尽卡顿：加大 Exo 缓冲池 + 30s 回看缓冲
        bufferConfig: {
          minBufferMs: 15000,
          maxBufferMs: 60000,
          bufferForPlaybackMs: 5000,
          bufferForPlaybackAfterRebufferMs: 10000,
          backBufferDurationMs: 30000,
        },
      }}
      style={StyleSheet.absoluteFill}
      resizeMode="contain"
      paused={paused}
      rate={rate}
      volume={volume}
      progressUpdateInterval={250}
      ignoreSilentSwitch="ignore"
      playInBackground
      playWhenInactive
      onLoad={(e) => {
        try { logInfo(`[vod] NativeKernel onLoad dur=${Math.round(e.duration || 0)}`, 'player.native'); } catch {}
        const ns = e?.naturalSize;
        onLoad(
          e.duration || 0,
          ns && Number(ns.width) > 0 && Number(ns.height) > 0
            ? { width: Number(ns.width), height: Number(ns.height) }
            : undefined,
        );
        if (resumeAt && resumeAt > 1) {
          try {
            videoRef.current?.seek?.(resumeAt);
          } catch {}
        }
      }}
      onProgress={(e) => onProgress(e.currentTime || 0)}
      onEnd={onEnd}
      onReadyForDisplay={() => {
        try { logInfo('[vod] first frame onReadyForDisplay', 'player.native'); } catch {}
        onFirstFrame?.();
      }}
      onBuffer={(e) => {
        onBufferChange?.(!!e?.isBuffering);
      }}
      onError={(event: any) => onError(JSON.stringify(event?.error || event).slice(0, 220))}
    />
  );
});

export default NativeKernel;
