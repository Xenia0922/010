import AsyncStorage from '@react-native-async-storage/async-storage';
import pocketApi from '../api/pocket48';
import { useMemberStore } from '../store';
import { logInfo, logWarn } from '../utils/runtimeLog';

/**
 * 房间映射缓存服务（v2.7.4）：
 * 官方数据（已交叉验证）：
 *  - getStarServerMap() → content.userServerMap = { "<userId>": "<serverId>" }（大房间 serverId）
 *  - im/seine/server/detail(serverId) → content.channelInfoList，顺序固定：
 *      [0] = 大房间 channelId（→ member.channelId）
 *      [1] = 小房间 channelId（→ member.yklzId）
 *  - 大房间的 serverId 就是 userServerMap 的值（张琼予 1148117 / 王秭歆 1181028 均与旧库吻合）
 *
 * 解析结果持久化到 AsyncStorage，避免每次扫描重复请求 seine/server/detail。
 */

const ROOM_MAP_KEY = 'yaya_member_room_map_v2';

export interface RoomMapEntry {
  channelId: string; // 大房间 channelId
  yklzId: string;    // 小房间 channelId
  serverId: string;  // 大房间 serverId
  updatedAt: number;
}

let roomMap: Record<string, RoomMapEntry> = {};
let hydrated = false;

export async function hydrateRoomMap(): Promise<void> {
  if (hydrated) return;
  try {
    const raw = await AsyncStorage.getItem(ROOM_MAP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') roomMap = parsed;
    }
  } catch {
    roomMap = {};
  }
  hydrated = true;
  logInfo(`[roomMap] 已加载房间映射缓存 ${Object.keys(roomMap).length} 条`, 'roomMap');
}

export function getRoomMapEntry(memberId: string): RoomMapEntry | undefined {
  return roomMap[String(memberId)];
}

/**
 * 把成员 store 中已有的 channelId/yklzId/serverId 写入缓存。
 * 成员库（yk1z+官方双源）为权威：现有缓存条目只补「逐字段缺口」（空值/0 可被库值覆盖），
 * 已有有效值的字段保持不变，避免覆盖运行时 seine 解析出的新映射。
 */
export function seedRoomMapFromMembers(members: any[]): void {
  let changed = false;
  for (const m of members) {
    const id = String(m?.id || '');
    if (!id) continue;
    const cid = String(m?.channelId || '');
    const yid = String(m?.yklzId || '');
    const sid = String(m?.serverId || '');
    if (!cid && !yid && !sid) continue;
    const existing = roomMap[id];
    if (!existing) {
      roomMap[id] = { channelId: cid, yklzId: yid, serverId: sid, updatedAt: Date.now() };
      changed = true;
      continue;
    }
    if ((!existing.channelId || existing.channelId === '0') && cid) { existing.channelId = cid; changed = true; }
    if ((!existing.yklzId || existing.yklzId === '0') && yid) { existing.yklzId = yid; changed = true; }
    if ((!existing.serverId || existing.serverId === '0') && sid) { existing.serverId = sid; changed = true; }
    existing.updatedAt = Date.now();
  }
  if (changed) persistRoomMap();
}

function persistRoomMap(): void {
  AsyncStorage.setItem(ROOM_MAP_KEY, JSON.stringify(roomMap)).catch(() => {});
}

/**
 * 解析 seine/server/detail 返回：
 * channelInfoList[0]=大房间 channelId、[1]=小房间 channelId；chatServerInfo.serverId=大房间 serverId。
 * 返回 { channelId(大), yklzId(小), serverId }，解析不到则为 ''。
 */
export function parseSeineDetail(content: any): { channelId: string; yklzId: string; serverId: string } {
  const list = Array.isArray(content?.channelInfoList) ? content.channelInfoList : [];
  const big = list[0];
  const small = list[1];
  const channelId = String(big?.channelId || '');
  const yklzId = String(small?.channelId || '');
  const serverId = String(content?.chatServerInfo?.serverId || '');
  return { channelId, yklzId, serverId };
}

/**
 * 按 userId 解析房间映射：
 *   1. 缓存命中（且含大房间 channelId）→ 直接返回
 *   2. 缺 serverId 时用 userServerMap 或 store 已有值补（调用方传入）
 *   3. 无缓存或缓存缺 → seine/server/detail(serverId) 解析（channelInfoList[0]/[1]），写缓存 + 回写 store
 * 返回 { channelId, yklzId, serverId, fromCache }
 */
export async function resolveMemberRooms(
  memberId: string,
  opts: { name?: string; knownChannelId?: string; knownYklzId?: string; knownServerId?: string } = {},
): Promise<{ channelId: string; yklzId: string; serverId: string; fromCache: boolean }> {
  const id = String(memberId);
  let channelId = opts.knownChannelId || '';
  let yklzId = opts.knownYklzId || '';
  let serverId = opts.knownServerId || '';

  // 1) 缓存
  const cached = roomMap[id];
  if (cached) {
    if (!channelId) channelId = cached.channelId || '';
    if (!yklzId) yklzId = cached.yklzId || '';
    if (!serverId) serverId = cached.serverId || '';
    if (channelId && serverId) return { channelId, yklzId, serverId, fromCache: true };
  }

  // 2) store 中已有（调用方没传）
  if (!channelId || !yklzId || !serverId) {
    const m = useMemberStore.getState().members.find((x) => String(x.id) === id);
    if (m) {
      if (!channelId) channelId = String(m.channelId || '');
      if (!yklzId) yklzId = String(m.yklzId || '');
      if (!serverId) serverId = String(m.serverId || '');
    }
  }
  if (channelId && serverId) {
    roomMap[id] = { channelId, yklzId, serverId, updatedAt: Date.now() };
    return { channelId, yklzId, serverId, fromCache: true };
  }

  // 2b) 连 serverId 都没有 → im/server/jump 按 userId 直查（48tools 同款 ServerJumpResult：
  // content={serverId, channelId}；需登录态，未登录/无权限时静默失败）
  if (!serverId && !channelId) {
    try {
      const jres: any = await pocketApi.serverJump(Number(id));
      const jc = jres?.content || jres?.data || {};
      const jsid = String(jc?.serverId || '');
      const jcid = String(jc?.channelId || '');
      if (jsid && jsid !== '0') {
        serverId = jsid;
        if (jcid && jcid !== '0') channelId = jcid;
        roomMap[id] = { channelId, yklzId, serverId, updatedAt: Date.now() };
        persistRoomMap();
        logInfo(`[roomMap] serverJump 解析 userId=${id} ${opts.name || ''} -> 大=${channelId} 小=${yklzId} srv=${serverId}`, 'roomMap');
      }
    } catch (e: any) {
      // 登录态缺失等，静默失败（不刷日志噪音）
    }
  }

  // 3) seine/server/detail 反查（serverId 是必需入参）
  if (serverId && !channelId) {
    try {
      const res: any = await pocketApi.getSeineServerDetail(Number(serverId));
      const content = res?.content || res?.data || {};
      const parsed = parseSeineDetail(content);
      if (parsed.channelId) {
        channelId = parsed.channelId;
        if (!yklzId) yklzId = parsed.yklzId;
        if (!serverId) serverId = parsed.serverId || serverId;
      } else {
        // 诊断：接口返回了但没解析出大房间——输出原始结构便于识别（空频道/结构变化/单频道）
        const listLen = Array.isArray(content?.channelInfoList) ? content.channelInfoList.length : -1;
        const keys = content ? Object.keys(content).join(',') : 'EMPTY';
        logWarn(`[roomMap] seine 无大房间 userId=${id} ${opts.name || ''} srv=${serverId} listLen=${listLen} keys=${keys} raw=${JSON.stringify(content).slice(0, 300)}`, 'roomMap');
      }
      roomMap[id] = { channelId, yklzId, serverId, updatedAt: Date.now() };
      persistRoomMap();
      if (channelId || yklzId || serverId) {
        useMemberStore.getState().patchMemberByUserId(id, { channelId, yklzId, serverId });
      }
      logInfo(`[roomMap] seine 解析 userId=${id} ${opts.name || ''} -> 大=${channelId} 小=${yklzId} srv=${serverId}`, 'roomMap');
    } catch (e: any) {
      logWarn(`[roomMap] seine 解析失败 userId=${id}：${e?.message || String(e)}`, 'roomMap');
    }
  }
  return { channelId, yklzId, serverId, fromCache: false };
}