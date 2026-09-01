/** 流分类（对应 FollowedRooms classifyMedia 全量规则） */
export type StreamKind = 'live' | 'vod' | 'audio' | 'image' | 'link';

/** 播放源：页面只需声明「播什么」，内核路由由 PlayerCore 决定 */
export interface PlayerSource {
  kind: StreamKind;
  /** 当前播放 URL */
  url: string;
  /** 候选地址（内核切换/失败重试时按序尝试） */
  urls?: string[];
  /** 防盗链头（UA/Referer/Origin/Cookie） */
  headers?: Record<string, string>;
  liveId?: string;
  /** rtmp/flv → 强制原生 ExoKernel（LiveExoView） */
  needsNativeExo?: boolean;
  /** 纯音频渲染（房间语音/上麦/电台） */
  audioOnly?: boolean;
}

export interface PlayerMeta {
  title: string;
  cover?: string;
}

/** 弹幕源（三引擎统一）：poll=口袋直播 HTTP 轮询；lrc=录播 LRC 文件；ws=B站 WebSocket */
export type DanmakuSource =
  | { type: 'none' }
  | { type: 'poll'; liveId: string }
  | { type: 'lrc'; lrcUrl: string; liveId?: string }
  | { type: 'ws'; roomId: string };

/** 功能开关：页面声明需要哪些能力，PlayerChrome 按需渲染 */
export interface PlayerFeatures {
  /** 倍速（1/1.5/2） */
  rate?: boolean;
  /** 弹幕开关 + 弹幕设置 */
  danmaku?: boolean;
  /** 直播送礼面板（口袋） */
  gift?: boolean;
  /** 贡献榜（口袋） */
  rank?: boolean;
  /** 画质切换（B站） */
  quality?: boolean;
  /** 续播记忆 */
  resume?: boolean;
  /** 内核互切（原生 <-> 网页） */
  kernelSwitch?: boolean;
}

export interface PlayerScreenProps {
  source: PlayerSource;
  meta: PlayerMeta;
  danmaku?: DanmakuSource;
  features?: PlayerFeatures;
  /** 底部控制坞额外动作（礼物/贡献榜等由外部实现） */
  extraActions?: Array<{
    key: string;
    icon: string;
    label: string;
    active?: boolean;
    onPress: () => void;
  }>;
  onClose?: () => void;
}
