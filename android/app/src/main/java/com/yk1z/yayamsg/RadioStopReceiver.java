package com.yk1z.yayamsg;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 通知栏「停止」按钮：通知 JS 停播并结束电台保活服务 */
public class RadioStopReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    RadioServiceModule.emitStopRequested(context);
    Intent stop = new Intent(context, RadioForegroundService.class);
    context.stopService(stop);
  }
}