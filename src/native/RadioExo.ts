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
  /** 封面：优先 file://（RN 下载落盘，OPPO 可靠）；http(s) 原生会尝试自拉 */
  art?: string;
}

/** 下发当前单曲并播放（media3 系统卡/锁屏/流体云由此驱动） */
export function exoPlayTrack(
  item: ExoTrackItem,
  positionSec: number,
  playing: boolean,
  headers?: Record<string, string>,
  volume = 1.0,
  repeat = 0,
) {
  if (Platform.OS !== 'android' || !M?.playQueue) return;
  try {
    M.playQueue(JSON.stringify([item]), 0, Number(positionSec) || 0, !!playing, JSON.stringify(headers || {}), Number(volume) || 0, repeat ? 1 : 0);
  } catch {}
}

export function exoControl(cmd: 'pause' | 'resume' | 'seek' | 'stop' | 'next' | 'prev' | 'repeat', positionSec = 0) {
  if (Platform.OS !== 'android' || !M?.control) return;
  try {
    M.control(cmd, Number(positionSec) || 0);
  } catch {}
}

// 原生 Exo 激活标记：激活后旧的自管 MediaSession 服务必须停（避免双会话，ColorOS 绑定旧的→依旧不刷新）
// ⚠️ 模块级裸变量：JS reload 会失步。但原生 poller 持续推 progress → 收到 progress&&playing 即自愈重新激活。
let nativeExoActive = false;
export const setNativeExoActive = (v: boolean) => { nativeExoActive = v; };
export const isNativeExoActive = () => nativeExoActive;

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
