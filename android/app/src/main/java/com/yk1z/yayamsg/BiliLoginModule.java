package com.yk1z.yayamsg;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * B站扫码登录 ticket 换 cookie（B站 2024+ 新协议）。
 *
 * 背景：扫码确认后 passport poll 返回的不再是「query 里带 SESSDATA 的旧式 crossDomain url」，
 * 而是 https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=xxx&gourl=... 。
 * cookie 由访问该 url 时服务端的 Set-Cookie 响应头下发（302）。
 *
 * RN fetch 拿不到这里：
 *  1. RN fetch 自动跟随 302 重定向，中间响应的 Set-Cookie 对 JS 不可见；
 *  2. JS 侧没有可靠手段关掉重定向跟随。
 * 故用原生 OkHttp：followRedirects(false) 停在 302 首包，直接读 Set-Cookie 头回传 JS。
 * JS 通过 NativeModules.BiliLoginModule.fetchTicket(url) 调用（Promise 返回 cookie 串）。
 */
public class BiliLoginModule extends ReactContextBaseJavaModule {

  private static final String DESKTOP_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

  private final OkHttpClient client;

  public BiliLoginModule(ReactApplicationContext reactContext) {
    super(reactContext);
    client = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build();
  }

  @NonNull
  @Override
  public String getName() {
    return "BiliLoginModule";
  }

  /**
   * 访问 ticket crossDomain url（不跟随 302），把响应里的所有 Set-Cookie 头拼成 "k=v; k=v" 返回。
   * 无论 302/200，都只取首个响应的 Set-Cookie（cookie 就在这包上）。
   */
  @ReactMethod
  public void fetchTicket(String ticketUrl, Promise promise) {
    if (ticketUrl == null || ticketUrl.isEmpty()) {
      promise.reject("E_TICKET_URL", "ticket url empty");
      return;
    }
    final Request request = new Request.Builder()
        .url(ticketUrl)
        .header("User-Agent", DESKTOP_UA)
        .header("Referer", "https://www.bilibili.com/")
        .get()
        .build();

    // OkHttp 网络调用不能跑主线程
    client.newCall(request).enqueue(new okhttp3.Callback() {
      @Override
      public void onFailure(@NonNull okhttp3.Call call, @NonNull java.io.IOException e) {
        promise.reject("E_FETCH_TICKET", "ticket request failed: " + e.getMessage());
      }

      @Override
      public void onResponse(@NonNull okhttp3.Call call, @NonNull Response response) {
        try {
          StringBuilder cookie = new StringBuilder();
          for (String line : response.headers("Set-Cookie")) {
            // "SESSDATA=xxx; Path=/; ..." → 只取 "k=v"，其余属性丢弃
            String kv = line == null ? "" : line.trim();
            int semi = kv.indexOf(';');
            if (semi >= 0) kv = kv.substring(0, semi).trim();
            if (kv.isEmpty() || !kv.contains("=")) continue;
            if (cookie.length() > 0) cookie.append("; ");
            cookie.append(kv);
          }
          promise.resolve(cookie.toString());
        } catch (Exception e) {
          promise.reject("E_PARSE_COOKIE", "parse set-cookie failed: " + e.getMessage());
        } finally {
          response.close();
        }
      }
    });
  }
}
