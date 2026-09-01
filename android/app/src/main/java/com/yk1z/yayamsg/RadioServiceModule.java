package com.yk1z.yayamsg;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.lang.ref.WeakReference;

/**
 * 电台前台保活服务桥：JS 侧开播/停播时启停 RadioForegroundService，
 * 通知栏「停止」→ RadioStopReceiver → 向 JS 发 RadioStopRequested 事件。
 */
public class RadioServiceModule extends ReactContextBaseJavaModule {
  private static WeakReference<ReactApplicationContext> contextRef;

  public RadioServiceModule(ReactApplicationContext reactContext) {
    super(reactContext);
    contextRef = new WeakReference<>(reactContext);
  }

  @NonNull
  @Override
  public String getName() {
    return "RadioServiceModule";
  }

  /** 通知栏「停止」被点击：通知 JS 停播（由 RadioStopReceiver 调用） */
  public static void emitStopRequested(Context context) {
    ReactApplicationContext reactContext = contextRef == null ? null : contextRef.get();
    if (reactContext == null || !reactContext.hasActiveCatalystInstance()) return;
    WritableMap payload = Arguments.createMap();
    reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
        .emit("RadioStopRequested", payload);
  }

  /** 开播：启动前台保活服务（幂等，重复调用仅更新通知文案） */
  @ReactMethod
  public void begin(String title) {
    ReactApplicationContext context = getReactApplicationContext();
    Intent intent = new Intent(context, RadioForegroundService.class);
    intent.putExtra("title", title == null ? "" : title);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(intent);
    } else {
      context.startService(intent);
    }
  }

  /** 停播：结束前台保活服务并移除通知 */
  @ReactMethod
  public void end() {
    ReactApplicationContext context = getReactApplicationContext();
    context.stopService(new Intent(context, RadioForegroundService.class));
  }
}