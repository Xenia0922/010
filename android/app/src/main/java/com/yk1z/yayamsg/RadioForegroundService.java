package com.yk1z.yayamsg;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.widget.RemoteViews;

import androidx.annotation.Nullable;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
  private MediaSession mediaSession;
  private String title = "";
  private String artist = "";
  private String album = "";
  private String lyric = "";
  private String coverUrl = "";
  private Bitmap coverBitmap = null;
  private boolean isPlaying = false;
  private long position = 0;
  private long duration = 0;
  private final ExecutorService coverLoader = Executors.newSingleThreadExecutor();

  @Override
  public void onCreate() {
    super.onCreate();
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    if (pm != null) {
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yaya:radio");
      wakeLock.setReferenceCounted(false);
    }
    mediaSession = new MediaSession(this, "yaya-media");
    mediaSession.setCallback(new MediaSession.Callback() {
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
      if (intent.hasExtra("artist")) artist = intent.getStringExtra("artist") == null ? "" : intent.getStringExtra("artist");
      if (intent.hasExtra("album")) album = intent.getStringExtra("album") == null ? "" : intent.getStringExtra("album");
      if (intent.hasExtra("lyric")) lyric = intent.getStringExtra("lyric") == null ? "" : intent.getStringExtra("lyric");
      if (intent.hasExtra("isPlaying")) isPlaying = intent.getBooleanExtra("isPlaying", false);
      if (intent.hasExtra("position")) position = (long) (intent.getDoubleExtra("position", 0) * 1000);
      if (intent.hasExtra("duration")) duration = (long) (intent.getDoubleExtra("duration", 0) * 1000);
      if (intent.hasExtra("cover")) {
        String nextCover = intent.getStringExtra("cover") == null ? "" : intent.getStringExtra("cover");
        if (!nextCover.equals(coverUrl)) {
          coverUrl = nextCover;
          coverBitmap = null; // 换歌/换封面：清旧图（buildNotification 会先无图刷新一次）
          loadCover(coverUrl);
        }
      }
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

  /** 后台下载封面图（4s 超时，失败静默保留无图态） */
  private void loadCover(final String url) {
    if (url == null || url.isEmpty()) return;
    coverLoader.execute(() -> {
      HttpURLConnection conn = null;
      try {
        URL u = new URL(url);
        conn = (HttpURLConnection) u.openConnection();
        conn.setConnectTimeout(4000);
        conn.setReadTimeout(6000);
        conn.setRequestProperty("User-Agent", "PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)");
        conn.setRequestProperty("Referer", "https://h5.48.cn/");
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("Accept", "image/*");
        int code = conn.getResponseCode();
        if (code / 100 != 2) return;
        Bitmap bmp;
        try (InputStream is = conn.getInputStream()) {
          BitmapFactory.Options opt = new BitmapFactory.Options();
          opt.inSampleSize = 2; // 通知小图 256 内，减半解码省内存
          bmp = BitmapFactory.decodeStream(is, null, opt);
        }
        if (bmp == null) return;
        coverBitmap = bmp;
        renotify();
      } catch (Throwable ignored) {
      } finally {
        if (conn != null) {
          try {
            conn.disconnect();
          } catch (Throwable ignored) {
          }
        }
      }
    });
  }

  /** 封面加载完成 / 歌词行变化：重发当前通知（前台服务幂等） */
  private void renotify() {
    try {
      NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
      if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
    } catch (Throwable ignored) {
    }
  }

  private Notification buildNotification() {
    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
      NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("播放音乐/电台时保持后台运行");
      nm.createNotificationChannel(channel);
    }
    String subLine = String.format("%s%s%s",
        artist == null || artist.isEmpty() ? "" : artist,
        (artist != null && !artist.isEmpty() && album != null && !album.isEmpty()) ? " · " : "",
        album == null || album.isEmpty() ? "" : album).trim();
    String text = subLine.isEmpty() ? "牙牙消息" : subLine;

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
    long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
        | (duration > 0 ? PlaybackState.ACTION_SEEK_TO : 0);
    PlaybackState playbackState = new PlaybackState.Builder()
        .setActions(actions)
        .setState(
            isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
            position, 1.0f, System.currentTimeMillis())
        .build();
    mediaSession.setPlaybackState(playbackState);
    mediaSession.setActive(true);

    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL_ID)
        : new Notification.Builder(this);
    if (coverBitmap != null) {
      builder.setLargeIcon(coverBitmap);
    }
    builder.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle((title == null || title.isEmpty()) ? "牙牙消息" : title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(contentPi)
        .setDeleteIntent(stopPi)
        .addAction(android.R.drawable.ic_media_previous, "上一首", prevPi)
        .addAction(isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, isPlaying ? "暂停" : "播放", playPausePi)
        .addAction(android.R.drawable.ic_media_next, "下一首", nextPi)
        .setStyle(new android.app.Notification.MediaStyle()
            .setMediaSession(mediaSession.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2));
    // 展开视图：封面 + 标题 + 歌手·专辑 + 滚动歌词（音乐场景；电台无歌词不发以免空布局）
    boolean hasMusicMeta = (lyric != null && !lyric.isEmpty())
        || (subLine != null && !subLine.isEmpty() && !"牙牙消息".equals(subLine));
    if (hasMusicMeta) {
      try {
        RemoteViews big = new RemoteViews(getPackageName(), R.layout.notification_media);
        big.setTextViewText(R.id.mc_title, (title == null || title.isEmpty()) ? "牙牙消息" : title);
        big.setTextViewText(R.id.mc_sub, subLine);
        big.setTextViewText(R.id.mc_lyric, (lyric == null || lyric.isEmpty()) ? "♪" : "♪ " + lyric);
        if (coverBitmap != null) {
          big.setImageViewBitmap(R.id.mc_art, coverBitmap);
        } else {
          big.setViewVisibility(R.id.mc_art, android.view.View.GONE);
        }
        builder.setCustomBigContentView(big);
      } catch (Throwable ignored) {
      }
    }
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
    coverLoader.shutdownNow();
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
