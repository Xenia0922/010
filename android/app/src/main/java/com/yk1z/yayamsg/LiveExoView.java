package com.yk1z.yayamsg;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Matrix;
import android.util.Log;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;

import com.google.android.exoplayer2.C;
import com.google.android.exoplayer2.DefaultLoadControl;
import com.google.android.exoplayer2.ExoPlayer;
import com.google.android.exoplayer2.MediaItem;
import com.google.android.exoplayer2.PlaybackException;
import com.google.android.exoplayer2.Player;
import com.google.android.exoplayer2.audio.AudioAttributes;
import com.google.android.exoplayer2.ext.rtmp.RtmpDataSource;
import com.google.android.exoplayer2.source.ProgressiveMediaSource;
import com.google.android.exoplayer2.upstream.DataSource;
import com.google.android.exoplayer2.upstream.DefaultDataSource;
import com.google.android.exoplayer2.video.VideoSize;

public class LiveExoView extends FrameLayout {
  private static final int MIN_BUFFER_MS = 6000;
  private static final int MAX_BUFFER_MS = 20000;
  private static final int PLAYBACK_BUFFER_MS = 1500;
  private static final int REBUFFER_MS = 3000;
  private static final int MAX_RETRY = 5;
  private static final long RETRY_DELAY_MS = 1600L;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final TextureView textureView;
  private final TextView statusText;
  private ExoPlayer player;
  private String url = "";
  private int retryCount = 0;
  private volatile boolean paused = false;
  private int videoWidth = 0;
  private int videoHeight = 0;
  private float videoPixelRatio = 1f;
  private boolean released = false;
  private boolean audioOnly = false;
  private final com.facebook.react.uimanager.ThemedReactContext reactContext;

  public LiveExoView(Context context) {
    super(context);
    this.reactContext = (context instanceof com.facebook.react.uimanager.ThemedReactContext)
        ? (com.facebook.react.uimanager.ThemedReactContext) context : null;
    setBackgroundColor(Color.BLACK);
    textureView = new TextureView(context);
    addView(textureView, new LayoutParams(-1, -1, Gravity.CENTER));
    applyAudioOnlyPresentation();

    statusText = new TextView(context);
    statusText.setTextColor(0xffeeeeee);
    statusText.setTextSize(12);
    statusText.setGravity(Gravity.CENTER);
    statusText.setPadding(dp(10), dp(6), dp(10), dp(6));
    statusText.setBackgroundColor(0xaa000000);
    LayoutParams statusParams = new LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
    statusParams.bottomMargin = dp(12);
    addView(statusText, statusParams);

    addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> applyAspectTransform());
  }

  /** 纯音频模式：不渲染视频画面，仅解码播放音频（上麦/电台流为声音，无需黑屏画面） */
  public void setAudioOnly(boolean audioOnly) {
    if (this.audioOnly == audioOnly) return;
    this.audioOnly = audioOnly;
    applyAudioOnlyPresentation();
    // 切换模式需重建播放器：挂载/卸载视频 surface、音频焦点与唤醒策略不同
    if (!url.isEmpty()) {
      start();
    }
  }

  private void applyAudioOnlyPresentation() {
    if (audioOnly) {
      setBackgroundColor(Color.TRANSPARENT);
      textureView.setVisibility(View.GONE);
    } else {
      setBackgroundColor(Color.BLACK);
      textureView.setVisibility(View.VISIBLE);
    }
  }

  /** JS 暂停/恢复（统一播放器控制条：播放/暂停直接控原生播放） */
  public void setPaused(boolean p) {
    Log.i("YayaLive", "setPaused=" + p);
    paused = p;
    if (player != null) {
      try {
        player.setPlayWhenReady(!p);
      } catch (Throwable ignored) {
      }
    }
  }

  public void setUrl(@Nullable String nextUrl) {
    String cleaned = nextUrl == null ? "" : nextUrl.trim();
    if (cleaned.equals(url)) return;
    url = cleaned;
    retryCount = 0;
    released = false;
    start();
  }

  public void stop() {
    Log.i("YayaLive", "stop url=" + url);
    released = true;
    handler.removeCallbacksAndMessages(null);
    // 延迟 ~150ms 释放：让解码/渲染线程把当前帧周期走完再销毁播放器。
    // 模拟器（MuMu）上若在上一次播放正渲染时同步 release，MediaCodec 易被顶死，
    // 表现为「第二次进直播只出第一帧就定住」（首次正常、后续全部卡首帧）。
    handler.postDelayed(this::releasePlayer, 150);
  }

  private void start() {
    handler.removeCallbacksAndMessages(null);
    releasePlayer();
    if (url.isEmpty()) {
      setStatus("No live url");
      return;
    }
    setStatus("Connecting...");
    Log.i("YayaLive", "start url=" + url + " audioOnly=" + audioOnly + " paused=" + paused);
    try {
      DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
          .setBufferDurationsMs(MIN_BUFFER_MS, MAX_BUFFER_MS, PLAYBACK_BUFFER_MS, REBUFFER_MS)
          .setPrioritizeTimeOverSizeThresholds(true)
          .build();
      player = new ExoPlayer.Builder(getContext()).setLoadControl(loadControl).build();
      player.setVideoScalingMode(C.VIDEO_SCALING_MODE_SCALE_TO_FIT);
      if (audioOnly) {
        // 纯音频模式：不挂视频 surface（避免黑屏画面），仅解码音频；
        // 设置音频焦点 + 局部唤醒锁（WAKE_LOCK），切后台/锁屏后继续收音
        player.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build(), true);
        player.setWakeMode(C.WAKE_MODE_LOCAL);
      } else {
        player.setVideoTextureView(textureView);
      }
      DataSource.Factory factory = isRtmp(url)
          ? new RtmpDataSource.Factory()
          : new DefaultDataSource.Factory(getContext());
      player.setMediaSource(new ProgressiveMediaSource.Factory(factory)
          .createMediaSource(MediaItem.fromUri(Uri.parse(url))));
      player.setPlayWhenReady(!paused);
      player.addListener(new Player.Listener() {
        @Override
        public void onPlaybackStateChanged(int state) {
          Log.i("YayaLive", "state=" + state + " url=" + url);
          if (state == Player.STATE_READY) {
            retryCount = 0;
            setStatus("Playing");
          } else if (state == Player.STATE_BUFFERING) {
            setStatus("Buffering...");
          } else if (state == Player.STATE_ENDED) {
            scheduleRetry("Stream ended");
          }
        }

        @Override
        public void onPlayerError(PlaybackException error) {
          Log.e("YayaLive", "error=" + error + " url=" + url);
          scheduleRetry("Playback failed");
        }

        @Override
        public void onVideoSizeChanged(VideoSize videoSize) {
          if (audioOnly) return; // 纯音频模式不渲染画面
          videoWidth = videoSize.width;
          videoHeight = videoSize.height;
          videoPixelRatio = videoSize.pixelWidthHeightRatio <= 0f ? 1f : videoSize.pixelWidthHeightRatio;
          applyAspectTransform();
          // 把视频实际尺寸发给 JS（小窗据此适配横竖屏容器比例）
          if (reactContext != null && videoWidth > 0 && videoHeight > 0) {
            try {
              com.facebook.react.uimanager.UIManagerModule uiManager = reactContext.getNativeModule(com.facebook.react.uimanager.UIManagerModule.class);
              if (uiManager != null) {
                uiManager.getEventDispatcher().dispatchEvent(new LiveSizeEvent(getId(), videoWidth, videoHeight));
              }
            } catch (Throwable ignored) {
            }
          }
        }
      });
      player.prepare();
    } catch (Throwable error) {
      scheduleRetry("Player init failed");
    }
  }

  private void scheduleRetry(String reason) {
    if (released) return;
    if (retryCount >= MAX_RETRY) {
      setStatus(reason);
      // 重试耗尽：把失败原因交给 JS（显示重试/切换网页播放器入口）
      emitErrorToJs(reason);
      return;
    }
    retryCount += 1;
    setStatus(reason + ", retrying " + retryCount + "/" + MAX_RETRY);
    handler.postDelayed(this::start, RETRY_DELAY_MS);
  }

  /** 重试耗尽后把失败原因发给 JS（LiveExoViewManager 注册的 onError） */
  private void emitErrorToJs(String reason) {
    if (reactContext == null) return;
    try {
      com.facebook.react.uimanager.UIManagerModule uiManager =
          reactContext.getNativeModule(com.facebook.react.uimanager.UIManagerModule.class);
      if (uiManager != null) {
        uiManager.getEventDispatcher().dispatchEvent(new LiveExoErrorEvent(getId(), reason));
      }
    } catch (Throwable ignored) {
    }
  }

  private void releasePlayer() {
    try {
      if (player != null) {
        try {
          player.setPlayWhenReady(false);
          player.stop();
        } catch (Throwable ignored) {
        }
        try {
          player.clearVideoTextureView(textureView);
        } catch (Throwable ignored) {
        }
        try {
          player.release();
        } catch (Throwable ignored) {
        }
      }
    } catch (Throwable ignored) {
    } finally {
      player = null;
    }
  }

  private void applyAspectTransform() {
    if (audioOnly) return; // 纯音频模式下不渲染画面，无需适配
    int hostW = getWidth();
    int hostH = getHeight();
    if (hostW <= 0 || hostH <= 0 || videoWidth <= 0 || videoHeight <= 0) return;
    float videoRatio = ((float) videoWidth * videoPixelRatio) / (float) videoHeight;
    float hostRatio = (float) hostW / (float) hostH;

    float scaleX = 1f;
    float scaleY = 1f;
    if (videoRatio > hostRatio) {
      scaleY = hostRatio / videoRatio;
    } else {
      scaleX = videoRatio / hostRatio;
    }

    Matrix matrix = new Matrix();
    matrix.setScale(scaleX, scaleY, hostW / 2f, hostH / 2f);
    textureView.setTransform(matrix);
  }

  private boolean isRtmp(String value) {
    return value.toLowerCase().startsWith("rtmp://");
  }

  private void setStatus(String text) {
    String value = text == null ? "" : text;
    String lower = value.toLowerCase();
    if (lower.contains("playing") || lower.contains("buffer")) {
      statusText.setVisibility(View.GONE);
      statusText.setText("");
      return;
    }
    statusText.setVisibility(value.isEmpty() ? View.GONE : View.VISIBLE);
    statusText.setText(value);
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }
}
