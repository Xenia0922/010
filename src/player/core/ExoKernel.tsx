import React, { useEffect } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { LiveExoView } from '../../native/LivePlayer';
import { usePlayerStore } from '../store/playerStore';
import { PlayerSource } from '../types';
import { logInfo } from '../../utils/runtimeLog';
import { setPipAspect } from '../../utils/pip';

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
  // 诊断：直播内核每次开播/切源记录（runtimeLog → 设置可导出）
  useEffect(() => {
    try { logInfo(`[live] ExoKernel open url=${String(source.url).slice(0, 90)} audioOnly=${!!source.audioOnly}`, 'player.exo'); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.url]);
  // ⚠️ 只在「用户显式暂停」(state==='paused') 时置原生暂停。
  // 此前写成 state!=='playing'：loading（首帧前）阶段 paused=true → 原生 playWhenReady=false
  // → 流根本不启动 → onSize 永不触发 → 永远 loading ——「大概率进不去、一进直播卡一帧」根因。
  // 现在 loading 期间 paused=false，Exo 自动起播；出帧后 onSize→playing；暂停/继续由控制条显式驱动。
  const paused = usePlayerStore((s) => s.state === 'paused');
  if (Platform.OS !== 'android' || !LiveExoView) {
    return null;
  }
  return (
    <LiveExoView
      style={StyleSheet.absoluteFill}
      url={source.url}
      audioOnly={source.audioOnly}
      paused={paused}
      onSize={(e) => {
        // 首帧画面尺寸 = 已开始播放 → 结束 loading
        try { logInfo('[live] ExoKernel first frame (onSize) → playing', 'player.exo'); } catch {}
        usePlayerStore.getState().setState('playing');
        // 同步 PiP 窗口比例（成员直播多为竖屏；不跟则系统小窗按默认 16:9 裁边）
        const w = Number(e?.nativeEvent?.width) || 0;
        const h = Number(e?.nativeEvent?.height) || 0;
        if (w > 0 && h > 0) setPipAspect(w, h);
      }}
      onError={(e) => {
        onError(String(e?.nativeEvent?.message || '').slice(0, 160) || '无法连接直播源');
      }}
    />
  );
}

export default ExoKernel;
