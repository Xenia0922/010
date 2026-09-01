import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadMembers, normalizeMember, classifyMemberState } from '../utils/members';
import { Member } from '../types';
import { useMemberStore } from '../store';
import { MEMBERS_URL } from '../constants';
import { fetchWithTimeout } from '../utils/network';
import pocketApi from '../api/pocket48';
import { logInfo, logWarn, logError } from '../utils/runtimeLog';
import { hydrateRoomMap, seedRoomMapFromMembers } from './roomMapCache';

// v6 结构：分类对齐 yk1z 库（isInGroup 为准，官方 IDFT 标的只有杨添淩 1 人真在团）。
// 与 v5（官方分类）不兼容，升级 key 强制首启重拉。
const CACHE_KEY = 'yaya_member_data_cache_v6';

/** 历史缓存版本 key：更新成功后清理，避免 AsyncStorage 库被旧行撑大（曾触发 SQLITE_FULL） */
const OLD_CACHE_KEYS = [
  'yaya_member_data_cache_v1',
  'yaya_member_data_cache_v2',
  'yaya_member_data_cache_v3',
  'yaya_member_data_cache_v4',
  'yaya_member_data_cache_v5',
];

/** 成员库冷启动 TTL：缓存未过期时直接展示并跳过网络同步，加速冷启动 */
const MEMBER_CACHE_TTL = 6 * 60 * 60 * 1000;

export interface MemberDataMeta {
  savedAt: number;
  signature: string;
  count: number;
  source: 'bundle' | 'remote' | 'official' | 'cache';
}

export async function loadCachedMemberData(): Promise<Member[] | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const members = await loadMembers(parsed.members);
    if (!members.length) return null;
    return members;
  } catch {
    return null;
  }
}

export async function getMemberDataMeta(): Promise<MemberDataMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      savedAt: parsed.savedAt || 0,
      signature: parsed.signature || '',
      count: parsed.count || 0,
      source: parsed.source || 'cache',
    };
  } catch {
    return null;
  }
}

export interface MemberUpdateResult {
  updated: boolean;
  count: number;
  message: string;
  source: 'official' | 'none';
  /** 官方接口诊断摘要（目录/映射/字段覆盖），供页面直接展示 */
  detail: string;
}

/** 采样首条记录的字段键，用于确认官方目录到底带哪些房间/档案字段 */
function sampleKeys(list: any[], label: string) {
  const first = list.find((i: any) => i && typeof i === 'object');
  if (!first) return;
  const keys = Object.keys(first);
  logInfo(`[memberData] ${label} 成功：数量=${list.length} 字段数=${keys.length} 样例字段=${keys.slice(0, 40).join(',')}`, 'memberData');
  logInfo(`[memberData] ${label} 首条=${JSON.stringify({
    id: first.id ?? first.memberId ?? first.userId ?? first.starId,
    ownerName: first.ownerName ?? first.starName ?? first.name ?? first.realName ?? first.nickname,
    channelId: first.channelId ?? first.roomId,
    serverId: first.serverId ?? first.serverID,
    yklzId: first.yklzId ?? first.smallRoomId,
    team: first.team ?? first.teamName,
    groupName: first.groupName,
    pinyin: first.pinyin,
  })}`, 'memberData');
}

/**
 * 拉取 yk1z 成员库（房间映射权威源）。
 * 官方接口只给档案字段 + userId→serverId 字典，不给 channelId/yklzId；
 * 房间消息/大小房间切换必须靠本库的 channelId（大房间）/yklzId（小房间）/serverId。
 */
async function fetchYk1zDb(): Promise<Member[]> {
  const res = await fetchWithTimeout(`${MEMBERS_URL}?t=${Date.now()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  }, 15000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const arr = Array.isArray(json) ? json : (json.roomId || json.data || json.members || json.list || []);
  const members = await loadMembers(arr);
  if (!members.length) throw new Error('yk1z 成员库返回为空');
  // 清理：normalizeMember 的 channelId 会兜底到 roomId，但 DB 的 roomId（如 67236601）是旧口袋房间
  // id、不是大房间 channelId。仅当原始记录真的带 channelId 才算有效（毕业成员多为 roomId-only）。
  for (const m of members) {
    const raw = arr.find((x: any) => String(x?.id ?? x?.memberId ?? x?.userId) === String(m.id));
    if (raw && !raw.channelId) m.channelId = '';
  }
  return members;
}

/**
 * 官方成员库（v2.7.4 双源合并，修复大小房间回归）：
 *   1. yk1z 数据库（MEMBERS_URL）→ 权威房间映射：channelId(大)/yklzId(小)/serverId，全量 900+ 位
 *   2. group_team_star → content.starInfo（871 位现役，档案字段；officialInfo 仅运营账号勿用）
 *   3. star/server/map/get → content.userServerMap（userId→serverId，补齐无库成员的 serverId）
 *   4. 关注成员 latestMessage 反推 channelId（消息带 channelId，补最后缺口）
 *   5. seine/server/detail 由 roomMapCache 按需执行（运行时兜底）
 *
 * 合并规则：房间映射以 yk1z 库为权威（无条件覆盖官方缺失值），官方只补缺口——
 * 与 2.7.3 行为一致（大小房间正确、小房间 channelId 可查），同时档案/花名册动态化。
 */
export async function fetchOfficialMembers(): Promise<Member[]> {
  // 并行拉取三源，任一失败不阻断整体（官方目录失败时退化为仅 yk1z 库）
  const [dbSettled, catalogSettled, mapSettled] = await Promise.allSettled([
    fetchYk1zDb(),
    pocketApi.getGroupTeamStar(),
    pocketApi.getStarServerMap(),
  ]);

  const dbMembers: Member[] = dbSettled.status === 'fulfilled' ? dbSettled.value : [];
  if (dbSettled.status === 'rejected') {
    logWarn(`[memberData] yk1z 成员库拉取失败（房间映射缺失，大小房间可能不可用）：${dbSettled.reason?.message || String(dbSettled.reason)}`, 'memberData');
  } else {
    logInfo(`[memberData] yk1z 成员库：${dbMembers.length} 位（成员库底座）`, 'memberData');
  }

  // 官方成员目录
  let catalogRes: any = null;
  if (catalogSettled.status === 'fulfilled') {
    catalogRes = catalogSettled.value;
    logInfo(`[memberData] getGroupTeamStar 请求成功 status=${catalogRes?.status ?? '?'} success=${catalogRes?.success ?? '?'} code=${catalogRes?.code ?? '?'}`, 'memberData');
  } else {
    logWarn(`[memberData] getGroupTeamStar 失败（降级为仅 yk1z 库）：${catalogSettled.reason?.message || String(catalogSettled.reason)}`, 'memberData');
  }
  const content = catalogRes?.content || catalogRes?.data || {};
  const starInfo = Array.isArray(content.starInfo) ? content.starInfo : [];
  const officialInfo = content.officialInfo;
  logInfo(`[memberData] group_team_star keys=${Object.keys(content).join(',')} starInfo=${starInfo.length} officialInfo=${Array.isArray(officialInfo) ? officialInfo.length : '?'}`, 'memberData');
  if (starInfo.length) sampleKeys(starInfo, 'group_team_star starInfo');

  // 官方 userId→serverId 字典（补齐服务器映射缺口）
  const userServerMap = new Map<string, string>();
  if (mapSettled.status === 'fulfilled') {
    const mapRes = mapSettled.value;
    const cont = mapRes?.content || mapRes?.data || {};
    logInfo(`[memberData] getStarServerMap 成功 status=${mapRes?.status ?? '?'} content keys=${Object.keys(cont).join(',')}`, 'memberData');
    if (cont.userServerMap && typeof cont.userServerMap === 'object') {
      for (const [k, v] of Object.entries(cont.userServerMap)) {
        if (k && v && k !== '0' && String(v) !== '0') userServerMap.set(String(k), String(v));
      }
      logInfo(`[memberData] userServerMap 字典解析：userId->serverId ${userServerMap.size} 条`, 'memberData');
    } else {
      logInfo(`[memberData] getStarServerMap 原始样例=${JSON.stringify(cont).slice(0, 500)}`, 'memberData');
    }
  } else {
    logWarn(`[memberData] getStarServerMap 失败（不阻断）：${mapSettled.reason?.message || String(mapSettled.reason)}`, 'memberData');
  }

  // 双源合并（v2.7.4 修正版）：成员库 = yk1z 库全量（严格一致，官方独有成员不追加——
  // 官方 starInfo 含虚拟偶像团 Error404Girls 等非真人，追加会污染成员库）。
  // 官方只做：补库里缺失的档案字段（头像/期数/serverId）、用官方 status/队伍重算状态分类、关注消息反推 channelId。
  let members: Member[] = [];
  if (dbMembers.length) {
    const officialById = new Map<string, any>();
    for (const raw of starInfo) officialById.set(String(raw?.userId ?? raw?.id ?? raw?.starId), raw);
    members = dbMembers.map((db) => {
      const off = officialById.get(String(db.id));
      if (!off) return db; // 库独有成员：保持原样（2.7.3 语义，分类用库字段）
      const m: any = { ...db };
      // 官方补缺口（库字段已有值一律不动，保证与 yk1z 库对得上）
      if (!m.avatar) m.avatar = String(off.avatar || '');
      if (!m.pinyin) m.pinyin = String(off.pinyin || '');
      if (!m.groupName) m.groupName = String(off.groupName || '');
      if (!m.team) m.team = String(off.teamName || '');
      if (!m.teamId) m.teamId = String(off.teamId || '');
      if (!m.liveRoomId) m.liveRoomId = String(off.liveRoomId || '');
      if (!m.periodName) m.periodName = off.periodName ? String(off.periodName) : m.periodName;
      if (!m.fullPhoto1) m.fullPhoto1 = off.fullPhoto1 ? String(off.fullPhoto1) : m.fullPhoto1;
      if (!m.fullPhoto2) m.fullPhoto2 = off.fullPhoto2 ? String(off.fullPhoto2) : m.fullPhoto2;
      if (!m.fullPhoto3) m.fullPhoto3 = off.fullPhoto3 ? String(off.fullPhoto3) : m.fullPhoto3;
      if (!m.fullPhoto4) m.fullPhoto4 = off.fullPhoto4 ? String(off.fullPhoto4) : m.fullPhoto4;
      if (!m.wbName) m.wbName = off.wbName ? String(off.wbName) : m.wbName;
      if (!m.wbUid) m.wbUid = off.wbUid ? String(off.wbUid) : m.wbUid;
      if (!m.birthday) m.birthday = off.birthday ? String(off.birthday) : m.birthday;
      // 分类对齐 yk1z 库：不覆盖库的 isInGroup/status/team（官方 "IDFT" 标的几乎全是毕业成员，
      // 只有杨添淩 1 人库 isInGroup=true 是在团），state 保持库语义
      return m;
    });
    logInfo(`[memberData] 双源合并完成：成员库 = yk1z 库 ${members.length} 位（官方仅补缺口与分类）`, 'memberData');
  } else {
    // yk1z 库拉取失败 → 退化为官方目录（房间映射会缺，日志警告）
    members = starInfo
      .map((raw: any) => normalizeMember(raw))
      .filter((m: Member) => m.id && m.ownerName);
    logWarn(`[memberData] yk1z 库不可用，退化为官方目录 ${members.length} 位`, 'memberData');
  }

  // 用 userServerMap 补 serverId（仅无库映射的成员会走到这里）
  if (userServerMap.size) {
    let patched = 0;
    for (const m of members) {
      if (!m.serverId || m.serverId === '0') {
        const sid = userServerMap.get(String(m.id));
        if (sid) { m.serverId = sid; patched += 1; }
      }
    }
    logInfo(`[memberData] userServerMap 补齐 serverId：${patched} 位`, 'memberData');
  }

  // 关注成员 latestMessage 反推 channelId（补最后缺口）
  try {
    const followedRes = await pocketApi.getFollowedIds();
    const followedContent = followedRes?.content || followedRes?.data || {};
    let idsArr: string[] = [];
    for (const key of ['data', 'list', 'friends', 'ids']) {
      if (Array.isArray(followedContent[key])) { idsArr = followedContent[key].map(String); break; }
    }
    if (!idsArr.length && Array.isArray(followedRes)) idsArr = followedRes.map(String);
    logInfo(`[memberData] 关注成员 ${idsArr.length} 位，尝试用最新消息反推 channelId`, 'memberData');
    if (idsArr.length) {
      const serverIds = idsArr
        .map((id: string) => {
          const sid = userServerMap.get(id);
          if (sid) return Number(sid);
          const m = members.find((mm) => String(mm.id) === id);
          return m?.serverId ? Number(m.serverId) : 0;
        })
        .filter((n: number) => n > 0);
      const BATCH = 50;
      const serverToChannel = new Map<string, string>();
      for (let i = 0; i < serverIds.length; i += BATCH) {
        const batch = Array.from(new Set(serverIds.slice(i, i + BATCH)));
        if (!batch.length) continue;
        const lastRes = await pocketApi.getLastMessages(batch);
        const lastList = Array.isArray(lastRes?.content?.lastMsgList) ? lastRes.content.lastMsgList : [];
        if (i === 0) logInfo(`[memberData] lastMessage 首批返回 ${lastList.length} 条`, 'memberData');
        for (const msg of lastList) {
          const sid = String(msg?.serverId || '');
          const cid = String(msg?.channelId || '');
          if (sid && cid && sid !== '0' && cid !== '0') serverToChannel.set(sid, cid);
        }
      }
      if (serverToChannel.size) {
        let patched = 0;
        for (const m of members) {
          if ((!m.channelId || m.channelId === '0') && m.serverId) {
            const cid = serverToChannel.get(String(m.serverId));
            if (cid) { m.channelId = cid; patched += 1; }
          }
        }
        logInfo(`[memberData] lastMessage 反推 channelId：${patched} 位`, 'memberData');
      }
    }
  } catch (e: any) {
    logWarn(`[memberData] 关注 members/反推 channelId 失败（不阻断）：${e?.message || String(e)}`, 'memberData');
  }

  // 统计房间字段覆盖情况
  const withServer = members.filter((m) => m.serverId && m.serverId !== '0').length;
  const withChannel = members.filter((m) => m.channelId && m.channelId !== '0').length;
  const withYklz = members.filter((m) => m.yklzId && m.yklzId !== '0').length;
  logInfo(`[memberData] 目录规范化后：${members.length} 位，serverId 覆盖 ${withServer} / channelId ${withChannel} / yklzId ${withYklz}`, 'memberData');

  // 成员状态分类覆盖（官方优先；上麦扫描据此跳过退团/暂休）
  const stateCounts: Record<string, number> = {};
  for (const m of members) {
    const s = m.state || 'unknown';
    stateCounts[s] = (stateCounts[s] || 0) + 1;
  }
  logInfo(`[memberData] 状态分类：${Object.entries(stateCounts).map(([k, v]) => `${k}=${v}`).join(' / ')}`, 'memberData');
  // IDFT 抽样（官方 teamName=IDFT 且库在团 = 真 IDFT，应只有杨添淩；其余官方 IDFT 标的为毕业）
  const idftOfficial = new Map<string, any>();
  for (const raw of starInfo) idftOfficial.set(String(raw?.userId ?? raw?.id ?? raw?.starId), raw);
  const idft = members.filter((m) => String(idftOfficial.get(String(m.id))?.teamName || '').includes('IDFT'));
  if (idft.length) {
    const activeIdft = idft.filter((m) => m.state === 'active');
    logInfo(`[memberData] 官方 IDFT 标的 ${idft.length} 位，其中库判在团 ${activeIdft.length} 位：${activeIdft.map((m) => `${m.ownerName}(id=${m.id})`).join(' ')}${activeIdft.length ? '' : '（无）'}`, 'memberData');
  }

  // 预热房间映射缓存（为上麦/播放页按需 seine 补齐做准备）
  try {
    await hydrateRoomMap();
    seedRoomMapFromMembers(members);
  } catch (e: any) {
    logWarn(`[memberData] 房间映射缓存预热失败：${e?.message || String(e)}`, 'memberData');
  }
  return members;
}

async function persist(members: Member[], source: MemberDataMeta['source']) {
  await AsyncStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      members,
      signature: '',
      savedAt: Date.now(),
      count: members.length,
      source,
    }),
  );
}

/**
 * v2.7.4：成员库为双源合并——yk1z 数据库（权威房间映射）+ 官方接口（档案/花名册/serverId）。
 * 成功 → 写缓存 + 入 store；失败 → 抛错（保留旧缓存仅作展示）。
 */
export async function updateMemberData(): Promise<MemberUpdateResult> {
  const members = await fetchOfficialMembers();
  if (!members.length) throw new Error('成员数据为空');

  const withServer = members.filter((m) => m.serverId && m.serverId !== '0').length;
  const withChannel = members.filter((m) => m.channelId && m.channelId !== '0').length;
  const withYklz = members.filter((m) => m.yklzId && m.yklzId !== '0').length;

  await persist(members, 'official');
  // 清理历史版本缓存行（防 AsyncStorage 6MB 上限被旧行撑爆 → SQLITE_FULL）
  try {
    await AsyncStorage.multiRemove(OLD_CACHE_KEYS);
  } catch {
    // 清理失败不影响主流程
  }
  useMemberStore.getState().setMembers(members);
  const detail = `成员 ${members.length} · serverId ${withServer} · channelId ${withChannel} · yklzId ${withYklz}（yk1z 库+官方双源）`;
  logInfo(`[memberData] 已载入成员库 ${members.length} 位（${detail}）`, 'memberData');
  return {
    updated: true,
    count: members.length,
    message: `已载入成员库 ${members.length} 位`,
    source: 'official',
    detail,
  };
}

/**
 * 应用启动时的成员数据库引导：
 *   1. 先同步展示本地缓存（避免空白）；
 *   2. 缓存未过期（TTL 6h）→ 跳过网络同步，冷启动秒开；
 *   3. 过期 → 双源拉取更新（失败静默保留缓存，但记日志）。
 */
export async function ensureMemberData(): Promise<void> {
  try {
    const cached = await loadCachedMemberData();
    if (cached && cached.length) {
      useMemberStore.getState().setMembers(cached);
      logInfo(`[memberData] 启动先用本地缓存展示 ${cached.length} 位`, 'memberData');
    } else {
      logInfo('[memberData] 无本地缓存，直接双源拉取（yk1z 库+官方）', 'memberData');
    }
  } catch {
    logWarn('[memberData] 读取本地缓存失败', 'memberData');
  }
  // 冷启动提速：缓存未过期则不动网络
  try {
    const meta = await getMemberDataMeta();
    if (meta && meta.savedAt && meta.count > 0 && Date.now() - meta.savedAt < MEMBER_CACHE_TTL) {
      const mins = Math.round((Date.now() - meta.savedAt) / 60000);
      logInfo(`[memberData] 缓存 ${mins} 分钟前更新，未过期（TTL ${MEMBER_CACHE_TTL / 3600000}h），跳过网络同步`, 'memberData');
      return;
    }
  } catch {
    // 元数据读取失败则继续拉取
  }
  try {
    await updateMemberData();
  } catch (e: any) {
    logWarn(`[memberData] 双源同步失败（保留缓存展示）：${e?.message || String(e)}`, 'memberData');
  }
}