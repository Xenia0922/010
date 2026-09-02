package com.yk1z.yayamsg;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.annotation.Nullable;

/**
 * 后台播放前台保活服务（媒体样式通知）：
 * - 播放音乐/电台期间以「前台服务 + 通知」持有前台优先级与局部唤醒锁，防后台/锁屏被回收断音；
 * - 通知为 MediaStyle 媒体控制：播放/暂停、上一首、下一首、停止（可折叠显示），
 *   锁屏经 MediaSessionCompat 显示控制；按钮点击 → RadioMediaReceiver → JS 控制播放器。
 * - 播放器本体仍在 RN 进程（LiveExoView / RNV Video），本服务只负责保活与通知交互。
 */
public class RadioForegroundService extends Service {
  private static final String CHANNEL_ID = "yaya_radio";
  private static final int NOTIFICATION_ID = 2024;

  private PowerManager.WakeLock wakeLock;
  private MediaSessionCompat mediaSession;
  private String title = "";
  private boolean isPlaying = false;
  private long position = 0;
  private long duration = 0;

  @Override
  public void onCreate() {
    super.onCreate();
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    if (pm != null) {
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yaya:radio");
      wakeLock.setReferenceCounted(false);
    }
    mediaSession = new MediaSessionCompat(this, "yaya-media");
    mediaSession.setCallback(new MediaSessionCompat.Callback() {
      @Override
      public void onPlay() {
        RadioServiceModule.emitControl(getApplicationContext(), "play_pause");
      }
      @Override
      public void onPause() {
        RadioServiceModule.emitControl(getApplicationContext(), "play_pause");
      }
      @Override
      public void onSkipToNext() {
        RadioServiceModule.emitControl(getApplicationContext(), "next");
      }
      @Override
      public void onSkipToPrevious() {
        RadioServiceModule.emitControl(getApplicationContext(), "prev");
      }
    });
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null) {
      if (intent.hasExtra("title")) title = intent.getStringExtra("title") == null ? "" : intent.getStringExtra("title");
      if (intent.hasExtra("isPlaying")) isPlaying = intent.getBooleanExtra("isPlaying", false);
      if (intent.hasExtra("position")) position = (long) (intent.getDoubleExtra("position", 0) * 1000);
      if (intent.hasExtra("duration")) duration = (long) (intent.getDoubleExtra("duration", 0) * 1000);
    }
    startForeground(NOTIFICATION_ID, buildNotification());
    if (wakeLock != null && !wakeLock.isHeld()) {
      try {
        wakeLock.acquire();
      } catch (SecurityException ignored) {
      }
    }
    return START_NOT_STICKY;
  }

  private Notification buildNotification() {
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
      NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("播放音乐/电台时保持后台运行");
      nm.createNotificationChannel(channel);
    }
    String text = (title == null || title.isEmpty()) ? "牙牙消息 · 后台播放中" : "牙牙消息";

    // 点击通知 → 回到 App
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent contentPi = PendingIntent.getActivity(
        this, 0, open,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    // 媒体控制按钮：广播 → RadioMediaReceiver → JS
    PendingIntent prevPi = mediaPi(RadioMediaReceiver.ACTION_PREV, 10);
    PendingIntent playPausePi = mediaPi(isPlaying ? RadioMediaReceiver.ACTION_PLAY_PAUSE : RadioMediaReceiver.ACTION_PLAY_PAUSE, 11);
    PendingIntent nextPi = mediaPi(RadioMediaReceiver.ACTION_NEXT, 12);
    PendingIntent stopPi = mediaPi(RadioMediaReceiver.ACTION_STOP, 13);

    // MediaSession 播放状态：供锁屏展示进度/可拖拽（duration>0 时允许 seek）
    PlaybackStateCompat.Builder stateBuilder = new PlaybackStateCompat.Builder()
        .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            | (duration > 0 ? PlaybackStateCompat.ACTION_SEEK_TO : 0));
    stateBuilder.setState(
        isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
        position, 1.0f);
    mediaSession.setPlaybackState(stateBuilder.build());
    mediaSession.setActive(true);

    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL_ID)
        : new Notification.Builder(this);
    builder.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle((title == null || title.isEmpty()) ? "牙牙消息" : title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(contentPi)
        .setDeleteIntent(stopPi)
        .setMediaSession(mediaSession.getSessionToken())
        .addAction(android.R.drawable.ic_media_previous, "上一首", prevPi)
        .addAction(isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, isPlaying ? "暂停" : "播放", playPausePi)
        .addAction(android.R.drawable.ic_media_next, "下一首", nextPi)
        .setStyle(new android.app.Notification.MediaStyle()
            .setMediaSession(mediaSession.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2));
    return builder.build();
  }

  private PendingIntent mediaPi(String action, int requestCode) {
    Intent i = new Intent(this, RadioMediaReceiver.class).setAction(action);
    return PendingIntent.getBroadcast(this, requestCode, i,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  @Override
  public void onDestroy() {
    if (mediaSession != null) {
      mediaSession.setActive(false);
      mediaSession.release();
    }
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
