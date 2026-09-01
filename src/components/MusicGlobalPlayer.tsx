import React from 'react';
import { useMusicPlayerStore } from '../store/musicPlayerStore';
import MiniPlayerBar from './MiniPlayerBar';
import FullScreenPlayer from './FullScreenPlayer';

/**
 * 音乐全局播放器挂载（B1 修复）：迷你条 + 全屏播放器挂到导航层，
 * 任何页面听歌都有控制条（此前仅音乐库页挂载，切页即消失）。
 * 全屏显隐由 musicPlayerStore.fullscreenVisible 全局管理。
 */
export function MusicGlobalPlayer() {
  const fullscreenVisible = useMusicPlayerStore((s) => s.fullscreenVisible);
  const setFullscreenVisible = useMusicPlayerStore((s) => s.setFullscreenVisible);
  return (
    <>
      <MiniPlayerBar onOpenFullScreen={() => setFullscreenVisible(true)} />
      <FullScreenPlayer visible={fullscreenVisible} onClose={() => setFullscreenVisible(false)} />
    </>
  );
}

export default MusicGlobalPlayer;
