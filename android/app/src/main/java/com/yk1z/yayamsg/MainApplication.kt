package com.yk1z.yayamsg

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider

import okhttp3.Interceptor

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

/** 与 src/api/bilibili.ts biliHeaders 一致的桌面 Chrome UA（B站风控按 UA 分端） */
private const val BILI_DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
          override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              add(LivePlayerPackage())
              add(PipPackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    // 最先安装：RN 网络模块的 OkHttp 客户端在 JS 首次发请求时才经 createClient(context) 构建，
    // 若先有别的请求把默认 client 缓存进 OkHttpClientProvider 就来不及了。
    installDesktopUaForBilibili()
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  /**
   * B站登录拿不到 cookie 的根因修复：Android RN 的 JS fetch 无法可靠携带自定义 User-Agent 头
   * （RN/OkHttp 路径会覆盖），B站 因此把扫码登录 poll 当移动端处理 → 不返回带 SESSDATA 的
   * crossDomain url（桌面浏览器正常）。这里在 OkHttp 层对 *.bilibili.com 请求强制覆写桌面 UA。
   */
  private fun installDesktopUaForBilibili() {
    OkHttpClientProvider.setOkHttpClientFactory(
      OkHttpClientFactory {
        OkHttpClientProvider.createClientBuilder(applicationContext)
          .addInterceptor(
            Interceptor { chain ->
              val request = chain.request()
              val host = request.url.host
              val isBiliHost = host == "bilibili.com" || host.endsWith(".bilibili.com")
              if (isBiliHost && request.header("User-Agent") != BILI_DESKTOP_UA) {
                chain.proceed(request.newBuilder().header("User-Agent", BILI_DESKTOP_UA).build())
              } else {
                chain.proceed(request)
              }
            }
          )
          .build()
      }
    )
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
