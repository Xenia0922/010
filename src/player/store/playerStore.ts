import { create } from 'zustand';
import { PlayerSource, PlayerMeta, DanmakuSource } from '../types';

/**
 * 全局播放器单例状态（重写核心）：
 * 统一管理 播放源/元数据/播放状态/进度/控制条显隐/全屏/内核切换，
 * 替代现状散落在 MediaScreen/BilibiliLiveScreen/FollowedRoomsScreen 的 local state。
 */
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

interface PlayerState {
  // 源与元数据
  source: PlayerSource | null;
  meta: PlayerMeta;
  danmaku: DanmakuSource;
  // 播放状态
  state: PlaybackState;
  position: number;
  duration: number;
  error: string;
  // 控制条 / 全屏 / 内核
  controlsVisible: boolean;
  fullscreen: boolean;
  useWebKernel: boolean;
  // 渲染内核（由 PlayerCore 上报）
  activeKernel: 'native' | 'exo' | 'web';
  // 画质（B站）
  qualityQn: number | null;
  /** seek 指令：UI 写入，PlayerCore 消费后清零（与音乐 store seekTarget 同模式） */
  seekTarget: number;
  /** 弹幕开关 */
  danmakuOn: boolean;

  // Actions
  open: (source: PlayerSource, meta?: PlayerMeta, danmaku?: DanmakuSource) => void;
  close: () => void;
  setState: (state: PlaybackState) => void;
  setPosition: (p: number) => void;
  setDuration: (d: number) => void;
  setError: (e: string) => void;
  clearError: () => void;
  toggleControls: (visible?: boolean) => void;
  setFullscreen: (v: boolean) => void;
  setUseWebKernel: (v: boolean) => void;
  setActiveKernel: (k: PlayerState['activeKernel']) => void;
  setQualityQn: (qn: number | null) => void;
  setSeekTarget: (t: number) => void;
  toggleDanmaku: () => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  source: null,
  meta: { title: '' },
  danmaku: { type: 'none' },
  state: 'idle',
  position: 0,
  duration: 0,
  error: '',
  controlsVisible: true,
  fullscreen: false,
  useWebKernel: false,
  activeKernel: 'native',
  qualityQn: null,
  seekTarget: 0,
  danmakuOn: true,

  open: (source, meta = { title: '' }, danmaku = { type: 'none' }) =>
    set({
      source,
      meta,
      danmaku,
      state: source.url ? 'loading' : 'idle',
      position: 0,
      duration: 0,
      error: '',
      controlsVisible: true,
      fullscreen: false,
      useWebKernel: false,
      activeKernel: source.needsNativeExo ? 'exo' : 'native',
      qualityQn: null,
      seekTarget: 0,
      danmakuOn: true,
    }),

  close: () =>
    set({
      source: null,
      meta: { title: '' },
      danmaku: { type: 'none' },
      state: 'idle',
      position: 0,
      duration: 0,
      error: '',
      fullscreen: false,
    }),

  setState: (state) => set({ state }),
  setPosition: (position) => set({ position }),
  setDuration: (duration) => set({ duration }),
  setError: (error) => set({ error, state: 'error' }),
  clearError: () => set({ error: '', state: 'loading' }),
  toggleControls: (visible) => set((s) => ({ controlsVisible: visible === undefined ? !s.controlsVisible : visible })),
  setFullscreen: (fullscreen) => set({ fullscreen }),
  setUseWebKernel: (useWebKernel) => set({ useWebKernel }),
  setActiveKernel: (activeKernel) => set({ activeKernel }),
  setQualityQn: (qualityQn) => set({ qualityQn }),
  setSeekTarget: (seekTarget) => set({ seekTarget }),
  toggleDanmaku: () => set((s) => ({ danmakuOn: !s.danmakuOn })),
}));

export default usePlayerStore;
