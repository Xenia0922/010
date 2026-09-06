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
    android.util.Log.i("YayaExo", "[sysdbg] MainActivity onCreate")
  }

  override fun onPause() {
    super.onPause()
    android.util.Log.i("YayaExo", "[sysdbg] MainActivity onPause")
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
    android.util.Log.i("YayaExo", "[sysdbg] MainActivity onResume")
    // 回前台：停掉后台补发窗口，然后立即重声明一次（覆盖回前台瞬间的会话刷新）
    reassertHandler.removeCallbacks(delayedReassert)
    reassertExoSession()
  }

  override fun onStop() {
    super.onStop()
    android.util.Log.i("YayaExo", "[sysdbg] MainActivity onStop")
  }

  override fun onStart() {
    super.onStart()
    android.util.Log.i("YayaExo", "[sysdbg] MainActivity onStart")
  }

  override fun onDestroy() {
    android.util.Log.i("YayaExo", "[sysdbg] MainActivity onDestroy")
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
   * 用户按 Home / 切到其他应用时：若 RN 侧标记有视频在播，自动进入画中画悬浮窗。
   * （RN 侧在播放器 onLoad 时 setVideoPlaying(true)，onEnd/onError/暂停时置 false）
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (PipModule.videoPlaying
        && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        && !isInPictureInPictureMode) {
      try {
        enterPictureInPictureMode(PipModule.buildPipParams())
      } catch (_: Exception) {
        // 部分 ROM 限制，静默
      }
    }
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
