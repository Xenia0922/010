import { useMemberStore, useSettingsStore } from '../store';
import { generatePa, generatePaAsync, getWasmError, initWasm } from '../auth';
import { requestJson, xhrPost, fetchWithTimeout } from '../utils/network';
import { unwrapList, normalizeUrl } from '../utils/data';
import AsyncStorage from '@react-native-async-storage/async-storage';

// E2 记录：移动端 API 方法数少于桌面端 v2.11 通道（100+）——未移植的桌面通道：
// 选举计分（score-*）、花漾（pageantry-*）、QR 登录（login-*-qr）、部分 Area48 话题接口；
// 移动端无对应 UI，历史确认不在范围。新增接口时以桌面 pocket-runtime.mjs 为参数/头权威源。

const BASE = 'https://pocketapi.48.cn';
const APP_VERSION = '7.0.41';
const APP_BUILD = '24011601';

type HeadersMap = Record<string, string>;

function createDeviceId(): string {
  const chars = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890';
  const rand = (length: number) => {
    let result = '';
    for (let i = 0; i < length; i += 1) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
  };
  return `${rand(8)}-${rand(4)}-${rand(4)}-${rand(4)}-${rand(12)}`;
}

// 设备指纹持久化：DEVICE_ID 不再每次冷启动随机（随机 id 会被服务端风控判定为异常设备，
// 也破坏「同一账号同一设备」的连续性）。首次生成后写入 AsyncStorage，后续启动复用；
// 进程内同步先落一个临时 id 保证早期请求可用，AsyncStorage 读回后以持久值替换。
const DEVICE_ID_KEY = 'yaya_device_id_v1';
let DEVICE_ID = createDeviceId();
let deviceIdLoaded = false;
AsyncStorage.getItem(DEVICE_ID_KEY)
  .then((saved) => {
    if (saved) DEVICE_ID = saved;
    deviceIdLoaded = true;
  })
  .catch(() => { deviceIdLoaded = true; });

/** 等待持久化 DEVICE_ID 就绪（最多 ~800ms，超时用内存临时 id 兜底，不阻塞请求） */
async function ensureDeviceId(): Promise<string> {
  if (deviceIdLoaded) return DEVICE_ID;
  const deadline = Date.now() + 800;
  while (!deviceIdLoaded && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 40));
  }
  if (deviceIdLoaded) return DEVICE_ID;
  // 持久化未回（异常环境）：本次进程使用临时 id，并尝试补写
  AsyncStorage.setItem(DEVICE_ID_KEY, DEVICE_ID).catch(() => {});
  return DEVICE_ID;
}

// --- App Info / Headers factories ---

function appInfo(modern = false, deviceId = DEVICE_ID) {
  if (modern) {
    return {
      vendor: 'apple',
      deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
      appVersion: '7.1.35',
      appBuild: '25101021',
      osVersion: '16.3.0',
      osType: 'ios',
      deviceName: 'iPhone 14 Pro',
      os: 'ios',
    };
  }
  return {
    vendor: 'apple',
    deviceId,
    appVersion: APP_VERSION,
    appBuild: APP_BUILD,
    osVersion: '16.3.1',
    osType: 'ios',
    deviceName: 'iPhone XR',
    os: 'ios',
  };
}

function createHeaders(token?: string, pa?: string | null, modern = false, deviceId = DEVICE_ID): HeadersMap {
  const headers: HeadersMap = {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': modern
      ? 'PocketFans201807/7.1.35 (iPhone; iOS 16.3; Scale/3.00)'
      : `PocketFans201807/${APP_VERSION} (iPhone; iOS 16.3.1; Scale/2.00)`,
    Host: 'pocketapi.48.cn',
    'Accept-Language': 'zh-Hans-CN;q=1',
    Accept: '*/*',
    appInfo: JSON.stringify(appInfo(modern, deviceId)),
  };
  if (token) headers.token = token;
  if (pa) headers.pa = pa;
  return headers;
}

function createModernHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createHeaders(token, pa, true);
  headers.appInfo = JSON.stringify({
    vendor: 'apple',
    deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
    appVersion: '7.1.35',
    appBuild: '25101021',
    osVersion: '16.3.0',
    osType: 'ios',
    deviceName: 'iPhone 14 Pro',
    os: 'ios',
  });
  headers['User-Agent'] = 'PocketFans201807/7.1.35 (iPhone; iOS 16.3; Scale/3.00)';
  headers['Content-Type'] = 'application/json;charset=utf-8';
  delete (headers as any).Origin;
  delete (headers as any).Referer;
  return headers;
}

function createCheckinHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createModernHeaders(token, pa);
  headers['P-Sign-Type'] = 'V0';
  return headers;
}

/** Android 客户端头（posts 相册/视频/动态、私信删除等） */
function createPocketAndroidHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers: HeadersMap = {
    'Content-Type': 'application/json; charset=UTF-8',
    'User-Agent': 'PocketFans201807/7.1.43_26070701 (SM-G9730:Android 12;Samsung V417IR release-keys)',
    'Accept-Language': 'zh-Hans-CN;q=1',
    Accept: '*/*',
    Host: 'pocketapi.48.cn',
    appInfo: JSON.stringify({
      IMEI: '7b93dfd0472f4736a628e85fae086486',
      appBuild: '26070701',
      appName: 'pocket48',
      appVersion: '7.1.43',
      deviceId: '7b93dfd0472f4736a628e85fae086486',
      deviceName: 'SM-G9730',
      osType: 'android',
      osVersion: '12',
      phoneName: 'SM-G9730',
      phoneSystemVersion: '12',
      vendor: 'Samsung',
    }),
  };
  if (token) headers.token = token;
  if (pa) headers.pa = pa;
  return headers;
}

/** Seine（ckg48 新版客户端）Android 头 */
function createSeineHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createPocketAndroidHeaders(token, pa);
  headers.appInfo = JSON.stringify({
    appVersion: '1.0.0',
    appBuild: 26061101,
    osType: 'android',
    appName: 'seine48',
    deviceId: '7b93dfd0472f4736a628e85fae086486',
    deviceName: 'SM-G9730',
    osVersion: '12',
    vendor: 'Samsung',
    IMEI: '7b93dfd0472f4736a628e85fae086486',
    phoneName: 'SM-G9730',
    phoneSystemVersion: '12',
  });
  headers['X-Custom-Device-Type'] = 'ANDROID';
  headers['User-Agent'] = 'PocketFans201807/1.0.0_26061101 (SM-G9730:Android 12;Samsung V417IR release-keys)';
  return headers;
}

/** Seine iOS 头（公演列表走 ckg48 域名） */
function createSeineIosHeaders(): HeadersMap {
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    Accept: '*/*',
    'Accept-Language': 'zh-Hans-CN;q=1',
    'User-Agent': 'Seina/1.2.0 (com.seine48.app; build:26072902; iOS 27.0.0) Alamofire/5.8.0',
    appInfo: JSON.stringify({
      deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
      appVersion: '1.2.0',
      deviceName: 'iPhone 16 Pro',
      osType: 'ios',
      appBuild: '26072902',
      osVersion: '27.0',
      appName: 'seine48',
      vendor: 'apple',
    }),
  };
}

/** Area48 社区头（老版 Android 客户端 6.0.22） */
function createArea48Headers(token?: string, pa?: string | null): HeadersMap {
  const headers: HeadersMap = {
    'Content-Type': 'application/json; charset=UTF-8',
    Accept: '*/*',
    'Accept-Language': 'zh-Hans-CN;q=1',
    'User-Agent': 'PocketFans201807/6.0.22_201128 (SM-G9730:Android 12;Samsung V417IR release-keys)',
    Host: 'pocketapi.48.cn',
    appInfo: JSON.stringify({
      IMEI: '6172656134383a303030303030',
      appBuild: '201128',
      appVersion: '6.0.22',
      deviceId: '6172656134383a303030303030',
      deviceName: 'SM-G9730',
      osType: 'android',
      osVersion: '12',
      phoneName: 'SM-G9730',
      phoneSystemVersion: '12',
      vendor: 'Samsung',
    }),
  };
  if (token) headers.token = token;
  if (pa) headers.pa = pa;
  return headers;
}

function createWeiboHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createModernHeaders(token, pa);
  headers.appInfo = JSON.stringify({
    vendor: 'apple',
    deviceId: '7B93DFD0-472F-4736-A628-E85FAE086487',
    appVersion: '7.1.38',
    appBuild: '26042402',
    osVersion: '26.5.0',
    osType: 'ios',
    deviceName: 'iPhone17,1',
    os: 'ios',
  });
  headers['User-Agent'] = 'PocketFans201807/7.1.38 (iPhone; iOS 26.5; Scale/3.00)';
  headers['P-Sign-Type'] = 'V0';
  return headers;
}

function createInvoiceHeaders(token?: string, options?: { tokenHeader?: boolean }): HeadersMap {
  const headers: HeadersMap = {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json, text/plain, */*',
    Host: 'pocketapi.48.cn',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  };
  if (options?.tokenHeader && token) headers.token = token;
  return headers;
}

function createPfileHeaders(token?: string, pa?: string | null): HeadersMap {
  const headers = createModernHeaders(token, pa);
  delete headers['Content-Type'];
  delete headers.Host;
  return headers;
}


function createMeet48Headers(): HeadersMap {
  const settings = useSettingsStore.getState().settings;
  const storedAuth = settings.meet48Auth;
  const authDisabled = storedAuth?.disabled === true;
  const deviceId = (!authDisabled && storedAuth?.deviceId) || createDeviceId();
  const headers: HeadersMap = {
    'content-type': 'application/json',
    accept: '*/*',
    'accept-language': 'zh_TW',
    'user-agent': 'Meet48/2.0.3 (com.dapp.meet48; build:2602062; iOS 26.4.2) Alamofire/5.8.0',
    'x-versioncode': '2.0.3',
    'x-app-id': '2e63a31eac9d056755b0f83b89ef6674',
    'x-device-info': JSON.stringify({
      appVersion: '2.0.3',
      deviceId,
      osType: 'ios',
      appName: 'Meet48',
      vendor: 'apple',
      osVersion: '26.4.2',
      appBuildId: '2602062',
      osLoginType: 'common',
      bundleId: 'com.dapp.meet48',
      deviceName: 'iPhone17,1',
    }),
    'x-web-type': '1',
    'x-deviceid': deviceId,
    'x-custom-device-type': 'IOS',
  };
  const token = authDisabled ? '' : (storedAuth?.token || '');
  const cookie = authDisabled ? '' : (storedAuth?.cookie || '');
  if (token) headers.token = token;
  if (cookie) headers.cookie = cookie;
  return headers;
}

function tokenFromStore(): string {
  return useSettingsStore.getState().settings.p48Token || '';
}

function requireToken(): string {
  const token = tokenFromStore();
  if (!token) throw new Error('缺少 Token，请先登录口袋48或粘贴 Token');
  return token;
}

function responseOk(data: any): boolean {
  if (!data) return false;
  if (data.success === false) return false;
  if (typeof data.status === 'number' && data.status !== 200) return false;
  if (typeof data.code === 'number' && data.code !== 0) return false;
  if (data.success === true) return true;
  if (data.status === 200) return true;
  if (data.code === 0) return true;
  if (data.content !== undefined || data.data !== undefined || data.list !== undefined) return true;
  return false;
}

function responseMessage(data: any, fallback: string): string {
  return data?.message || data?.msg || data?.error || data?.statusDesc || fallback;
}

function assertPocketOk(data: any, fallback = 'pocket api request failed') {
  if (responseOk(data)) return data;
  const detail = responseMessage(data, fallback);
  const status = data?.status ?? data?.code;
  throw new Error(status !== undefined ? `${detail} (${status})` : detail);
}

async function createSignedHeaders(token?: string, modern = false, patch: HeadersMap = {}) {
  await initWasm();
  const pa = await generatePaAsync();
  if (!pa) {
    const reason = getWasmError();
    throw new Error(reason ? `签名模块未就绪：${reason}` : '签名模块未就绪，无法请求口袋接口');
  }
  const deviceId = await ensureDeviceId();
  return {
    ...createHeaders(token, pa, modern, deviceId),
    ...patch,
  };
}

async function rawPost(url: string, data: any, options: { token?: string; modern?: boolean; headers?: HeadersMap; signed?: boolean } = {}) {
  const token = options.token ?? tokenFromStore();
  const headers = options.signed === false
    ? { ...createHeaders(token, null, !!options.modern, await ensureDeviceId()), ...(options.headers || {}) }
    : await createSignedHeaders(token, !!options.modern, options.headers || {});
  return xhrPost(url, data, headers);
}

function parsePocketJson(text: string): any {
  if (!text) return null;
  const fixed = text.replace(/:\s*([0-9]{15,})/g, ':"$1"');
  try {
    return JSON.parse(fixed);
  } catch {
    return { status: 500, success: false, message: fixed.replace(/\s+/g, ' ').slice(0, 180) };
  }
}

async function signedHeaders(token?: string, modern = false, patch: HeadersMap = {}) {
  return createSignedHeaders(token ?? tokenFromStore(), modern, patch);
}

async function pocketPost(url: string, data: any, options: { tokenRequired?: boolean; modern?: boolean; headers?: HeadersMap; fallback?: string; signed?: boolean } = {}) {
  const token = options.tokenRequired === false ? tokenFromStore() : requireToken();
  const res = await rawPost(url, data, {
    token,
    modern: options.modern,
    headers: options.headers,
    signed: options.signed !== false,
  });
  return assertPocketOk(res, options.fallback);
}

async function publicMediaPost(url: string, data: any, fallback: string) {
  const res = await requestJson<any>(url, {
    method: 'POST',
    body: data,
    timeout: 15000,
    headers: {
      'app-info': JSON.stringify({
        vendor: 'google',
        deviceId: '123',
        appVersion: '6.0.0',
        appBuild: '123',
        osType: 'android',
        osVersion: '10.0.0',
        deviceName: 'pixel',
      }),
    },
  });
  return assertPocketOk(res, fallback);
}

function pushUniqueId(target: string[], value: any) {
  const text = String(value || '');
  if (!text || text === '0' || target.includes(text)) return;
  target.push(text);
}

function collectServerIdsForChannel(node: any, channelId: string, target: string[], depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectServerIdsForChannel(item, channelId, target, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;

  const nodeChannel = String(
    node.channelId
      || node.roomId
      || node.teamInfo?.channelId
      || node.teamInfo?.roomId
      || '',
  );
  if (nodeChannel === String(channelId)) {
    pushUniqueId(target, node.serverId || node.serverID || node.teamInfo?.serverId || node.teamInfo?.serverID);
  }

  Object.entries(node).forEach(([key, value]) => {
    if (String(key) === String(channelId)) pushUniqueId(target, value);
    collectServerIdsForChannel(value, channelId, target, depth + 1);
  });
}

async function resolveServerIds(channelId: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    const res = await pocketPost(`${BASE}/im/api/v1/im/team/room/info`, { channelId: String(channelId) });
    pushUniqueId(ids, res?.content?.serverId || res?.content?.teamInfo?.serverId || res?.data?.serverId || res?.serverId);
  } catch {
    // Fall through to the server map; some large rooms have stale local serverId values.
  }
  try {
    const res = await pocketPost(`${BASE}/im/api/v1/team/star/server/map/get`, {}, {
      modern: true,
      fallback: 'get room server map failed',
    });
    collectServerIdsForChannel(res, channelId, ids);
  } catch {
    // The map is a fallback only.
  }
  return ids;
}

async function resolveServerId(channelId: string): Promise<string> {
  const ids = await resolveServerIds(channelId);
  return ids[0] || '';
}

function rememberServerId(channelId: string, serverId: string) {
  if (!channelId || !serverId || serverId === '0') return;
  useMemberStore.getState().updateMemberRoomIds(channelId, { serverId });
}

async function tryPocketPost(
  attempts: Array<{ url: string; payload: any; modern?: boolean; tokenRequired?: boolean; signed?: boolean; label: string }>,
  fallback: string,
) {
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const res = await pocketPost(attempt.url, attempt.payload, {
        modern: attempt.modern,
        tokenRequired: attempt.tokenRequired,
        signed: attempt.signed,
        fallback: `${fallback}: ${attempt.label}`,
      });
      return {
        ...res,
        _request: {
          label: attempt.label,
          payload: attempt.payload,
        },
      };
    } catch (error: any) {
      errors.push(`${attempt.label}: ${error?.message || String(error)}`);
    }
  }
  throw new Error(errors.join('\n') || fallback);
}

function safeNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export const pocketApi = {
  initWasm,
  generatePa,
  generatePaAsync,

  async loginSendSms(mobile: string, area = '86', answer?: string) {
    const payload: any = { mobile, area };
    if (answer) payload.answer = answer;
    const data = await rawPost(`${BASE}/user/api/v1/sms/send2`, payload, { signed: false });
    if (data.status === 200 || data.success) return { success: true };
    if (data.status === 2001) {
      try {
        const verificationData = JSON.parse(data.message);
        return {
          success: false,
          needVerification: true,
          question: verificationData.question,
          options: verificationData.answer,
        };
      } catch {
        return { success: false, msg: data.message || '需要安全验证' };
      }
    }
    return { success: false, msg: responseMessage(data, '验证码发送失败') };
  },

  async loginByCode(mobile: string, code: string) {
    const res = await rawPost(`${BASE}/user/api/v1/login/app/mobile/code`, { mobile, code }, { token: '', signed: true });
    return assertPocketOk(res, '登录失败');
  },

  async loginCheckToken() {
    return pocketPost(`${BASE}/user/api/v1/user/info/reload`, { from: 'appstart' }, { fallback: 'Token 无效' });
  },

  async editUserInfo(params: { key?: string; value?: string; nickName?: string; avatar?: string }) {
    const changes: Array<{ key: string; value: string }> = [];
    if (params.key) {
      changes.push({ key: String(params.key), value: String(params.value ?? '') });
    } else {
      if (params.nickName?.trim()) changes.push({ key: 'nickname', value: params.nickName.trim() });
      if (params.avatar?.trim()) changes.push({ key: 'avatar', value: params.avatar.trim() });
    }
    if (!changes.length) throw new Error('缺少修改字段');

    const results = [];
    for (const change of changes) {
      const res = await pocketPost(`${BASE}/user/api/v1/user/info/edit`, change, {
        modern: true,
        fallback: '修改资料失败',
      });
      results.push(res);
    }
    return results[results.length - 1];
  },

  async getUserRenameCount() {
    return pocketPost(`${BASE}/user/api/v1/user/rename/count`, {}, {
      modern: true,
      fallback: '获取改名次数失败',
    });
  },

  async uploadUserAvatar(params: { uri: string; fileName?: string; mimeType?: string }) {
    const token = requireToken();
    const headers = await signedHeaders(token, true);
    delete headers['Content-Type'];
    delete headers.Host;
    const mimeType = params.mimeType || 'image/jpeg';
    const fileName = params.fileName || `avatar-${Date.now()}.${mimeType.includes('png') ? 'png' : 'jpg'}`;
    const formData = new FormData();
    formData.append('fromType', 'avatar');
    formData.append('file', {
      uri: params.uri,
      name: fileName,
      type: mimeType,
    } as any);
    // FormData 上传无法走 requestJson（其会 JSON.stringify body），这里保留 fetch 但补超时取消，防无限挂起
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch('https://pfile.48.cn/filesystem/upload/image', {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });
    } catch (error: any) {
      throw new Error(error?.name === 'AbortError' ? '上传头像超时' : '上传头像网络失败');
    } finally {
      clearTimeout(timer);
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
    if (response.ok && data && (data.status === 200 || data.success)) {
      const item = Array.isArray(data.content) ? data.content[0] : data.content;
      const path = item?.path || item?.url || item?.filePath || '';
      if (!path) throw new Error('上传头像成功但没有返回图片路径');
      return { success: true, content: item, path };
    }
    const source = data || response;
    throw new Error((source as any)?.message || (source as any)?.msg || `上传失败 HTTP ${response.status}`);
  },

  async checkIn() {
    const res = await rawPost(`${BASE}/user/api/v1/checkin`, {}, {
      token: requireToken(),
      modern: true,
      headers: { 'P-Sign-Type': 'V0' },
      signed: true,
    });
    if (responseOk(res)) return res;
    const message = responseMessage(res, '签到失败');
    if (/\u5df2\u7b7e\u5230|\u91cd\u590d\u7b7e\u5230|\u5df2\u7ecf\u7b7e\u5230|\u5df2\u9886\u53d6|\u660e\u5929\u518d\u6765/.test(message)) {
      return { success: true, status: res?.status ?? res?.code ?? 200, message, content: res?.content || null, alreadyChecked: true };
    }
    throw new Error(res?.status !== undefined || res?.code !== undefined ? `${message} (${res?.status ?? res?.code})` : message);
  },

  async getCheckinToday() {
    return pocketPost(`${BASE}/user/api/v1/checkin/check/today`, {}, {
      modern: true,
      fallback: '获取今日签到状态失败',
    });
  },

  async getNimLoginInfo() {
    // E1：优先走桌面 v2.11 同款新通道 im/api/v1/im/userinfo（P-Sign-Type V0）——
    // 官方云信凭证新接口，返回 content.accid/accId/imUserId + pwd/token/imPwd + userId；
    // 失败再回退旧路径（user/info/reload / user/info/home）多路兜底，防旧接口下线后私信/签到失效。
    try {
      const res = await pocketPost(`${BASE}/im/api/v1/im/userinfo`, {}, {
        headers: createCheckinHeaders(),
        fallback: '获取云信凭证失败',
      });
      if (res?.content) return res;
    } catch {
      /* 落到旧多路兜底 */
    }
    return tryPocketPost([
      {
        url: `${BASE}/user/api/v1/user/info/reload`,
        payload: { from: 'appstart' },
        modern: true,
        label: 'reload modern',
      },
      {
        url: `${BASE}/user/api/v1/user/info/reload`,
        payload: { from: 'appstart' },
        label: 'reload legacy',
      },
      {
        url: `${BASE}/user/api/v1/user/info/home`,
        payload: {},
        modern: true,
        label: 'info home modern',
      },
      {
        url: `${BASE}/user/api/v1/user/info/home`,
        payload: {},
        label: 'info home legacy',
      },
    ], 'get self user info failed');
  },

  async getUserProfile(userId: string) {
    const id = String(userId || '');
    if (!id) throw new Error('missing userId');
    return tryPocketPost([
      {
        url: `${BASE}/user/api/v1/user/info`,
        payload: { userId: id },
        modern: true,
        label: 'user info userId',
      },
      {
        url: `${BASE}/user/api/v1/user/info`,
        payload: { id },
        label: 'user info id',
      },
      {
        url: `${BASE}/user/api/v1/user/detail`,
        payload: { userId: id },
        modern: true,
        label: 'user detail userId',
      },
      {
        url: `${BASE}/user/api/v1/user/home`,
        payload: { userId: id },
        modern: true,
        label: 'user home userId',
      },
    ], 'get user profile failed');
  },

  async switchBigSmall(targetUserId: string) {
    return pocketPost(`${BASE}/user/api/v1/bigsmall/switch/user`, { toUserId: String(targetUserId) }, { fallback: '切换账号失败' });
  },

  async getStarServerMap() {
    return pocketPost(`${BASE}/im/api/v1/team/star/server/map/get`, {}, {
      modern: true,
      fallback: '获取成员房间映射失败',
    });
  },

  async getUserMoney() {
    return pocketPost(`${BASE}/user/api/v1/user/money`, {}, { fallback: '获取余额失败' });
  },

  async getGroupTeamStar(payload?: any) {
    return pocketPost(`${BASE}/user/api/v1/client/update/group_team_star`, payload || {}, {
      modern: true,
      tokenRequired: false,
      fallback: '获取官方成员列表失败',
    });
  },

  async getFollowedIds() {
    return pocketPost(`${BASE}/user/api/v1/friendships/friends/id`, {}, { fallback: '获取关注房间失败' });
  },

  async followMember(memberId: string) {
    return pocketPost(`${BASE}/user/api/v2/friendships/friends/add`, { toSourceId: safeNumber(memberId), toType: 1 }, { fallback: '关注失败' });
  },

  async unfollowMember(memberId: string) {
    return pocketPost(`${BASE}/user/api/v2/friendships/friends/remove`, { toSourceId: safeNumber(memberId), toType: 1 }, { fallback: '取消关注失败' });
  },

  async getLastMessages(serverIdList: number[]) {
    return pocketPost(`${BASE}/im/api/v1/team/classic/last/message/get`, {
      serverIdList: serverIdList.map(Number).filter((item) => Number.isFinite(item) && item > 0),
    }, { fallback: '获取最新消息失败' });
  },

  async getRoomMessages(params: { channelId: string; serverId: string; nextTime?: number; fetchAll?: boolean; limit?: number; fallbackChannelId?: string }) {
    const channelId = String(params.channelId || '');
    const fallbackCid = params.fallbackChannelId ? String(params.fallbackChannelId) : '';
    const originalServerId = String(params.serverId || '');
    if (!channelId) throw new Error('missing channelId');
    // v2.4.2 logic: resolve serverId when original is empty, and remember it
    const resolvedServerId = (originalServerId && originalServerId !== '0') ? '' : await resolveServerId(channelId);
    const serverIds = [originalServerId, resolvedServerId]
      .map((item) => String(item || ''))
      .filter((item, index, arr) => item && item !== '0' && arr.indexOf(item) === index);
    if (serverIds.length) rememberServerId(channelId, serverIds[0]);

    const urls = params.fetchAll
      ? [
        { url: `${BASE}/im/api/v1/team/message/list/all`, mode: 'all' },
        { url: `${BASE}/im/api/v1/team/message/list/homeowner`, mode: 'owner-fallback' },
      ]
      : [{ url: `${BASE}/im/api/v1/team/message/list/homeowner`, mode: 'owner' }];
    const attempts: Array<{ url: string; payload: any; modern?: boolean; signed?: boolean; label: string }> = [];
    const limit = params.limit || 100;
    const next = params.nextTime || 0;
    // Try both channelId and fallbackChannelId
    const cids = [channelId, ...(fallbackCid && fallbackCid !== channelId ? [fallbackCid] : [])];
    for (const cid of cids) {
      const svrs = cid === channelId ? serverIds : [params.serverId || ''].filter(s => s && s !== '0');
      for (const serverId of svrs.length ? svrs : ['']) {
        const sid = String(serverId || '');
        if (!sid || sid === '0') continue;
        for (const entry of urls) {
          attempts.push({
            url: entry.url,
            payload: { channelId: safeNumber(cid), serverId: safeNumber(sid), nextTime: next, limit },
            label: `${entry.mode} num ch=${cid} srv=${sid}`,
          });
          attempts.push({
            url: entry.url,
            payload: { channelId: String(cid), serverId: String(sid), nextTime: next, limit },
            label: `${entry.mode} str ch=${cid} srv=${sid}`,
          });
          attempts.push({
            url: entry.url,
            payload: { channelId: safeNumber(cid), serverId: safeNumber(sid), nextTime: next, limit },
            modern: true,
            label: `${entry.mode} mod ch=${cid} srv=${sid}`,
          });
        }
      }
    }
    if (!attempts.length) throw new Error('missing serverId');
    return tryPocketPost(attempts, 'get room messages failed');
  },

  async getRoomInfo(channelId: string) {
    return pocketPost(`${BASE}/im/api/v1/im/team/room/info`, { channelId: String(channelId) }, { tokenRequired: false, fallback: '获取房间信息失败' });
  },

  /** 解析房间信息（大/小房间通用）：
   *  1) room/info → content.channelInfo（单数，FollowedRooms 同款字段）
   *  2) 小房间（yklzId）实测 room/info 返回 2001 无权限 → 回退【塞纳河接口】
   *     im/api/seine/server/detail（seine48 头）：返回 channelInfoList（大/小房间 channelId+channelName）
   *     + chatServerInfo.serverBgWallImg（背景墙图）+ serverName。
   *  serverId 必须传入（成员数据里有），否则无法走塞纳河兜底。 */
  async getRoomMeta(channelId: string | number, fallbackChannelId?: string | number, serverId?: string | number) {
    const cid = String(channelId);
    console.warn('[diag:roommeta] IN cid=' + cid + ' fb=' + String(fallbackChannelId ?? 'NONE') + ' serverId=' + String(serverId ?? 'EMPTY'));
    // 传入 serverId 为空时（成员数据缺 serverId）自动解析，否则无法走塞纳河兜底 → name/bg 全空。
    // 复刻 getRoomMessages 的 v2.4.2 逻辑：resolveServerId 从 room/info 的 content.serverId 提取并写回 store。
    let resolvedSid = serverId;
    if (!resolvedSid || String(resolvedSid) === '0' || String(resolvedSid) === '') {
      try {
        const s = await resolveServerId(cid);
        if (s && s !== '0') { resolvedSid = s; rememberServerId(cid, s); }
      } catch { /* 解析失败保持空，下方兜底流程自然跳过塞纳河 */ }
    }
    const tryRoomInfo = async (target: string): Promise<{ name: string; bg: string }> => {
      const res = await this.getRoomInfo(target).catch(() => null);
      const content = (res as any)?.content || (res as any)?.data || {};
      if ((res as any)?.status && Number((res as any)?.status) !== 200) return { name: '', bg: '' };
      const ci = content.channelInfo || {};
      let name = String(ci.channelName || '');
      let bg = String(ci.bgImg || ci.backgroundImg || ci.backgroundImgUrl || ci.bgImgUrl || '');
      if (!name && Array.isArray(content.channelInfoList)) {
        const hit = content.channelInfoList.find((c: any) => String(c?.channelId) === target);
        if (hit) {
          name = String(hit.channelName || '');
          bg = String(hit.bgImg || hit.backgroundImg || hit.backgroundImgUrl || hit.bgImgUrl || '');
        }
      }
      if (!bg) {
        const ucc = content.userChatConfig || {};
        bg = String(ucc.bgImg || ucc.bgImgUrl || '');
      }
      return { name, bg: bg ? normalizeUrl(bg) : '' };
    };
    let meta = await tryRoomInfo(cid);
    console.warn('[diag:roommeta] cid=' + cid + ' name=' + meta.name + ' bg=' + (meta.bg ? meta.bg.slice(0, 90) : 'EMPTY'));
    // 小房间/解析失败 → 塞纳河 server/detail（channelInfoList 含大小房间名 + serverBgWallImg）
    if ((!meta.name && !meta.bg) && resolvedSid !== undefined && resolvedSid !== null && String(resolvedSid) !== '' && String(resolvedSid) !== '0') {
      try {
        const res = await this.getSeineServerDetail(Number(resolvedSid)).catch(() => null);
        const content = (res as any)?.content || (res as any)?.data || {};
        const list = Array.isArray(content.channelInfoList) ? content.channelInfoList : [];
        const hit = list.find((c: any) => String(c?.channelId) === cid)
          || (fallbackChannelId !== undefined && fallbackChannelId !== null ? list.find((c: any) => String(c?.channelId) === String(fallbackChannelId)) : undefined);
        const si = content.chatServerInfo || {};
        const bg = String(si.serverBgWallImg || si.bgImg || '');
        console.warn('[diag:roommeta] SEINE cid=' + cid + ' listLen=' + list.length + ' hit=' + (hit ? 'Y:' + String(hit.channelName || '') + '/bg=' + String(hit.bgImg || hit.backgroundImg || hit.bgImgUrl || 'EMPTY') : 'N') + ' serverBg=' + (bg ? bg.slice(0, 60) : 'EMPTY'));
        if (hit || bg) {
          meta = {
            name: meta.name || (hit ? String(hit.channelName || '') : ''),
            bg: meta.bg || (bg ? normalizeUrl(bg) : ''),
          };
        }
      } catch { /* 塞纳河兜底失败忽略 */ }
    }
    // 最终兜底：回退同成员大房间背景
    if (!meta.name && !meta.bg && fallbackChannelId !== undefined && fallbackChannelId !== null && String(fallbackChannelId) !== cid) {
      const fb = await tryRoomInfo(String(fallbackChannelId)).catch(() => ({ name: '', bg: '' }));
      console.warn('[diag:roommeta] FALLBACK cid=' + cid + ' fb=' + String(fallbackChannelId) + ' fbName=' + fb.name + ' fbBg=' + (fb.bg ? fb.bg.slice(0, 60) : 'EMPTY'));
      if (fb.bg) meta = { name: meta.name || fb.name, bg: fb.bg };
    }
    return meta;
  },

  async getRoomAlbum(params: { channelId: string; nextTime?: number }) {
    return pocketPost(`${BASE}/im/api/v1/team/msg/list/img`, {
      channelId: String(params.channelId),
      nextTime: params.nextTime || 0,
    }, { fallback: '获取房间相册失败' });
  },

  async getOfficialTalkList(params: { ctime?: number; groupId?: number; limit?: number } = {}) {
    return publicMediaPost(`${BASE}/media/api/media/v1/talk/list`, {
      ctime: params.ctime || 0,
      groupId: params.groupId ?? 0,
      limit: params.limit || 20,
    }, 'get talk list failed');
  },

  async getOfficialTalk(talkId: string) {
    return publicMediaPost(`${BASE}/media/api/media/v1/talk`, {
      resId: String(talkId),
    }, 'get talk audio failed');
  },

  async getOfficialMusicList(params: { ctime?: number; limit?: number } = {}) {
    return publicMediaPost(`${BASE}/media/api/media/v1/music/list`, {
      ctime: params.ctime || 0,
      limit: params.limit || 20,
    }, 'get music list failed');
  },

  async getOfficialMusic(musicId: string) {
    return publicMediaPost(`${BASE}/media/api/media/v1/music`, {
      resId: String(musicId),
    }, 'get music url failed');
  },

  async getOfficialVideoList(params: { ctime?: number; typeId?: number; groupId?: number; limit?: number } = {}) {
    return publicMediaPost(`${BASE}/media/api/media/v1/video/list`, {
      ctime: params.ctime || 0,
      typeId: params.typeId ?? 0,
      groupId: params.groupId ?? 0,
      limit: params.limit || 20,
    }, 'get video list failed');
  },

  async getOfficialVideo(videoId: string) {
    return publicMediaPost(`${BASE}/media/api/media/v1/video`, {
      resId: String(videoId),
    }, 'get video url failed');
  },

  async getPrivateMessageList(lastTime?: number) {
    return pocketPost(`${BASE}/message/api/v1/user/message/list`, {
      lastTime: Number(lastTime) || Date.now(),
    }, { modern: true, fallback: '获取私信列表失败' });
  },

  async getPrivateMessageDetail(targetUserId: string, lastTime = 0) {
    return pocketPost(`${BASE}/message/api/v1/user/message/info`, {
      lastTime: Number(lastTime) || 0,
      targetUserId: String(targetUserId),
    }, { modern: true, fallback: '获取私信详情失败' });
  },

  async sendPrivateMessageReply(targetUserId: string, text: string) {
    return pocketPost(`${BASE}/message/api/v1/user/message/reply`, {
      messageType: 'TEXT',
      text: String(text),
      targetUserId: String(targetUserId),
    }, { modern: true, fallback: '发送私信失败' });
  },

  async getFlipList(beginLimit = 0, limit = 20) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/user/question/list`, {
      status: 0,
      beginLimit,
      limit,
      memberId: '',
    }, { fallback: '获取翻牌记录失败' });
  },

  async getFlipPrices(memberId: string) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v2/custom/index`, {
      memberId: String(memberId),
    }, { fallback: '获取翻牌类型失败' });
  },

  async sendFlipQuestion(payload: any) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/user/question`, payload, { fallback: '发送翻牌失败' });
  },

  async operateFlipQuestion(questionId: string, operateType = 1) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/user/question/operate`, {
      questionId: String(questionId),
      operateType,
    }, { fallback: '操作翻牌失败' });
  },

  async getStarArchives(memberId: number) {
    return pocketPost(`${BASE}/user/api/v1/user/star/archives`, { memberId: Number(memberId) }, { tokenRequired: false, fallback: '获取成员档案失败' });
  },

  async getStarHistory(memberId: number) {
    return pocketPost(`${BASE}/user/api/v1/user/star/history`, {
      memberId: Number(memberId),
      limit: 100,
      lastTime: 0,
    }, { tokenRequired: false, fallback: '获取成员历史失败' });
  },

  async getOpenLive(params: { memberId: string; nextTime?: number }) {
    const memberId = String(params.memberId || '');
    if (!memberId) throw new Error('missing memberId');
    return tryPocketPost([
      { url: `${BASE}/im/api/v1/chatroom/msg/list/aim/type`, payload: { extMsgType: 'OPEN_LIVE', roomId: '', ownerId: memberId, nextTime: Number(params.nextTime) || 0 }, label: 'openlive' },
      { url: `${BASE}/im/api/v1/chatroom/msg/list/aim/type`, payload: { extMsgType: 'OPEN_LIVE', roomId: '', ownerId: memberId, nextTime: Number(params.nextTime) || 0 }, signed: false, label: 'openlive unsigned' },
    ], '获取成员公演失败');
  },

  async getOpenLiveOne(liveId: string) {
    const id = String(liveId);
    return tryPocketPost([
      // v2.7.3 语义：默认请求即返回 rtmp（与桌面/官方一致的原始流）
      {
        url: `${BASE}/live/api/v1/live/getOpenLiveOne`,
        payload: { liveId: id },
        tokenRequired: false,
        label: 'open live one',
      },
      {
        url: `${BASE}/live/api/v1/live/getOpenLiveOne`,
        payload: { liveId: id, streamProtocol: 'FLV' },
        tokenRequired: false,
        label: 'open live one flv',
      },
      {
        url: `${BASE}/live/api/v1/live/getOpenLiveOne`,
        payload: { liveId: id, streamProtocol: 'HLS' },
        tokenRequired: false,
        label: 'open live one hls',
      },
    ], '获取公演详情失败');
  },

  async getLiveOne(liveId: string) {
    const id = String(liveId);
    return tryPocketPost([
      // v2.7.3 语义：默认请求即返回 rtmp（与桌面/官方一致的原始流）
      {
        url: `${BASE}/live/api/v1/live/getLiveOne`,
        payload: { liveId: id },
        tokenRequired: false,
        label: 'live one',
      },
      {
        url: `${BASE}/live/api/v1/live/getLiveOne`,
        payload: { liveId: id, streamProtocol: 'FLV' },
        tokenRequired: false,
        label: 'live one flv',
      },
      {
        url: `${BASE}/live/api/v1/live/getLiveOne`,
        payload: { liveId: id, streamProtocol: 'HLS' },
        tokenRequired: false,
        label: 'live one hls',
      },
    ], '获取直播详情失败');
  },

  /**
   * 获取直播间弹幕（录播回放）。接口失败/无数据返回空数组，绝不抛错，
   * 保证弹幕只是「锦上添花」，不会拖垮播放。
   */
  async getLiveBarrage(liveId: string): Promise<Array<{ messageId: string; content: string; color: string; time: number; user: string }>> {
    const id = String(liveId || '');
    if (!id) return [];
    try {
      const res = await tryPocketPost([
        { url: `${BASE}/live/api/v1/live/barrage/list`, payload: { liveId: id, time: 0 }, tokenRequired: false, label: 'barrage' },
        { url: `${BASE}/live/api/v1/live/barrage/list`, payload: { liveId: id, lastTime: 0 }, tokenRequired: false, label: 'barrage lastTime' },
      ], '获取弹幕失败');
      const infos = unwrapList(res, [
        'content.barrageInfos',
        'content.list',
        'content.data',
        'barrageInfos',
        'data.barrageInfos',
        'list',
      ]);
      return infos.map((b: any) => ({
        messageId: String(b.messageId || b.id || ''),
        content: String(b.content || b.msg || b.text || ''),
        color: String(b.color || ''),
        time: Number(b.time || b.t || 0) || 0,
        user: String(b.user || b.nickName || b.userName || b.name || ''),
      }));
    } catch {
      return [];
    }
  },

  /**
   * 获取录播弹幕的 LRC 文本。
   * 关键：录播弹幕不在 barrage/list，而在 getLiveOne 返回的 content.msgFilePath（或 lrcUrl）
   * 指向的 LRC 文件（纯文本，格式 [hh:mm:ss.fff]昵称\t内容）。参考 pocket48_lite 实现。
   * 拉到 LRC 文本后由 parseDanmaku 解析（已支持该格式）。
   * 失败/无数据返回 null，弹幕只是锦上添花，绝不拖垮播放。
   */
  async getLiveLrc(liveId: string): Promise<string | null> {
    const id = String(liveId || '');
    if (!id) return null;
    try {
      const one: any = await pocketApi.getLiveOne(id);
      const content = (one && one.content) || one || {};
      const lrcUrl: string = content.msgFilePath || content.lrcUrl || '';
      if (!lrcUrl) return null;
      const url = /^https?:\/\//i.test(lrcUrl)
        ? lrcUrl
        : `${BASE}${lrcUrl.startsWith('/') ? '' : '/'}${lrcUrl}`;
      const res = await fetchWithTimeout(url, {}, 10000);
      if (!res.ok) return null;
      const text = await res.text();
      return text && text.trim() ? text : null;
    } catch {
      return null;
    }
  },

  async getOpenLivePublicList(params: { groupId?: number; next?: number; record?: boolean }) {
    return pocketPost(`${BASE}/live/api/v1/live/getOpenLiveList`, {
      groupId: params.groupId ?? 0,
      debug: false,
      next: params.next ?? 0,
      record: !!params.record,
    }, { tokenRequired: false, fallback: '获取公演列表失败' });
  },

  async getMemberPhotos(memberId: string, page = 0, size = 20) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/user/nft/user_nft_list`, {
      starId: safeNumber(memberId),
      size,
      page,
    }, { tokenRequired: false, fallback: '获取个人相册失败' });
  },

  async getLiveList(params: { groupId?: number; liveType?: number; page?: number; record?: boolean; debug?: boolean; next?: number; size?: number; userId?: number | string }) {
    const payload: any = {
      groupId: params.groupId ?? 0,
      debug: params.debug ?? false,
      liveType: params.liveType ?? 0,
      next: params.next ?? 0,
      record: params.record ?? false,
    };
    // 按成员（userId）服务端直查：桌面基线 fetchLiveList / 48tools requestLiveList 均透传 userId，
    // 服务端原生支持按成员过滤直播/录播，避免「全量加载全局列表再前端筛选」导致的历史数据缺失。
    // 注意官方坑：next=0 时带 userId 查不到数据，首次查询需先取列表最新 liveId 作为 next（调用方处理）。
    if (params.userId !== undefined && params.userId !== null && params.userId !== '') {
      payload.userId = Number(params.userId) || String(params.userId);
    }
    if (params.page !== undefined) payload.page = params.page;
    if (params.size !== undefined) payload.size = params.size;
    return pocketPost(`${BASE}/live/api/v1/live/getLiveList`, payload, { tokenRequired: false, fallback: '获取直播列表失败' });
  },

  /** 服务端搜索（房间/成员/话题，48tools 同款 im/server/search）：返回 content.serverApiList[]，
   *  每项含 serverId/serverName/serverIcon/serverOwner/followStatus。需登录 token。 */
  async serverSearch(searchContent: string) {
    return pocketPost(`${BASE}/im/api/v1/im/server/search`, { searchContent: String(searchContent || '').trim() }, { fallback: '搜索失败' });
  },

  /** 服务端跳转：由 starId 获取 serverId/channelId（进入房间/会话定位用，48tools 同款 im/server/jump） */
  async serverJump(starId: number | string) {
    return pocketPost(`${BASE}/im/api/v1/im/server/jump`, { starId: Number(starId), targetType: 1 }, { fallback: '获取房间信息失败' });
  },

  async operateRoomVoice(params: { channelId: string; serverId: string }) {
    const channelId = String(params.channelId || '');
    let serverId = String(params.serverId || '');
    if (!serverId || serverId === '0') serverId = await resolveServerId(channelId);
    rememberServerId(channelId, serverId);
    return pocketPost(`${BASE}/im/api/v1/team/voice/operate`, {
      channelId: safeNumber(channelId),
      serverId: safeNumber(serverId),
      operateCode: 2,
    }, { fallback: '获取房间电台失败' });
  },

  async sendGift(params: { giftId: string; liveId: string; acceptUserId: string; giftNum?: number }) {
    return pocketPost(`${BASE}/gift/api/v1/gift/send`, {
      giftId: String(params.giftId),
      businessId: String(params.liveId),
      acceptUserId: String(params.acceptUserId),
      giftNum: Number(params.giftNum) || 1,
      isPocketGift: 0,
      businessCode: 0,
      zip: 0,
      isCombo: 0,
      ruleId: 0,
      giftType: 1,
      crm: `${Date.now()}${Math.random().toString().slice(2)}`,
    }, { modern: true, fallback: '送礼失败' });
  },

  async getGiftList(liveId: string) {
    return pocketPost(`${BASE}/gift/api/v1/gift/list`, {
      businessId: String(liveId),
      giftType: 1,
    }, { fallback: '获取礼物列表失败' });
  },

  async getLiveRank(liveId: string) {
    return pocketPost(`${BASE}/live/api/v2/live/getLiveRank`, {
      type: 1,
      liveId: String(liveId),
    }, { fallback: '获取直播榜单失败' });
  },

  // --- v2.6 New APIs ---

  async getLiveResult(liveId: string) {
    return pocketPost(`${BASE}/live/api/v1/live/result`, {
      liveId: String(liveId),
    }, { tokenRequired: false, fallback: '获取直播结果失败' });
  },

  async getTripList(params: { groupId?: number; memberId?: string; userId?: string; lastTime?: string; isMore?: boolean } = {}) {
    const payload: any = {
      lastTime: String(params.lastTime || '0'),
      groupId: Number(params.groupId) || 0,
      isMore: !!params.isMore,
    };
    if (params.memberId) payload.memberId = String(params.memberId);
    if (params.userId) payload.userId = String(params.userId);
    return pocketPost(`${BASE}/trip/api/trip/v1/list`, payload, { fallback: '获取行程失败' });
  },

  async getMeleeWeekRank(rankId: number, nextId?: string) {
    const payload: any = { rankId: Number(rankId) || 0 };
    if (nextId) payload.nextId = nextId;
    return pocketPost(`${BASE}/gift/api/v1/melee/rank/getMeleeWeekRank`, payload, { fallback: '获取乱斗周榜失败' });
  },

  async getMeleeRankPage(rankId?: number, nextId?: string) {
    const payload: any = {};
    if (rankId !== undefined && rankId !== null) payload.rankid = Number(rankId) || 0;
    if (nextId) payload.nextId = nextId;
    return pocketPost(`${BASE}/gift/api/v1/melee/rank/getMeleeRankPage`, payload, { fallback: '获取乱斗榜单失败' });
  },

  async getMeleeYearRankPage(rankId?: number, nextId?: string) {
    const payload: any = {};
    if (rankId !== undefined && rankId !== null) payload.rankid = Number(rankId) || 0;
    if (nextId) payload.nextId = nextId;
    return pocketPost(`${BASE}/gift/api/v1/melee/rank/getMeleeYearRankPage`, payload, { fallback: '获取乱斗年榜失败' });
  },

  async getPersonMeleeRankPage(resId: number) {
    return pocketPost(`${BASE}/gift/api/v1/melee/rank/getPersonMeleeRankPage`, {
      resId: Number(resId) || 0,
    }, { fallback: '获取成员鸡腿贡献榜失败' });
  },

  async getMemberDynamic(params: { ownerId: string; nextTime?: number; roomId?: string }) {
    return pocketPost(`${BASE}/im/api/v1/chatroom/msg/list/aim/type`, {
      extMsgType: 'POST_INFO',
      roomId: String(params.roomId || ''),
      ownerId: String(params.ownerId),
      nextTime: Number(params.nextTime) || 0,
    }, { fallback: '获取成员动态失败', headers: createWeiboHeaders(requireToken()) });
  },

  async getMemberWeibo(params: { ownerId: string; nextTime?: number; roomId?: string }) {
    return pocketPost(`${BASE}/im/api/v1/chatroom/msg/list/aim/type`, {
      extMsgType: 'WEI_BO',
      roomId: String(params.roomId || ''),
      ownerId: String(params.ownerId),
      nextTime: Number(params.nextTime) || 0,
    }, { fallback: '获取成员微博失败', headers: createWeiboHeaders(requireToken()) });
  },

  async getMemberPostImages(userId: string, nextTime = 0) {
    return pocketPost(`${BASE}/posts/api/v1/posts/img/list`, {
      userId: String(userId),
      nextTime: Number(nextTime) || 0,
    }, { fallback: '获取成员图片动态失败' });
  },

  async getConversationPage(nextTime = 0, limit = 20) {
    return pocketPost(`${BASE}/im/api/v1/conversation/page`, {
      nextTime: Number(nextTime) || 0,
      limit: Number(limit) || 20,
    }, { modern: true, fallback: '获取会话列表失败' });
  },

  async getUserHomeInfo(userId?: string) {
    const payload: any = {};
    if (userId) payload.userId = String(userId);
    return pocketPost(`${BASE}/user/api/v1/user/info/home`, payload, {
      modern: true,
      fallback: '获取用户主页信息失败',
    });
  },

  async getUnreadMessageCount() {
    return pocketPost(`${BASE}/message/api/v1/unread/message/num`, {}, {
      modern: true,
      fallback: '获取未读消息数失败',
    });
  },

  async getUserPictureFrames() {
    return pocketPost(`${BASE}/user/api/v1/user/get/picture/frame`, {}, {
      modern: true,
      fallback: '获取头像框失败',
    });
  },

  async getMediaCollectionTotalCount() {
    return pocketPost(`${BASE}/media/api/media/v1/getCollectionTotalCount`, {}, {
      modern: true,
      fallback: '获取收藏统计失败',
    });
  },

  async getFlipCustomIndexV1(memberId: string) {
    return pocketPost(`${BASE}/idolanswer/api/idolanswer/v1/custom/index`, {
      memberId: String(memberId),
    }, { tokenRequired: false, fallback: '获取翻牌配置失败' });
  },

  // --- Invoice APIs ---

  async getInvoiceTips() {
    const res = await requestJson<any>(`${BASE}/invoice/api/v1/invoice/tips`, {
      method: 'GET',
      headers: createInvoiceHeaders(),
    });
    return assertPocketOk(res, '获取开票提示失败');
  },

  async getInvoiceConfig() {
    return pocketPost(`${BASE}/invoice/api/v1/invoice/config`, {}, {
      headers: createInvoiceHeaders(requireToken(), { tokenHeader: true }),
      fallback: '获取开票配置失败',
    });
  },

  async getInvoiceOrderList(nextTime = '', yearMonth = '') {
    const token = requireToken();
    return pocketPost(`${BASE}/invoice/api/v1/order/list`, {
      nextTime: String(nextTime || '0'),
      token,
      yearMonth: String(yearMonth || ''),
    }, {
      headers: createInvoiceHeaders(),
      fallback: '获取可开票订单失败',
    });
  },

  async applyElectronicInvoice(params: {
    buyerType?: number;
    buyerName?: string;
    buyerTaxNo?: string;
    buyerAddress?: string;
    buyerPhone?: string;
    buyerBankName?: string;
    buyerBankAccount?: string;
    notifyEmail?: string;
    notifyMobile?: string;
    orderDataId?: string[];
  }) {
    const token = requireToken();
    const ids = (params.orderDataId || []).map(item => String(item || '').trim()).filter(Boolean);
    if (!ids.length) throw new Error('请选择要开票的订单');
    const payload: any = {
      buyerType: Number(params.buyerType) === 1 ? 1 : 0,
      buyerName: String(params.buyerName || '').trim(),
      notifyEmail: String(params.notifyEmail || '').trim(),
      notifyMobile: String(params.notifyMobile || '').trim(),
      orderDataId: ids,
      token,
    };
    if (payload.buyerType === 1) {
      Object.assign(payload, {
        buyerAddress: String(params.buyerAddress || '').trim(),
        buyerBankAccount: String(params.buyerBankAccount || '').trim(),
        buyerBankName: String(params.buyerBankName || '').trim(),
        buyerPhone: String(params.buyerPhone || '').trim(),
        buyerTaxNo: String(params.buyerTaxNo || '').trim(),
      });
    }
    return pocketPost(`${BASE}/invoice/api/v1/invoice/apply/electronic`, payload, {
      headers: createInvoiceHeaders(),
      fallback: '提交开票申请失败',
    });
  },

  // --- Meet48 APIs ---

  async getMeet48LiveList(params: { next?: number; record?: boolean } = {}) {
    const res = await requestJson<any>('https://meetapi-v2.meet48.xyz/meet48-api/live/api/v1/live/getLiveList', {
      method: 'POST',
      body: { title: null, next: params.next || 0, record: !!params.record },
      headers: createMeet48Headers(),
    });
    return assertPocketOk(res, 'Meet48 API 错误');
  },

  async getMeet48LiveOne(liveId: string) {
    const res = await requestJson<any>('https://meetapi-v2.meet48.xyz/meet48-api/live/api/v1/live/getLiveOne', {
      method: 'POST',
      body: { liveId: String(liveId), streamProtocol: 'RTMP' },
      headers: createMeet48Headers(),
    });
    return assertPocketOk(res, 'Meet48 API 错误');
  },

  // --- v2.7 New APIs (同步自 yk1z/yaya_msg 电脑版, 2026-08-16) ---

  /** 删除单条私信 */
  async deletePrivateMessage(msgId: string) {
    return pocketPost(`${BASE}/message/api/v1/user/message/delete/msg`, {
      msgId: String(msgId),
    }, { fallback: '删除私信失败', headers: createPocketAndroidHeaders() });
  },

  /** 私信发送图片消息 */
  async sendPrivateImageMessage(targetUserId: string, image: { imgUrl: string; imgWidth?: number; imgHeight?: number; imgSize?: number; text?: string }) {
    return pocketPost(`${BASE}/message/api/v1/user/message/reply`, {
      messageType: 'IMAGE',
      imgUrl: String(image.imgUrl),
      imgWidth: Number(image.imgWidth || 0),
      imgHeight: Number(image.imgHeight || 0),
      imgSize: Number(image.imgSize || 0),
      targetUserId: String(targetUserId),
      text: String(image.text || ''),
    }, { modern: true, fallback: '发送图片私信失败' });
  },

  /** 上传图片到口袋（私信图片等，fromType 为空） */
  async uploadPocketImage(params: { uri: string; fileName?: string; mimeType?: string; fromType?: string }) {
    const token = requireToken();
    const headers = await signedHeaders(token, true);
    delete headers['Content-Type'];
    delete headers.Host;
    const mimeType = params.mimeType || 'image/jpeg';
    const fileName = params.fileName || `image-${Date.now()}.${mimeType.includes('png') ? 'png' : 'jpg'}`;
    const formData = new FormData();
    if (params.fromType) formData.append('fromType', params.fromType);
    formData.append('file', {
      uri: params.uri,
      name: fileName,
      type: mimeType,
    } as any);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch('https://pfile.48.cn/filesystem/upload/image', {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });
    } catch (error: any) {
      throw new Error(error?.name === 'AbortError' ? '上传图片超时' : '上传图片网络失败');
    } finally {
      clearTimeout(timer);
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
    if (response.ok && data && (data.status === 200 || data.success)) {
      const item = Array.isArray(data.content) ? data.content[0] : data.content;
      const path = item?.path || item?.url || item?.filePath || '';
      if (!path) throw new Error('上传成功但没有返回图片路径');
      return { success: true, content: item, path };
    }
    const source = data || response;
    throw new Error((source as any)?.message || (source as any)?.msg || `上传失败 HTTP ${response.status}`);
  },

  /** 主页相册（图片动态，Android 头） */
  async getPostImageList(userId: string, nextId = 0, limit = 20) {
    return pocketPost(`${BASE}/posts/api/v1/posts/img/list`, {
      nextId: Number(nextId || 0),
      limit: Number(limit) || 20,
      userId: Number(userId) || 0,
    }, { fallback: '获取主页相册失败', headers: createPocketAndroidHeaders() });
  },

  /** 主页视频（v2） */
  async getPostVideoList(userId: string, nextId = 0, limit = 20) {
    return pocketPost(`${BASE}/posts/api/v2/posts/video/list`, {
      nextId: Number(nextId) || 0,
      limit: Number(limit) || 20,
      userId: Number(userId) || 0,
    }, { fallback: '获取主页视频失败', headers: createPocketAndroidHeaders() });
  },

  /** 主页动态时间线 */
  async getPostTimelineHome(userId: string, nextId = 0, limit = 20) {
    return pocketPost(`${BASE}/posts/api/v1/posts/timeline/home`, {
      nextId: Number(nextId) || 0,
      limit: Number(limit) || 20,
      userId: Number(userId) || 0,
    }, { fallback: '获取主页动态失败', headers: createPocketAndroidHeaders() });
  },

  /** Seine 公演列表（ckg48 域名，iOS Seine 头） */
  async getSeinePerformanceList(groupId = 0, next = 0) {
    return requestJson<any>('https://snhapi-v1.ckg48.cn/home/api/seine/home/interaction/list', {
      method: 'POST',
      body: {
        type: 2,
        groupId: String(groupId || 0),
        next: String(next || 0),
      },
      headers: createSeineIosHeaders(),
      timeout: 15000,
    }).then((res: any) => assertPocketOk(res, '获取公演列表失败'));
  },

  /** Seine 频道详情（serverId → 房间名映射） */
  async getSeineServerDetail(serverId: number) {
    return pocketPost(`${BASE}/im/api/seine/server/detail`, {
      serverId: Number(serverId),
    }, { fallback: '获取频道详情失败', headers: createSeineHeaders() });
  },

  /** 单成员最新消息（team/last/message，push 服务同款） */
  async getLastMessageByServerId(serverId: number) {
    return pocketPost(`${BASE}/im/api/v1/team/last/message/get`, {
      serverId: Number(serverId),
    }, { fallback: '获取最新消息失败' });
  },

  /** 社区动态（Area48 最新） */
  async getArea48Newest(nextId = 0) {
    return pocketPost(`${BASE}/posts/api/v1/area48/data/newest/new`, {
      nextId: Number(nextId) || 0,
    }, { fallback: '获取社区动态失败', headers: createArea48Headers() });
  },

  /** 社区推荐 */
  async getArea48Recommend(nextId = 0) {
    return pocketPost(`${BASE}/posts/api/v1/area48/data/recommend/new`, {
      nextId: Number(nextId) || 0,
    }, { fallback: '获取社区推荐失败', headers: createArea48Headers() });
  },

  /** 帖子详情 */
  async getArea48PostDetails(postId: string) {
    return pocketPost(`${BASE}/posts/api/v1/posts/details`, {
      needViewer: true,
      needComment: true,
      postId: String(postId),
    }, { fallback: '获取帖子详情失败', headers: createArea48Headers() });
  },

  /** 帖子评论列表 */
  async getArea48Comments(resourceId: string, next = 0) {
    return pocketPost(`${BASE}/comment/api/v1/comment/level1/getCommentList`, {
      next: next ? String(next) : 0,
      resourceId: String(resourceId),
      resourceMd: 'md',
      resourceType: 1002,
    }, { fallback: '获取评论失败', headers: createArea48Headers() });
  },

  /** 发表评论 */
  async addArea48Comment(resourceId: string, commentMsg: string, commentUrl = '') {
    return pocketPost(`${BASE}/comment/api/v1/comment/addComment`, {
      resourceId: String(resourceId),
      commentMsg: String(commentMsg).trim(),
      commentUrl: String(commentUrl || ''),
      resourceMd: 'md',
      resourceType: 1002,
    }, { fallback: '发送评论失败', headers: createArea48Headers() });
  },

  /** 社区发帖 */
  async createArea48Post(params: { title?: string; content: string; topicArray?: string; extInfo?: string }) {
    return pocketPost(`${BASE}/posts/api/v1/posts/create`, {
      topicArray: String(params.topicArray || ''),
      postSource: '1',
      title: String(params.title || '').trim(),
      content: String(params.content).trim(),
      extInfo: String(params.extInfo || ''),
    }, { fallback: '发布动态失败', headers: createArea48Headers() });
  },

  /** 屏蔽词列表（发言前过滤） */
  async getPocketMaskWords(clientTime = 0) {
    try {
      const res = await requestJson<any>(`${BASE}/home/api/check/maskword?clientTime=${Number(clientTime) || 0}`, {
        method: 'GET',
        headers: createArea48Headers(),
        timeout: 10000,
      });
      if (res?.status === 200 || res?.success) return { success: true, content: res.content || {} };
      return { success: false, content: {} };
    } catch {
      return { success: false, content: {} };
    }
  },


  // --- Open Live Participants (web scraping) ---

  async getOpenLiveParticipants(liveId: string, title = '', dateHint = '') {
    const pageHeaders: HeadersMap = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      Referer: 'https://live.48.cn/',
    };

    try {
      // Try the memberhot API first
      const livePageUrl = `https://live.48.cn/Index/inlive/id/${encodeURIComponent(liveId)}`;
      const html = await requestJson<string>(livePageUrl, {
        method: 'GET',
        headers: pageHeaders,
      }) as any; // Returns raw HTML as string

      // Extract hidden input values
      const extractInput = (inputId: string) => {
        const pattern = new RegExp(`<input[^>]+id=["']${inputId}["'][^>]+value=["']([^"']*)["']`, 'i');
        const match = String(html || '').match(pattern);
        return match ? String(match[1] || '').trim() : '';
      };

      const videoId = extractInput('vedio_id');
      const clubId = extractInput('club_id');
      const pageToken = extractInput('param');

      if (videoId && clubId && pageToken) {
        try {
          const payload = new URLSearchParams({
            act: 'default',
            video_id: videoId,
            token: pageToken,
            club_id: clubId,
          }).toString();

          const memberRes = await requestJson<any>(
            'https://live.48.cn/Index/ajax_getmemberhot/',
            {
              method: 'POST',
              body: payload,
              bodyType: 'raw',
              headers: {
                ...pageHeaders,
                Origin: 'https://live.48.cn',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
              },
            },
          );

          const rows = Array.isArray(memberRes?.desc) ? memberRes.desc : [];
          const participants = rows
            .map((item: any) => ({
              name: String(item?.memberName || '').trim(),
              memberId: String(item?.memberId || '').trim(),
              avatar: String(item?.avatar || '').trim(),
              hot: item?.hot ?? '',
            }))
            .filter((item: any) => item.name);

          if (participants.length) {
            return { success: true, content: { participants, source: 'memberhot' } };
          }
        } catch {
          // Fall through to HTML parsing
        }
      }

      // Fallback: extract names from HTML
      const nameMatches = String(html || '').matchAll(/<p class="listname">\s*([^<\r\n]+?)\s*(?:<em|<\/p>)/gi);
      const names: string[] = [];
      for (const match of nameMatches) {
        const name = String(match[1] || '').replace(/\s+/g, ' ').trim();
        if (name && !names.includes(name)) names.push(name);
      }
      const htmlParticipants = names.map(name => ({ name, memberId: '', avatar: '', hot: '' }));
      if (htmlParticipants.length) {
        return { success: true, content: { participants: htmlParticipants, source: 'html' } };
      }
    } catch {
      // All attempts failed
    }

    return { success: false, msg: '未找到参与成员' };
  },
};

export default pocketApi;
