import { create } from 'zustand';

/** 应用内悬浮小窗播放信息 */
export interface MiniPlayerInfo {
  url: string;
  title: string;
  cover?: string;
  isLive: boolean;
  /** 交棒给小窗时的播放位置（秒），小窗 onLoad 后 seek 续播 */
  position?: number;
  /** 公演/B站直播走网页内核播放（去 LIVE 标 + WebAudio 增益） */
  web?: { headers?: Record<string, string>; volumeBoost?: number };
  /** 点击小窗回放（全屏）参数：直接传回 MediaScreen 路由参数 */
  backTo: {
    mode: 'live' | 'vod';
    playUrl: string;
    playTitle?: string;
    playCover?: string;
    /** 小窗→大窗续播位置（仅录播；MediaScreen 直接按此 seek） */
    playPosition?: number;
  };
}

interface MiniPlayerState {
  info: MiniPlayerInfo | null;
  visible: boolean;
  playing: boolean;
  /** 小窗实时播放位置（秒）：点小窗回大窗时据此续播（大小窗切换不丢进度） */
  currentPos: number;
  /**
   * 系统 PiP ⏯ 点击触发序号：外部（PipToggleBridge）无法直接碰 MiniPlayer 的 WebView ref，
   * 只能经 store 发信号，MiniPlayer 组件监听序号变化后执行与点小窗暂停键相同的切换逻辑。
   */
  sysToggleSeq: number;
  open: (info: MiniPlayerInfo) => void;
  close: () => void;
  setPlaying: (p: boolean) => void;
  setCurrentPos: (p: number) => void;
  requestSysToggle: () => void;
}

export const useMiniPlayerStore = create<MiniPlayerState>((set) => ({
  info: null,
  visible: false,
  playing: true,
  currentPos: 0,
  sysToggleSeq: 0,
  open: (info) => set({ info, visible: true, playing: true, currentPos: 0 }),
  close: () => set({ visible: false, info: null, currentPos: 0 }),
  setPlaying: (playing) => set({ playing }),
  setCurrentPos: (currentPos) => set({ currentPos }),
  requestSysToggle: () => set((s) => ({ sysToggleSeq: s.sysToggleSeq + 1 })),
}));
