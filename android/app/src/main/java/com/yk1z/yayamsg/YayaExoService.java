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
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 原生 ExoPlayer + 单一 framework MediaSession（OPPO/ColorOS 终版，2026-09-05）。
 *
 * 调试结论（PJZ110 实测多轮）：
 *  - media3 MediaSessionService 会话：系统卡能渲染进度条，但 ColorOS 对 PLAY_PAUSE 命令不路由；
 *  - framework android.media.session.MediaSession：全部命令可达（暂停/播放/seek/切歌），
 *    但 ColorOS 卡单独靠 pushState 不刷新 —— 需「每秒重建带 MediaStyle + token 的完整通知」助推
 *    （main 版 RadioForegroundService 验证过的 ColorOS workaround）。
 *  - 双会话并存 = 命令随机路由、两卡互抢 → 禁止（19:33 实测“像在打架”）。
 *
 * 因此收敛为单一 framework 会话：命令直达 ExoPlayer（即时生效），进度/状态 500ms 推 session +
 * 每秒重建 MediaStyle 通知助推卡刷新；上一首/下一首拦截回 JS 引擎（队列/模式/URL 在 JS）。
 */
public class YayaExoService extends Service {
  public static final String ACTION_PLAY_QUEUE = "yaya.exo.play_queue";
  private static final String CHANNEL_ID = "yaya_radio_v3";
  private static final int NOTIFICATION_ID = 2024;
  private static final Handler h = new Handler(Looper.getMainLooper());

  private final Map<String, String> currentHeaders = new HashMap<>();
  private ExoPlayer exo;
  private MediaSession session;              // framework MediaSession（唯一会话）
  private boolean pollRunning = false;
  private int currentRepeat = Player.REPEAT_MODE_OFF;
  private long lastNotifyMs = 0;
  // 元数据（来自 playQueue JSON）
  private String title = "";
  private String artist = "";
  private String album = "";
  private String artPath = "";
  private Bitmap artBitmap;

  private final Runnable progressPoller = new Runnable() {
    @Override public void run() {
      emitProgress();
      pushState(); // framework 会话（真实位置）
      // ColorOS workaround：每秒重建 MediaStyle 完整通知（疑仅重绘最近一次完整通知）
      long now = System.currentTimeMillis();
      if (now - lastNotifyMs >= 1000) {
        lastNotifyMs = now;
        try {
          NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
          if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
        } catch (Throwable ignored) {}
      }
      h.postDelayed(this, 500);
    }
  };

  private final Player.Listener playerListener = new Player.Listener() {
    @Override public void onPlaybackStateChanged(int state) {
      if (state == Player.STATE_ENDED) {
        // 播完 → JS 引擎切下一首（单曲循环 REPEAT_MODE_ONE 不会到这）
        RadioExoModule.emitJs(getApplicationContext(), "ended", null);
      }
      emitProgress();
      pushState();
    }
    @Override public void onMediaItemTransition(@Nullable MediaItem m, int reason) { emitProgress(); pushState(); }
    @Override public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) { emitProgress(); pushState(); }
    @Override public void onPlayerError(PlaybackException error) {
      Map<String, Object> extra = new HashMap<>();
      extra.put("message", String.valueOf(error.getMessage()));
      RadioExoModule.emitJs(getApplicationContext(), "error", extra);
    }
  };

  private static Map<String, Object> mapOf(String k, String v) {
    Map<String, Object> m = new HashMap<>();
    m.put(k, v);
    return m;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    ensureChannel();
  }

  private void ensureChannel() {
    try {
      NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_DEFAULT);
      ch.setDescription("播放音乐/电台时保持后台运行");
      ch.setSound(null, null);
      ch.enableVibration(false);
      getSystemService(NotificationManager.class).createNotificationChannel(ch);
    } catch (Throwable ignored) {}
  }

  /** 建真实播放器 + framework 会话（headers 变化才重建） */
  private void ensurePlayer(Map<String, String> headers) {
    if (headers != null && headers.equals(currentHeaders) && exo != null) return;
    stopPolling();
    destroySession();
    if (exo != null) { try { exo.release(); } catch (Throwable ignored) {} exo = null; }
    currentHeaders.clear();
    if (headers != null) currentHeaders.putAll(headers);

    DefaultHttpDataSource.Factory ds = new DefaultHttpDataSource.Factory()
        .setUserAgent("PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)")
        .setDefaultRequestProperties(currentHeaders)
        .setAllowCrossProtocolRedirects(true);
    // handleAudioFocus=true：来电/蓝牙等标准暂停（18:08 自激根因是 RNV 占位 Video 当时也在抢焦点，
    // 已由 JS nativeOk 修复（Exo 下发即静音 Video）消除；恢复标准焦点行为）
    exo = new ExoPlayer.Builder(this, new DefaultMediaSourceFactory(ds))
        .setRenderersFactory(new DefaultRenderersFactory(this).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER))
        .setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build(), /* handleAudioFocus */ true)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .build();
    exo.setHandleAudioBecomingNoisy(true);
    exo.addListener(playerListener);

    session = new MediaSession(this, "yaya-media");
    session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
    // media-button 接收标记：让 ColorOS 把面板/媒体键命令路由给本会话
    session.setMediaButtonReceiver(
        PendingIntent.getBroadcast(this, 200,
            new Intent(this, MediaButtonProxyReceiver.class).setAction(Intent.ACTION_MEDIA_BUTTON),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    session.setCallback(new MediaSession.Callback() {
      @Override public void onPlay() { if (exo != null) exo.play(); }
      @Override public void onPause() { if (exo != null) exo.pause(); }
      @Override public void onSkipToNext() { RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", "next")); }
      @Override public void onSkipToPrevious() { RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", "prev")); }
      @Override public void onSeekTo(long pos) { if (exo != null) exo.seekTo(Math.max(0, pos)); }
      @Override public void onStop() { if (exo != null) exo.pause(); }
    });
    session.setActive(true);
    artBitmap = null;
    artPath = "";
    lastNotifyMs = 0;
    pushState();
  }

  private void destroySession() {
    if (session != null) {
      try { session.setActive(false); } catch (Throwable ignored) {}
      try { session.release(); } catch (Throwable ignored) {}
      session = null;
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent == null) return START_NOT_STICKY;
    String action = intent.getAction();
    if (ACTION_PLAY_QUEUE.equals(action)) {
      try {
        String hJson = intent.getStringExtra("headers");
        Map<String, String> nh = new HashMap<>();
        if (hJson != null && !hJson.isEmpty()) {
          JSONObject jo = new JSONObject(hJson);
          java.util.Iterator<String> it = jo.keys();
          while (it.hasNext()) { String k = it.next(); nh.put(k, jo.optString(k, "")); }
        }
        ensurePlayer(nh);

        String queueJson = intent.getStringExtra("queue");
        int index = Math.max(0, intent.getIntExtra("index", 0));
        long posMs = (long) (intent.getDoubleExtra("position", 0) * 1000);
        boolean playing = intent.getBooleanExtra("playing", true);
        JSONArray arr = new JSONArray(queueJson == null ? "[]" : queueJson);
        List<MediaItem> items = new ArrayList<>();
        String firstUrl = "";
        for (int i = 0; i < arr.length(); i++) {
          JSONObject o = arr.getJSONObject(i);
          String url = o.optString("url", "");
          if (i == 0) firstUrl = url;
          items.add(new MediaItem.Builder().setUri(url).build());
          title = o.optString("title");
          artist = o.optString("artist");
          album = o.optString("album");
          String art = o.optString("art");
          if (!art.equals(artPath)) {
            artPath = art;
            artBitmap = null;
            if (art.startsWith("file://")) {
              try { artBitmap = BitmapFactory.decodeFile(art.substring("file://".length())); } catch (Throwable ignored) {}
            }
          }
        }
        // 同曲去重：离开音乐页后再进入，页面 armed 状态重置会重推同一首 → 原生已在播则不重载
        // （重载会 setMediaItems(posMs) 从头/从旧位置打断后台播放）；仅按需 play()/seekTo(posMs)
        MediaItem cur = exo.getCurrentMediaItem();
        String curUrl = cur == null ? null : cur.mediaId;
        boolean sameTrack = curUrl != null && curUrl.equals(firstUrl);
        double vol = intent.getDoubleExtra("volume", 1.0);
        exo.setVolume((float) Math.max(0, Math.min(1.0, vol)));
        int rep = intent.getIntExtra("repeat", 0);
        if (rep != currentRepeat) {
          currentRepeat = rep;
          exo.setRepeatMode(rep == 1 ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
        }
        if (sameTrack && exo.getPlaybackState() != Player.STATE_ENDED) {
          if (posMs > 0) exo.seekTo(posMs);
          if (playing && !exo.getPlayWhenReady()) exo.play();
          // else if (!playing && exo.getPlayWhenReady()) exo.pause();
        } else {
          exo.setMediaItems(items, Math.max(0, Math.min(index, items.size() - 1)), posMs);
          exo.prepare();
          if (playing) exo.play();
        }
        startPolling();
        startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
      } catch (Throwable t) {
        Map<String, Object> extra = new HashMap<>();
        extra.put("message", "queue err " + t.getMessage());
        RadioExoModule.emitJs(getApplicationContext(), "error", extra);
      }
    } else {
      String cmd = intent.getStringExtra("cmd");
      if (exo == null) {
        try {
          startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } catch (Throwable ignored) {}
        return START_NOT_STICKY;
      }
      if ("pause".equals(cmd)) { exo.pause(); pushState(); }
      else if ("resume".equals(cmd)) { exo.play(); pushState(); }
      else if ("next".equals(cmd)) { RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", "next")); }
      else if ("prev".equals(cmd)) { RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", "prev")); }
      else if ("play_pause".equals(cmd)) {
        if (isPlaying()) { exo.pause(); } else { exo.play(); }
        pushState();
      } else if ("seek".equals(cmd)) {
        exo.seekTo(Math.max(0, (long) (intent.getDoubleExtra("position", 0) * 1000)));
      } else if ("repeat".equals(cmd)) {
        int rep = intent.getIntExtra("repeat", 0);
        currentRepeat = rep;
        exo.setRepeatMode(rep == 1 ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
      } else if ("stop".equals(cmd)) {
        stopPolling();
        if (exo != null) { exo.stop(); exo.clearMediaItems(); }
        try { stopSelf(); } catch (Throwable ignored) {}
      }
    }
    return START_NOT_STICKY;
  }

  private boolean isPlaying() {
    return exo != null && exo.getPlayWhenReady() && exo.getPlaybackState() != Player.STATE_ENDED;
  }

  private void startPolling() {
    if (pollRunning) return;
    pollRunning = true;
    h.removeCallbacks(progressPoller);
    h.postDelayed(progressPoller, 500);
  }
  private void stopPolling() {
    pollRunning = false;
    h.removeCallbacks(progressPoller);
  }

  /** JS 进度回流（App 内进度条/播放态） */
  private void emitProgress() {
    if (exo == null) return;
    try {
      Map<String, Object> extra = new HashMap<>();
      extra.put("position", exo.getCurrentPosition() / 1000.0);
      extra.put("duration", exo.getDuration() > 0 ? exo.getDuration() / 1000.0 : 0);
      extra.put("playing", exo.getPlayWhenReady() && exo.getPlaybackState() != Player.STATE_ENDED);
      extra.put("index", exo.getCurrentMediaItemIndex());
      RadioExoModule.emitJs(getApplicationContext(), "progress", extra);
    } catch (Throwable ignored) {}
  }

  /** framework 会话状态推送（真实播放器数据） */
  private void pushState() {
    if (session == null || exo == null) return;
    try {
      long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
          | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
          | PlaybackState.ACTION_SEEK_TO;
      boolean playing = exo.getPlayWhenReady() && exo.getPlaybackState() != Player.STATE_ENDED;
      // ⚠️ updated 必须用 elapsedRealtime（单调时钟）：SystemUI 用 (now-updated)×speed+position 演算进度，
      // 用墙钟 currentTimeMillis 会让 ColorOS 算出异常差值 → 播放态进度错乱/归 0（19:59 实测）
      PlaybackState ps = new PlaybackState.Builder()
          .setActions(actions)
          .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
              exo.getCurrentPosition(), playing ? 1.0f : 0f, android.os.SystemClock.elapsedRealtime())
          .build();
      session.setPlaybackState(ps);
      MediaMetadata.Builder b = new MediaMetadata.Builder();
      b.putString(MediaMetadata.METADATA_KEY_TITLE, title.isEmpty() ? "牙牙消息" : title);
      b.putString(MediaMetadata.METADATA_KEY_ARTIST, artist);
      b.putString(MediaMetadata.METADATA_KEY_ALBUM, album);
      long dur = exo.getDuration();
      if (dur > 0) b.putLong(MediaMetadata.METADATA_KEY_DURATION, dur);
      if (artBitmap != null) b.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artBitmap);
      session.setMetadata(b.build());
    } catch (Throwable ignored) {}
  }

  private Notification buildNotification() {
    try {
      NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
      if (nm != null) {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setSound(null, null);
        channel.enableVibration(false);
        nm.createNotificationChannel(channel);
      }
      String sub = artist.isEmpty() ? "牙牙消息" : artist + (album.isEmpty() ? "" : " · " + album);
      Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
      PendingIntent contentPi = open == null ? null
          : PendingIntent.getActivity(this, 0, open,
              PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
      boolean playing = isPlaying();
      Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID);
      if (artBitmap != null) builder.setLargeIcon(artBitmap);
      builder.setSmallIcon(R.mipmap.ic_launcher)
          .setContentTitle(title.isEmpty() ? "牙牙消息" : title)
          .setContentText(sub)
          .setCategory(Notification.CATEGORY_TRANSPORT)
          .setVisibility(Notification.VISIBILITY_PUBLIC)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setContentIntent(contentPi)
          .addAction(android.R.drawable.ic_media_previous, "上一首", cmdPi("prev"))
          .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
              playing ? "暂停" : "播放", cmdPi("play_pause"))
          .addAction(android.R.drawable.ic_media_next, "下一首", cmdPi("next"))
          .setStyle(new android.app.Notification.MediaStyle()
              .setMediaSession(session == null ? null : session.getSessionToken())
              .setShowActionsInCompactView(0, 1, 2));
      return builder.build();
    } catch (Throwable ignored) {
      return null;
    }
  }

  private PendingIntent cmdPi(String cmd) {
    Intent i = new Intent(this, YayaExoService.class).putExtra("cmd", cmd);
    int rc = "prev".equals(cmd) ? 30 : "next".equals(cmd) ? 32 : 31;
    return PendingIntent.getForegroundService(this, rc, i,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  @Override
  public void onDestroy() {
    stopPolling();
    destroySession();
    if (exo != null) { try { exo.release(); } catch (Throwable ignored) {} exo = null; }
    super.onDestroy();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
