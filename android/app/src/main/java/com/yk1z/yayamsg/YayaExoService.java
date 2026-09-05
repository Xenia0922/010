package com.yk1z.yayamsg;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 原生 ExoPlayer + media3 会话（分支 exo-native-music · 2026-09-05 重构）。
 *
 * 定位：音乐播放的系统媒体控件正解（OPPO/ColorOS 锁屏/流体云/媒体中心不刷新的修复线）。
 * 与旧链路（RadioForegroundService 自管 framework MediaSession）的区别：
 *  - 真实播放就在本服务（ExoPlayer），PlaybackState/进度/seek/暂停全部由 media3 驱动系统 UI，
 *    不再依赖 JS 500ms 手工推位置 —— ColorOS「会话数据对但 UI 不刷新」的根因是旧链路把
 *    会话与真实播放器分离，media3 单一来源天然解决；
 *  - 通知交给 media3 的 DefaultMediaNotificationProvider（MediaStyle + 系统标准进度/控件），
 *    渠道沿用项目结论 IMPORTANCE_DEFAULT（ColorOS LOW 渠道会被折叠不投喂媒体中心）；
 *  - 队列/模式/URL 解析仍在 JS（MusicEngine）决策：本服务只持有“当前单曲”，
 *    切歌由 JS 重新下发 playQueue。上一首/下一首命令经 CmdPlayer 拦截回 JS，避免空队列自走。
 */
public class YayaExoService extends MediaSessionService {
  public static final String ACTION_PLAY_QUEUE = "yaya.exo.play_queue";
  // v3：与 RadioForegroundService 的 yaya_radio_v2 区分；必须 DEFAULT（ColorOS LOW 折叠坑）
  private static final String CHANNEL_ID = "yaya_radio_v3";
  private static final int NOTIFICATION_ID = 2024;
  private static final Handler h = new Handler(Looper.getMainLooper());

  private final Map<String, String> currentHeaders = new HashMap<>();
  private CmdPlayer player;              // ForwardingPlayer 包装（next/prev 拦截回 JS）
  private ExoPlayer exo;                 // 真实播放器（经 player 包装访问）
  private MediaSession mediaSession;
  private boolean pollRunning = false;
  private int currentRepeat = Player.REPEAT_MODE_OFF;

  private final Runnable progressPoller = new Runnable() {
    @Override public void run() {
      emitProgress();
      h.postDelayed(this, 500);
    }
  };

  private final Player.Listener playerListener = new Player.Listener() {
    @Override public void onPlaybackStateChanged(int state) {
      if (state == Player.STATE_ENDED) {
        // 播完单曲 → 交 JS 引擎切下一首（顺序/随机在 JS；单曲循环走 REPEAT_MODE_ONE 不会到这）
        RadioExoModule.emitJs(getApplicationContext(), "ended", null);
      }
      emitProgress();
    }
    @Override public void onMediaItemTransition(@Nullable MediaItem m, int reason) { emitProgress(); }
    @Override public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) { emitProgress(); }
    @Override public void onPlayerError(PlaybackException error) {
      Map<String, Object> extra = new HashMap<>();
      extra.put("message", String.valueOf(error.getMessage()));
      RadioExoModule.emitJs(getApplicationContext(), "error", extra);
      emitProgress();
    }
  };

  // ---- 切歌命令：系统卡/线控的 上一首/下一首 → JS 引擎（JS 解析 URL 后重新下发当前曲）----
  private final class CmdPlayer extends ForwardingPlayer {
    CmdPlayer(Player p) { super(p); }
    @Override public boolean hasNextMediaItem() { return true; }      // 队列恒有“下一首”概念（JS 侧）
    @Override public boolean hasPreviousMediaItem() { return true; }
    @Override public Player.Commands getAvailableCommands() {
      Player.Commands c = super.getAvailableCommands();
      if (c.contains(Player.COMMAND_SEEK_TO_NEXT) && c.contains(Player.COMMAND_SEEK_TO_PREVIOUS)) return c;
      Player.Commands.Builder b = c.buildUpon();
      b.addIf(Player.COMMAND_SEEK_TO_NEXT, !c.contains(Player.COMMAND_SEEK_TO_NEXT));
      b.addIf(Player.COMMAND_SEEK_TO_PREVIOUS, !c.contains(Player.COMMAND_SEEK_TO_PREVIOUS));
      return b.build();
    }
    @Override public void seekToNextMediaItem() { RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", "next")); }
    @Override public void seekToPreviousMediaItem() { RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", "prev")); }
  }

  private static Map<String, Object> mapOf(String k, String v) {
    Map<String, Object> m = new HashMap<>();
    m.put(k, v);
    return m;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    ensureNotificationChannel(); // 先建 DEFAULT 渠道：media3 Provider 发现已存在即不降级为 LOW
    DefaultMediaNotificationProvider provider = new DefaultMediaNotificationProvider.Builder(this)
        .setChannelId(CHANNEL_ID)
        .setChannelName(R.string.app_name)
        .setNotificationId(NOTIFICATION_ID)
        .build();
    setMediaNotificationProvider(provider);
    rebuildPlayer(new HashMap<String, String>()); // 建真实播放器 + 会话并 addSession（会话即 Active）
  }

  private void ensureNotificationChannel() {
    try {
      NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_DEFAULT);
      ch.setDescription("播放音乐/电台时保持后台运行");
      ch.setSound(null, null);
      ch.enableVibration(false);
      getSystemService(NotificationManager.class).createNotificationChannel(ch);
    } catch (Throwable ignored) {}
  }

  /** 建（或按 headers 重建）播放器与会话。headers 变化才重建，避免切歌反复换会话 token。 */
  private void rebuildPlayer(Map<String, String> headers) {
    stopPolling();
    if (player != null) { try { player.stop(); } catch (Throwable ignored) {} }
    if (exo != null) { try { exo.release(); } catch (Throwable ignored) {} exo = null; player = null; }
    if (mediaSession != null) {
      try { removeSession(mediaSession); } catch (Throwable ignored) {}
      try { mediaSession.release(); } catch (Throwable ignored) {}
      mediaSession = null;
    }
    currentHeaders.clear();
    currentHeaders.putAll(headers);

    DefaultHttpDataSource.Factory ds = new DefaultHttpDataSource.Factory()
        .setUserAgent("PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)")
        .setDefaultRequestProperties(currentHeaders)
        .setAllowCrossProtocolRedirects(true);
    exo = new ExoPlayer.Builder(this, new DefaultMediaSourceFactory(ds))
        .setRenderersFactory(new DefaultRenderersFactory(this).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER))
        .setAudioAttributes(
            new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            /* handleAudioFocus */ true)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .build();
    exo.setHandleAudioBecomingNoisy(true);
    player = new CmdPlayer(exo);
    player.addListener(playerListener);
    // setSessionActivity：点击锁屏媒体卡/通知 → 回到 App
    Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent contentPi = open == null ? null
        : PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    mediaSession = new MediaSession.Builder(this, player)
        .setId("yaya-exo")
        .setSessionActivity(contentPi)
        .build();
    addSession(mediaSession);
  }

  @Override
  public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
    return mediaSession;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    super.onStartCommand(intent, flags, startId);
    if (intent == null) return START_NOT_STICKY;
    String action = intent.getAction();
    if (ACTION_PLAY_QUEUE.equals(action)) {
      // startForegroundService 契约：5s 内必须 startForeground（先占位，media3 稍后覆盖为媒体通知）
      ensureForegroundPlaceholder();
      try {
        String queueJson = intent.getStringExtra("queue");
        int index = Math.max(0, intent.getIntExtra("index", 0));
        long posMs = (long) (intent.getDoubleExtra("position", 0) * 1000);
        boolean playing = intent.getBooleanExtra("playing", true);
        String hJson = intent.getStringExtra("headers");
        Map<String, String> nh = new HashMap<>();
        if (hJson != null && !hJson.isEmpty()) {
          JSONObject jo = new JSONObject(hJson);
          java.util.Iterator<String> it = jo.keys();
          while (it.hasNext()) { String k = it.next(); nh.put(k, jo.optString(k, "")); }
        }
        if (!nh.equals(currentHeaders)) rebuildPlayer(nh);

        JSONArray arr = new JSONArray(queueJson == null ? "[]" : queueJson);
        List<MediaItem> items = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
          JSONObject o = arr.getJSONObject(i);
          String url = o.optString("url", "");
          MediaMetadata.Builder md = new MediaMetadata.Builder()
              .setTitle(o.optString("title"))
              .setArtist(o.optString("artist"));
          String album = o.optString("album");
          if (!album.isEmpty()) md.setAlbumTitle(album);
          // 封面：file://（JS 下载落盘，OPPO 唯一可靠路径）或 http(s)（media3 BitmapLoader 自行拉取）
          String art = o.optString("art");
          if (!art.isEmpty()) md.setArtworkUri(android.net.Uri.parse(art));
          items.add(new MediaItem.Builder().setUri(url).setMediaMetadata(md.build()).build());
        }
        player.setMediaItems(items, Math.max(0, Math.min(index, items.size() - 1)), posMs);
        player.prepare();
        double vol = intent.getDoubleExtra("volume", 1.0);
        player.setVolume((float) Math.max(0, Math.min(1.0, vol)));
        int repeat = intent.getIntExtra("repeat", 0);
        if (repeat != currentRepeat) {
          currentRepeat = repeat;
          player.setRepeatMode(repeat == 1 ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
        }
        if (playing) player.play();
        startPolling();
      } catch (Throwable t) {
        Map<String, Object> extra = new HashMap<>();
        extra.put("message", "queue err " + t.getMessage());
        RadioExoModule.emitJs(getApplicationContext(), "error", extra);
      }
    } else {
      String cmd = intent.getStringExtra("cmd");
      if (player == null) return START_NOT_STICKY;
      if ("pause".equals(cmd)) player.pause();
      else if ("resume".equals(cmd)) player.play();
      else if ("seek".equals(cmd)) {
        player.seekTo(Math.max(0, (long) (intent.getDoubleExtra("position", 0) * 1000)));
      } else if ("repeat".equals(cmd)) {
        int repeat = intent.getIntExtra("repeat", 0);
        currentRepeat = repeat;
        player.setRepeatMode(repeat == 1 ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
      } else if ("stop".equals(cmd)) {
        stopPolling();
        if (player != null) { player.stop(); player.clearMediaItems(); }
        try { stopSelf(); } catch (Throwable ignored) {}
      }
    }
    return START_NOT_STICKY;
  }

  /** 占位通知（无 MediaStyle）：仅满足 startForeground 5s 契约；media3 会立即以媒体通知覆盖同 id */
  private void ensureForegroundPlaceholder() {
    try {
      Notification n = new Notification.Builder(this, CHANNEL_ID)
          .setSmallIcon(R.mipmap.ic_launcher)
          .setContentTitle("牙牙消息")
          .setContentText("正在播放")
          .setCategory(Notification.CATEGORY_TRANSPORT)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .build();
      startForeground(NOTIFICATION_ID, n);
    } catch (Throwable ignored) {}
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

  /** JS 进度回流（驱动 App 内 MiniPlayer/全屏播放器进度条；系统 UI 由 media3 自己推，不经此） */
  private void emitProgress() {
    if (player == null || exo == null) return;
    try {
      Map<String, Object> extra = new HashMap<>();
      extra.put("position", player.getCurrentPosition() / 1000.0);
      extra.put("duration", player.getDuration() > 0 ? player.getDuration() / 1000.0 : 0);
      extra.put("playing", player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED);
      extra.put("index", player.getCurrentMediaItemIndex());
      RadioExoModule.emitJs(getApplicationContext(), "progress", extra);
    } catch (Throwable ignored) {}
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) { return super.onBind(intent); }

  @Override
  public void onDestroy() {
    stopPolling();
    if (mediaSession != null) {
      try { removeSession(mediaSession); } catch (Throwable ignored) {}
      try { mediaSession.release(); } catch (Throwable ignored) {}
      mediaSession = null;
    }
    if (exo != null) { try { exo.release(); } catch (Throwable ignored) {} exo = null; player = null; }
    super.onDestroy();
  }
}
