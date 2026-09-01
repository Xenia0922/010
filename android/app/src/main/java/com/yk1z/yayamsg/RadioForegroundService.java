package com.yk1z.yayamsg;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;

/**
 * 电台前台保活服务（纯音频模式配套）：
 * 播放上麦/电台语音期间以「前台服务 + 通知」持有前台优先级与局部唤醒锁，
 * 避免后台/锁屏时进程被系统回收导致断音。
 * 播放器本体仍在 RN 进程的 LiveExoView（ExoPlayer）中，本服务只负责保活与通知交互；
 * 通知「停止」按钮 → RadioStopReceiver → JS 收到 RadioStopRequested 事件后停播。
 */
public class RadioForegroundService extends Service {
  private static final String CHANNEL_ID = "yaya_radio";
  private static final int NOTIFICATION_ID = 2024;

  private PowerManager.WakeLock wakeLock;
  private String title = "";

  @Override
  public void onCreate() {
    super.onCreate();
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    if (pm != null) {
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yaya:radio");
      wakeLock.setReferenceCounted(false);
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && intent.hasExtra("title")) {
      title = intent.getStringExtra("title") == null ? "" : intent.getStringExtra("title");
    }
    startForeground(NOTIFICATION_ID, buildNotification(title));
    if (wakeLock != null && !wakeLock.isHeld()) {
      try {
        wakeLock.acquire();
      } catch (SecurityException ignored) {
        // 极端情况下无 WAKE_LOCK 权限也不阻断前台通知
      }
    }
    return START_NOT_STICKY;
  }

  private Notification buildNotification(String radioTitle) {
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
      NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("播放音乐/电台时保持后台运行");
      nm.createNotificationChannel(channel);
    }
    String text = (radioTitle == null || radioTitle.isEmpty())
        ? "后台播放中"
        : "正在播放 " + radioTitle;

    // 点击通知 → 回到 App
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent contentPi = PendingIntent.getActivity(
        this, 0, open,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    // 通知「停止」→ 广播给 JS 停播并结束保活服务
    Intent stopIntent = new Intent(this, RadioStopReceiver.class);
    PendingIntent stopPi = PendingIntent.getBroadcast(
        this, 1, stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL_ID)
        : new Notification.Builder(this);
    builder.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("牙牙消息")
        .setContentText(text)
        .setOngoing(true)
        .setContentIntent(contentPi)
        .addAction(0, "停止", stopPi);
    return builder.build();
  }

  @Override
  public void onDestroy() {
    if (wakeLock != null && wakeLock.isHeld()) {
      try {
        wakeLock.release();
      } catch (Throwable ignored) {
      }
    }
    super.onDestroy();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}