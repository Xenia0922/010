export function getPlayerHtml(streamUrl: string, posterUrl?: string, initialTime?: number, showControls = true, extraHeaders: Record<string, string> = {}): string {
  const poster = posterUrl || '';
  const startTime = Number.isFinite(initialTime) && (initialTime as number) > 0 ? (initialTime as number) : 0;
  // 直播流不挂原生 controls：HTML5 播放条上的进度条/预览对直播无意义且遮挡画面
  const videoControls = showControls ? 'controls' : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#000;display:flex;align-items:center;justify-content:center;width:100vw;height:100vh;overflow:hidden}
  #player-wrapper{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center}
  video{width:100%;height:auto;max-height:100vh;background:#000}
  #loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#5a5a5a;font-size:14px;font-family:sans-serif}
  .spinner{border:2px solid #333;border-top:2px solid #ff6f91;border-radius:50%;width:24px;height:24px;animation:spin 1s linear infinite;margin:0 auto 8px}
  @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
  #error{display:none;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#ff4444;font-size:13px;font-family:sans-serif;text-align:center;padding:16px;line-height:1.6}
</style>
<script src="https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js"></script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.4.0/dist/hls.min.js"></script>
</head>
<body>
<div id="player-wrapper">
  <video id="video" ${videoControls} autoplay playsinline webkit-playsinline poster="${poster}"></video>
  <div id="loading">
    <div class="spinner"></div>
  </div>
  <div id="error"></div>
</div>
<script>
(function() {
  var video = document.getElementById('video');
  var loading = document.getElementById('loading');
  var errorDiv = document.getElementById('error');

  function showError(msg) {
    loading.style.display = 'none';
    errorDiv.style.display = 'block';
    errorDiv.textContent = msg;
  }

  function hideLoading() {
    loading.style.display = 'none';
  }

  var startTime = ${JSON.stringify(startTime)};
  var EXTRA_HEADERS = ${JSON.stringify(extraHeaders || {})};
  // 请求级防盗链头（B站流必需；flv/hls 的 XHR 都经它补头）
  function applyHeaders(xhr) {
    try {
      for (var k in EXTRA_HEADERS) {
        if (EXTRA_HEADERS.hasOwnProperty(k)) xhr.setRequestHeader(k, EXTRA_HEADERS[k]);
      }
    } catch (e) {}
  }
  function makeXhrSetup() { return function(xhr) { applyHeaders(xhr); }; }

  // 续播位置回传：定期 + 暂停时上报当前进度（由 RN 侧落盘）
  function reportProgress() {
    if (window.ReactNativeWebView && video.currentTime > 0) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'progress', time: video.currentTime }));
      } catch (e) {}
    }
  }
  video.addEventListener('pause', reportProgress);
  video.addEventListener('ended', function() {
    if (window.ReactNativeWebView) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ended' })); } catch (e) {}
    }
  });
  setInterval(reportProgress, 2000);

  // 画面真实可播立即撤掉 loading（flv.play() promise 在部分 WebView 不 resolve → spinner 常驻）
  var startedSent = false;
  function markStarted() {
    hideLoading();
    if (!startedSent && window.ReactNativeWebView) {
      startedSent = true;
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'started' })); } catch (e) {}
    }
  }
  video.addEventListener('playing', markStarted);
  video.addEventListener('canplay', markStarted);
  video.addEventListener('error', function() { showError('视频源错误'); });

  video.addEventListener('loadedmetadata', function() {
    if (startTime && startTime > 0) {
      try { video.currentTime = startTime; } catch (e) {}
    }
  });

  // 外部控制指令（RN 控制层）：seek / 倍速 / 播放暂停
  if (window.ReactNativeWebView) {
    window.addEventListener('message', function(ev) {
      var msg = {};
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      try {
        if (msg.type === 'seek' && typeof msg.time === 'number') video.currentTime = msg.time;
        else if (msg.type === 'rate' && msg.rate > 0) video.playbackRate = msg.rate;
        else if (msg.type === 'play') video.play();
        else if (msg.type === 'pause') video.pause();
      } catch (e) {}
    });
  }

  var url = ${JSON.stringify(streamUrl)};
  var ext = url.split('?')[0].split('#')[0].toLowerCase();

  function tryNative() {
    video.src = url;
    video.load();
    video.play().then(function() {
      hideLoading();
    }).catch(function(e) {
      showError('网页原生播放失败: ' + e.message);
    });
  }

  try {
    if (ext.endsWith('.m3u8') || url.indexOf('m3u8') > -1 || url.indexOf('.ts') > -1) {
      if (window.Hls && Hls.isSupported()) {
        var hls = new Hls({ enableWorker: true, lowLatencyMode: false, xhrSetup: makeXhrSetup() });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, function() {
          hideLoading();
          video.play().catch(function(){});
        });
        hls.on(Hls.Events.ERROR, function(evt, data) {
          if (data.fatal) {
            showError('HLS 加载失败');
            hls.destroy();
          }
        });
      } else {
        tryNative();
      }
    } else if (ext.endsWith('.flv') || url.indexOf('flv') > -1) {
      if (window.mpegts && mpegts.isSupported()) {
        var flv = mpegts.createPlayer({
          type: 'flv',
          url: url,
          isLive: true,
          hasAudio: true,
          hasVideo: true,
          enableStashBuffer: false,
          stashInitialSize: 128,
          xhrSetup: makeXhrSetup()
        });
        flv.attachMediaElement(video);
        flv.load();
        flv.play().then(function() {
          hideLoading();
        }).catch(function(e) {
          showError('FLV 播放失败: ' + e.message);
        });
        flv.on(mpegts.Events.ERROR, function() {
          showError('FLV 加载失败');
          flv.destroy();
        });
      } else {
        tryNative();
      }
    } else {
      tryNative();
    }
  } catch(e) {
    showError('网页播放器异常: ' + e.message);
  }
})();
</script>
</body>
</html>`;
}

export default { getPlayerHtml };
