package com.yk1z.yayamsg;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.lang.ref.WeakReference;
import java.util.Map;

/** 原生 Exo 播放桥（exo-native-music）：下发队列/命令，进度等事件回流 JS。 */
public class RadioExoModule extends ReactContextBaseJavaModule {
  private static WeakReference<ReactApplicationContext> contextRef;

  public RadioExoModule(ReactApplicationContext reactContext) {
    super(reactContext);
    contextRef = new WeakReference<>(reactContext);
  }

  @NonNull @Override
  public String getName() { return "RadioExoModule"; }

  static void emitJs(Context ctx, String type, Map<String, Object> extra) {
    ReactApplicationContext rc = contextRef == null ? null : contextRef.get();
    if (rc == null || !rc.hasActiveCatalystInstance()) return;
    WritableMap payload = Arguments.createMap();
    payload.putString("type", type);
    if (extra != null) {
      for (Map.Entry<String, Object> e : extra.entrySet()) {
        Object v = e.getValue();
        if (v instanceof String) payload.putString(e.getKey(), (String) v);
        else if (v instanceof Boolean) payload.putBoolean(e.getKey(), (Boolean) v);
        else if (v instanceof Integer) payload.putInt(e.getKey(), (Integer) v);
        else if (v instanceof Double) payload.putDouble(e.getKey(), (Double) v);
        else if (v instanceof Float) payload.putDouble(e.getKey(), ((Float) v).doubleValue());
        else if (v instanceof Long) payload.putDouble(e.getKey(), ((Long) v).doubleValue());
      }
    }
    try {
      rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("YayaExoEvent", payload);
    } catch (Throwable ignored) {}
  }

  private void send(Intent i) {
    ReactApplicationContext ctx = getReactApplicationContext();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ctx.startForegroundService(i);
    } else {
      ctx.startService(i);
    }
  }

  @ReactMethod
  public void playQueue(String queueJson, int index, double positionSec, boolean playing, String headersJson) {
    Intent i = new Intent(getReactApplicationContext(), YayaExoService.class)
        .setAction(YayaExoService.ACTION_PLAY_QUEUE)
        .putExtra("queue", queueJson == null ? "[]" : queueJson)
        .putExtra("index", Math.max(0, index))
        .putExtra("position", positionSec)
        .putExtra("playing", playing)
        .putExtra("headers", headersJson == null ? "{}" : headersJson);
    send(i);
  }

  @ReactMethod
  public void control(String cmd, double positionSec) {
    Intent i = new Intent(getReactApplicationContext(), YayaExoService.class)
        .putExtra("cmd", cmd)
        .putExtra("position", positionSec);
    send(i);
  }
}
