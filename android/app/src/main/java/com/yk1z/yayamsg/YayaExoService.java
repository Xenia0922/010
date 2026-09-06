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
import android.util.Log;

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
  /** 会话重声明：App 回前台/即将离开（Home键）时由 Activity 触发——重新 setActive + 重推状态 + 重建通知。
   *  修复：从音乐页返回 App 首页后再切后台，ColorOS 偶发把媒体卡绑定到过期会话/旧状态，
   *  表现为通知栏/锁屏控件"失灵"；每次前台恢复/离开前重声明一次，卡必绑到当前唯一活跃会话。 */
  public static final String ACTION_REASSERT = "yaya.exo.reassert";
  /** 下一首/上一首单跳提示：JS 播放确立时推送，service 手动 skip 时优先本地切换
   * （后台 JS 被 ColorOS 冻结 timer/网络时，cmd=next 事件到 JS 后异步链路永不完成 → 切歌无效） */
  public static final String ACTION_SET_HINTS = "yaya.exo.set_hints";
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
  private String lastTrackUrl = ""; // 当前已下发曲目 url（progress 事件带出，供 JS 去竞态）
  private String artist = "";
  private String album = "";
  private String artPath = "";
  private Bitmap artBitmap;
  // 元数据指纹：title|artist|album|artPath|duration 任一变化才重发 session metadata（含整图 bitmap，
  // 每 500ms tick 都重发 = 每半秒一次全图 Binder 拷贝，功耗大头）
  private String lastMetaSig = "";
  // 通知点击跳转 PI：构建昂贵（getLaunchIntentForPackage + PendingIntent），懒建一次复用
  private PendingIntent cachedContentPi;
  // skip hints（单跳）：服务端本地切歌用，结构 = {url,title,artist,album,art?,index?}
  // index = 引擎语义下的队列下标（供 JS 恢复对账定位曲目）；-1 = 未知
  // art = 封面 file://（JS 已落盘）；后台本地切歌直接展示，不等回前台 JS 补推
  private String nextUrl = "", nextTitle = "", nextArtist = "", nextAlbum = "", nextArt = "";
  private String prevUrl = "", prevTitle = "", prevArtist = "", prevAlbum = "", prevArt = "";
  private int nextIndexHint = -1, prevIndexHint = -1;

  private final Runnable progressPoller = new Runnable() {
    @Override public void run() {
      boolean playing = isPlaying();
      emitProgress();
      pushState(); // framework 会话（真实位置）；元数据内部已按需缓存（仅切曲才重发）
      // ColorOS workaround：播放中每 3s 重建 MediaStyle 完整通知助推卡刷新（疑仅重绘最近一次完整通知）。
      // 暂停/结束态不重建（内容静止，3s 拉长到 3s 一次轻量会话保活即可），省通知构建 + 包管理器 IPC。
      if (playing) {
        long now = System.currentTimeMillis();
        if (now - lastNotifyMs >= 3000) {
          lastNotifyMs = now;
          try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
          } catch (Throwable ignored) {}
        }
      }
      h.postDelayed(this, playing ? 500 : 3000);
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

    session = new MediaSession(this, "yaya-music");
    session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
    // media-button 接收标记：让 ColorOS 把面板/媒体键命令路由给本会话
    session.setMediaButtonReceiver(
        PendingIntent.getBroadcast(this, 200,
            new Intent(this, MediaButtonProxyReceiver.class).setAction(Intent.ACTION_MEDIA_BUTTON),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    session.setCallback(new MediaSession.Callback() {
      @Override public void onPlay() { Log.i("YayaExo", "CMD onPlay"); if (exo != null) exo.play(); }
      @Override public void onPause() { Log.i("YayaExo", "CMD onPause curPos=" + (exo == null ? -1 : exo.getCurrentPosition())); if (exo != null) exo.pause(); }
      @Override public void onSkipToNext() { Log.i("YayaExo", "CMD onSkipToNext"); localSkip(true); }
      @Override public void onSkipToPrevious() { Log.i("YayaExo", "CMD onSkipToPrevious"); localSkip(false); }
      @Override public void onSeekTo(long pos) { Log.i("YayaExo", "CMD onSeekTo pos=" + pos); if (exo != null) exo.seekTo(Math.max(0, pos)); }
      @Override public void onStop() { Log.i("YayaExo", "CMD onStop"); if (exo != null) exo.pause(); }
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
        // ⚠️ startForegroundService 5s 契约：解析 JSON/建会话可能耗时，先占位进前台（防 RemoteServiceException）
        try {
          startForeground(NOTIFICATION_ID, minimalFg(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } catch (Throwable ignored) {}
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
          if (i == 0) lastTrackUrl = url;
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
        // ⚠️ mediaId 可能为 null（setUri 未显式设 mediaId）→ 必须回退取 localConfiguration.uri，
        //    否则同曲比较恒 false → 每次重复下发都整曲重载（22:53 实测 0.18s 内 4 连 SET-ITEMS）
        MediaItem cur = exo.getCurrentMediaItem();
        String curUrl = cur == null ? null
            : (cur.mediaId != null && !cur.mediaId.isEmpty() ? cur.mediaId
              : (cur.localConfiguration != null && cur.localConfiguration.uri != null
                 ? cur.localConfiguration.uri.toString() : null));
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
          Log.i("YayaExo", "SET-ITEMS url=" + firstUrl + " posMs=" + posMs + " sameTrack=" + sameTrack + " curState=" + (exo.getPlaybackState()));
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
    } else if (ACTION_REASSERT.equals(action)) {
      // 会话重声明：App 每次回前台 / 用户按 Home 离开前触发（见 MainActivity）。
      // ColorOS 在 App 内导航/页面堆栈变化后偶发把媒体卡绑到过期会话状态 → 控件失灵；
      // 这里强制 setActive + 重推状态 + 重建 MediaStyle 通知，确保系统卡绑定当前会话。
      if (exo == null) {
        // 未在播：不建通知不留活口（避免凭空冒一个媒体卡）
        try { stopSelf(); } catch (Throwable ignored) {}
        return START_NOT_STICKY;
      }
      try { if (session != null) session.setActive(true); } catch (Throwable ignored) {}
      pushState();
      try {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
      } catch (Throwable ignored) {}
      return START_NOT_STICKY;
    } else if (ACTION_SET_HINTS.equals(action)) {
      // JS 播放确立/状态变化时推送的 skip hint：更新槽位（不建播放器不播）
      applySkipHints(intent.getStringExtra("next"), intent.getStringExtra("prev"));
      if (exo == null) {
        // 未在播还收到 hint（停播竞态残留）→ 立即停，避免 startForegroundService 5s 契约崩溃
        try { stopSelf(); } catch (Throwable ignored) {}
      }
      return START_NOT_STICKY;
    } else {
      String cmd = intent.getStringExtra("cmd");
      if (exo == null) {
        try {
          startForeground(NOTIFICATION_ID, minimalFg(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } catch (Throwable ignored) {}
        return START_NOT_STICKY;
      }
      if ("pause".equals(cmd)) { exo.pause(); pushState(); }
      else if ("resume".equals(cmd)) { exo.play(); pushState(); }
      else if ("next".equals(cmd)) { localSkip(true); }
      else if ("prev".equals(cmd)) { localSkip(false); }
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

  // ---------- skip hints + 本地切歌（ColorOS 冻结后台 JS 的根治） ----------

  /** JS 推来的 hint JSON：{url,title,artist,album,art?,index?}；null/空串 → 清空该方向槽位 */
  private void applySkipHints(String nextJson, String prevJson) {
    try {
      if (nextJson != null && nextJson.startsWith("{")) {
        JSONObject o = new JSONObject(nextJson);
        String u = o.optString("url", "");
        setNextHint(u, o.optString("title", ""), o.optString("artist", ""), o.optString("album", ""),
            o.optString("art", ""),
            o.has("index") ? o.optInt("index", -1) : -1);
      } else {
        clearNextHint();
      }
    } catch (Throwable t) { clearNextHint(); }
    try {
      if (prevJson != null && prevJson.startsWith("{")) {
        JSONObject o = new JSONObject(prevJson);
        String u = o.optString("url", "");
        setPrevHint(u, o.optString("title", ""), o.optString("artist", ""), o.optString("album", ""),
            o.optString("art", ""),
            o.has("index") ? o.optInt("index", -1) : -1);
      } else {
        clearPrevHint();
      }
    } catch (Throwable t) { clearPrevHint(); }
  }

  private void setNextHint(String u, String t, String a, String al, String art, int idx) {
    nextUrl = u == null ? "" : u; nextTitle = t == null ? "" : t;
    nextArtist = a == null ? "" : a; nextAlbum = al == null ? "" : al;
    nextArt = art == null ? "" : art; nextIndexHint = idx;
  }
  private void setPrevHint(String u, String t, String a, String al, String art, int idx) {
    prevUrl = u == null ? "" : u; prevTitle = t == null ? "" : t;
    prevArtist = a == null ? "" : a; prevAlbum = al == null ? "" : al;
    prevArt = art == null ? "" : art; prevIndexHint = idx;
  }
  private void clearNextHint() { setNextHint("", "", "", "", "", -1); }
  private void clearPrevHint() { setPrevHint("", "", "", "", "", -1); }

  /** 当前已下发曲目 url（mediaId/localConfiguration.uri 双回退，与 playQueue 同曲去重逻辑一致） */
  private String currentMediaUrl() {
    MediaItem cur = exo == null ? null : exo.getCurrentMediaItem();
    if (cur == null) return null;
    if (cur.mediaId != null && !cur.mediaId.isEmpty()) return cur.mediaId;
    if (cur.localConfiguration != null && cur.localConfiguration.uri != null) return cur.localConfiguration.uri.toString();
    return null;
  }

  /**
   * 上/下一首本地切歌（后台冻结 JS 也能生效）：
   * hint 有 url → 直接换 MediaItem 播放（同 url 视为重播 seek0），元数据/通知/会话即时更新，
   * 并把刚离开的曲目塞进反方向槽位（一步回退即回原曲，符合引擎语义）；hint 缺失才兜底 emitJs cmd。
   */
  private void localSkip(boolean isNext) {
    if (exo == null) return;
    String u = isNext ? nextUrl : prevUrl;
    if (u.isEmpty()) {
      // 无可用 hint：旧路径（JS 活着时 cmd→引擎 next/prev 仍完整生效）
      RadioExoModule.emitJs(getApplicationContext(), "cmd", mapOf("cmd", isNext ? "next" : "prev"));
      return;
    }
    String nTitle = isNext ? nextTitle : prevTitle;
    String nArtist = isNext ? nextArtist : prevArtist;
    String nAlbum = isNext ? nextAlbum : prevAlbum;
    String nArt = isNext ? nextArt : prevArt;
    int nIndex = isNext ? nextIndexHint : prevIndexHint;
    // 反方向槽位 = 刚离开的当前曲（一步 prev/next 可回原曲，含其封面）；已用方向槽位清空
    // （无下一跳元数据，避免二次点击重放同曲；前台 JS 会即刻按新 index 重新推送）
    if (isNext) { setPrevHint(lastTrackUrl, title, artist, album, artPath, -1); clearNextHint(); }
    else { setNextHint(lastTrackUrl, title, artist, album, artPath, -1); clearPrevHint(); }
    title = nTitle; artist = nArtist; album = nAlbum; lastTrackUrl = u;
    String curU = currentMediaUrl();
    boolean same = curU != null && curU.equals(u);
    try {
      if (same) {
        exo.seekTo(0); // 同一曲（single 重播）→ 不重载直接从头（封面不变）
      } else {
        exo.setMediaItems(java.util.Collections.singletonList(new MediaItem.Builder().setUri(u).build()), 0, 0);
        exo.prepare();
        // 换曲后套用 hint 封面（file:// 已落盘）；无/不可用 → 清旧封面防错配
        artPath = nArt;
        artBitmap = null;
        if (nArt.startsWith("file://")) {
          try { artBitmap = BitmapFactory.decodeFile(nArt.substring("file://".length())); } catch (Throwable ignored) {}
        }
      }
      exo.play();
    } catch (Throwable t) {
      Map<String, Object> extra = new HashMap<>();
      extra.put("message", "localSkip err " + t.getMessage());
      RadioExoModule.emitJs(getApplicationContext(), "error", extra);
      return;
    }
    pushState();
    try {
      NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
      if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
    } catch (Throwable ignored) {}
    // 通知 JS 对账（store 下标/url/歌词）；JS 冻结时事件排队，恢复后按序到达即自愈
    Map<String, Object> ev = new HashMap<>();
    ev.put("cmd", isNext ? "next" : "prev");
    ev.put("url", u);
    ev.put("title", nTitle);
    ev.put("artist", nArtist);
    ev.put("album", nAlbum);
    if (nIndex >= 0) ev.put("index", (double) nIndex);
    RadioExoModule.emitJs(getApplicationContext(), "skipped", ev);
  }

  /** 5s 契约占位通知（最快构建，随后由 buildNotification 覆盖更新） */
  private Notification minimalFg() {
    try {
      return new Notification.Builder(this, CHANNEL_ID)
          .setSmallIcon(R.mipmap.ic_launcher)
          .setContentTitle("牙牙消息")
          .setContentText("正在播放")
          .setCategory(Notification.CATEGORY_TRANSPORT)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .build();
    } catch (Throwable t) {
      try {
        return new Notification.Builder(this)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("牙牙消息").setContentText("正在播放").build();
      } catch (Throwable t2) {
        return null;
      }
    }
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

  /** JS 进度回流（App 内进度条/播放态）；带当前曲 url 供 JS 丢弃切歌竞态的旧曲心跳 */
  private void emitProgress() {
    if (exo == null) return;
    try {
      Map<String, Object> extra = new HashMap<>();
      extra.put("position", exo.getCurrentPosition() / 1000.0);
      extra.put("duration", exo.getDuration() > 0 ? exo.getDuration() / 1000.0 : 0);
      extra.put("playing", exo.getPlayWhenReady() && exo.getPlaybackState() != Player.STATE_ENDED);
      extra.put("index", exo.getCurrentMediaItemIndex());
      extra.put("url", lastTrackUrl);
      RadioExoModule.emitJs(getApplicationContext(), "progress", extra);
    } catch (Throwable ignored) {}
  }

  /** framework 会话状态推送（真实播放器数据）；元数据仅变化时重发（见 lastMetaSig） */
  private void pushState() {
    if (session == null || exo == null) return;
    try {
      // 全量标准动作位：PLAY_PAUSE|PLAY|PAUSE|STOP|SEEK|NEXT|PREV —— ColorOS 面板按 actions 位决定
      // 按钮可用性；此前漏 NEXT/PREV 会导致上一首/下一首按钮"看着在、点着没反应"。
      long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
          | PlaybackState.ACTION_PLAY_PAUSE
          | PlaybackState.ACTION_STOP
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
      // 元数据仅在切曲/封面变化时重发（含 artBitmap 的 binder 拷贝；duration 就绪也算变化）
      long dur = exo.getDuration();
      String sig = title + "|" + artist + "|" + album + "|" + artPath + "|" + (dur > 0 ? dur : 0);
      if (sig.equals(lastMetaSig)) return;
      lastMetaSig = sig;
      MediaMetadata.Builder b = new MediaMetadata.Builder();
      b.putString(MediaMetadata.METADATA_KEY_TITLE, title.isEmpty() ? "牙牙消息" : title);
      b.putString(MediaMetadata.METADATA_KEY_ARTIST, artist);
      b.putString(MediaMetadata.METADATA_KEY_ALBUM, album);
      if (dur > 0) b.putLong(MediaMetadata.METADATA_KEY_DURATION, dur);
      if (artBitmap != null) b.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artBitmap);
      session.setMetadata(b.build());
    } catch (Throwable ignored) {}
  }

  private Notification buildNotification() {
    try {
      String sub = artist.isEmpty() ? "牙牙消息" : artist + (album.isEmpty() ? "" : " · " + album);
      if (cachedContentPi == null) {
        // 懒建一次（getLaunchIntentForPackage 是包管理器 IPC，每 3s 一次太贵）
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
          cachedContentPi = PendingIntent.getActivity(this, 0, open,
              PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
      }
      Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID);
      if (artBitmap != null) builder.setLargeIcon(artBitmap);
      // 极简系统媒体通知：控制按钮只放系统媒体卡（QS/锁屏由 session 提供），
      // 通知栏仅保留 MediaStyle 收纳条目（可在 系统设置-通知-牙牙消息-后台播放 关闭）
      builder.setSmallIcon(R.mipmap.ic_launcher)
          .setContentTitle(title.isEmpty() ? "牙牙消息" : title)
          .setContentText(sub)
          .setCategory(Notification.CATEGORY_TRANSPORT)
          .setVisibility(Notification.VISIBILITY_PUBLIC)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setContentIntent(cachedContentPi)
          .setStyle(new android.app.Notification.MediaStyle()
              .setMediaSession(session == null ? null : session.getSessionToken()));
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
  public void onTaskRemoved(Intent rootIntent) {
    super.onTaskRemoved(rootIntent);
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
