/**
 * 统一播放器（重写）：
 * 页面只需声明「播什么、带哪些功能」，内核路由/控制层/全屏/续播/内核切换内部完成。
 *
 * 分层：
 *  - resolve/streamResolver：统一流判定（分类/候选提取/内核选择/防盗链头）—— 兼容矩阵见分析文档 3.5
 *  - store/playerStore：全局单例状态
 *  - core/PlayerCore：内核路由（Native=RNV / Exo=LiveExoView / Web=flv.js+hls.js）
 *  - chrome/PlayerChrome + FullscreenManager：唯一控制层与全屏/PiP 管理
 *  - PlayerScreen：组装入口
 */
export { PlayerScreen } from './PlayerScreen';
export { default as usePlayerStore } from './store/playerStore';
export { PlayerCore } from './core/PlayerCore';
export { PlayerChrome } from './chrome/PlayerChrome';
export { FullscreenManager, formatPlayTime } from './chrome/FullscreenManager';
export { default as streamResolver } from './resolve/streamResolver';
export {
  classifyUrl,
  streamScore,
  pickPlayableUrls,
  needsNativeExo,
  isLiveStreamUrl,
  isPlayableMediaUrl,
  buildPocketHeaders,
  resolveSource,
} from './resolve/streamResolver';
export type {
  StreamKind,
  PlayerSource,
  PlayerMeta,
  DanmakuSource,
  PlayerFeatures,
  PlayerScreenProps,
} from './types';

export { default } from './PlayerScreen';
