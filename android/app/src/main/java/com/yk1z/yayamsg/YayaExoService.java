package com.yk1z.yayamsg;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 原生 ExoPlayer + media3 会话（分支 exo-native-music）。
 * 播放/进度/系统媒体卡(OPPO 流体云/锁屏)全部由 ExoPlayer 原生驱动；
 * JS 经 RadioExoModule 下发队列/控制，进度与播完事件回流 JS。
 */
public class YayaExoService extends MediaSessionService {
  public static final String ACTION_PLAY_QUEUE = "yaya.exo.play_queue";
  private static final String CHANNEL_ID = "yaya_radio_v3";
  private static final int NOTIFICATION_ID = 2024;
  private static final Handler h = new Handler(Looper.getMainLooper());

  private ExoPlayer player;
  private MediaSession mediaSession;
  private Map<String, String> currentHeaders = new HashMap<>();
  private final Runnable progressPoller = new Runnable() {
    @Override public void run() {
      emitProgress();
      h.postDelayed(this, 500);
    }
  };
  private boolean pollRunning = false;

  @Override
  public void onCreate() {
    super.onCreate();
    NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_DEFAULT);
    ch.setDescription("播放音乐/电台时保持后台运行");
    ch.setSound(null, null);
    ch.enableVibration(false);
    getSystemService(NotificationManager.class).createNotificationChannel(ch);
    rebuildPlayer(currentHeaders);
  }

  private void rebuildPlayer(Map<String, String> headers) {
    stopPolling();
    if (player != null) { try { player.stop(); } catch (Throwable ignored) {} player.release(); player = null; }
    if (mediaSession != null) { try { mediaSession.release(); } catch (Throwable ignored) {} mediaSession = null; }
    DefaultHttpDataSource.Factory ds = new DefaultHttpDataSource.Factory()
        .setUserAgent("yayamsg")
        .setDefaultRequestProperties(headers)
        .setAllowCrossProtocolRedirects(true);
    player = new ExoPlayer.Builder(this, new DefaultMediaSourceFactory(ds))
        .setRenderersFactory(new DefaultRenderersFactory(this).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER))
        .build();
    player.addListener(new Player.Listener() {
      @Override public void onPlaybackStateChanged(int state) {
        if (state == Player.STATE_ENDED) RadioExoModule.emitJs(getApplicationContext(), "ended", null);
        emitProgress();
      }
      @Override public void onMediaItemTransition(@Nullable MediaItem m, int reason) { emitProgress(); }
      @Override public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) { emitProgress(); }
      @Override public void onPlayerError(PlaybackException error) {
        Map<String, Object> extra = new HashMap<>();
        extra.put("message", String.valueOf(error.getMessage()));
        RadioExoModule.emitJs(getApplicationContext(), "error", extra);
      }
    });
    // next/prev 回 JS（引擎管队列/模式/URL 解析）；play/pause/seek 保持 Exo 原生
    mediaSession = new MediaSession.Builder(this, player)
        .setCallback(new MediaSession.Callback() {
          @Override
          public int onPlayerCommandRequest(MediaSession ms, MediaSession.ControllerInfo info, int command) {
            if (command == Player.COMMAND_SEEK_TO_NEXT) {
              RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", "next"));
              return Player.COMMAND_INVALID; // 阻止 Exo 空队列自走，交由 JS 引擎切歌
            }
            if (command == Player.COMMAND_SEEK_TO_PREVIOUS) {
              RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", "prev"));
              return Player.COMMAND_INVALID;
            }
            return command;
          }
        })
        .build();
  }

  private static java.util.Map<String, Object> mapOf(String k, String v) {
    java.util.Map<String, Object> m = new HashMap<>();
    m.put(k, v);
    return m;
  }

  @Override
  public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
    return mediaSession;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    ensureForeground(); // startForegroundService 契约：5s 内必须 startForeground（否则闪退）
    if (intent != null && ACTION_PLAY_QUEUE.equals(intent.getAction())) {
      try {
        String queueJson = intent.getStringExtra("queue");
        int index = intent.getIntExtra("index", 0);
        long posMs = (long) (intent.getDoubleExtra("position", 0) * 1000);
        boolean playing = intent.getBooleanExtra("playing", true);
        String hJson = intent.getStringExtra("headers");
        // headers 应用
        Map<String, String> nh = new HashMap<>();
        if (hJson != null && !hJson.isEmpty()) {
          JSONObject jo = new JSONObject(hJson);
          java.util.Iterator<String> it = jo.keys();
          while (it.hasNext()) { String k = it.next(); nh.put(k, jo.optString(k, "")); }
        }
        if (!nh.equals(currentHeaders)) {
          currentHeaders = nh;
          rebuildPlayer(currentHeaders);
        }
        JSONArray arr = new JSONArray(queueJson);
        List<MediaItem> items = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
          JSONObject o = arr.getJSONObject(i);
          String url = o.optString("url", "");
          MediaMetadata.Builder md = new MediaMetadata.Builder()
              .setTitle(o.optString("title"))
              .setArtist(o.optString("artist"));
          String album = o.optString("album");
          if (!album.isEmpty()) md.setAlbumTitle(album);
          String art = o.optString("art");
          if (!art.isEmpty()) md.setArtworkUri(android.net.Uri.parse(art));
          items.add(new MediaItem.Builder()
              .setUri(url)
              .setMediaMetadata(md.build())
              .build());
        }
        player.setMediaItems(items, Math.max(0, Math.min(index, items.size() - 1)), posMs);
        player.prepare();
        if (playing) player.play();
        startPolling();
      } catch (Throwable t) {
        Map<String, Object> extra = new HashMap<>();
        extra.put("message", "queue err " + t.getMessage());
        RadioExoModule.emitJs(getApplicationContext(), "error", extra);
      }
    } else if (intent != null) {
      String cmd = intent.getStringExtra("cmd");
      if ("pause".equals(cmd)) { player.pause(); }
      else if ("resume".equals(cmd)) { player.play(); }
      else if ("next".equals(cmd)) { player.seekToNextMediaItem(); }
      else if ("prev".equals(cmd)) { player.seekToPreviousMediaItem(); }
      else if ("seek".equals(cmd)) {
        player.seekTo(Math.max(0, (long) (intent.getDoubleExtra("position", 0) * 1000)));
      }
      else if ("stop".equals(cmd)) {
        player.stop();
        player.clearMediaItems();
        stopPolling();
        stopSelf();
      }
    }
    return START_NOT_STICKY;
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

  private void emitProgress() {
    if (player == null) return;
    try {
      Map<String, Object> extra = new HashMap<>();
      extra.put("position", player.getCurrentPosition() / 1000.0);
      extra.put("duration", player.getDuration() > 0 ? player.getDuration() / 1000.0 : 0);
      extra.put("playing", player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED);
      extra.put("index", player.getCurrentMediaItemIndex());
      RadioExoModule.emitJs(getApplicationContext(), "progress", extra);
    } catch (Throwable ignored) {}
  }

  @Override
  public void onUpdateNotification(MediaSession session) {
    ensureForeground();
  }

  private void ensureForeground() {
    try {
      Notification n = new Notification.Builder(this, CHANNEL_ID)
          .setSmallIcon(R.mipmap.ic_launcher)
          .setContentTitle("牙牙消息")
          .setContentText("正在播放")
          .setCategory(Notification.CATEGORY_TRANSPORT)
          .setVisibility(Notification.VISIBILITY_PUBLIC)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .build();
      startForeground(NOTIFICATION_ID, n);
    } catch (Throwable ignored) {}
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) { return super.onBind(intent); }

  @Override
  public void onDestroy() {
    stopPolling();
    if (mediaSession != null) mediaSession.release();
    if (player != null) player.release();
    super.onDestroy();
  }
}
