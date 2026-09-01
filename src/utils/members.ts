import { Member } from '../types';

let memberDatabase: Member[] = [];
let memberMap: Map<string, Member> = new Map();

function text(value: any): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

function fallbackMemberId(raw: any): string {
  return text(
    raw?.id
      || raw?.memberId
      || raw?.userId
      || raw?.starId
      || raw?.channelId
      || raw?.roomId
      || raw?.yklzId
      || raw?.smallRoomId
      || raw?.account
      || raw?.ownerName
      || raw?.starName
      || raw?.name,
  );
}

export function pinyinInitials(value: any): string {
  return text(value)
    .replace(/[^a-zA-Z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toLowerCase();
}

export function memberSearchText(member: Member): string {
  const short = member.ownerName.split('-').pop() || '';
  const rawPinyin = (member.pinyin || '').trim();
  // split camelCase: "BaoYuXin" → ["Bao","Yu","Xin"]; "baoyuxin" → ["baoyuxin"]
  const camelParts = rawPinyin.split(/(?=[A-Z])/).filter(Boolean);
  const pinyinLower = rawPinyin.toLowerCase();
  const initials = camelParts.map((p) => p[0]).join('').toLowerCase();
  const initialsSpaced = camelParts.map((p) => p[0]).join(' ').toLowerCase();
  return [
    member.ownerName,
    short,
    pinyinLower,
    initials,
    initialsSpaced,
    member.team || '',
    member.groupName || '',
    String(member.id || ''),
  ].join(' ').toLowerCase();
}

/**
 * 成员状态分类（对齐 yk1z 库，用户确认的最终语义）：
 *  - 库记录（isInGroup 已知）：isInGroup=false → 毕业(1)/退团(2)/暂休(3)；true → 在团（status 2/3 优先判离/暂休）
 *  - 官方 "IDFT" 队伍名只有杨添淩 1 人是真在团（库 isInGroup=true），其余官方 IDFT 标的都是毕业成员
 *    ——所以必须用库的 isInGroup，不能信官方 status/teamName
 *  - 仅官方记录（库未收录的新成员）：status 2=退团 3=暂休 1=在团（荣誉毕业生/明星殿堂→毕业）0=在团
 */
export function classifyMemberState(raw: any): string {
  if (raw?.state) return raw.state;
  const inGroupKnown = raw?.isInGroup !== undefined && raw?.isInGroup !== null;
  const status = Number(raw?.status ?? raw?.memberStatus);
  const team = String(raw?.teamName || raw?.team || '');
  if (inGroupKnown) {
    if (raw.isInGroup === false) {
      if (status === 1) return 'graduated';
      if (status === 2) return 'left';
      if (status === 3) return 'paused';
      return 'unknown';
    }
    // isInGroup=true：在团（status 2/3 视为退团/暂休）
    if (status === 2) return 'left';
    if (status === 3) return 'paused';
    return 'active';
  }
  // 仅官方（库未收录的新成员）：官方 status 编码
  if (status === 2) return 'left';
  if (status === 3) return 'paused';
  if (status === 1) {
    if (team.indexOf('荣誉毕业生') >= 0 || team.indexOf('明星殿堂') >= 0) return 'graduated';
    return 'active';
  }
  if (status === 0) return 'active';
  return 'unknown';
}

export function normalizeMember(raw: any): Member {
  return {
    ...raw,
    id: fallbackMemberId(raw),
    ownerName: text(raw?.ownerName || raw?.starName || raw?.name || raw?.realName || raw?.nickname),
    serverId: text(raw?.serverId),
    channelId: text(raw?.channelId || raw?.roomId),
    yklzId: text(raw?.yklzId || raw?.smallRoomId || raw?.smallChannelId),
    roomId: text(raw?.roomId),
    liveRoomId: text(raw?.liveRoomId),
    team: text(raw?.team || raw?.teamName),
    pinyin: text(raw?.pinyin),
    avatar: text(raw?.avatar),
    groupName: text(raw?.groupName),
    teamId: text(raw?.teamId),
    isInGroup: raw?.isInGroup !== false,
    state: classifyMemberState(raw),
  };
}

export async function loadMembers(json?: any): Promise<Member[]> {
  let arr: any[] = [];
  if (Array.isArray(json)) arr = json;
  else if (json) {
    arr = json.roomId || json.data || json.content || json.list || json.members || [];
  }
  memberDatabase = arr
    .filter((m: any) => m && (m.id || m.memberId || m.userId || m.ownerName || m.starName || m.name))
    .map(normalizeMember)
    .filter((m) => m.id && m.ownerName);
  memberMap.clear();
  for (const m of memberDatabase) {
    memberMap.set(String(m.id), m);
    if (m.serverId) memberMap.set(String(m.serverId), m);
    if (m.channelId) memberMap.set(String(m.channelId), m);
    if (m.yklzId) memberMap.set(String(m.yklzId), m);
  }
  return memberDatabase;
}

export function searchMembers(query: string, limit = 20): Member[] {
  if (!query?.trim()) return memberDatabase.slice(0, limit);
  const q = query.trim().toLowerCase();
  return memberDatabase.filter((m) => {
    const name = m.ownerName.toLowerCase();
    const pn = (m.pinyin || '').toLowerCase();
    const initials = pinyinInitials(m.pinyin);
    const team = (m.team || '').toLowerCase();
    return name.includes(q) || pn.includes(q) || initials.includes(q) || team.includes(q) || m.id.includes(q);
  }).slice(0, limit);
}

export function findMember(idOrName: string): Member | undefined {
  if (!idOrName) return undefined;
  if (memberMap.has(idOrName)) return memberMap.get(idOrName);
  const results = searchMembers(idOrName, 1);
  return results[0];
}

export function findMemberByChannelId(channelId: string): Member | undefined {
  return memberDatabase.find((m) => m.channelId === channelId || m.yklzId === channelId);
}

export function getAllMembers(): Member[] { return memberDatabase; }

export function getMembersByGroup(group: string): Member[] {
  if (group === 'all') return memberDatabase;
  return memberDatabase.filter((m) => m.groupName === group);
}

export function getMemberCount(): number { return memberDatabase.length; }
