import React, { useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { NativeKernel, NativeKernelHandle } from './NativeKernel';
import { ExoKernel } from './ExoKernel';
import { WebKernel } from './WebKernel';

/**
 * PlayerCore：内核路由（重写核心）。
 * 按 store.activeKernel 渲染对应内核，并统一回调写回 store。
 * 内核选择规则（由 streamResolver + 用户切换共同决定）：
 *  - rtmp/flv → exo（原生 LiveExoView，自带 5 次重试）
 *  - hls/mp4/audio → native（RNV）
 *  - 用户切网页 / 原生失败 → web（flv.js + hls.js）
 */
export function PlayerCore({ onVideoSize }: { onVideoSize?: (w: number, h: number) => void }) {
  const source = usePlayerStore((s) => s.source);
  const state = usePlayerStore((s) => s.state);
  const activeKernel = usePlayerStore((s) => s.activeKernel);
  const useWebKernel = usePlayerStore((s) => s.useWebKernel);
  const position = usePlayerStore((s) => s.position);
  const nativeRef = useRef<NativeKernelHandle>(null);

  const setState = usePlayerStore((s) => s.setState);
  const setPosition = usePlayerStore((s) => s.setPosition);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const setError = usePlayerStore((s) => s.setError);
  const setActiveKernel = usePlayerStore((s) => s.setActiveKernel);
  const setUseWebKernel = usePlayerStore((s) => s.setUseWebKernel);
  const seekTarget = usePlayerStore((s) => s.seekTarget);

  // seek 指令消费：UI 拖动进度条 → NativeKernel.seek → 清零
  useEffect(() => {
    if (seekTarget > 0 && !useWebKernel && activeKernel === 'native' && nativeRef.current) {
      nativeRef.current.seek(seekTarget);
      usePlayerStore.getState().setSeekTarget(0);
    }
  }, [seekTarget, useWebKernel, activeKernel]);

  const handleLoad = useCallback(
    (duration: number, naturalSize?: { width: number; height: number }) => {
      setDuration(duration);
      setState('playing');
      if (onVideoSize && naturalSize) {
        onVideoSize(naturalSize.width, naturalSize.height);
      }
    },
    [setDuration, setState, onVideoSize],
  );

  const handleProgress = useCallback(
    (t: number) => {
      if (state !== 'paused') setPosition(t);
    },
    [state, setPosition],
  );

  if (!source || !source.url) return null;

  const paused = state !== 'playing';
  const kernel = useWebKernel ? 'web' : activeKernel;

  // 原生 → 网页兜底（内核互切）
  const switchToWeb = useCallback(() => {
    setUseWebKernel(true);
    setError('');
    setState('playing');
  }, [setUseWebKernel, setError, setState]);

  const kernelError = useCallback(
    (msg: string) => {
      setError(msg);
      setState('error');
    },
    [setError, setState],
  );

  if (kernel === 'web') {
    return (
      <WebKernel
        source={source}
        resumeAt={position > 1 ? position : 0}
        onProgress={handleProgress}
        onEnded={() => setState('paused')}
        onError={kernelError}
      />
    );
  }
  if (kernel === 'exo') {
    return (
      <ExoKernel
        source={source}
        onError={(msg) => {
          kernelError(msg);
          // 原生重试耗尽 → 提供网页兜底（仅非 audioOnly）
          if (!source.audioOnly) switchToWeb();
        }}
      />
    );
  }
  return (
    <NativeKernel
      ref={nativeRef}
      source={source}
      paused={paused}
      rate={1}
      resumeAt={position > 1 ? position : 0}
      onLoad={handleLoad}
      onProgress={handleProgress}
      onEnd={() => setState('paused')}
      onError={(detail) => kernelError(`原生播放器失败：${detail}`)}
    />
  );
}

export default PlayerCore;
