import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Android 13+ 通知权限请求（A1：POST_NOTIFICATIONS）。
 * - Android < 13 无此权限概念，直接返回 true；
 * - 已授权 / 用户拒绝均幂等（拒绝后不反复打扰，只提示一次 toast 由调用方决定）；
 * - 返回是否已授权。
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}
