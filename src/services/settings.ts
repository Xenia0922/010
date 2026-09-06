import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings } from '../types';
import { logError } from '../utils/runtimeLog';

const SETTINGS_KEY = 'yaya_settings';
let settingsCache: AppSettings | null = null;
let settingsLoadPromise: Promise<AppSettings> | null = null;
let settingsWriteChain: Promise<void> = Promise.resolve();

// 默认设置唯一权威源：store/index.ts 的 useSettingsStore 也从这里取初始值，
// 新增字段只改这一处（此前双源曾漏掉 meet48Auth，导致该字段在 store 有值、持久化默认丢失）。
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  language: 'system',
  p48Token: '',
  bilibiliCookie: '',
  bilibiliUserInfo: null,
  msg_sort_order: 'desc',
  yaya_followed_custom_order: [],
  yaya_music_play_mode: 'sequential',
  yaya_music_volume: 0.7,
  yaya_audio_program_play_mode: 'sequential',
  yaya_auto_checkin_enabled: false,
  yaya_auto_checkin_last_date: '',
  yaya_auto_checkin_last_user: '',
  yaya_trip_show_all: false,
  customBackgroundFile: '',
  customBackgroundUpdatedAt: 0,
  meet48Auth: null,
  pip_auto: false,
};

export async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return { ...settingsCache };
  if (settingsLoadPromise) return settingsLoadPromise.then((settings) => ({ ...settings }));

  settingsLoadPromise = (async () => {
    let settings = { ...DEFAULT_SETTINGS };
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_KEY);
      if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
      logError(e, 'settings.loadSettings');
    }
    settingsCache = settings;
    return { ...settings };
  })();

  try {
    return await settingsLoadPromise;
  } finally {
    settingsLoadPromise = null;
  }
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const operation = settingsWriteChain
    .catch(() => undefined)
    .then(async () => {
      const current = await loadSettings();
      const merged = { ...current, ...settings };
      settingsCache = merged;
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    });
  settingsWriteChain = operation;
  await operation;
}

export async function getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
  const settings = await loadSettings();
  return settings[key];
}

export async function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  await saveSettings({ [key]: value });
}

export async function clearSettings(): Promise<void> {
  const operation = settingsWriteChain
    .catch(() => undefined)
    .then(async () => {
      settingsCache = { ...DEFAULT_SETTINGS };
      await AsyncStorage.removeItem(SETTINGS_KEY);
    });
  settingsWriteChain = operation;
  await operation;
}
