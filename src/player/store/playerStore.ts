import { create } from 'zustand';
import { PlayerSource, PlayerMeta, DanmakuSource } from '../types';
// 播放互斥（单向）：playerStore 开播(直播/录播/视频/电台经此)时暂停后台音乐；
// 反向（音乐开播停 playerStore 媒体）在 MusicEngine.playTrack/resume 内处理。
import { useMusicPlayerStore } from '../../store/musicPlayerStore';

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
  /** 本次开播是否因「公演默认网页」自动进入 web：web 失败时回退原生一次（防整场看不了） */
  forceWebOnce: boolean;
  // 渲染内核（由 PlayerCore 上报）
  activeKernel: 'native' | 'exo' | 'web';
  // 画质（B站）
  qualityQn: number | null;
  /** 播放倍速（回放可用；live 恒 1） */
  rate: number;
  /** 画面旋转角度（桌面对齐：90° 步进，竖屏视频旋转用） */
  rotateDeg: number;
  /** 镜像模式：none/horizontal/vertical */
  mirrorMode: 'none' | 'horizontal' | 'vertical';
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
  setForceWebOnce: (v: boolean) => void;
  setActiveKernel: (k: PlayerState['activeKernel']) => void;
  setQualityQn: (qn: number | null) => void;
  setRate: (r: number) => void;
  setRotateDeg: (deg: number) => void;
  setMirrorMode: (m: 'none' | 'horizontal' | 'vertical') => void;
  setSeekTarget: (t: number) => void;
  toggleDanmaku: () => void;
  /** 播放失败时切到下一候选线路；返回是否切换成功（无候选/已到末尾 → false） */
  nextCandidate: () => boolean;
  /** 页面级 onClose 回调（PlayerScreen 挂载时注册；返回键/关闭时先调用它清理页面状态） */
  onClose: (() => void) | null;
  setOnClose: (fn: (() => void) | null) => void;
}

/**
 * rtmp/rtmps/.flv 是 Exo(LiveExoView) 专属流：即使页面漏传 needsNativeExo 也必须走 exo，
 * 否则误进 RNV vod 内核 → 直播卡首帧 + 拖动进度条 seek 直播流 → 原生闪退。
 */
function kernelForSource(source: PlayerSource): 'exo' | 'native' {
  const u = String((source && source.url) || '').toLowerCase();
  if (source?.needsNativeExo) return 'exo';
  if (u.startsWith('rtmp://') || u.startsWith('rtmps://')) return 'exo';
  if (u.includes('.flv')) return 'exo';
  return 'native';
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  onClose: null,
  setOnClose: (fn) => set({ onClose: fn }),
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
  forceWebOnce: false,
  activeKernel: 'native',
  qualityQn: null,
  rate: 1,
  rotateDeg: 0,
  mirrorMode: 'none' as const,
  seekTarget: 0,
  danmakuOn: true,

  open: (source, meta = { title: '' }, danmaku = { type: 'none' }) => {
    // 播放互斥：后播者胜 —— 直播/录播/电台/视频开播时，后台音乐自动暂停（可再点回播放）
    try {
      const mst = useMusicPlayerStore.getState();
      if (mst.queue.length && (mst.playbackState === 'playing' || mst.playbackState === 'paused')) {
        mst.setPlaybackState('paused'); // → MusicLibrary 351 effect exoControl pause + 通知转暂停
      }
    } catch {}
    return set((s) => {
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
        forceWebOnce: false,
        activeKernel: kernelForSource(source),
        qualityQn: null,
        rate: 1,
        rotateDeg: 0,
        mirrorMode: 'none' as const,
        seekTarget: 0,
        danmakuOn: true,
        candidateUrls: urls,
        candidateIndex: 0,
        ...(urls[0] && urls[0] !== source.url ? { source: { ...source, url: urls[0] } } : {}),
      };
    });
  },

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
  setForceWebOnce: (forceWebOnce) => set({ forceWebOnce }),
  setActiveKernel: (activeKernel) => set({ activeKernel }),
  setQualityQn: (qualityQn) => set({ qualityQn }),
  setRate: (rate) => set({ rate }),
  setRotateDeg: (rotateDeg) => set({ rotateDeg: ((rotateDeg % 360) + 360) % 360 }),
  setMirrorMode: (mirrorMode) => set({ mirrorMode }),
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
