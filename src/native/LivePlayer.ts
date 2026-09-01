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
      onSize?: (e: { nativeEvent: LiveSizeEventData }) => void;
      /** 原生重试耗尽后回调：播放失败/断流（message 为失败原因） */
      onError?: (e: { nativeEvent: { message: string } }) => void;
    }>('LiveExoView')
  : null;

/** 开播电台：启动前台保活服务（通知栏 + WAKE_LOCK，后台/锁屏续播） */
export function startRadioForeground(title: string) {
  if (Platform.OS === 'android' && RadioServiceModule?.begin) {
    RadioServiceModule.begin(title || '');
  }
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