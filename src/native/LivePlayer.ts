import { DeviceEventEmitter, NativeModules, Platform, requireNativeComponent, ViewProps } from 'react-native';
import { t } from '../i18n';

const { LivePlayerModule, RadioServiceModule } = NativeModules;

export interface LivePlayerOptions {
  liveId?: string;
  acceptUserId?: string;
  urls?: string[];
}

export function openNativeLivePlayer(url: string, title: string, options: LivePlayerOptions = {}) {
  if (Platform.OS !== 'android' || !LivePlayerModule?.open) {
    throw new Error('Android native live player is not available');
  }
  LivePlayerModule.open(url.trim(), title || 'Pocket48 Live', {
    ...options,
    labels: {
      back: t('返回'),
      rotate: t('横屏'),
      refresh: t('刷新'),
      gift: t('礼物'),
      failTitle: t('直播播放失败'),
      retry: t('重试'),
      close: t('关闭'),
      giftHintTitle: t('提示'),
      giftHintMsg: t('缺少 liveId，无法打开礼物面板'),
      giftOk: t('确定'),
    },
  });
}

export function setLiveImmersiveMode(enabled: boolean) {
  if (Platform.OS === 'android' && LivePlayerModule?.setImmersive) {
    LivePlayerModule.setImmersive(enabled);
  }
}

/** onSize 事件负载：视频实际宽高（小窗据此适配横竖屏容器） */
export interface LiveSizeEventData {
  width: number;
  height: number;
}

export const LiveExoView = Platform.OS === 'android'
  ? requireNativeComponent<ViewProps & {
      url: string;
      /** 纯音频模式：不渲染视频画面，仅解码音频（上麦/电台流） */
      audioOnly?: boolean;
      /** 暂停/恢复（原生 Exo 播放控制，统一播放器控制条使用） */
      paused?: boolean;
      onSize?: (e: { nativeEvent: LiveSizeEventData }) => void;
      /** 原生重试耗尽后回调：播放失败/断流（message 为失败原因） */
      onError?: (e: { nativeEvent: { message: string } }) => void;
    }>('LiveExoView')
  : null;

/** 媒体通知数据（MediaStyle：标题/封面/歌手/专辑/歌词/播放态/进度） */
export interface RadioMediaInfo {
  title: string;
  cover?: string;
  /** 歌手/团体（通知副标题第一段） */
  artist?: string;
  /** 专辑名（通知副标题第二段） */
  album?: string;
  /** 当前歌词行（展开通知显示；行变化用 updateRadioLyric 独立高频通道） */
  lyric?: string;
  isPlaying: boolean;
  position?: number;
  duration?: number;
}

/** 开播/更新媒体通知：启动前台保活服务（MediaStyle 通知栏控制 + WAKE_LOCK，后台/锁屏续播） */
/** 高频真实进度同步（仅位置；服务端不重建通知） */
export function syncRadioPosition(positionSec: number) {
  if (Platform.OS !== 'android') return;
  try {
    (RadioServiceModule as any).syncPosition(Number(positionSec) || 0);
  } catch {}
}

export function startRadioForeground(info: string | RadioMediaInfo) {
  if (Platform.OS !== 'android' || !RadioServiceModule?.updateMedia) return;
  if (typeof info === 'string') {
    RadioServiceModule.updateMedia(info, '', false, 0, 0);
    return;
  }
  const fn = RadioServiceModule.updateMediaEx || RadioServiceModule.updateMedia;
  fn(
    info.title || '',
    info.cover || '',
    info.artist || '',
    info.album || '',
    !!info.isPlaying,
    Number(info.position) || 0,
    Number(info.duration) || 0,
  );
}

/**
 * 歌词行更新（通知展开区歌词随播放滚动）。
 * 独立于 5s 节流的元数据通道：只在歌词行切换时调用（每秒最多几次，开销极小）。
 */
export function updateRadioLyric(text: string) {
  if (Platform.OS !== 'android' || !RadioServiceModule?.updateLyric) return;
  RadioServiceModule.updateLyric(String(text || ''));
}

/** 停播电台：结束前台保活服务并移除通知 */
export function stopRadioForeground() {
  if (Platform.OS === 'android' && RadioServiceModule?.end) {
    RadioServiceModule.end();
  }
}

/** 通知栏「停止」回调：返回解绑函数 */
export function onRadioStopRequested(cb: () => void): () => void {
  if (Platform.OS !== 'android') return () => {};
  const sub = DeviceEventEmitter.addListener('RadioStopRequested', cb);
  return () => sub.remove();
}

/** 媒体通知控制回调（播放/暂停、上一首、下一首、停止）：返回解绑函数 */
export function onRadioControlRequested(cb: (action: 'play' | 'pause' | 'play_pause' | 'prev' | 'next' | 'stop' | 'seek', value?: number) => void): () => void {
  if (Platform.OS !== 'android') return () => {};
  const sub = DeviceEventEmitter.addListener('RadioControlRequested', (e: any) => {
    const a = String(e?.action || '');
    if (a === 'play' || a === 'pause' || a === 'play_pause' || a === 'prev' || a === 'next' || a === 'stop' || a === 'seek') {
      cb(a as any, Number(e?.value) || 0);
    }
  });
  return () => sub.remove();
}