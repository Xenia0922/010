/**
 * 原生 Exo 播放桥（M2）：真实音频在 YayaExoService（ExoPlayer + media3 会话）。
 * 引擎仍负责队列/切歌/模式；本模块只做：单曲下发 + 控制 + 事件回流。
 */
import { NativeModules, DeviceEventEmitter, Platform } from 'react-native';

const M: any = NativeModules.RadioExoModule;

export interface ExoTrackItem {
  url: string;
  title: string;
  artist: string;
  album: string;
  art?: string;
}

/** 下发当前单曲并播放（media3 系统卡/锁屏/流体云由此驱动） */
export function exoPlayTrack(item: ExoTrackItem, positionSec: number, playing: boolean, headers?: Record<string, string>) {
  if (Platform.OS !== 'android' || !M?.playQueue) return;
  try {
    M.playQueue(JSON.stringify([item]), 0, Number(positionSec) || 0, playing, JSON.stringify(headers || {}));
  } catch {}
}

export function exoControl(cmd: 'pause' | 'resume' | 'seek' | 'stop' | 'next' | 'prev', positionSec = 0) {
  if (Platform.OS !== 'android' || !M?.control) return;
  try {
    if (cmd === 'next' || cmd === 'prev') {
      // next/prev 已由服务端拦截回调回 JS（本入口备用于内部调用）
      M.control(cmd, 0);
    } else {
      M.control(cmd, Number(positionSec) || 0);
    }
  } catch {}
}

/** 订阅事件：progress/ended/error/cmd */
export function subscribeExo(cb: (type: string, payload: any) => void): () => void {
  if (Platform.OS !== 'android') return () => {};
  const sub = DeviceEventEmitter.addListener('YayaExoEvent', (e: any) => {
    try {
      const type = String(e?.type || '');
      if (type) cb(type, e);
    } catch {}
  });
  return () => sub.remove();
}
