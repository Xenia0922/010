type JsonValue = any;

/**
 * 带超时的 fetch 封装（Hermes 兼容）。
 * 注意：不能用 AbortSignal.timeout() —— 该 API 在 React Native Hermes 中不存在，
 * 调用会抛 "undefined is not a function"（历史教训：曾导致音乐库/弹幕 LRC/歌词/成员库全部静默失败）。
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ?? controller.signal;
  return fetch(url, { ...options, signal }).finally(() => clearTimeout(timer));
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: any;
  /** POST body 编码，默认 JSON；raw 用于 form-urlencoded 等已序列化请求。 */
  bodyType?: 'json' | 'raw';
  headers?: Record<string, string>;
  /** 超时时间（毫秒），默认 GET=10000 / POST=15000 */
  timeout?: number;
  /** GET 响应缓存有效期（毫秒），0 或不传表示不缓存。仅对 GET 生效。 */
  cacheTtl?: number;
  /** 外部取消信号（如组件卸载时取消请求），与 timeout 互斥触发 */
  signal?: AbortSignal;
}

/**
 * 解析响应文本，兼容口袋48 接口把超大数字（如 15+ 位 ID）以 JSON 数字返回导致解析失败的情况。
 */
function parseResponse(text: string): JsonValue {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const fixed = text.replace(/:\s*([0-9]{15,})/g, ':"$1"');
    try {
      return JSON.parse(fixed);
    } catch {
      return text;
    }
  }
}

// --- 请求级优化：并发去重 + GET 缓存 ---
// 同一时刻相同 URL 的并发请求只发一次；GET 可带 TTL 短缓存，降低弱网/重复拉取开销。
const inflight = new Map<string, Promise<any>>();
const responseCache = new Map<string, { ts: number; data: JsonValue }>();

function requestKey(method: string, url: string, body?: any): string {
  return `${method} ${url}` + (method === 'POST' && body !== undefined ? ` ${JSON.stringify(body)}` : '');
}

/**
 * 统一的 JSON 请求封装。
 * - 基于 fetch + AbortController，支持超时取消与 signal 外部取消；
 * - GET 支持并发去重与可选 TTL 缓存；
 * - 保留原 XHR 实现的解析修正与错误消息提取逻辑。
 */
function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method || 'GET';
  const cacheTtl = options.cacheTtl ?? 0;
  const key = requestKey(method, url, options.body);

  // 命中 GET 缓存
  if (method === 'GET' && cacheTtl > 0) {
    const hit = responseCache.get(key);
    if (hit && Date.now() - hit.ts < cacheTtl) {
      return Promise.resolve(hit.data as T);
    }
  }

  // 并发去重：相同请求在途时复用（仅在无外部 signal 时去重，避免误取消）
  if (!options.signal && inflight.has(key)) {
    return inflight.get(key) as Promise<T>;
  }

  const promise = (async (): Promise<T> => {
    const controller = new AbortController();
    const timeout = options.timeout ?? (method === 'GET' ? 10000 : 15000);
    const timer = setTimeout(() => controller.abort(), timeout);
    // 外部 signal 也要生效：外部中止时联动内部 controller（否则 timeout 形同虚设）
    let extAbort: (() => void) | null = null;
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else {
        extAbort = () => controller.abort();
        options.signal.addEventListener('abort', extAbort, { once: true });
      }
    }

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json, text/plain, */*',
        ...(method === 'POST' ? { 'Content-Type': 'application/json;charset=utf-8' } : {}),
        ...(options.headers || {}),
      };

      const res = await fetch(url, {
        method,
        headers,
        body: method === 'POST'
          ? options.bodyType === 'raw'
            ? String(options.body ?? '')
            : JSON.stringify(options.body ?? {})
          : undefined,
        signal: options.signal ?? controller.signal,
      });

      clearTimeout(timer);
      if (extAbort && options.signal) options.signal.removeEventListener('abort', extAbort);
      const text = await res.text();
      const body = parseResponse(text);

      if (res.status >= 200 && res.status < 300) {
        if (method === 'GET' && cacheTtl > 0) {
          responseCache.set(key, { ts: Date.now(), data: body });
        }
        return body as T;
      }

      const message =
        (body && typeof body === 'object' && (body.message || body.msg || body.error)) ||
        (typeof body === 'string' && body.trim() ? body.trim().slice(0, 180) : '') ||
        `HTTP ${res.status}`;
      throw new Error(message);
    } catch (error: any) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') {
        throw new Error('网络请求超时');
      }
      // fetch 网络层失败（无连接等）抛 TypeError
      if (error instanceof TypeError) {
        throw new Error('网络请求失败');
      }
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();

  if (!options.signal) {
    inflight.set(key, promise);
  }
  return promise;
}

function fetchJson<T>(url: string, cacheTtl = 0): Promise<T> {
  return requestJson<T>(url, { method: 'GET', timeout: 10000, cacheTtl });
}

async function fetchJsonStrict<T>(url: string): Promise<T> {
  const res = await fetchJson<any>(url);
  if (!res || typeof res === 'string') throw new Error('响应不是有效 JSON');
  return res as T;
}

function xhrPost(url: string, data: any, headers: Record<string, string>): Promise<any> {
  return requestJson(url, {
    method: 'POST',
    body: data,
    headers,
    timeout: 15000,
  });
}

/**
 * 探测网络连通性：保留 XHR 实现（可探测任意外部域名，不受 CORS 限制），仅用于诊断面板。
 */
function probeUrl(url: string, timeout = 8000): Promise<{ ok: boolean; status: number; message: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = timeout;
    xhr.onload = () => {
      const ok = xhr.status >= 200 && xhr.status < 500;
      resolve({ ok, status: xhr.status, message: `HTTP ${xhr.status}` });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, message: '请求失败' });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, message: '请求超时' });
    try {
      xhr.send();
    } catch (error: any) {
      resolve({ ok: false, status: 0, message: error?.message || String(error) });
    }
  });
}

async function checkNetworkStatus() {
  const targets = [
    { name: '成员数据', url: 'https://data.gnz.hk/members.json' },
    { name: '口袋接口', url: 'https://pocketapi.48.cn/' },
    { name: '资源域名', url: 'https://source.48.cn/' },
    { name: 'B站接口', url: 'https://api.bilibili.com/x/web-interface/nav' },
  ];

  const results = await Promise.all(
    targets.map(async (target) => ({
      ...target,
      ...(await probeUrl(target.url)),
    })),
  );

  return {
    ok: results.some((item) => item.ok),
    results,
  };
}

export { requestJson, fetchJson, fetchJsonStrict, xhrPost, probeUrl, checkNetworkStatus };
