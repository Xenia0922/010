package com.yk1z.yayamsg

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
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
  }

  override fun onResume() {
    super.onResume()
    android.util.Log.i("YayaExo", "[sysdbg] MainActivity onResume")
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
