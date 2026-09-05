package com.yk1z.yayamsg;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * framework MediaSession 的媒体键接收标记（ColorOS 命令入口）。
 * 真正的按键处理由 MediaSession.Callback（onPlay/onPause/onSkip…）完成，
 * 本 receiver 仅让系统把本应用判为“可处理媒体键”并把按键路由到 yaya-media 会话。
 */
public class MediaButtonProxyReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    // 无需额外处理：framework 已把媒体键派发到带 MediaButtonReceiver 的会话
  }
}
