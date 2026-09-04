import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import pocketApi from '../api/pocket48';
import { logInfo, logWarn } from '../utils/runtimeLog';
import { hydrateRoomMap, resolveMemberRooms } from '../services/roomMapCache';

/** 上麦快照持久化 key：冷启动先展示旧结果，后台再增量重扫 */
const SNAPSHOT_KEY = 'yaya_onmic_snapshot_v1';

export interface OnMicMemberInput {
  memberId: string;
  name: string;
  channelId: string;
  serverId: string;
  smallChannelId?: string;
  /** 成员状态分类（官方源优先）：退团/暂休不进扫描 */
  state?: string;
}

export interface OnMicEntry {
  memberId: string;
  name: string;
  channelId: string;
  serverId: string;
  smallChannelId: string;
  /** 房间电台音频流已开启（streamUrl 存在） */
  hasRadio: boolean;
  /** 当前在麦（语音）人数 */
  onMicCount: number;
  /** 上麦信号来自小房间（大房间无声时补测得出，播放页应默认小房间） */
  smallVoice?: boolean;
  /** 最近一次探测到的流地址（秒开用；wsSecret 会过期，播放页会立即后台校验换流） */
  streamUrl?: string;
  /** 本条目最近一次确认时间（快照恢复时用于展示时效） */
  updatedAt?: number;
}

interface OnMicState {
  /** 以 memberId 为键的上麦成员表 */
  onMic: Record<string, OnMicEntry>;
  scanning: boolean;
  lastScan: number;
  /** 本轮扫描总数（供 UI 显示进度） */
  total: number;
  /** 本轮已探测数 */
  done: number;
  /** 成员最近一次探测时间（增量扫描按最久未探测排序取预算） */
  probedAt: Record<string, number>;
  /** 快照年龄（毫秒）：>0 表示当前数据来自快照恢复 */
  snapshotAgeMs?: number;
  scan: (members: OnMicMemberInput[], opts?: { force?: boolean; smallFallback?: boolean }) => Promise<void>;
  clear: () => void;
}

/** 两次扫描周期之间的最小间隔（毫秒） */
const SCAN_INTERVAL = 60 * 1000;
/** 非强制扫描每轮预算：最多探测 1/3 成员（至少 40 位），最久未探测的优先，约 3 轮全量覆盖 */
const BUDGET_MIN = 40;
/** 并发探测数：8→16（实测全量 529 人从 ~95s 降到 ~40s；配合「发现即上屏」体验显著变快） */
const SCAN_CONCURRENCY = 16;

/**
 * 判断某成员的 `team/voice/operate`(operateCode=2) 返回内容是否处于「上麦中」：
 *  - content.streamUrl 非空 → 房间电台音频流已开（有人在麦上播音）
 *  - content.voiceUserList 中存在 voiceStatus !== false 的用户 → 有人在语音麦上
 * 两者任一满足即视为上麦中。
 */
function parseOnMic(content: any): { hasRadio: boolean; onMicCount: number } {
  if (!content) return { hasRadio: false, onMicCount: 0 };
  const hasRadio = !!content.streamUrl;
  const list = Array.isArray(content.voiceUserList) ? content.voiceUserList : [];
  const onMicCount = list.filter((u: any) => u && u.voiceStatus !== false).length;
  return { hasRadio, onMicCount };
}

let snapshotHydrated = false;

/**
 * v2.7.4 上麦扫描（语义：全部成员房间电台探测）：
 *  - 上麦 ≠ 口袋直播（liveList 是直播列表，与房间语音无关），只认 voice/operate 返回。
 *  - 快照优先：冷启动先恢复上次上麦结果（秒显），再后台重扫。
 *  - 预算制增量：非强制扫描每轮只探测「最久未探测」的 1/3（至少 40 位），
 *    降低服务端压力（原全量 505 人/轮）；强制扫描（进页）仍全量。
 *  - 大房间无声时补测小房间（yklzId），小房间有音则标记 smallVoice，播放页默认切小房间。
 *  - 60s 节流 + scanning 防重入。
 */
export const useOnMicStore = create<OnMicState>((set, get) => ({
  onMic: {},
  scanning: false,
  lastScan: 0,
  total: 0,
  done: 0,
  probedAt: {},
  snapshotAgeMs: undefined,
  scan: async (allMembers, opts = {}) => {
    if (!allMembers || allMembers.length === 0) return;
    if (get().scanning) return;
    // 节流：距上次扫描不足 SCAN_INTERVAL 时跳过（除非 force 强制刷新）
    const last = get().lastScan;
    if (!opts.force && last && Date.now() - last < SCAN_INTERVAL) {
      return;
    }
    // 冷启动：先恢复上麦快照（仅首次），页面秒显旧数据
    if (!snapshotHydrated) {
      snapshotHydrated = true;
      try {
        const raw = await AsyncStorage.getItem(SNAPSHOT_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          const entries: Record<string, OnMicEntry> = (parsed?.entries && typeof parsed.entries === 'object')
            ? parsed.entries : {};
          const savedAt = Number(parsed?.savedAt || 0);
          const ageMs = savedAt ? Date.now() - savedAt : 0;
          if (Object.keys(entries).length) {
            set({ onMic: entries, snapshotAgeMs: ageMs >= 0 ? ageMs : 0 });
            logInfo(`[onMic] 快照恢复上麦成员 ${Object.keys(entries).length} 位（${Math.round(Math.max(ageMs, 0) / 60000)} 分钟前）`, 'onMic');
          }
        }
      } catch {
        // 快照损坏忽略
      }
    }
    set({ scanning: true, total: 0, done: 0 });
    const updates: Record<string, OnMicEntry> = {};
    let voiceSampleLogged = false;
    let uniq: OnMicMemberInput[] = [];
    try {
      await hydrateRoomMap();
      uniq = allMembers.filter(
        (m, i, arr) => arr.findIndex((x) => x.memberId === m.memberId) === i,
      );
      // 退团/暂休成员不进上麦扫描：官方分类（channelId/serverId 缺失的也被滤掉）
      const beforeState = uniq.length;
      uniq = uniq.filter((m) => m.state !== 'left' && m.state !== 'paused');
      if (uniq.length !== beforeState) {
        logInfo(`[onMic] 状态过滤移除退团/暂休 ${beforeState - uniq.length} 位（剩余 ${uniq.length}）`, 'onMic');
      }
      if (!uniq.length) {
        set({ scanning: false, lastScan: Date.now(), done: 0, total: 0 });
        return;
      }

      // 预算制增量：非强制扫描只取「最久未探测」的子集
      const probedAt = { ...get().probedAt } as Record<string, number>;
      let candidates = uniq;
      if (!opts.force) {
        const budget = Math.max(BUDGET_MIN, Math.ceil(uniq.length / 3));
        if (uniq.length > budget) {
          candidates = [...uniq]
            .sort((a, b) => (probedAt[a.memberId] || 0) - (probedAt[b.memberId] || 0))
            .slice(0, budget);
        }
      }
      set({ total: candidates.length });
      // 小房间补测只在小扫描（关注成员等 ≤40 位）里做：大批量（如全量 529 人）做的话
      // 每个静默成员都多打一次接口，请求量翻倍拖慢扫描。关注成员仍由房间页小扫描覆盖。
      const enableSmallFallback = opts.smallFallback ?? candidates.length <= 40;
      // 成功探测集合：仅「本次请求成功且确认未上麦」的成员才允许从列表移除；
      // 请求失败（网络/超时/未登录）的成员保留旧状态——避免一次网络抖动整列被清空（"加载不出上麦列表"根因）
      const okIds = new Set<string>();
      let cursor = 0;
      const worker = async () => {
        while (cursor < candidates.length) {
          const m = candidates[cursor++];
          try {
            // 房间映射：缓存优先 → store → serverJump → seine（逐步补齐，持久化）
            const room = await resolveMemberRooms(m.memberId, {
              name: m.name,
              knownChannelId: m.channelId,
              knownYklzId: m.smallChannelId,
              knownServerId: m.serverId,
            });
            if (!room.channelId || room.channelId === '0' || room.channelId === 'undefined') {
              okIds.add(m.memberId);
              probedAt[m.memberId] = Date.now();
              continue; // 实在拿不到大房间 channelId 的成员跳过（成功判定：本次确无结果）
            }
            const res: any = await pocketApi.operateRoomVoice({ channelId: room.channelId, serverId: room.serverId });
            const content = res?.content || (res?.data && res.data.content) || {};
            // 诊断：首个候选的真实返回结构（校准解析字段）
            if (!voiceSampleLogged) {
              voiceSampleLogged = true;
              logInfo(`[onMic] voice/operate 返回结构（${m.name} ch=${room.channelId} srv=${room.serverId}）：${JSON.stringify(res).slice(0, 700)}`, 'onMic');
            }
            let { hasRadio, onMicCount } = parseOnMic(content);
            let smallVoice = false;
            let smallStreamUrl = '';
            // 大房间无声 → 小房间补测（仅小扫描开启；很多成员在小房间开语音）
            const smallCid = room.yklzId || m.smallChannelId || '';
            if (enableSmallFallback && !hasRadio && onMicCount === 0 && smallCid && smallCid !== '0') {
              try {
                const smallRes: any = await pocketApi.operateRoomVoice({ channelId: smallCid, serverId: room.serverId });
                const smallContent = smallRes?.content || (smallRes?.data && smallRes.data.content) || {};
                const small = parseOnMic(smallContent);
                if (small.hasRadio || small.onMicCount > 0) {
                  hasRadio = small.hasRadio;
                  onMicCount = small.onMicCount;
                  smallVoice = true;
                  smallStreamUrl = String(smallContent?.streamUrl || '');
                  logInfo(`[onMic] ${m.name} 小房间上麦中：radio=${hasRadio} 在麦=${onMicCount} ch=${smallCid} srv=${room.serverId}`, 'onMic');
                }
              } catch {
                // 小房间探测失败忽略
              }
            }
            if (hasRadio || onMicCount > 0) {
              const entry: OnMicEntry = {
                memberId: m.memberId,
                name: m.name,
                channelId: room.channelId,
                serverId: room.serverId,
                smallChannelId: room.yklzId || m.smallChannelId || '',
                hasRadio,
                onMicCount,
                smallVoice: smallVoice || undefined,
                streamUrl: smallVoice
                  ? (smallStreamUrl || undefined)
                  : (String(content?.streamUrl || '') || undefined),
                updatedAt: Date.now(),
              };
              updates[m.memberId] = entry;
              // 发现即上屏：不等整轮扫描结束，立即把该成员写进列表（新发现/快照成员都能即时出现）
              set((s) => ({ onMic: { ...s.onMic, [entry.memberId]: entry } }));
              if (!smallVoice) {
                logInfo(`[onMic] ${m.name} 上麦中：radio=${hasRadio} 在麦=${onMicCount} ch=${room.channelId} srv=${room.serverId}`, 'onMic');
              }
            }
            okIds.add(m.memberId);
          } catch {
            // 单个成员查询失败（未登录 / 无权限 / 网络）忽略，不阻断整体扫描；不进 okIds → 列表保留其旧状态
          } finally {
            probedAt[m.memberId] = Date.now();
            set((s) => ({ done: s.done + 1 }));
          }
        }
      };
      const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, candidates.length) }, () => worker());
      await Promise.all(workers);
      logInfo(`[onMic] 扫描完成：${candidates.length} 位，发现上麦 ${Object.keys(updates).length} 位${opts.force ? '（全量）' : '（增量）'}`, 'onMic');
      // 合并而非整体替换：本次扫描到的成员（在麦写入、未在麦移除），其余成员状态保持不变
      set((s) => {
        const next: Record<string, OnMicEntry> = { ...s.onMic };
        const scannedIds = new Set(candidates.map((m) => m.memberId));
        // 仅移除「成功确认未上麦」的成员；失败的保留（防误清）
        scannedIds.forEach((id) => { if (okIds.has(id) && !(id in updates)) delete next[id]; });
        Object.assign(next, updates);
        return {
          onMic: next,
          probedAt,
          scanning: false,
          lastScan: Date.now(),
          done: get().total,
          snapshotAgeMs: undefined,
        };
      });
    } catch (e: any) {
      logWarn(`[onMic] 扫描异常：${e?.message || String(e)}`, 'onMic');
    }
    // 无论成功失败都持久化当前结果（含快照恢复后的首次空结果）
    try {
      await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        entries: get().onMic,
        savedAt: Date.now(),
      }));
    } catch {
      // 持久化失败忽略
    }
  },
  clear: () => set({ onMic: {}, scanning: false, lastScan: 0, total: 0, done: 0, probedAt: {}, snapshotAgeMs: undefined }),
}));