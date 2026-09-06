package com.yk1z.yayamsg;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
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
  // v2：渠道重要性 LOW→DEFAULT 后须换 ID（旧渠道被系统缓存不升级，ColorOS 仍按旧 LOW 折叠）
  private static final String CHANNEL_ID = "yaya_radio_v2";
  private static final int NOTIFICATION_ID = 2024;

  private PowerManager.WakeLock wakeLock;
  private MediaSession mediaSession;
  private String title = "";
  private String artist = "";
  private String album = "";
  private String lyric = "";
  private String coverUrl = "";
  private Bitmap coverBitmap = null;
  private Bitmap appIconBitmap = null;
  private boolean isPlaying = false;
  private long position = 0;
  private long duration = 0;
  private final ExecutorService coverLoader = Executors.newSingleThreadExecutor();
  // ---- 系统媒体控件（锁屏/厂商媒体中心）进度同步 ----
  // 系统 MediaStyle 模板的进度/时间来自 MediaSession 的 playbackState，需持续更新；
  // 本服务每秒本地推进 position 并只写 session state（不重建通知，开销小）。
  private final Handler progressHandler = new Handler(Looper.getMainLooper());
  private boolean tickerRunning = false;
  private long lastNotifyMs = 0;
  private final Runnable progressTicker = new Runnable() {
    @Override
    public void run() {
      if (isPlaying) {
        position += 500; // 500ms 步进
        pushSessionState(); // 先会话
        long now = System.currentTimeMillis();
        // 每 1s 重建通知（完整推送 metadata+MediaStyle token+art）：
        // ColorOS 疑似只重绘"最新一次完整通知+会话"（三星无需，OPPO 需要）
        if (now - lastNotifyMs >= 1000) {
          lastNotifyMs = now;
          try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
          } catch (Throwable ignored) {
          }
        }
      }
      if (isPlaying) progressHandler.postDelayed(this, 500);
      else tickerRunning = false;
    }
  };

  private void startTicker() {
    if (tickerRunning) return;
    tickerRunning = true;
    progressHandler.removeCallbacks(progressTicker);
    progressHandler.postDelayed(progressTicker, 1000);
  }

  private void stopTicker() {
    tickerRunning = false;
    progressHandler.removeCallbacks(progressTicker);
  }

  /** 只更新 session 播放状态（系统媒体条进度/锁屏时间据此走），不重建通知 */
  private void pushSessionState() {
    if (mediaSession == null) return;
    try {
      long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
          | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
          | (duration > 0 ? PlaybackState.ACTION_SEEK_TO : 0);
      PlaybackState state = new PlaybackState.Builder()
          .setActions(actions)
          .setState(isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
              position, 1.0f, System.currentTimeMillis())
          .build();
      mediaSession.setPlaybackState(state);
      mediaSession.setActive(true);
    } catch (Throwable ignored) {
    }
  }

  @Override
  public void onCreate() {
    super.onCreate();
    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
    if (pm != null) {
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yaya:radio");
      wakeLock.setReferenceCounted(false);
    }
    try {
      appIconBitmap = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
    } catch (Throwable ignored) {
    }
    mediaSession = new MediaSession(this, "yaya-radio");
    mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
    if (Build.VERSION.SDK_INT >= 21) {
      mediaSession.setPlaybackToLocal(new android.media.AudioAttributes.Builder()
          .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
          .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
          .build());
    }
    mediaSession.setCallback(new MediaSession.Callback() {
      @Override
      public void onPlay() {
        android.util.Log.i("YayaRadio", "[sysdbg] OLD session CMD onPlay");
        RadioServiceModule.emitControl(getApplicationContext(), "play");
      }
      @Override
      public void onPause() {
        android.util.Log.i("YayaRadio", "[sysdbg] OLD session CMD onPause");
        RadioServiceModule.emitControl(getApplicationContext(), "pause");
      }
      @Override
      public void onSkipToNext() {
        android.util.Log.i("YayaRadio", "[sysdbg] OLD session CMD next");
        RadioServiceModule.emitControl(getApplicationContext(), "next");
      }
      @Override
      public void onSkipToPrevious() {
        android.util.Log.i("YayaRadio", "[sysdbg] OLD session CMD prev");
        RadioServiceModule.emitControl(getApplicationContext(), "prev");
      }
      @Override
      public void onSeekTo(long pos) {
        android.util.Log.i("YayaRadio", "[sysdbg] OLD session CMD seek pos=" + pos);
        // 系统媒体条拖动：通知 JS seek（value=毫秒）
        RadioServiceModule.emitControlWithValue(getApplicationContext(), "seek", (double) pos);
      }
    });
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    // 高频真实进度：只同步位置到会话（跳过字段/通知重建，避免 500ms×startForeground 开销）
    if (intent != null && intent.getBooleanExtra("tickOnly", false)) {
      if (intent.hasExtra("position")) position = (long) (intent.getDoubleExtra("position", 0) * 1000);
      if (isPlaying) pushSessionState();
      return START_NOT_STICKY;
    }
    if (intent != null) {
      // ⚠️ startForegroundService 5s 契约：解析/封面 decode 可能耗时，先占位进前台
      // （旧实现解析完才 startForeground → buildNotification/解码慢或抛错即 RemoteServiceException 崩溃）
      try {
        if (Build.VERSION.SDK_INT >= 29) {
          startForeground(NOTIFICATION_ID, buildMinimalNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
          startForeground(NOTIFICATION_ID, buildMinimalNotification());
        }
      } catch (Throwable ignored) {}
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
          if (coverUrl.startsWith("file://")) {
            // 本地文件（RN 下载）：decodeFile 同步，最稳路径
            try {
              coverBitmap = BitmapFactory.decodeFile(coverUrl.replace("file://", ""));
            } catch (Throwable ignored) {
              coverBitmap = null;
            }
          } else if (coverUrl.startsWith("data:image")) {
            // dataURI 同步解码：buildNotification 当次即带封面（避免异步 renotify 时序/丢失）
            coverBitmap = decodeDataUri(coverUrl);
          } else {
            coverBitmap = null;
          }
          if (coverBitmap == null && !coverUrl.isEmpty()) loadCover(coverUrl);
        }
      }
    }
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
    } else {
      Log.i("RadioFg", "start: play=" + isPlaying + " posMs=" + position + " durMs=" + duration
        + " cover=" + (coverUrl == null || coverUrl.isEmpty() ? "EMPTY" : coverUrl)
        + " title=" + title + " art=" + (coverBitmap != null ? "Y" : "N"));
    startForeground(NOTIFICATION_ID, buildNotification());
    }
    if (wakeLock != null && !wakeLock.isHeld()) {
      try {
        wakeLock.acquire();
      } catch (SecurityException ignored) {
      }
    }
    return START_NOT_STICKY;
  }

  /** 5s 契约占位通知（无封面/歌词，最快构建） */
  private Notification buildMinimalNotification() {
    try {
      Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
          ? new Notification.Builder(this, CHANNEL_ID)
          : new Notification.Builder(this);
      b.setSmallIcon(R.mipmap.ic_launcher)
          .setContentTitle("牙牙消息")
          .setContentText("后台播放")
          .setCategory(Notification.CATEGORY_TRANSPORT)
          .setVisibility(Notification.VISIBILITY_PUBLIC)
          .setOngoing(true)
          .setOnlyAlertOnce(true);
      return b.build();
    } catch (Throwable t) {
      // channel 缺失等极端情况：给系统一个无渠道旧版通知仍满足契约
      try {
        return new Notification.Builder(this)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("牙牙消息").setContentText("后台播放").build();
      } catch (Throwable t2) {
        return null;
      }
    }
  }

  /** 后台下载封面图（4s 超时，失败静默保留无图态） */
  private void loadCover(final String url) {
    if (url == null || url.isEmpty()) return;
    coverLoader.execute(() -> {
      // data: URI（RN 侧已把图片拉成 base64，绕开 Java 网络在个别 ROM 被压制/失败的问题）
      if (url.startsWith("data:image")) {
        try {
          int comma = url.indexOf(',');
          String b64 = comma >= 0 ? url.substring(comma + 1) : url;
          byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
          BitmapFactory.Options opt = new BitmapFactory.Options();
          Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opt);
          if (bmp != null) {
            coverBitmap = bmp;
            Log.i("RadioFg", "cover OK dataURI " + bmp.getWidth() + "x" + bmp.getHeight());
            renotify();
            return;
          }
        } catch (Throwable t) {
          Log.i("RadioFg", "cover dataURI decode ERR " + (t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage()));
        }
        return;
      }
      // 独立三连试：原样 → 强制160 → 强制500（snh48 resize 仅部分规格存在；不因"已是 resize"跳过）
      String[] tries = { url, variantResize(url, "160x160"), variantResize(url, "500x500") };
      java.util.LinkedHashSet<String> uniq = new java.util.LinkedHashSet<>();
      for (String t : tries) if (t != null && !t.isEmpty()) uniq.add(t);
      for (String t : uniq) {
        if (tryLoadCoverOnce(t)) return;
      }
      Log.i("RadioFg", "cover ALL FAIL url=" + url);
    });
  }

  /** 生成指定尺寸缩略：替换已有 /resize_xxx/ 或插到路径首 */
  private String variantResize(String u, String size) {
    try {
      java.net.URI uri = new java.net.URI(u);
      String host = uri.getHost();
      String path = uri.getPath() == null ? "" : uri.getPath();
      String cleaned = path.replaceAll("/resize_[0-9]+x[0-9]+", "");
      String newPath = (cleaned.startsWith("/") ? "" : "/") + "resize_" + size + (cleaned.startsWith("/") ? cleaned : "/" + cleaned);
      return "https://" + host + newPath;
    } catch (Throwable t) {
      return u;
    }
  }

  /** 同步解码 data:image URI（RN 拉取→base64） */
  private Bitmap decodeDataUri(String u) {
    try {
      if (u == null || !u.startsWith("data:image")) return null;
      int comma = u.indexOf(',');
      String b64 = comma >= 0 ? u.substring(comma + 1) : u;
      byte[] bytes = null;
      int[] flags = { Base64.DEFAULT, Base64.NO_WRAP, Base64.NO_PADDING | Base64.NO_WRAP };
      for (int f : flags) {
        try {
          bytes = Base64.decode(b64, f);
          if (bytes != null && bytes.length > 0) break;
        } catch (Throwable ignored) {
        }
      }
      if (bytes == null || bytes.length == 0) return null;
      return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
    } catch (Throwable t) {
      return null;
    }
  }

  private byte[] readAll(InputStream is) throws java.io.IOException {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
    return out.toByteArray();
  }

  private boolean tryLoadCoverOnce(final String url) {
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
      if (code / 100 != 2) {
        Log.i("RadioFg", "cover http " + code + " " + url);
        return false;
      }
      // ⚠️ 同一条连接只读一次流（旧实现读两遍 → 第二遍为空 → 解码 null → OPPO 封面=logo）
      byte[] bytes = readAll(conn.getInputStream());
      if (bytes == null || bytes.length == 0) {
        Log.i("RadioFg", "cover empty body " + url);
        return false;
      }
      BitmapFactory.Options bounds = new BitmapFactory.Options();
      bounds.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
      BitmapFactory.Options opt = new BitmapFactory.Options();
      int longest = Math.max(bounds.outWidth, bounds.outHeight);
      opt.inSampleSize = longest > 1024
          ? (int) Math.pow(2, Math.ceil(Math.log(longest / 1024.0) / Math.log(2)))
          : 1;
      Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opt);
      if (bmp == null) {
        Log.i("RadioFg", "cover decode null: " + url);
        return false;
      }
      coverBitmap = bmp;
      Log.i("RadioFg", "cover OK " + url + " " + bmp.getWidth() + "x" + bmp.getHeight());
      renotify();
      return true;
    } catch (Throwable t) {
      Log.i("RadioFg", "cover ERR " + url);
      return false;
    } finally {
      if (conn != null) {
        try {
          conn.disconnect();
        } catch (Throwable ignored) {
        }
      }
    }
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
      // IMPORTANCE_DEFAULT：ColorOS 等把 LOW 当"不重要通知"折叠→不投喂媒体中心/锁屏
      // （MuMu/AOSP 无此问题，实测 session 正常；OPPO 需渠道够级别才显示媒体卡片）
      NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_DEFAULT);
      channel.setDescription("播放音乐/电台时保持后台运行");
      channel.setSound(null, null);
      channel.enableVibration(false);
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

    // MediaSession 元数据：标题/歌手/专辑/时长 + 封面（锁屏与各厂商媒体中心取封面/时间用）
    try {
      MediaMetadata.Builder md = new MediaMetadata.Builder();
      md.putString(MediaMetadata.METADATA_KEY_TITLE, (title == null || title.isEmpty()) ? "牙牙消息" : title);
      md.putString(MediaMetadata.METADATA_KEY_ARTIST, artist == null ? "" : artist);
      md.putString(MediaMetadata.METADATA_KEY_ALBUM, album == null ? "" : album);
      if (duration > 0) md.putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
      if (coverBitmap != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, coverBitmap);
      mediaSession.setMetadata(md.build());
    } catch (Throwable ignored) {
    }
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
    if (isPlaying) startTicker();
    else stopTicker();

    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(this, CHANNEL_ID)
        : new Notification.Builder(this);
    if (coverBitmap != null) {
      builder.setLargeIcon(coverBitmap);
    } else if (appIconBitmap != null) {
      builder.setLargeIcon(appIconBitmap); // 兜底：无封面也显示 app logo（免去系统色块）
    }
    builder.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle((title == null || title.isEmpty()) ? "牙牙消息" : title)
        .setContentText(text)
        .setCategory(Notification.CATEGORY_TRANSPORT)
        // 公开可见性：锁屏/安全锁下仍显示封面与控件（部分厂商默认 private 会藏内容→看似无封面/无进度）
        .setVisibility(Notification.VISIBILITY_PUBLIC)
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
        // 纯 MediaSession 路线：通知大视图只放封面/标题/歌词，进度完全走会话（ColorOS 忽略通知内 progress）
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
    stopTicker();
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
