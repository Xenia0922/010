package com.yk1z.yayamsg;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Rational;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * 画中画（悬浮窗）控制器。
 * RN 侧通过 NativeModules.PipController 调用：
 *  - setVideoPlaying(true/false)：标记当前是否有视频在播（MainActivity.onUserLeaveHint
 *    据此在用户切后台时自动进入画中画悬浮窗；没有视频在播则不打扰）
 *  - enterPip()：手动进入画中画（播放器控制条"小窗"按钮）
 *  - setVideoPlaying 同时驱动 PiP 窗口内自定义 ⏯ 按钮的图标与可用态：
 *    SystemUI 的 PiP 媒体按钮取自"活跃 MediaSession"——而视频播放器（RNV/Exo/WebView）
 *    从不注册会话，唯一会话是音乐服务 → PiP 控件曾误绑音乐。
 *    这里给 PiP 窗口挂上自己的 RemoteAction(播放/暂停)，点击经广播回 RN 由当前视频源消费，
 *    与音乐会话彻底解耦。按钮图标随播放态在 PiP 中即时刷新。
 */
public class PipModule extends ReactContextBaseJavaModule {
  /** RN 侧标记当前是否有视频在播：true 时切后台自动进 PiP */
  public static volatile boolean videoPlaying = false;
  /**
   * 系统小窗（PiP）总开关：RN 侧启动/设置页同步。false = 即使有视频在播，
   * MainActivity.onUserLeaveHint 也不自动进系统悬浮窗（用户未主动要小窗就不弹）。
   * 默认 false（不持久化：App 每次冷启由 JS 从设置 store 同步，早于任何 videoPlaying 置位）。
   */
  public static volatile boolean pipEnabled = false;
  /** PiP 窗口宽高比（跟随视频内容，默认 16:9；竖屏视频切后台悬浮窗也是竖的） */
  private static volatile float pipAspectW = 16f;
  private static volatile float pipAspectH = 9f;
  /** 点击 PiP ⏯ 的系统广播 action（动态注册，收到后回发 JS 事件） */
  public static final String ACTION_PIP_TOGGLE = "yaya.pip.toggle";
  /** RN 事件名：PiP ⏯ 被点（JS 侧 DeviceEventEmitter 订阅） */
  public static final String EVENT_PIP_TOGGLE = "PipToggleCmd";

  private static volatile ReactApplicationContext savedReactContext;
  private static volatile Context savedAppContext;
  private static final Handler main = new Handler(Looper.getMainLooper());
  private final BroadcastReceiver toggleReceiver = new BroadcastReceiver() {
    @Override public void onReceive(Context context, Intent intent) {
      emitToggleToJs();
    }
  };

  public PipModule(ReactApplicationContext reactContext) {
    super(reactContext);
    savedReactContext = reactContext;
    savedAppContext = reactContext.getApplicationContext();
  }

  @NonNull
  @Override
  public String getName() {
    return "PipController";
  }

  @Override
  public void initialize() {
    super.initialize();
    try {
      IntentFilter f = new IntentFilter(ACTION_PIP_TOGGLE);
      savedAppContext.registerReceiver(toggleReceiver, f);
    } catch (Throwable ignored) {
      // 已注册过/环境限制：静默
    }
  }

  @ReactMethod
  public void setVideoPlaying(boolean playing) {
    videoPlaying = playing;
    refreshPipActions();
  }

  /** 系统小窗总开关（设置页「小窗播放」/ 启动同步）：false 时 onUserLeaveHint 不自动进 PiP。
   *  ⚠️ 曾漏实现此方法：JS setPipEnabled 抛错被 catch，pipEnabled 恒 false → 真机开开关退出也不弹系统小窗。 */
  @ReactMethod
  public void setPipEnabled(boolean enabled) {
    pipEnabled = enabled;
  }

  @Override
  public void onCatalystInstanceDestroy() {
    try {
      if (savedAppContext != null) savedAppContext.unregisterReceiver(toggleReceiver);
    } catch (Throwable ignored) {}
    super.onCatalystInstanceDestroy();
  }

  /** 更新 PiP 窗口比例（RN 侧 onLoad 拿 naturalSize 后传入，竖屏内容竖屏悬浮窗） */
  @ReactMethod
  public void setAspectRatio(double w, double h) {
    if (w > 0 && h > 0) {
      pipAspectW = (float) w;
      pipAspectH = (float) h;
    }
  }

  /** 手动进入画中画（悬浮窗）：播放器控制条上的"小窗"按钮调用 */
  @ReactMethod
  public void enterPip() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    Activity activity = getCurrentActivity();
    if (activity == null || activity.isDestroyed() || activity.isInPictureInPictureMode()) return;
    try {
      activity.enterPictureInPictureMode(buildPipParams());
    } catch (Exception ignored) {
      // 部分 ROM 在转场等特定时刻调用会抛异常，静默忽略
    }
  }

  /** 播放/暂停态变化时刷新 PiP 内按钮：仅当已处于 PiP 中才有意义（无参重建 params 更新图标） */
  public static void refreshPipActions() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    if (savedReactContext == null) return;
    main.post(() -> {
      try {
        Activity activity = savedReactContext.getCurrentActivity();
        if (activity == null || activity.isDestroyed() || !activity.isInPictureInPictureMode()) return;
        activity.setPictureInPictureParams(buildPipParams());
      } catch (Throwable ignored) {
        // 刷新失败不影响播放
      }
    });
  }

  /** 构造 PiP 参数：宽高比 + （有视频在播时）播放/暂停 RemoteAction */
  public static PictureInPictureParams buildPipParams() {
    try {
      PictureInPictureParams.Builder b = new PictureInPictureParams.Builder()
          .setAspectRatio(new Rational(Math.round(pipAspectW), Math.round(pipAspectH)));
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        RemoteAction action = buildToggleAction();
        if (action != null) b.setActions(java.util.Collections.singletonList(action));
      }
      return b.build();
    } catch (Exception e) {
      return new PictureInPictureParams.Builder().build();
    }
  }

  /** PiP ⏯ RemoteAction：播放中显示「暂停」图标，暂停/无视频时显示「播放」图标（点击恒为 toggle） */
  private static RemoteAction buildToggleAction() {
    if (savedAppContext == null) return null;
    try {
      int iconRes = videoPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
      String label = videoPlaying ? "pause" : "play";
      Intent intent = new Intent(ACTION_PIP_TOGGLE).setPackage(savedAppContext.getPackageName());
      int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
      PendingIntent pi = PendingIntent.getBroadcast(savedAppContext, 1001, intent, flags);
      return new RemoteAction(Icon.createWithResource(savedAppContext, iconRes), label, label, pi);
    } catch (Throwable t) {
      return null;
    }
  }

  /** PiP ⏯ 被点：广播 → RN 事件（JS 侧决定切当前视频源的播放/暂停） */
  private static void emitToggleToJs() {
    if (savedReactContext == null) return;
    main.post(() -> {
      try {
        WritableMap m = Arguments.createMap();
        m.putBoolean("playing", videoPlaying);
        savedReactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(EVENT_PIP_TOGGLE, m);
      } catch (Throwable ignored) {
        // JS 侧未就绪/已卸载：按钮点击无效（Pip 模式下 JS 仍存活，正常可达）
      }
    });
  }
}
