package com.yk1z.yayamsg;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 媒体通知控制按钮（播放/暂停、上一首、下一首、停止）：
 * 将 action 转发给 JS（RadioControlRequested 事件）；stop 额外结束保活服务。
 */
public class RadioMediaReceiver extends BroadcastReceiver {
  public static final String ACTION_PLAY_PAUSE = "com.yk1z.yayamsg.MEDIA_PLAY_PAUSE";
  public static final String ACTION_PREV = "com.yk1z.yayamsg.MEDIA_PREV";
  public static final String ACTION_NEXT = "com.yk1z.yayamsg.MEDIA_NEXT";
  public static final String ACTION_STOP = "com.yk1z.yayamsg.MEDIA_STOP";

  @Override
  public void onReceive(Context context, Intent intent) {
    String action = intent == null ? "" : intent.getAction();
    if (ACTION_STOP.equals(action)) {
      RadioServiceModule.emitControl(context, "stop");
      context.stopService(new Intent(context, RadioForegroundService.class));
      return;
    }
    if (ACTION_PLAY_PAUSE.equals(action)) {
      RadioServiceModule.emitControl(context, "play_pause");
    } else if (ACTION_PREV.equals(action)) {
      RadioServiceModule.emitControl(context, "prev");
    } else if (ACTION_NEXT.equals(action)) {
      RadioServiceModule.emitControl(context, "next");
    }
  }
}
