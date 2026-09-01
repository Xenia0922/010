import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { APP_VERSION } from '../constants';

export type LogLevel = 'info' | 'warn' | 'error' | 'crash';

export interface LogEntry {
  id: string;
  t: number; // epoch ms
  level: LogLevel;
  msg: string;
  stack?: string;
  ctx?: string; // 可选上下文（如页面/函数名）
}

const STORAGE_KEY = 'yaya_runtime_log_v1';
const MAX_ENTRIES = 500;

let loaded = false;
let buffer: LogEntry[] = []; // 已落盘的日志（加载完成后使用）
let pending: LogEntry[] = []; // 加载完成前暂存
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let consoleInstalled = false;

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(buffer)).catch(() => {});
  }, 400);
}

function trim(arr: LogEntry[]): LogEntry[] {
  return arr.length > MAX_ENTRIES ? arr.slice(arr.length - MAX_ENTRIES) : arr;
}

function write(entry: LogEntry) {
  if (!loaded) {
    pending.push(entry);
    return;
  }
  buffer.push(entry);
  buffer = trim(buffer);
  persist();
}

function stringifyArg(a: unknown): string {
  if (a instanceof Error) return a.message;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function extractStack(args: unknown[]): string | undefined {
  const err = args.find((x) => x instanceof Error) as Error | undefined;
  return err?.stack;
}

// ===== 对外 API =====

/** console.debug 转发：logcat（ReactNativeJS tag）可见，且不被 installConsoleCapture 捕获 → 不重复 */
function tee(level: 'info' | 'warn' | 'error', tag: string | undefined, msg: string, stack?: string) {
  try {
    const line = tag ? `[${tag}] ${msg}` : msg;
    if (level === 'error') console.debug(`[ERR] ${line}${stack ? `\n${stack}` : ''}`);
    else console.debug(line);
  } catch {
    /* 忽略 */
  }
}

export function logInfo(msg: string, ctx?: string) {
  tee('info', ctx, msg);
  write({ id: genId(), t: Date.now(), level: 'info', msg, ctx });
}

export function logWarn(msg: string, ctx?: string) {
  tee('warn', ctx, msg);
  write({ id: genId(), t: Date.now(), level: 'warn', msg, ctx });
}

export function logError(err: unknown, ctx?: string) {
  const msg = err instanceof Error ? err.message : stringifyArg(err);
  const stack = err instanceof Error ? err.stack : undefined;
  tee('error', ctx, msg, stack);
  write({ id: genId(), t: Date.now(), level: 'error', msg, stack, ctx });
}

export function logCrash(err: unknown, ctx?: string) {
  const msg = err instanceof Error ? err.message : stringifyArg(err);
  const stack = err instanceof Error ? err.stack : undefined;
  write({ id: genId(), t: Date.now(), level: 'crash', msg, stack, ctx });
}

export function getLogEntries(): LogEntry[] {
  // 最新在前
  return [...buffer].reverse();
}

export function getLogCounts(): Record<LogLevel, number> {
  const c: Record<LogLevel, number> = { info: 0, warn: 0, error: 0, crash: 0 };
  for (const e of buffer) c[e.level] += 1;
  return c;
}

export async function clearLog() {
  buffer = [];
  pending = [];
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}

export function exportLogText(entries?: LogEntry[]): string {
  const src = (entries ?? buffer).slice().reverse(); // 与现有顺序保持一致（最新在前）
  const os = `${Platform.OS} ${String(Platform.Version)}`;
  const header = `牙牙消息 v${APP_VERSION} · ${os} · 日志导出 ${new Date().toLocaleString()}\n${'='.repeat(40)}`;
  const body = src
    .map((e) => {
      const d = new Date(e.t);
      const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      const tag = e.ctx ? `[${e.ctx}]` : '';
      const stack = e.stack ? `\n    ${e.stack.replace(/\n/g, '\n    ')}` : '';
      return `[${ts}] ${e.level.toUpperCase()} ${tag} ${e.msg}${stack}`;
    })
    .join('\n');
  return `${header}\n${body}\n`;
}

// 初始化：加载历史 + 会话标记 + 接管 console
export async function initRuntimeLog() {
  if (loaded) {
    // 已初始化，仅补一个会话开始的标记
    const os = `${Platform.OS} ${String(Platform.Version)}`;
    logInfo(`会话恢复 · 牙牙消息 v${APP_VERSION} · ${os}`);
    return;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) buffer = trim(parsed as LogEntry[]);
    }
  } catch {
    /* 忽略损坏数据 */
  }
  loaded = true;
  // 合并初始化前暂存的条目
  if (pending.length) {
    buffer = trim(buffer.concat(pending));
    pending = [];
    persist();
  }
  const os = `${Platform.OS} ${String(Platform.Version)}`;
  logInfo(`会话开始 · 牙牙消息 v${APP_VERSION} · ${os}`);
  installConsoleCapture();
}

// 接管 console.* ，让全应用已有的 console.warn/error 自动入日志
function installConsoleCapture() {
  if (consoleInstalled) return;
  consoleInstalled = true;
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  const origInfo = console.info.bind(console);
  const origLog = console.log.bind(console);

  console.error = (...args: unknown[]) => {
    origError(...args);
    write({
      id: genId(),
      t: Date.now(),
      level: 'error',
      msg: args.map(stringifyArg).join(' '),
      stack: extractStack(args),
      ctx: 'console',
    });
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    write({
      id: genId(),
      t: Date.now(),
      level: 'warn',
      msg: args.map(stringifyArg).join(' '),
      ctx: 'console',
    });
  };
  console.info = (...args: unknown[]) => {
    origInfo(...args);
    write({
      id: genId(),
      t: Date.now(),
      level: 'info',
      msg: args.map(stringifyArg).join(' '),
      ctx: 'console',
    });
  };
  console.log = (...args: unknown[]) => {
    origLog(...args);
    // log 量大，仅记录前若干字符，避免刷屏
    const text = args.map(stringifyArg).join(' ');
    if (text.length > 200) return;
    write({ id: genId(), t: Date.now(), level: 'info', msg: text, ctx: 'console' });
  };
}
