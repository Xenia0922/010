import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings, Member } from '../types';
import { APP_VERSION } from '../constants';
import { DEFAULT_SETTINGS } from '../services/settings';

interface SettingsState {
  settings: AppSettings;
  setSettings: (patch: Partial<AppSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  setSettings: (patch) =>
    set((state) => ({ settings: { ...state.settings, ...patch } })),
}));

interface MemberState {
  members: Member[];
  membersLoaded: boolean;
  setMembers: (members: Member[]) => void;
  updateMemberRoomIds: (channelId: string, patch: Partial<Pick<Member, 'serverId' | 'channelId' | 'yklzId'>>) => void;
  /** 按 userId 回写房间映射（seine 解析结果），供 roomMapCache 使用 */
  patchMemberByUserId: (memberId: string, patch: Partial<Pick<Member, 'serverId' | 'channelId' | 'yklzId' | 'roomId' | 'liveRoomId'>>) => void;
}

export const useMemberStore = create<MemberState>((set) => ({
  members: [],
  membersLoaded: false,
  setMembers: (members) => set({ members, membersLoaded: true }),
  updateMemberRoomIds: (channelId, patch) =>
    set((state) => ({
      members: state.members.map((member) =>
        String(member.channelId) === String(channelId) ? { ...member, ...patch } : member,
      ),
    })),
  patchMemberByUserId: (memberId, patch) =>
    set((state) => ({
      members: state.members.map((member) =>
        String(member.id) === String(memberId) ? { ...member, ...patch } : member,
      ),
    })),
}));

interface UiState {
  tabBarHidden: boolean;
  toastMessage: string;
  setTabBarHidden: (hidden: boolean) => void;
  showToast: (message: string) => void;
  hideToast: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  tabBarHidden: false,
  toastMessage: '',
  setTabBarHidden: (hidden) => set({ tabBarHidden: hidden }),
  showToast: (message) => set({ toastMessage: message }),
  hideToast: () => set({ toastMessage: '' }),
}));

// --- v2.6: Announcement store ---

const ANNOUNCEMENT_SEEN_KEY = 'yaya_announcement_seen';

interface AnnouncementState {
  seenIds: string[];
  lastFetched: number;
  hydrated: boolean;
  markSeen: (id: string) => void;
  setLastFetched: (ts: number) => void;
}

export const useAnnouncementStore = create<AnnouncementState>((set) => ({
  seenIds: [],
  lastFetched: 0,
  hydrated: false,
  markSeen: (id) =>
    set((state) => {
      if (state.seenIds.includes(id)) return {};
      const next = [...state.seenIds, id];
      AsyncStorage.setItem(ANNOUNCEMENT_SEEN_KEY, JSON.stringify(next)).catch(() => {});
      return { seenIds: next };
    }),
  setLastFetched: (ts) => set({ lastFetched: ts }),
}));

// Persist seen announcement ids so the modal doesn't re-pop on every cold launch.
AsyncStorage.getItem(ANNOUNCEMENT_SEEN_KEY)
  .then((raw) => {
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (Array.isArray(ids) && ids.length) {
      useAnnouncementStore.setState({ seenIds: ids });
    }
  })
  .catch(() => {})
  .finally(() => {
    useAnnouncementStore.setState({ hydrated: true });
  });

// --- 版本更新检测 ---

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Xenia0922/yaya_msg_mobile/releases/latest';
// 降级源：GitHub release 页面 HTML（无 API 匿名限流；共享出口 IP 触发 403 时自动切换）
const GITHUB_RELEASES_PAGE = 'https://github.com/Xenia0922/yaya_msg_mobile/releases/latest';
// 更新跳转链接：统一指向用户自建下载页（夸克网盘 + GitHub 双渠道，可随时改页内链接无需发版）
const UPDATE_DOWNLOAD_PAGE = 'https://010push.a23xyz.xyz/app/';
const UPDATE_TIMEOUT = 8000;
// 检查结果持久化，24h 内不重复打 GitHub API（未认证限流 60/h，冷启全打会快速耗尽）
const UPDATE_LAST_CHECK_KEY = 'yaya_update_last_check';
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

function parseVersion(v: string): number[] {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((seg) => parseInt(seg, 10))
    .filter((n) => !Number.isNaN(n));
}

/** candidate 是否比 current 新（纯数字段比较，如 2.6.6 > 2.6.5） */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

interface UpdateState {
  /** 是否有可用更新（本地版本低于 GitHub 最新 Release 版本） */
  hasUpdate: boolean;
  /** 最新版本号（如 v2.6.6），无更新时为空 */
  latestVersion: string;
  /** 最新版 APK 直链（releases/download，免登录直接下载）；无 APK 附件时为空 */
  latestUrl: string;
  /** 本次会话已检查的时间戳，0 表示未检查 */
  lastCheckedAt: number;
  checkUpdate: (force?: boolean) => Promise<boolean>;
}

// 请求互斥：并发/连点只发一个请求
let updateChecking = false;

export const useUpdateStore = create<UpdateState>((set) => ({
  hasUpdate: false,
  latestVersion: '',
  latestUrl: '',
  lastCheckedAt: 0,
  // 应用启动时静默检测一次（限流 24h）；失败（网络/无 Release/超时）静默视为无更新，
  // 绝不打扰用户 —— 没有红点就当作没有更新。
  // force=true 为设置页手动「检查更新」：绕过 24h 限流立即请求。
  // 任何失败都不抛错、一律视为「无更新」（返回 false），成功/失败都写缓存限流；
  // 手动 force 不受缓存影响，随时可重试。
  checkUpdate: async (force = false) => {
    // 并发锁：静默检查进行中时，普通调用直接跳过；force（手动检查）必须继续，
    // 否则启动静默检查未结束时手动点「检查更新」会被吞 → 误报「已是最新版本」
    if (updateChecking && !force) return false;
    const { lastCheckedAt } = useUpdateStore.getState();
    // 合并内存与持久化的检查时间：非强制且 24h 内已查过则直接跳过（启动静默限流）
    const persisted = await AsyncStorage.getItem(UPDATE_LAST_CHECK_KEY).catch(() => null);
    const persistedTs = persisted ? Number(persisted) || 0 : 0;
    const lastTs = Math.max(lastCheckedAt, persistedTs);
    if (!force && lastTs && Date.now() - lastTs < UPDATE_CHECK_INTERVAL) return false;
    updateChecking = true;
    const finish = (has: boolean, tag: string, url: string) => {
      const now = Date.now();
      set({ hasUpdate: has, latestVersion: has ? tag : '', latestUrl: has ? url : '', lastCheckedAt: now });
      AsyncStorage.setItem(UPDATE_LAST_CHECK_KEY, String(now)).catch(() => {});
    };
    try {
      // 源1：GitHub API（未认证匿名限流 60/h，共享出口 IP 时可能 403）
      let tag = '';
      try {
        const res = await Promise.race([
          fetch(GITHUB_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yaya-msg-mobile' } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), UPDATE_TIMEOUT)),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: any = await res.json();
        tag = String(data.tag_name || data.name || '');
      } catch {
        // 源2：GitHub release 页面 HTML（无 API 匿名限流）：重定向 URL 提取 tag
        const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';
        const page = await Promise.race([
          fetch(GITHUB_RELEASES_PAGE, { headers: { 'User-Agent': UA } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), UPDATE_TIMEOUT + 2000)),
        ]);
        if (!page.ok) throw new Error(`HTTP ${page.status}`);
        const finalUrl = page.url || GITHUB_RELEASES_PAGE;
        const tagMatch = finalUrl.match(/\/releases\/tag\/([^/?#]+)/);
        tag = tagMatch ? decodeURIComponent(tagMatch[1]) : '';
        if (!tag) throw new Error('page missing tag');
      }
      // 有比当前更新的 release 版本时，跳转链接统一用自建下载页（用户可随时改页内下载渠道）
      const has = !!tag && isNewerVersion(tag, APP_VERSION);
      finish(has, tag, has ? UPDATE_DOWNLOAD_PAGE : '');
      return has;
    } catch {
      // 检查失败（网络不通/两个源都不可用）：视为无更新，不抛错不打扰
      finish(false, '', '');
      return false;
    } finally {
      updateChecking = false;
    }
  },
}));
