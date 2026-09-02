import React, { useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { logWarn } from '../../utils/runtimeLog';
import { NativeKernel, NativeKernelHandle } from './NativeKernel';
import { ExoKernel } from './ExoKernel';
import { WebKernel, WebKernelHandle } from './WebKernel';

/**
 * PlayerCore：内核路由（重写核心）。
 * 按 store.activeKernel 渲染对应内核，并统一回调写回 store。
 * 内核选择规则（由 streamResolver + 用户切换共同决定）：
 *  - rtmp/flv → exo（原生 LiveExoView，自带 5 次重试）
 *  - hls/mp4/audio → native（RNV）
 *  - 用户切网页 / 原生失败 → web（flv.js + hls.js）
 */
export function PlayerCore({ onVideoSize, resumeAt: externalResumeAt }: { onVideoSize?: (w: number, h: number) => void; resumeAt?: number }) {
  const source = usePlayerStore((s) => s.source);
  const state = usePlayerStore((s) => s.state);
  const activeKernel = usePlayerStore((s) => s.activeKernel);
  const useWebKernel = usePlayerStore((s) => s.useWebKernel);
  const position = usePlayerStore((s) => s.position);
  const nativeRef = useRef<NativeKernelHandle>(null);
  const webRef = useRef<WebKernelHandle>(null);
  /** 诊断去重：记录上次已打日志的内核|源（⚠️ 必须放所有条件 return 之前——Hook 铁律） */
  const lastLogged = useRef('');

  const setState = usePlayerStore((s) => s.setState);
  const setPosition = usePlayerStore((s) => s.setPosition);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const setError = usePlayerStore((s) => s.setError);
  const setActiveKernel = usePlayerStore((s) => s.setActiveKernel);
  const setUseWebKernel = usePlayerStore((s) => s.setUseWebKernel);
  const seekTarget = usePlayerStore((s) => s.seekTarget);

  // seek 指令消费：UI 拖动进度条 → 当前内核 seek（native/exo 直调；web 经 postMessage）→ 清零
  useEffect(() => {
    if (seekTarget <= 0) return;
    const su = String(source?.url || '').toLowerCase();
    const liveShape = source?.kind === 'live' || su.startsWith('rtmp://') || su.startsWith('rtmps://') || su.includes('.flv');
    if (liveShape) {
      // 直播流 seek 无意义且可能原生崩溃（Exo 对直播 HLS/RTMP seek 抛异常）→ 丢弃指令
      usePlayerStore.getState().setSeekTarget(0);
      return;
    }
    if (!useWebKernel && activeKernel === 'native' && nativeRef.current) {
      nativeRef.current.seek(seekTarget);
      usePlayerStore.getState().setSeekTarget(0);
    } else if (useWebKernel && webRef.current) {
      webRef.current.seek(seekTarget);
      usePlayerStore.getState().setSeekTarget(0);
    }
  }, [seekTarget, useWebKernel, activeKernel]);
  // rate 同步：web 内核每次倍速变化下发（native 经 prop 实时生效）
  const rate = usePlayerStore((s) => s.rate);
  useEffect(() => {
    if (useWebKernel && webRef.current && rate > 0) {
      webRef.current.setRate(rate);
    }
  }, [rate, useWebKernel]);

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

  // 原生 → 网页兜底（内核互切）
  // ⚠️ 全部 hooks 必须在条件 return 之前（source null 时提前返回会导致
  // hooks 数量变化 → "Rendered more hooks than during the previous render" 崩溃）
  const switchToWeb = useCallback(() => {
    setUseWebKernel(true);
    setError('');
    setState('playing');
  }, [setUseWebKernel, setError, setState]);

  const kernelError = useCallback(
    (msg: string) => {
      // 诊断：内核失败原因写 runtimeLog（设置→日志可导出）
      try { logWarn(`[player] kernel fail ${msg}`, 'player.kernelError'); } catch {}
      // 有候选线路 → 自动切换下一线路（B站多线路/官方多备用地址）；全部失败才进 error 态
      const switched = usePlayerStore.getState().nextCandidate();
      if (!switched) {
        setError(msg);
        setState('error');
      }
    },
    [setError, setState],
  );

  // 内核选择（仅依赖 store，不依赖 source，须在条件 return 前算出）
  const kernel = useWebKernel ? 'web' : activeKernel;

  if (!source || !source.url) return null;

  const paused = state !== 'playing';
  // 诊断：每次开播记录所选内核与源（runtimeLog；非 hook，可放 return 后）
  if (lastLogged.current !== `${kernel}|${source.url}`) {
    lastLogged.current = `${kernel}|${source.url}`;
    try { logWarn(`[player] open kernel=${kernel} state=${state} kind=${source.kind} url=${String(source.url).slice(0, 90)}`, 'player.core'); } catch {}
  }

  if (kernel === 'web') {
    return (
      <WebKernel
        ref={webRef}
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
      rate={rate}
      volume={source.volume}
      resumeAt={externalResumeAt && externalResumeAt > 1 ? externalResumeAt : position > 1 ? position : 0}
      onLoad={handleLoad}
      onProgress={handleProgress}
      onEnd={() => setState('paused')}
      onFirstFrame={() => {
        // 首帧上屏：保险起见确保 state 已 playing（加载转圈结束）
        if (usePlayerStore.getState().state === 'loading') setState('playing');
      }}
      onBufferChange={(buffering) => {
        try { logWarn(`[vod] buffer ${buffering ? 'start' : 'end'}`, 'player.native'); } catch {}
      }}
      onError={(detail) => kernelError(`原生播放器失败：${detail}`)}
    />
  );
}

export default PlayerCore;
