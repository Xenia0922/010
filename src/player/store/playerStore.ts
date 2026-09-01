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
  /** 候选线路（播放失败时按序自动切换，source.url 指向当前线路） */
  candidateUrls: string[];
  candidateIndex: number;
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
  /** 播放失败时切到下一候选线路；返回是否切换成功（无候选/已到末尾 → false） */
  nextCandidate: () => boolean;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  source: null,
  meta: { title: '' },
  danmaku: { type: 'none' },
  candidateUrls: [],
  candidateIndex: 0,
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
    set((s) => {
      const urls = (source.urls && source.urls.length ? source.urls : [source.url]).filter(Boolean);
      return {
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
        candidateUrls: urls,
        candidateIndex: 0,
        ...(urls[0] && urls[0] !== source.url ? { source: { ...source, url: urls[0] } } : {}),
      };
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
  nextCandidate: () => {
    let switched = false;
    set((s) => {
      if (!s.source || s.candidateIndex + 1 >= s.candidateUrls.length) return {};
      const nextIdx = s.candidateIndex + 1;
      switched = true;
      return {
        candidateIndex: nextIdx,
        source: { ...s.source, url: s.candidateUrls[nextIdx] },
        state: 'loading',
        error: '',
        position: 0,
        duration: 0,
      };
    });
    return switched;
  },
}));

export default usePlayerStore;
