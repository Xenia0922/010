import React, { useEffect } from 'react';
import { BackHandler } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { usePlayerStore } from '../store/playerStore';
import { setLiveImmersiveMode } from '../../native/LivePlayer';
import { setPipPlaying } from '../../utils/pip';

/**
 * 唯一全屏/横屏/沉浸/PiP 管理器（重写核心）：
 * 替代现状 MediaScreen/BilibiliLiveScreen/FollowedRoomsScreen 三套独立实现。
 */
export function FullscreenManager() {
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const state = usePlayerStore((s) => s.state);
  const source = usePlayerStore((s) => s.source);

  // 全屏 ↔ 横屏 ↔ 沉浸式
  useEffect(() => {
    if (fullscreen) {
      setLiveImmersiveMode(true);
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    } else {
      setLiveImmersiveMode(false);
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    }
    return () => setLiveImmersiveMode(false);
  }, [fullscreen]);

  // PiP 标志：播放中且未全屏（App 切后台自动进系统悬浮窗）
  useEffect(() => {
    setPipPlaying(!!source?.url && state === 'playing' && !fullscreen);
  }, [source, state, fullscreen]);

  // 返回键：先退全屏，再关闭播放器（R4：优先调页面 onClose 清理播放器页状态，
  // 避免 VideoLibrary/Bilibili 等"黑屏需按两次返回"）
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const s = usePlayerStore.getState();
      if (!s.source) return false;
      if (s.fullscreen) {
        s.setFullscreen(false);
        return true;
      }
      if (s.onClose) {
        s.onClose();
      } else {
        s.close();
      }
      return true;
    });
    return () => sub.remove();
  }, []);

  return null;
}

/** 时间格式化 mm:ss / h:mm:ss */
export function formatPlayTime(t: number): string {
  const sec = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default FullscreenManager;
