package com.yk1z.yayamsg

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  private val reassertHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val delayedReassert = object : Runnable {
    override fun run() { reassertExoSession() }
  }
  /** onPause 后延迟窗口内的补发点（ms）：ColorOS SystemUI 构建媒体卡通常滞后于 Home 键瞬间 */
  private val reassertBackoff = longArrayOf(400, 1200, 3200)

  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun onPause() {
    super.onPause()
    // 视频（直播/录播/网页）在播并被系统小窗（PiP）接管时，绝不重声明音乐会话——
    // 否则 SystemUI 的 PiP/媒体控件会绑到音乐而非画面中的视频（用户反馈"控件控制的是音乐"根因之一）。
    // 仅无视频在播（听歌/一般页面切后台）才补发音乐会话重声明。
    if (PipModule.videoPlaying) {
      // 系统小窗开关关闭：切后台不自动进 PiP，视频将随 Activity 后台停止 —— 顺手停掉
      // "暂停残留"的音乐前台服务，避免 SystemUI 媒体卡残留 App 的（音乐）控件。
      if (!PipModule.pipEnabled) stopMusicIfIdle()
      return
    }
    // 离开前台（按 Home/切应用/进通知栏）前重声明 Exo 会话：
    // ColorOS 在「音乐页→App 首页→再切后台」路径上把媒体卡绑到过期会话状态 → 通知栏/锁屏控件失灵。
    // 关键点：此路径在切后台前没有 onResume（导航回首页不触发 resume），
    // 若只在 onResume 重声明，控件失灵的瞬间永远等不到修复 → 必须 onPause 也重声明一次。
    // ⚠️ 且 SystemUI 的媒体卡/胶囊构建通常滞后 Home 键数百 ms~数秒——一次 onPause 重声明不够，
    // 需要在退后台后的延迟窗口内再补发几次（覆盖 ColorOS 懒构建/懒绑定），直到前台恢复才停。
    reassertExoSession()
    for (d in reassertBackoff) {
      reassertHandler.removeCallbacks(delayedReassert)
      reassertHandler.postDelayed(delayedReassert, d)
    }
  }

  override fun onResume() {
    super.onResume()
    // 回前台：停掉后台补发窗口，然后立即重声明一次（覆盖回前台瞬间的会话刷新）
    reassertHandler.removeCallbacks(delayedReassert)
    reassertExoSession()
  }

  override fun onStop() {
    super.onStop()
  }

  override fun onStart() {
    super.onStart()
  }

  override fun onDestroy() {
    super.onDestroy()
  }

  /** 前台恢复即重声明 Exo 媒体会话（服务未在播时自灭，不留多余通知/卡片） */
  private fun reassertExoSession() {
    try {
      val i = android.content.Intent(this, YayaExoService::class.java)
          .setAction(YayaExoService.ACTION_REASSERT)
      startService(i)
    } catch (_: Throwable) { }
  }

  /**
   * 用户按 Home / 切到其他应用时：若设置了"画中画"开关且 RN 侧标记有视频在播，
   * 自动进入画中画悬浮窗；开关关闭则绝不弹 App 外系统小窗（用户没主动要小窗就不加载）。
   * （RN 侧在播放器 onLoad 时 setVideoPlaying(true)，onEnd/onError/暂停时置 false）
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (!PipModule.videoPlaying || !PipModule.pipEnabled) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        && !isInPictureInPictureMode) {
      try {
        enterPictureInPictureMode(PipModule.buildPipParams())
      } catch (_: Exception) {
        // 部分 ROM 限制，静默
      }
      // 视频小窗接管媒体身份：音乐若只是"暂停/未起播"（服务与通知仍在）则彻底停掉，
      // 释放其 MediaSession，避免 SystemUI 把 PiP/通知卡控件绑到音乐上。
      // 音乐真正在放（playWhenReady，罕见双音场景）则不打断。
      stopMusicIfIdle()
    }
  }

  /** 音乐服务只是"暂停残留"（无真实播放）则彻底停掉：撤前台通知、释放 MediaSession */
  private fun stopMusicIfIdle() {
    if (YayaExoService.musicActuallyPlaying) return
    try {
      startService(
        android.content.Intent(this, YayaExoService::class.java)
          .putExtra("cmd", "stop")
      )
    } catch (_: Throwable) { }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
