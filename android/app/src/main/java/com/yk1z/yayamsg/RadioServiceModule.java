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
 * 后台播放媒体通知桥（媒体样式通知）：
 * - begin/updateMedia：启动/更新 RadioForegroundService 的媒体通知（标题/封面/播放态/进度）
 * - 通知栏「播放暂停/上一首/下一首/停止」→ RadioMediaReceiver → 向 JS 发控制事件
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
    emitControl(context, "stop");
  }

  /** 媒体控制按钮被点击：通知 JS 执行对应动作（play_pause/prev/next/stop） */
  public static void emitControl(Context context, String action) {
    ReactApplicationContext reactContext = contextRef == null ? null : contextRef.get();
    if (reactContext == null || !reactContext.hasActiveCatalystInstance()) return;
    WritableMap payload = Arguments.createMap();
    payload.putString("action", action);
    reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
        .emit("RadioControlRequested", payload);
  }

  /** 开播/更新：启动前台保活服务并展示媒体通知（幂等，重复调用仅更新通知） */
  @ReactMethod
  public void updateMedia(String title, String cover, boolean isPlaying, double position, double duration) {
    updateMediaEx(title, cover, "", "", isPlaying, position, duration);
  }

  /**
   * 完整元数据更新：标题/封面/歌手/专辑 + 播放态与进度。
   * JS 桥 startRadioForeground 的音乐调用走本方法（歌词另有 updateLyric 高频通道）。
   */
  @ReactMethod
  public void updateMediaEx(String title, String cover, String artist, String album, boolean isPlaying, double position, double duration) {
    ReactApplicationContext context = getReactApplicationContext();
    Intent intent = new Intent(context, RadioForegroundService.class);
    intent.putExtra("title", title == null ? "" : title);
    intent.putExtra("cover", cover == null ? "" : cover);
    intent.putExtra("artist", artist == null ? "" : artist);
    intent.putExtra("album", album == null ? "" : album);
    intent.putExtra("isPlaying", isPlaying);
    intent.putExtra("position", position);
    intent.putExtra("duration", duration);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(intent);
    } else {
      context.startService(intent);
    }
  }

  /** 歌词行更新：更新通知展开区歌词文本并重发通知（行切换才调用，频率极低） */
  @ReactMethod
  public void updateLyric(String text) {
    ReactApplicationContext context = getReactApplicationContext();
    Intent intent = new Intent(context, RadioForegroundService.class);
    intent.putExtra("lyric", text == null ? "" : text);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(intent);
    } else {
      context.startService(intent);
    }
  }

  /** 兼容旧调用：仅更新标题 */
  @ReactMethod
  public void begin(String title) {
    updateMedia(title, "", false, 0, 0);
  }

  /** 停播：结束前台保活服务并移除通知 */
  @ReactMethod
  public void end() {
    ReactApplicationContext context = getReactApplicationContext();
    context.stopService(new Intent(context, RadioForegroundService.class));
  }
}
