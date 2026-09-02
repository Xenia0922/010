import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState } from 'react-native';
import { PerfFlatList } from '../components/PerfFlatList';
import { setLiveImmersiveMode } from '../native/LivePlayer';
import { usePalette, radii, radiiAlias } from '../theme';
import { useResolvedTheme } from '../hooks/useAppTheme';

import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  ImageBackground,
  Linking,
  Modal,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
} from 'react-native';
import { BlurView } from 'expo-blur';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ScreenOrientation from 'expo-screen-orientation';
import Video from 'react-native-video';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSettingsStore, useMemberStore, useUiStore } from '../store';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { FadeInView, ScalePressable } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { Member, RoomMessage } from '../types';
import { formatTimestamp } from '../utils/format';
import { findMediaDurationSeconds } from '../utils/mediaDuration';
import { setPipPlaying } from '../utils/pip';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import { useOnMicStore } from '../store/onMicStore';
import {
  errorMessage,
  messagePayload,
  messageText,
  normalizeUrl,
  parseMaybeJson,
  pickText,
  unwrapList,
} from '../utils/data';
import { t, useI18n } from '../i18n';
import { logInfo } from '../utils/runtimeLog';
import pocketApi from '../api/pocket48';
import PlayerScreen from '../player';
import ZoomImageModal from '../components/ZoomImageModal';
import { enqueueDownload } from '../services/downloads';
import { memberSearchText } from '../utils/members';
import { getBgDisplayUri, ensureBgCached } from '../services/roomBgCache';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
type FollowedRoom = {
  memberId: string;
  member?: Member;
  lastMessage?: any;
  /** 小房间（yklzId）最新消息，与大房间分开显示 */
  lastSmallMessage?: any;
};

type RoomMode = 'big' | 'small';
type MediaType = 'audio' | 'video' | 'live' | 'image' | 'link';

type RoomMedia = {
  type: MediaType;
  url: string;
  title: string;
  duration?: string;
  liveId?: string;
  isLive?: boolean;
  needsVlc?: boolean;
  cover?: string;
  /** 消息/卡片已明示「回放/录播」：播放时应走可拖进度条的录播播放器，而非直播播放器 */
  replayHint?: boolean;
};

type SenderProfile = {
  id: string;
  name: string;
  avatar: string;
};

type MessageRole = 'idol' | 'mine' | 'fan';

const URL_REG = /(https?:\/\/[^\s"'<>，。！？、]+|rtmp:\/\/[^\s"'<>，。！？、]+)/gi;

const PLAY_URL_FIELDS = [
  'playStreamPath',
  'playUrlPath',
  'playPathUrl',
  'streamUrl',
  'streamURL',
  'playUrl',
  'urlPath',
  'playPath',
  'streamPath',
  'path',
  'src',
  'pullStreamPath',
  'liveStreamPath',
  'livePlayStreamPath',
  'streamPathHd',
  'streamPathHigh',
  'streamPathNormal',
  'streamPathOrigin',
  'url',
  'liveUrl',
  'm3u8Url',
  'flvUrl',
  'hlsUrl',
  'videoUrl',
  'audioUrl',
  'voiceUrl',
  'recordUrl',
  'mediaUrl',
  'filePath',
  'imageUrl',
  'imagePath',
  'picPath',
  'picturePath',
  'cover',
  'content.playStreamPath',
  'content.playUrlPath',
  'content.playPathUrl',
  'content.streamUrl',
  'content.playUrl',
  'content.playPath',
  'content.streamPath',
  'content.pullStreamPath',
  'content.liveStreamPath',
  'content.livePlayStreamPath',
  'content.url',
  'content.imageUrl',
  'content.imagePath',
  'content.picPath',
  'data.playStreamPath',
  'data.playUrlPath',
  'data.playPathUrl',
  'data.streamUrl',
  'data.playUrl',
  'data.playPath',
  'data.streamPath',
  'data.pullStreamPath',
  'data.liveStreamPath',
  'data.livePlayStreamPath',
  'data.url',
  'data.imageUrl',
  'data.imagePath',
  'data.picPath',
];

function shortName(member?: Member, fallback = '') {
  const raw = member?.ownerName || fallback || t('未知成员');
  return raw.replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/, '');
}

/** 房间消息气泡内嵌媒体播放器（统一 PlayerScreen）：
 *  音频 → 隐藏小容器；视频 → 按内容比例自适应高度（maxHeight 340，与旧 AdaptiveAspectVideo 一致） */
function RoomMediaPlayer({ media }: { media: RoomMedia }) {
  const [aspect, setAspect] = useState(16 / 9);
  const [boxW, setBoxW] = useState(0);
  const isAudio = media.type === 'audio';
  const height = isAudio ? 48 : boxW > 0 && aspect > 0 ? Math.min(boxW / aspect, 340) : 200;
  return (
    <View
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0) setBoxW(w);
      }}
      style={{
        height,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: isAudio ? 'transparent' : '#000',
        marginTop: 6,
      }}
    >
      <PlayerScreen
        inline
        source={{
          kind: isAudio ? 'audio' : 'vod',
          url: media.url,
          headers: { 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)', Referer: 'https://h5.48.cn/' },
        }}
        meta={{ title: media.title || '' }}
        onVideoSize={(w, h) => {
          if (w > 0 && h > 0) setAspect(w / h);
        }}
        persistent
      />
    </View>
  );
}

/** 通用文本限位（房间名等） */
function capText(text: string, max = 18) {
  const clean = (text || '').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function parseObject(value: any) {
  const parsed = parseMaybeJson(value);
  if (parsed && typeof parsed === 'object') return parsed;
  return {};
}

function extraInfo(item: any) {
  return parseObject(item?.extInfo);
}

function messageBody(item: any) {
  const body = messagePayload(item);
  return body && typeof body === 'object' ? body : {};
}

function firstTextFrom(objects: any[], paths: string[]) {
  for (const obj of objects) {
    const value = pickText(obj, paths);
    if (value) return value;
  }
  return '';
}

function deepFindText(value: any, keys: string[], depth = 0): string {
  if (!value || depth > 5) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindText(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of keys) {
    const direct = value[key];
    if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct);
  }
  for (const child of Object.values(value)) {
    const found = deepFindText(child, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function collectUrls(value: any, result: string[] = [], depth = 0) {
  if (!value || depth > 6) return result;
  if (typeof value === 'string') {
    const matches = value.match(URL_REG) || [];
    matches.forEach((url) => result.push(normalizeUrl(url)));
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, result, depth + 1));
    return result;
  }
  if (typeof value === 'object') {
    const skipKeys = new Set(['avatar', 'headImg', 'headUrl', 'picPath', 'coverPath', 'coverUrl', 'avatarUrl', 'userAvatar', 'senderAvatar']);
    for (const [key, val] of Object.entries(value)) {
      if (skipKeys.has(key) && typeof val === 'string') continue;
      collectUrls(val, result, depth + 1);
    }
  }
  return result;
}

function senderProfile(item: any, room: Member): SenderProfile {
  if (!item) return { id: '', name: t('未知用户'), avatar: '' };
  const body = messageBody(item);
  const ext = extraInfo(item);
  const objects = [item, ext, body];
  const id = firstTextFrom(objects, [
    'senderUserId',
    'senderId',
    'fromUserId',
    'fromAccount',
    'userId',
    'uid',
    'account',
    'sender.userId',
    'sender.id',
    'user.userId',
    'user.id',
    'message.userId',
    'message.senderId',
  ]) || deepFindText(objects, ['senderUserId', 'fromUserId', 'userId', 'uid']);
  const name = firstTextFrom(objects, [
    'senderName',
    'senderNickName',
    'nickName',
    'nickname',
    'userName',
    'name',
    'fromNickName',
    'sender.nickName',
    'sender.nickname',
    'sender.name',
    'user.nickName',
    'user.nickname',
    'user.name',
    'message.nickName',
    'message.nickname',
  ]) || deepFindText(objects, ['nickName', 'nickname', 'senderName', 'userName', 'name']);
  const avatar = normalizeUrl(firstTextFrom(objects, [
    'avatar',
    'senderAvatar',
    'headImg',
    'headUrl',
    'sender.avatar',
    'sender.headImg',
    'user.avatar',
    'user.headImg',
    'userInfo.avatar',
    'userInfo.headImg',
    'message.avatar',
    'message.headImg',
  ]) || deepFindText(objects, ['senderAvatar', 'avatar', 'headImg', 'headUrl'])); // 仅小头像字段，勿深扫 picPath 大图

  return {
    id,
    name: name || (id ? t('用户 {id}', { id }) : t('未知用户')),
    avatar: avatar || '',
  };
}

function isIdolMessage(item: any, room: Member, includeFans: boolean) {
  const body = messageBody(item);
  const ext = extraInfo(item);
  const profile = senderProfile(item, room);
  const ownerIds = [room.id, (room as any).userId, (room as any).memberId].map(String).filter(Boolean);
  if (profile.id && ownerIds.includes(String(profile.id))) return true;
  // 已识别出发送者 ID 且不是房主（其他成员/粉丝在别人房间发言）：显示自己的名字，不套用房主身份
  if (profile.id) return false;
  // 拿不到发送者 ID：退回原来的判断逻辑
  if (!includeFans) return true;
  const role = firstTextFrom([item, ext, body], ['roleId', 'user.roleId', 'sender.roleId', 'message.roleId']);
  if (role && ['2', '3', '4', 'star', 'idol'].includes(String(role).toLowerCase())) return true;
  return false;
}

function currentUserIdFrom(res: any): string {
  return firstTextFrom([res?.content, res?.data, res], [
    'userInfo.userId',
    'userInfo.id',
    'user.userId',
    'user.id',
    'userId',
    'id',
    'account',
  ]);
}

function messageRole(item: any, room: Member, includeFans: boolean, currentUserId: string): MessageRole {
  if (!item) return 'fan';
  const profile = senderProfile(item, room);
  if (includeFans && currentUserId && profile.id && String(profile.id) === String(currentUserId)) return 'mine';
  if (isIdolMessage(item, room, includeFans)) return 'idol';
  return 'fan';
}

function messageKey(item: any) {
  if (!item) return `empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const direct = item.id || item.msgId || item.messageId || item.clientMsgId || item.uuid || item.msgUuid;
  if (direct) return String(direct);
  const profile = senderProfile(item, {} as Member);
  const body = messageBody(item);
  const text = firstTextFrom([body, item], ['text', 'message', 'msgContent', 'content', 'bodys', 'body']);
  const media = firstTextFrom([body, item], ['url', 'fileUrl', 'pictureUrl', 'coverUrl', 'liveId']);
  // 注意：兜底键【不含 index】—— 同一消息在不同 list 中 index 不同会导致去重失败、重复累积。
  // 无稳定 id 时以 时间+发送者+内容 作近似键，足以区分不同消息并拦截同批重复。
  return String(`${getMessageTime(item)}-${profile.id || profile.name || ''}-${text || media || JSON.stringify(body).slice(0, 120)}`);
}

function getMessageTime(item: any): number {
  const value = Number(item?.msgTime || item?.messageTime || item?.ctime || item?.time || 0);
  return Number.isFinite(value) ? value : 0;
}

function getNextTime(res: any, list: any[]): number {
  const direct = Number(firstTextFrom([res?.content, res?.data, res], ['nextTime', 'next', 'lastTime']));
  if (Number.isFinite(direct) && direct > 0) return direct;
  return 0;
}

// 诊断标记：undefined/null 元素究竟是「首次进入就带毒」还是「merge 累积污染」由这里打印栈标记区分
let __msgDiagTag = 'INIT';
function diagnoseUndefined(list: any[], tag: string) {
  if (!Array.isArray(list)) return;
  const bad = list
    .map((it, i) => (it == null ? i : -1))
    .filter((i) => i >= 0);
  if (bad.length) {
    // 真机/调试时可见：指出是哪个入口首次把 undefined 写进 roomMessages
    // eslint-disable-next-line no-console
    console.warn(`[msgDiag:${tag}] 检出 ${bad.length} 个 null/undefined 元素，下标=[${bad.slice(0, 20).join(',')}]`, {
      rawSample: list.slice(0, 5),
      stack: new Error().stack,
    });
  }
}

function mergeMessages(prev: RoomMessage[], next: RoomMessage[]) {
  // 根因防御：prev / next 任一含 undefined 都会「累积污染」整个聊天记录（之前只在外层 filter，
  // 但 prev 一旦带毒，后续 merge 永远带毒，最终在 renderChatItem 崩溃）。这里双端都过滤 + 诊断。
  const cleanPrev = prev.filter(Boolean);
  if (cleanPrev.length !== prev.length) diagnoseUndefined(prev, 'MERGE_PREV');
  const seen = new Set(cleanPrev.map((item) => messageKey(item)));
  const merged = [...cleanPrev];
  next.filter(Boolean).forEach((item) => {
    const key = messageKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return sortMessagesNewestFirst(merged);
}

function sortMessagesNewestFirst<T>(list: T[]): T[] {
  return list.slice().sort((a: any, b: any) => getMessageTime(b) - getMessageTime(a));
}

/**
 * 大房间最新消息：只认 channelId===大房间 或 成员本人发言。
 * 注意不能按 serverId 兜底——小房间与大房间共用 serverId，兜底会把小房间消息冒充大房间预览。
 */
function findLastMessage(messages: any[], member?: Member) {
  if (!member) return null;
  const bigId = String(member.channelId || '');
  return messages.find((msg) => (
    (bigId && String(msg.channelId || '') === bigId)
    || String(msg.userId || msg.ownerId || '') === String(member.id || '')
  ));
}

/** 小房间（yklzId）最新消息：只认 channelId 精确匹配小房间 */
function findSmallLastMessage(messages: any[], member?: Member) {
  if (!member) return null;
  const ykid = String(member.yklzId || '');
  if (!ykid || ykid === '0' || ykid === 'undefined') return null;
  return messages.find((msg) => String(msg.channelId || '') === ykid)
    || null;
}

function roomChannelId(member: Member, mode: RoomMode) {
  return String(mode === 'small' ? (member.yklzId || '') : (member.channelId || ''));
}

function roomLabel(member: Member, mode: RoomMode) {
  return mode === 'small'
    ? t('小房间 {id}', { id: member.yklzId || t('未配置') })
    : t('大房间 {id}', { id: member.channelId || t('未配置') });
}

function streamScore(url: string, preferLive = false): number {
  const lower = url.toLowerCase();
  if (preferLive && lower.startsWith('rtmp://')) return 130;
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return preferLive ? 100 : 90;
  if (lower.includes('.flv')) return preferLive ? 110 : 70;
  if (lower.startsWith('rtmp://')) return 60;
  if (/\.(mp4|mov)(\?|$)/i.test(lower)) return 80;
  if (/\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(lower)) return 80;
  return 40;
}

function pickPlayableUrls(raw: any, preferLive = false): string[] {
  const candidates: string[] = [];
  const direct = normalizeUrl(pickText(raw, PLAY_URL_FIELDS));
  if (direct) candidates.push(direct);
  const nested = unwrapList(raw, [
    'streams',
    'playStreams',
    'liveStreams',
    'urls',
    'content.streams',
    'content.playStreams',
    'content.liveStreams',
    'content.streamList',
    'content.playStreamList',
    'content.urls',
    'data.streams',
    'data.playStreams',
    'data.liveStreams',
    'data.streamList',
    'data.playStreamList',
    'data.urls',
  ]);
  nested.forEach((item) => {
    const url = normalizeUrl(pickText(item, PLAY_URL_FIELDS));
    if (url) candidates.push(url);
  });
  collectUrls(raw).forEach((url) => candidates.push(url));
  return Array.from(new Set(candidates.filter(Boolean))).sort((a, b) => streamScore(b, preferLive) - streamScore(a, preferLive));
}

function extractLiveIdFromText(value: any): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  const text = `${raw} ${decoded}`;
  return String(
    text.match(/[?&](?:liveId|liveid|live_id)=([0-9]+)/i)?.[1]
    || text.match(/[?&](?:id|live)=([0-9]{5,})/i)?.[1]
    || text.match(/(?:liveId|liveid|live_id)["'\s:=]+([0-9]+)/i)?.[1]
    || text.match(/\/(?:live|playback|record|replay)\/([0-9]+)/i)?.[1]
    || '',
  );
}

function isPlayableMediaUrl(url: string) {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://')
    || lower.includes('.m3u8')
    || lower.includes('.flv')
    || /\.(mp4|mov|m4v|3gp|mp3|m4a|aac|amr|wav)(\?|$)/i.test(lower)
    || lower.includes('playstream')
    || lower.includes('stream');
}

function streamNeedsProxy(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv');
}

function isLiveStreamUrl(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv') || lower.includes('.m3u8');
}

/**
 * 房间点击判「是否录播（可拖进度 vod）」。事实：
 * - 房间消息条目（roomMedia）同步构建、不带 isLive 标记；回放地址常见 HLS(.m3u8)/FLV 形态，
 *   若把 .m3u8 一律当直播流，消息里的录播卡就全部套上直播播放器（无进度条）——本 bug 根因。
 * - rtmp/flv 推流只可能是直播；消息明示回放(replayHint)即使 rtmp/flv 也按录播。
 * - m3u8/mp4 二义：仅当明确带 isLive 标记（直播列表 record:false 命中 / 详情状态位）才直播，否则录播。
 */
function roomTapIsVod(next: RoomMedia): boolean {
  if (next.replayHint) return true;
  const u = String(next.url || '').toLowerCase();
  if (u.startsWith('rtmp://') || u.includes('.flv')) return false;
  return !next.isLive;
}

/** 直播/回放列表短缓存：同一房间短时间内的多次「抓流比对」只打一次接口 */
const LIVE_LIST_CACHE_TTL = 40 * 1000;
const liveListCache: Record<string, { t: number; res: any }> = {};
async function cachedLiveList(record: boolean, page = 0, next = 0): Promise<any> {
  const key = `r:${record ? 1 : 0}:p:${page}:n:${next}`;
  const hit = liveListCache[key];
  if (hit && Date.now() - hit.t < LIVE_LIST_CACHE_TTL) return hit.res;
  const res = await pocketApi.getLiveList({ record, debug: true, page, next });
  liveListCache[key] = { t: Date.now(), res };
  return res;
}

/** 从已拉取的直播/录播详情判断当前状态。
 *  口袋 48 接口的事实字段：录播详情带 content.msgFilePath / content.lrcUrl（LRC 弹幕文件，
 *  见 pocket48.getLiveLrc 的既有用法），直播详情带 isLiving / living / isEnd 等状态位。
 *  无法确定时返回 'unknown'，交由上层按 URL 形态兜底。 */
function detailLiveState(detail: any): 'live' | 'replay' | 'unknown' {
  const d = detail?.content || detail?.data || detail || {};
  if (d.isLiving === true || d.living === true || d.isLive === true) return 'live';
  if (d.isLiving === false || d.living === false || d.isLive === false
    || d.isEnd === true || d.isEnded === true || d.isFinished === true
    || d.isRecord === 1 || d.isRecord === true || d.record === 1 || d.record === true
    || d.isReplay === 1 || d.isReplay === true || d.isPlayback === true
    || Boolean(d.msgFilePath) || Boolean(d.lrcUrl)) return 'replay';
  return 'unknown';
}

function isRawJsonText(value: string) {
  const text = String(value || '').trim();
  return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'));
}

function findLiveItem(listRes: any, liveId: string) {
  const list = unwrapList(listRes, [
    'content.liveList',
    'content.list',
    'content.data',
    'data.liveList',
    'data.list',
    'liveList',
    'list',
  ]);
  return list.find((item: any) => String(item.liveId || item.id || item.live_id || '') === String(liveId));
}

async function resolveRoomLiveMedia(media: RoomMedia): Promise<RoomMedia> {
  const liveId = String(media.liveId || extractLiveIdFromText(media) || '');
  const title = media.title || t('直播 / 录播');
  // 消息里已带可播放地址：直接返回，不再请求任何接口（直播分享/录播卡片通常自带 URL）
  const ownUrl = isPlayableMediaUrl(media.url) ? media.url : '';
  if (ownUrl) {
    const lower = ownUrl.toLowerCase();
    const isRtmp = lower.startsWith('rtmp://') || lower.includes('.flv');
    if (isRtmp) {
      // rtmp/flv 推流只可能是直播
      return { ...media, liveId, title, url: ownUrl, isLive: true, needsVlc: streamNeedsProxy(ownUrl) };
    }
    if (media.replayHint) {
      // 消息明示回放（录播卡）
      return { ...media, liveId, title, url: ownUrl, isLive: false, needsVlc: streamNeedsProxy(ownUrl) };
    }
    // m3u8/mp4 二义：默认按「回放」（录播可拖进度条）；直播列表(record:false)命中才视为直播。
    // 直播(rtmp/flv) 已在上方直接返回 live；Exo 直播状态已修复可正常出画面，因此不再为防黑屏牺牲录播判定
    let isLive = false;
    if (liveId) {
      try {
        const found = await findLiveItem(await cachedLiveList(false, 0, 0), liveId);
        isLive = !!found;
      } catch {
        isLive = false; // 查询失败按回放处理（录播优先，进度条可用；真直播多为 rtmp/flv 不受影响）
      }
    }
    return { ...media, liveId, title, url: ownUrl, isLive, needsVlc: streamNeedsProxy(ownUrl) };
  }
  const attempts: Array<{ label: 'live' | 'replay' | 'detail'; run: () => Promise<any> }> = [];
  if (liveId) {
    attempts.push({ label: 'detail', run: () => pocketApi.getLiveOne(liveId) });
    attempts.push({ label: 'detail', run: () => pocketApi.getOpenLiveOne(liveId) });
    attempts.push({ label: 'live', run: async () => findLiveItem(await cachedLiveList(false, 0, 0), liveId) });
    attempts.push({ label: 'replay', run: async () => findLiveItem(await cachedLiveList(true, 0, 0), liveId) });
    attempts.push({ label: 'replay', run: async () => findLiveItem(await pocketApi.getOpenLivePublicList({ record: true, next: 0 }), liveId) });
  }
  // 并行发起全部候选接口，按优先级取第一个出 URL 的结果；
  // 原来 6 个接口串行（最坏每个 15s 超时），是「解析卡死、第一次点击无响应」的根因。
  const ATTEMPT_TIMEOUT = 4000;
  const settled = await Promise.allSettled(
    attempts.map((attempt) => Promise.race([
      attempt.run(),
      new Promise<any>((resolve) => setTimeout(() => resolve(null), ATTEMPT_TIMEOUT)),
    ])),
  );
  // 先分辨直播还是录播，再决定播放器：
  // 回放列表（record:true）命中的结果确定是录播，优先采用；
  // 其余（正在直播列表 / 详情）按接口状态位或 URL 形态兜底判断，避免把回放流误当直播播放。
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < attempts.length; i += 1) {
      if ((pass === 0) !== (attempts[i].label === 'replay')) continue;
      const result = settled[i];
      if (result.status !== 'fulfilled' || !result.value) continue;
      const detail = result.value;
      const urls = pickPlayableUrls(detail, true).filter(isPlayableMediaUrl);
      if (urls[0]) {
        const d = detail?.content || detail?.data || detail || {};
        const cover = normalizeUrl(
          d.liveCover || d.coverPath || d.cover || d.coverUrl || d.picPath || d.liveRoomCover || ''
        ) || media.cover;
        let isLive: boolean;
        if (attempts[i].label === 'replay') {
          isLive = false;
        } else if (attempts[i].label === 'live') {
          isLive = true;
        } else {
          const state = detailLiveState(detail);
          if (state === 'replay') isLive = false;
          else if (state === 'live') isLive = true;
          else {
            // 详情无明确状态位：rtmp/flv 视为直播；m3u8/mp4 一律按回放（录播可拖，防录播套直播控件）
            const u0 = String(urls[0] || '').toLowerCase();
            isLive = u0.startsWith('rtmp://') || u0.includes('.flv');
          }
        }
        return {
          ...media,
          type: 'live',
          liveId,
          title,
          url: urls[0],
          cover,
          isLive,
          needsVlc: streamNeedsProxy(urls[0]),
        };
      }
    }
  }
  return { ...media, liveId, title, url: ownUrl, isLive: isLiveStreamUrl(ownUrl), needsVlc: streamNeedsProxy(ownUrl) };
}

/**
 * 解析直播地址 + 瞬时失败自动重试：首轮全部候选接口都拿不到地址、且是「快速失败」
 * （网络抖动/接口偶发 500，几秒内就结束）时，稍候 600ms 整轮重试一次。
 * 若首轮是慢超时（已等满 5s+）则不再重试——慢网重试无意义，避免把点击拖成 20s。
 */
async function resolveRoomLiveMediaWithRetry(media: RoomMedia): Promise<RoomMedia> {
  const started = Date.now();
  const first = await resolveRoomLiveMedia(media);
  if (first.url) return first;
  if (Date.now() - started > 2500) return first;
  await new Promise((resolve) => setTimeout(resolve, 400));
  return resolveRoomLiveMedia(media);
}

function classifyMedia(url: string, msgType: string, text: string): MediaType {
  const lower = `${url} ${msgType} ${text}`.toLowerCase();
  // 先按明确扩展名判定（最高优先级）：避免 url 里含 "live" 字样的普通 .mp4/.m3u8 视频被误判成直播。
  if (/\.(mp4|mov|m4v|3gp)(\?|$)/i.test(url)) return 'video';
  if (/\.(m3u8|flv|ts)(\?|$)/i.test(url) || lower.startsWith('rtmp://')) return 'live';
  if (/\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(url)) return 'audio';
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url) || lower.includes('image') || lower.includes('expressimage')) return 'image';
  // 扩展名兜底后再按关键字判定（live/playback/record/replay 等无扩展名场景）
  if (lower.includes('live') || lower.includes('playback') || lower.includes('record') || lower.includes('replay')) return 'live';
  if (lower.includes('voice') || lower.includes('audio')) return 'audio';
  if (lower.includes('video')) return 'video';
  return 'link';
}

// 诊断：收集媒体消息里所有「疑似时长」的数字字段，用于定位真实 duration 字段名。
// 仅在 duration 取不到（返回空）时打印；限频每 30s 最多一次。
// 注意：release 包也打印（去掉 __DEV__ 守卫），便于真机实跑反馈音频时长字段名；低频无碍。
const __diagThrottle: { last: number } = { last: 0 };
function diagDurationFields(label: string, sources: any[]) {
  const now = Date.now();
  if (now - __diagThrottle.last < 30000) return;
  __diagThrottle.last = now;
  const candidates: Record<string, any> = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (!/duration|time|length|second|ms$/i.test(k)) continue;
      if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
        candidates[k] = v;
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[diag:duration:${label}] candidates=`, JSON.stringify(candidates), 'type=', String(sources[0]?.msgType || ''));
}

function roomMedia(item: any): RoomMedia | null {
  if (!item) return null;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const text = messageText(item);
  const msgType = String(item.msgType || item.extMsgType || body.msgType || body.extMsgType || '').toUpperCase();
  if (msgType.includes('GIFT') || String(item.msgType) === '7') return null;

  if (msgType === 'EXPRESSIMAGE' || msgType === 'EXPRESS') {
    const exprUrl = normalizeUrl(body?.expressImgInfo?.emotionRemote || body?.url || '');
    if (exprUrl) return { type: 'image' as const, url: exprUrl, title: t('表情') };
  }

  const liveId = firstTextFrom([item, ext, body], [
    'liveId',
    'liveid',
    'live_id',
    'message.liveId',
    'msg.liveId',
    'content.liveId',
    'data.liveId',
  ]) || deepFindText([item, ext, body], ['liveId', 'liveid', 'live_id']) || extractLiveIdFromText([item, ext, body, text]);
  const urls = pickPlayableUrls([item, ext, body], !!liveId || msgType.includes('LIVE'));
  let url = urls[0] || '';
  // Fallback: try collecting all URLs from raw data
  if (!url && !liveId) {
    const allUrls: string[] = [];
    collectUrls(item, allUrls);
    collectUrls(ext, allUrls);
    collectUrls(body, allUrls);
    url = allUrls.find(u => u && /^https?:\/\//i.test(u)) || '';
  }
  // Fallback: if still no url but text/body has a URL, use it
  if (!url && !liveId) {
    const rawUrls: string[] = [];
    collectUrls(item, rawUrls);
    collectUrls(ext, rawUrls);
    collectUrls(body, rawUrls);
    // Also check the raw text for URLs
    const textMatch = String(text || '').match(/(https?:\/\/[^\s]+)/i);
    if (textMatch) rawUrls.push(textMatch[1]);
    url = rawUrls.find(u => u && /^https?:\/\//i.test(u)) || '';
  }
  // Still no URL? Check if text IS a media indicator
  if (!url && !liveId) {
    const t = String(text || '').toLowerCase();
    if (t.includes('[图片]') || t.includes('[语音]') || t.includes('[视频]') || t.includes('[链接]') || t.includes('[直播]')) {
      // Y20: 占位文本不是可播放媒体——return null 走普通文本气泡，
      // 不再把 '[图片]'/'[直播]' 当 url（此前 classifyMedia 后渲染成破图/误调 Linking）
      return null;
    }
  }
  if (!url && !liveId) return null;
  const type = liveId ? 'live' : classifyMedia(url, msgType, text);
  const durationSec = [item, ext, body].reduce((best, src) => best || findMediaDurationSeconds(src), 0);
  const duration = durationSec > 0 ? String(Math.round(durationSec)) : '';
  // 诊断：audio/video 取不到时长时，dump 真实字段名（DEV 限频）
  if ((type === 'audio' || type === 'video') && !duration) {
    diagDurationFields(type, [item, ext, body]);
  }
  // Audio/video 在房间里只用两个字前缀，避免「语音 语音消息」这种重复；live 保留完整标签
  const title = type === 'audio' ? t('语音')
    : type === 'video' ? t('视频')
    : type === 'live' ? t('直播 / 录播')
    : type === 'image' ? t('图片')
    : text && !text.startsWith('[') && text !== url ? text
    : t('链接');
  // 封面：对齐电脑版 _ref_yk1z —— 优先用服务端关键帧缩略图 thumbPath（口袋48给视频/音频的关键帧图），
  // 拼 https://source.48.cn 前缀（thumbPath 是相对路径，normalizeUrl 不会拼，需单独处理）。
  // 退而求其次再用 coverUrl/coverPath/cover/liveCover/picPath 等绝对地址字段。
  const rawCover = firstTextFrom([item, ext, body], [
    'thumbPath', 'coverUrl', 'coverPath', 'cover', 'liveCover', 'picPath', 'picturePath', 'imageUrl', 'poster',
    'videoCover', 'videoPoster', 'thumbnail', 'thumbUrl',
    'message.coverUrl', 'message.cover', 'content.coverUrl', 'data.coverUrl',
  ]) || deepFindText([item, ext, body], [
    'thumbPath', 'coverUrl', 'cover', 'liveCover', 'picPath', 'coverPath', 'imageUrl', 'poster', 'thumb',
  ]) || '';
  let cover = '';
  if (rawCover) {
    const s = String(rawCover).trim();
    if (/^https?:\/\//i.test(s)) cover = normalizeUrl(s);
    else if (s.startsWith('/')) cover = `https://source.48.cn${s}`;
    else if (!s.startsWith('[')) cover = normalizeUrl(s); // 非占位文本
  }
  // 封面字段已在上方优先 thumbPath/cover 等绝对地址字段；fix7u 已确认服务端对房间视频消息不回独立 cover 字段
  // （fix7t 的 [diag:cover2] 全量扫描证明 finalCover 恒为空，仅 ext.user.avatar 误命中），故无 cover 时一律走首帧。

  // 消息/卡片本身已明示「回放/录播」时，播放器应走「可拖进度条的录播模式」，
  // 而不是仅凭 .flv/.m3u8 后缀误判成直播（回放地址常见 HLS/FLV 形态）。
  const replayHint = !!(msgType.match(/RECORD|PLAYBACK|VOD|REPLAY|回放/)
    || /(回放|录播|replay|playback)/i.test(`${String(text || '')} ${String(body?.title || '')} ${String(body?.content || '')} ${String(body?.desc || '')} ${String(item?.title || '')}`)
    || /(replayUrl|playbackUrl|recordUrl|\/replay\/|\/record\/|\/playback\/)/i.test(`${url} ${String(body?.replayUrl || '')} ${String(body?.playbackUrl || '')} ${String(body?.recordUrl || '')}`));
  const mediaResult = { type, url, title, duration, liveId, cover, replayHint };
  return mediaResult;
}

function roomGiftInfo(item: any): { name: string; num: number; image: string; total: string } | null {
  if (!item) return null;
  const body = messageBody(item);
  const ext = extraInfo(item);
  const msgType = String(item.msgType || item.extMsgType || body.msgType || body.extMsgType || body.messageType || '').toUpperCase();
  const giftReplyInfo = body.giftReplyInfo || ext.giftReplyInfo || {};
  const giftInfo = body.giftInfo || giftReplyInfo.giftInfo || ext.giftInfo || item.giftInfo || null;
  if (!giftInfo && !msgType.includes('GIFT') && String(item.msgType) !== '7') return null;
  if (msgType.includes('LIVE') && !giftInfo) return null;
  const source = giftInfo || giftReplyInfo || body;
  const name = firstTextFrom([giftInfo, giftReplyInfo, body], ['giftName', 'replyName', 'name']) || t('礼物');
  const num = Number(firstTextFrom([giftInfo, giftReplyInfo, body], ['giftNum', 'replyNum', 'num', 'count']) || '1') || 1;
  const image = normalizeUrl(firstTextFrom([giftInfo, giftReplyInfo, body], ['picPath', 'giftPic', 'image', 'icon']));
  const money = Number(firstTextFrom([giftInfo, giftReplyInfo, body], ['money', 'replyMoney', 'cost', 'price']) || '0') || 0;
  return { name, num, image, total: money ? t('{count} 鸡腿', { count: money * num }) : '' };
}

function mediaLabel(type: MediaType) {
  if (type === 'audio') return '\u8bed\u97f3';
  if (type === 'video') return '\u89c6\u9891';
  if (type === 'live') return '\u76f4\u64ad';
  if (type === 'image') return '\u56fe\u7247';
  return '\u94fe\u63a5';
}

// 限频诊断日志：同 key 在 intervalMs 内只打印一次，便于在 release 包观察真实数据而不刷屏
const __diagStamps: Record<string, number> = {};
function __diagStamp(key: string, intervalMs: number): boolean {
  const now = Date.now();
  if (__diagStamps[key] && now - __diagStamps[key] < intervalMs) return false;
  __diagStamps[key] = now;
  return true;
}

function playerSource(url: string) {
  // 与小窗 MiniPlayer 完全一致的防盗链 headers（含 Origin）——fix7u：统一播放器配置，消除封面/放大视频与小窗的方向差异
  return {
    uri: url,
    headers: {
      'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
      Referer: 'https://h5.48.cn/',
      Origin: 'https://h5.48.cn',
    },
  };
}

// 自适应宽高比的视频容器：监听 react-native-video onLoad 取 naturalSize，
// 用真实宽高比驱动容器 aspectRatio，避免硬编码高度把竖屏 9:16 / 横屏 16:9 / 方屏 1:1 视频全部压扁或上下拉黑出现"上下两条"。
// - 默认 16:9，避免第一帧 onLoad 之前视觉塌陷
// - maxHeight 防止异常长方形视频挤爆消息气泡
// - borderRadius / backgroundColor 与 inlineVideo 旧样式一致
//     ExoPlayer 解析的真实 duration（秒）回填角标。探测 Video 不显示画面，不受旋转影响。
function VideoCoverCard({ media, onPress, onLongPress }: { media: RoomMedia; onPress: () => void; onLongPress: () => void }) {
  const palette = usePalette();
  const [resolvedDur, setResolvedDur] = useState(media.duration || '');
  const [coverError, setCoverError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const hasCover = !!media.cover && !coverError;
  // 封面（fix7y 回退）：放弃自动播放/方向修正实验，恢复原始静止首帧封面（paused <Video> 首帧 + 灰占位过渡态）。
  // 服务端不回独立封面字段这一事实未变，且 Android ExoPlayer 对带方向元数据的视频在暂停首帧下会镜像——
  // 用户确认「修不好」，故回退到「有画面、静止、不播放」的原始行为，不再尝试修正方向。
  return (
    <TouchableOpacity style={styles.videoCoverWrap as any} onPress={onPress} onLongPress={onLongPress} activeOpacity={0.9}>
      {hasCover ? (
        <Image
          source={{ uri: media.cover }}
          style={styles.videoCoverImg as any}
          resizeMode="cover"
          onError={() => setCoverError(true)}
        />
      ) : (
        <View style={styles.videoCoverImg as any}>
          <Video
            source={playerSource(media.url)}
            style={StyleSheet.absoluteFill}
            paused
            controls={false}
            resizeMode="cover"
            muted
            playWhenInactive={false}
            playInBackground={false}
            onLoad={() => setLoaded(true)}
          />
          {!loaded ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.fill2, alignItems: 'center', justifyContent: 'center' }]}>
              <MaterialCommunityIcons name="play-circle-outline" size={40} color={palette.labelTertiary} />
            </View>
          ) : null}
        </View>
      )}
      <View style={styles.videoCoverOverlay}>
        <View style={styles.livePlayCircle}>
          <MaterialCommunityIcons name="play" size={22} color="#FFFFFF" style={{ marginLeft: 3 }} />
        </View>
      </View>
      {resolvedDur ? (
        <View style={styles.videoCoverDuration}>
          <Text style={styles.videoCoverDurationText}>{resolvedDur}s</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// 直播/录播封面图：加载失败（source.48.cn 移动端偶发被拒）时回退灰底，避免破图/空白块
function LiveCoverImage({ uri, palette }: { uri: string; palette: any }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.fill2, alignItems: 'center', justifyContent: 'center' }]}>
        <MaterialCommunityIcons name="play-circle-outline" size={34} color={palette.labelTertiary} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={styles.liveCardImg}
      resizeMode="cover"
      onError={() => setErr(true)}
    />
  );
}

// 音频消息卡片。消息体里没有 duration 字段（实测只有 msgTime 时间戳），时长只能靠播放器解析。
// 内部用隐藏探测 Video（1px 透明、不可见）拿 ExoPlayer 真实 duration 回填角标，与 VideoCoverCard 同机制。
function AudioMediaCard({
  media, idol, mine, palette, onPlay, onLongPress, playing,
}: {
  media: RoomMedia; idol: boolean; mine: boolean; palette: any;
  onPlay: () => void; onLongPress: () => void; playing: boolean;
}) {
  const [resolvedDur, setResolvedDur] = useState(media.duration || '');
  return (
    <TouchableOpacity
      style={[styles.mediaCard, { backgroundColor: (idol || mine) ? palette.tint : palette.surfaceGlass, borderColor: (idol || mine) ? 'rgba(255,255,255,0.38)' : palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]}
      activeOpacity={0.92}
      onLongPress={onLongPress}
    >
      {media.cover ? (
        <Image source={{ uri: media.cover }} style={styles.liveCover} resizeMode="cover" />
      ) : null}
      <View style={styles.mediaMeta}>
        <Text style={[styles.mediaIcon, (idol || mine) ? { color: palette.onTint } : { color: palette.tint }]}>{t(mediaLabel(media.type))}</Text>
        {media.type !== 'audio' && media.type !== 'video' && media.title ? (
          <Text style={[styles.mediaTitle, (idol || mine) ? { color: palette.onTint } : { color: palette.label }]} numberOfLines={2}>{media.title}</Text>
        ) : null}
        {resolvedDur ? <Text style={[styles.mediaDuration, (idol || mine) ? { color: palette.onTint } : { color: palette.labelSecondary }]}>{resolvedDur}s</Text> : null}
      </View>
      <TouchableOpacity
        style={[styles.mediaPlayBtn, { backgroundColor: palette.tint, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }]}
        onPress={onPlay}
        activeOpacity={0.85}
      >
        <MaterialCommunityIcons
          name={playing ? 'pause' : 'play'}
          size={14}
          color={palette.onTint}
        />
        <Text style={[styles.mediaPlayText, { color: palette.onTint }]}>
          {playing ? t('暂停') : resolvedDur ? `${resolvedDur}s` : t('播放')}
        </Text>
      </TouchableOpacity>
      {/* 隐藏探测 Video：仅用于拿真实时长，不渲染可见画面 */}
      <Video
        source={playerSource(media.url)}
        style={{ width: 1, height: 1, opacity: 0, position: 'absolute', top: -9999, left: -9999 }}
        paused
        controls={false}
        resizeMode="cover"
        muted
        onLoad={(data: any) => {
          const d = Number(data?.duration || 0);
          if (d > 0) setResolvedDur(String(Math.round(d)));
        }}
      />
    </TouchableOpacity>
  );
}

function normalizeLiveRank(res: any): any[] {
  let list = unwrapList(res, [
    'content.rankList',
    'content.userRankList',
    'content.userRankingList',
    'content.contributionList',
    'content.list',
    'content.data',
    'data.rankList',
    'data.userRankList',
    'data.userRankingList',
    'data.contributionList',
    'data.list',
    'rankList',
    'userRankList',
    'userRankingList',
    'contributionList',
    'list',
  ]);
  if (!list.length) {
    const content = res?.content || res?.data || res;
    const found: any[] = [];
    const walk = (node: any, depth = 0) => {
      if (!node || depth > 5) return;
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, depth + 1));
        return;
      }
      if (typeof node !== 'object') return;
      const hasUser = pickText(node, ['nickName', 'nickname', 'userName', 'name', 'userInfo.nickname', 'userInfo.nickName', 'user.nickname', 'user.nickName']);
      const hasValue = pickText(node, ['score', 'total', 'cost', 'money', 'giftValue', 'value', 'amount', 'contribution', 'count', 'giftNum']);
      if (hasUser || hasValue || node.userInfo || node.user) found.push(node);
      Object.values(node).forEach((value) => walk(value, depth + 1));
    };
    walk(content);
    list = found;
  }
  return list.map((item: any, index: number) => ({
    ...item,
    userId: pickText(item, ['userId', 'uid', 'id', 'account', 'userInfo.userId', 'userInfo.id', 'user.userId', 'user.id', 'user.userIdStr', 'memberInfo.userId', 'memberInfo.id']),
    rank: Number(item.rank || item.no || item.index || index + 1),
    name: pickText(item, [
      'nickName',
      'nickname',
      'userName',
      'name',
      'senderName',
      'userInfo.nickName',
      'userInfo.nickname',
      'userInfo.name',
      'user.nickName',
      'user.nickname',
      'user.userName',
      'user.name',
      'memberInfo.nickName',
      'memberInfo.nickname',
    ], t('用户 {id}', { id: index + 1 })),
    avatar: normalizeUrl(pickText(item, [
      'avatar',
      'headImg',
      'picPath',
      'userInfo.avatar',
      'userInfo.headImg',
      'user.avatar',
      'user.headImg',
      'user.userAvatar',
      'memberInfo.avatar',
    ])),
    value: pickText(item, ['score', 'total', 'cost', 'money', 'giftValue', 'value', 'amount', 'contribution', 'count', 'giftNum'], ''),
  }));
}

function avatarInitial(name: string) {
  return (name || t('用')).trim().slice(0, 1).toUpperCase();
}

// 时长归一逻辑：详见 src/utils/mediaDuration.ts（findMediaDurationSeconds）。
// 该工具按字段名区分秒/毫秒，过滤掉「time」「seconds」等与时长无关的宽泛字段。

export default function FollowedRoomsScreen() {
  const palette = usePalette();
  const resolvedTheme = useResolvedTheme();
  const { t } = useI18n();
  const token = useSettingsStore((state) => state.settings.p48Token);
  const setTabBarHidden = useUiStore((state) => state.setTabBarHidden);
  const showToast = useUiStore((state) => state.showToast);
  const navigation = useNavigation<any>();
  const members = useMemberStore((state) => state.members);
  const onMicMap = useOnMicStore((state) => state.onMic);
  const [followed, setFollowed] = useState<FollowedRoom[]>([]);
  const followedRef = useRef<FollowedRoom[]>([]);
  followedRef.current = followed;
  const [followedLoading, setFollowedLoading] = useState(false);
  // 直播状态：ids=直播中主播 id 集合，names=直播中昵称集合（接口字段不一，昵称兜底）
  const [liveNow, setLiveNow] = useState<{ ids: Set<string>; names: Set<string> }>({ ids: new Set(), names: new Set() });
  const [pinned, setPinned] = useState<string[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Member | null>(null);
  const [roomMessages, setRoomMessages] = useState<RoomMessage[]>([]);
  // 持有一份最新 roomMessages 引用，供 refreshRoomMessages 预判「是否有新消息」而无需把 roomMessages 列入 deps（避免定时器频繁重建）
  const roomMessagesRef = useRef<RoomMessage[]>([]);
  roomMessagesRef.current = roomMessages;
  const [loading, setLoading] = useState(false);
  // 标记「房间消息已成功加载过一次」。仅用它来压制进房/切房间切换瞬间的「暂无消息」空态——
  // 比单纯依赖 loading 更可靠（不依赖 React 批处理时序）。切换/进房期间恒为 false，绝不闪空态；
  // 加载成功返回（即便为空数组）才置 true，此时才允许显示「暂无消息」真实空态。
  const [roomLoadedOnce, setRoomLoadedOnce] = useState(false);
  // 切换房间瞬间的「干净中间态」：true 时列表区只渲染骨架，既不显示旧房间残留消息、也不显示空态。
  // 进新房间的第一帧立刻置 true，新消息 setRoomMessages 后置 false → 彻底消除旧房间内容闪一帧。
  const [followedError, setFollowedError] = useState('');
  const [roomMsgError, setRoomMsgError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [roomSearchQuery, setRoomSearchQuery] = useState('');
  const [roomSearchOpen, setRoomSearchOpen] = useState(false);
  const [roomMode, setRoomMode] = useState<RoomMode>('big');
  const [showFanMessages, setShowFanMessages] = useState(false);
  const [playingMedia, setPlayingMedia] = useState<RoomMedia | null>(null);
  const [roomNextTime, setRoomNextTime] = useState(0);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  // 房间内展示：房间名（channelInfo.channelName）+ 背景图（channelInfo.bgImg）
  const [roomMeta, setRoomMeta] = useState<{ name: string; bg: string }>({ name: '', bg: '' });
  const roomMetaCache = useRef<Record<string, { name: string; bg: string }>>({});
  // 背景图渐显：新背景 uri 变化时重置为 0，ImageBackground onLoad 后淡入到 1，消除「从无到有硬跳变」
  const bgOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // 背景 uri 变化（进房/切房/更新）时先归零，等新图 onLoad 再淡入
    bgOpacity.setValue(0);
  }, [roomMeta.bg, bgOpacity]);
  const activeChannelRef = useRef('');
  const roomSeqRef = useRef(0); // Y22: 进房序号（快速切房丢弃慢响应）
  const msgListRef = useRef<any>(null);
  // 大/小房间滑动位置【各自分开记忆】：key = channelId（大小房间 channelId 不同 → 天然分离），
  // 切回某房间数据到位后恢复到该房间上次位置；无记忆（首次）才停在顶部最新。
  const scrollPosCache = useRef<Record<string, number>>({});
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMsgScroll = useCallback((e: any) => {
    const y = Number(e?.nativeEvent?.contentOffset?.y);
    const cid = activeChannelRef.current;
    if (!cid || !Number.isFinite(y)) return;
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    scrollSaveTimer.current = setTimeout(() => {
      scrollSaveTimer.current = null;
      scrollPosCache.current[cid] = y;
    }, 200);
  }, []);
  // 消息列表 ref：开房/大小房间切换数据到位后滚回顶部（最新消息）——
  // 否则旧房间滚动 offset 套到新房间数据上「滑动位置不对」（用户反馈）

  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const loadingMoreMessagesRef = useRef(false);
  // 实时刷新进行中标志：与 loadMore 互斥，避免两者同时 setRoomMessages 造成列表重排/滚动弹回
  const refreshingRef = useRef(false);
  const [currentUserId, setCurrentUserId] = useState('');
  const [fullImageUrl, setFullImageUrl] = useState('');
  const [roomPlayer, setRoomPlayer] = useState<RoomMedia | null>(null);
  const [roomPlayerFullscreen, setRoomPlayerFullscreen] = useState(false);
  /** 直播解析占位：点击无流地址的直播卡 → 立即弹全屏「解析中」，不再干等无反馈（连击才加载进去的元凶） */
  const [liveResolve, setLiveResolve] = useState<null | { key: string; error: string; media: RoomMedia }>(null);
  const liveResolveToken = useRef(0);

  // 画中画（悬浮窗）状态同步：房间播放器打开且未全屏时置位
  useEffect(() => {
    // 应用内小窗已接管 PiP 标志时不覆盖（防小窗切后台不进悬浮窗）
    if (useMiniPlayerStore.getState().visible) return;
    setPipPlaying(!!roomPlayer && !roomPlayerFullscreen);
  }, [roomPlayer, roomPlayerFullscreen]);
  const [rankVisible, setRankVisible] = useState(false);
  const [rankRows, setRankRows] = useState<any[]>([]);
  const [rankStatus, setRankStatus] = useState('');
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [followBusy, setFollowBusy] = useState<Set<string>>(new Set());
  // 用 ref 持有最新值，避免 toggleFollow 的 useCallback 闭包捕获到过期的 followedIds/followBusy
  const followedIdsRef = useRef(followedIds);
  const followBusyRef = useRef(followBusy);
  followedIdsRef.current = followedIds;
  followBusyRef.current = followBusy;
  // loadFollowed 定义在 toggleFollow 之后，用 ref 持有以避免前向引用报错
  const loadFollowedRef = useRef<(silent?: boolean) => void>(() => {});

  useFocusEffect(useCallback(() => {
    setTabBarHidden(!!selectedRoom || !!roomPlayer);
    return () => {
      setTabBarHidden(false);
      setLiveImmersiveMode(false);
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, [roomPlayer, selectedRoom, setTabBarHidden]));

  useEffect(() => {
    setTabBarHidden(!!selectedRoom);
    if (!selectedRoom) {
      setRoomPlayer(null);
      setLiveImmersiveMode(false);
      setRoomPlayerFullscreen(false);
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    }
    return () => {
      setTabBarHidden(false);
      setLiveImmersiveMode(false);
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, [selectedRoom, setTabBarHidden]);

  useEffect(() => {
    setLiveImmersiveMode(!!roomPlayer && roomPlayerFullscreen);
    if (roomPlayerFullscreen) {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    }
    return () => setLiveImmersiveMode(false);
  }, [roomPlayer, roomPlayerFullscreen]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (roomPlayer) {
        setRoomPlayer(null);
        setRoomPlayerFullscreen(false);
        setLiveImmersiveMode(false);
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
        setTabBarHidden(!!selectedRoom);
        return true;
      }
      if (selectedRoom) {
        setRoomPlayer(null);
        setRoomPlayerFullscreen(false);
        setPlayingMedia(null);
        setSelectedRoom(null);
        setLiveImmersiveMode(false);
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
        setTabBarHidden(false);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [roomPlayer, selectedRoom, setTabBarHidden]);

  const closeRoomPlayer = useCallback(() => {
    setRoomPlayer(null);
    setRoomPlayerFullscreen(false);
    setLiveImmersiveMode(false);
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    setTabBarHidden(!!selectedRoom);
  }, [selectedRoom, setTabBarHidden]);

  // 应用内小窗：房间播放器交棒给悬浮小窗
  const handleRoomMiniPlayer = useCallback(() => {
    const cur = roomPlayer;
    if (!cur?.url) return;
    const lower = String(cur.url || '').toLowerCase();
    const needsNativeLive = !!cur.isLive && (lower.startsWith('rtmp://') || lower.includes('.flv'));
    if (needsNativeLive) {
      // RTMP / FLV 直播流在小窗（原生 LiveExoView 小尺寸 SurfaceView）无法稳定播放，
      // 直接全屏观看（房间内原生播放器可正常播），不进入小窗。
      setRoomPlayerFullscreen(true);
      showToast(t('RTMP 直播请直接全屏观看'));
      return;
    }
    useMiniPlayerStore.getState().open({
      url: cur.url,
      title: cur.title,
      cover: cur.cover,
      isLive: !!cur.isLive,
      position: 0,
      backTo: { mode: 'vod', playUrl: cur.url, playTitle: cur.title, playCover: cur.cover },
    });
    closeRoomPlayer();
  }, [roomPlayer, closeRoomPlayer, showToast, t]);

  const closeRoom = useCallback(() => {
    setRoomPlayer(null);
    setRoomPlayerFullscreen(false);
    setPlayingMedia(null);
    setSelectedRoom(null);
    setRoomMeta({ name: '', bg: '' });
    activeChannelRef.current = '';
    setLiveImmersiveMode(false);
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    setTabBarHidden(false);
  }, [setTabBarHidden]);

  const togglePin = async (memberId: string) => {
    const next = pinned.includes(memberId) ? pinned.filter((id) => id !== memberId) : [...pinned, memberId];
    setPinned(next);
    try {
      await AsyncStorage.setItem('yaya_pinned_rooms', JSON.stringify(next));
    } catch (error: any) {
      showToast(t('置顶保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  };

  /** 置顶成员调换：dir=-1 上移 / 1 下移（交换相邻置顶位） */
  const movePin = async (memberId: string, dir: -1 | 1) => {
    const idx = pinned.indexOf(memberId);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= pinned.length) return;
    const next = [...pinned];
    [next[idx], next[to]] = [next[to], next[idx]];
    setPinned(next);
    try {
      await AsyncStorage.setItem('yaya_pinned_rooms', JSON.stringify(next));
    } catch (error: any) {
      showToast(t('置顶保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  };

  const toggleFollow = useCallback(async (member: Member) => {
    if (!token) { showToast(t('请先登录后再关注成员')); return; }
    const id = String((member as any).id || (member as any).userId || '');
    if (!id || id === '0') { showToast(t('该成员缺少可关注的 ID')); return; }
    if (followBusyRef.current.has(id)) return;
    // 关键：用 ref 读取最新关注状态，避免 useCallback 闭包捕获到过期的 followedIds，
    // 否则「已关注」状态下再次点击会误判为未关注而重复调用 followMember（表现为取消关注无效）
    const isFollowing = followedIdsRef.current.has(id);
    setFollowedIds((prev) => { const n = new Set(prev); if (isFollowing) n.delete(id); else n.add(id); return n; });
    setFollowBusy((prev) => { const b = new Set(prev); b.add(id); return b; });
    try {
      if (isFollowing) await pocketApi.unfollowMember(id);
      else await pocketApi.followMember(id);
      showToast(isFollowing ? t('已取消关注 {name}', { name: member.ownerName }) : t('已关注 {name}', { name: member.ownerName }));
      // 让房间里的关注/取关结果立即反映到关注列表（无需回列表手动刷新）
      setFollowed((prev) => {
        const exists = prev.some((p) => String(p.memberId) === id);
        if (isFollowing) return prev.filter((p) => String(p.memberId) !== id);
        if (exists) return prev;
        return [{ memberId: id, member }, ...prev];
      });
      // 与电脑版一致：操作后延迟从服务器拉取最新关注列表，保证状态权威同步
      setTimeout(() => { loadFollowedRef.current(true); }, 600);
    } catch (e) {
      setFollowedIds((prev) => { const r = new Set(prev); if (isFollowing) r.add(id); else r.delete(id); return r; });
      showToast(t('操作失败：{msg}', { msg: errorMessage(e) }));
    } finally {
      setFollowBusy((prev) => { const b = new Set(prev); b.delete(id); return b; });
    }
  }, [showToast, t, token]);

  useEffect(() => {
    AsyncStorage.getItem('yaya_pinned_rooms').then((v) => {
      if (v) { try { setPinned(JSON.parse(v)); } catch { setPinned([]); } }
    });
  }, []);

  const loadFollowed = useCallback(async (silent = false) => {
    if (!token) {
      setFollowed([]);
      return;
    }
    setFollowedLoading(true);
    try {
      const idsRes = await pocketApi.getFollowedIds();
      const idsArr = unwrapList(idsRes, ['content.data', 'content', 'data', 'list']).map(String);
      setFollowedIds(new Set(idsArr));
      const followedMembers = idsArr.map((id: string) => {
        const member = members.find((item: any) => String(item.id || item.userId) === id);
        return { memberId: id, member };
      }).filter((item: any) => item.member?.channelId);
      const serverIds = followedMembers.map((item: any) => Number(item.member?.serverId || 0)).filter((id: number) => id > 0);
      // 小房间没有独立 serverId，用 yklzId（小房间 channelId）一起查询最新消息，
      // 否则小房间在列表里永远显示「暂无消息」
      const smallRoomIds = followedMembers.map((item: any) => Number(item.member?.yklzId || 0)).filter((id: number) => id > 0);
      const queryIds = Array.from(new Set([...serverIds, ...smallRoomIds]));
      const lastMsgsRes = queryIds.length ? await pocketApi.getLastMessages(queryIds) : null;
      const lastMsgs = unwrapList(lastMsgsRes, ['content.lastMsgList', 'content.data', 'data', 'lastMsgList']);
      setFollowed(followedMembers.map((item: any) => ({
        ...item,
        lastMessage: findLastMessage(lastMsgs, item.member),
        lastSmallMessage: findSmallLastMessage(lastMsgs, item.member),
      })));
      // 上麦检测：扫描关注成员房间语音状态（静默，失败忽略）。结果写入 onMicStore 供
      // 房间列表「上麦中」徽标与房间内上麦按钮共用。
      const onMicInputs = followedMembers
        .map((item: any) => ({
          memberId: item.memberId,
          name: String(item.member?.ownerName || item.member?.name || item.memberId),
          channelId: String(item.member?.channelId || ''),
          serverId: String(item.member?.serverId || ''),
          smallChannelId: String(item.member?.yklzId || ''),
          state: String(item.member?.state || ''),
        }))
        .filter((m: any) => m.channelId);
      if (onMicInputs.length) useOnMicStore.getState().scan(onMicInputs);
      // 直播状态：拉取首页直播列表（非阻塞），按主播 id / liveRoomId / 昵称匹配关注成员点亮状态点
      pocketApi.getLiveList({ record: false, next: 0, size: 100 }).then((res: any) => {
        const liveItems = unwrapList(res, ['content.liveList', 'content.list', 'data.liveList', 'liveList', 'list', 'data']);
        const ids = new Set<string>();
        const names = new Set<string>();
        liveItems.forEach((it: any) => {
          const owner = String(it.userId || it.ownerId || it.memberId || it.userInfo?.userId || it.userInfo?.id || it.user?.userId || it.owner?.userId || it.memberInfo?.userId || it.hostId || it.account || '');
          if (owner) ids.add(owner);
          const lr = String(it.liveRoomId || it.roomId || '');
          if (lr) ids.add(lr);
          const nick = String(it.nickname || it.nickName || it.userInfo?.nickname || it.userInfo?.starName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
          if (nick) names.add(nick);
        });
        setLiveNow({ ids, names });
      }).catch(() => {});
      if (!silent) showToast(t('已加载 {count} 个房间', { count: followedMembers.length }));
      setFollowedError('');
    } catch (e) {
      setFollowedError(errorMessage(e));
      if (!silent) showToast(t('加载失败：{msg}', { msg: errorMessage(e) }));
    }
    finally { setFollowedLoading(false); }
  }, [members, showToast, t, token]);
  loadFollowedRef.current = loadFollowed;

  // 列表页实时刷新：关注成员的直播状态 + 上麦状态，每 60s 静默刷新（仅列表视图时）
  // 列表页实时刷新：关注成员的直播状态 + 上麦状态 + 最新消息，每 30s 静默刷新（仅列表视图时）。
  // 之前直播状态 60s、最新消息完全不刷新（只有 loadFollowed 手动拉一次）→ 卡片「最新消息」长期静止。
  // 现在合并到一个 tick：直播/上麦 + 最新消息一起 30s 刷新；followedRef 持最新列表避免闭包过期。
  useEffect(() => {
    if (selectedRoom) return;
    let active = true;
    const refreshLiveAndMic = () => {
      if (!active) return;
      pocketApi.getLiveList({ record: false, next: 0, size: 100 }).then((res: any) => {
        if (!active) return;
        const liveItems = unwrapList(res, ['content.liveList', 'content.list', 'data.liveList', 'liveList', 'list', 'data']);
        const ids = new Set<string>();
        const names = new Set<string>();
        liveItems.forEach((it: any) => {
          const owner = String(it.userId || it.ownerId || it.memberId || it.userInfo?.userId || it.userInfo?.id || it.user?.userId || it.owner?.userId || it.memberInfo?.userId || it.hostId || it.account || '');
          if (owner) ids.add(owner);
          const lr = String(it.liveRoomId || it.roomId || '');
          if (lr) ids.add(lr);
          const nick = String(it.nickname || it.nickName || it.userInfo?.nickname || it.userInfo?.starName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
          if (nick) names.add(nick);
        });
        setLiveNow({ ids, names });
      }).catch(() => {});
      const cur = followedRef.current;
      if (cur.length) {
        const onMicInputs = cur
          .map((item: any) => ({
            memberId: item.memberId,
            name: String(item.member?.ownerName || item.member?.name || item.memberId),
            channelId: String(item.member?.channelId || ''),
            serverId: String(item.member?.serverId || ''),
            smallChannelId: String(item.member?.yklzId || ''),
            state: String(item.member?.state || ''),
          }))
          .filter((m: any) => m.channelId);
        if (onMicInputs.length) useOnMicStore.getState().scan(onMicInputs);
      }
    };
    const refreshLastMessages = () => {
      if (!active) return;
      const cur = followedRef.current;
      if (!cur.length) return;
      const serverIds = cur.map((item: any) => Number(item.member?.serverId || 0)).filter((id: number) => id > 0);
      const smallRoomIds = cur.map((item: any) => Number(item.member?.yklzId || 0)).filter((id: number) => id > 0);
      const queryIds = Array.from(new Set([...serverIds, ...smallRoomIds]));
      if (!queryIds.length) return;
      pocketApi.getLastMessages(queryIds).then((res: any) => {
        if (!active) return;
        const lastMsgs = unwrapList(res, ['content.lastMsgList', 'content.data', 'data', 'lastMsgList']);
        setFollowed((prev) => prev.map((f) => ({
          ...f,
          lastMessage: findLastMessage(lastMsgs, f.member),
          lastSmallMessage: findSmallLastMessage(lastMsgs, f.member),
        })));
      }).catch(() => {});
    };
    const tick = () => { refreshLiveAndMic(); refreshLastMessages(); };
    tick();
    const id = setInterval(tick, 30000);
    return () => { active = false; clearInterval(id); };
  }, [selectedRoom]);

  // Y23: 关注列表在 members 就绪后只拉一次（loadFollowed 依赖 members，随其变化会反复重拉）
  const followedFetchedRef = useRef(false);
  useEffect(() => {
    if (!members.length || followedFetchedRef.current) return;
    followedFetchedRef.current = true;
    loadFollowed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.length]);

  // mode: 'internal' = 同房间内切换大/小房间或成员/粉丝发言（同一成员，标题/背景不变，必须秒切、无骨架）
  //       'enter'    = 从房间列表点成员进入（跨成员/跨房间，保留骨架隔离旧房间残留）
  const openRoom = useCallback(async (room: Member, nextMode: RoomMode = 'big', includeFans = showFanMessages, mode: 'internal' | 'enter' = 'enter') => {
    // D3：进房耗时诊断（runtimeLog 可查看；真机反馈卡顿时据此定位是消息接口慢还是渲染慢）
    const roomOpenStart = Date.now();
    const channelId = roomChannelId(room, nextMode);
    if (!channelId) {
      showToast(nextMode === 'small' ? t('这个成员缺少小房间 channelId，无法打开小房间。') : t('这个成员缺少大房间 channelId，无法打开房间。'));
      return;
    }
    setSelectedRoom(room);
    const openSeq = ++roomSeqRef.current;
    const channelChanged = activeChannelRef.current !== channelId;
    activeChannelRef.current = channelId;
    // internal：同房间内切换大/小房间或成员/粉丝发言（同一成员、同一背景）。
    // 不清 meta、不进骨架，上一帧消息直接被新数据覆盖 → 标题/背景秒切、无割裂（fix7 回归修复点）。
    // enter：从列表点成员进入房间（跨成员/跨房间），保留骨架隔离旧房间残留 + 清 meta 让本地缓存瞬时显示。
    if (mode === 'internal') {
      // 同房间内切换：不清 meta、不进骨架 —— 标题/背景秒切、无割裂（fix7 回归修复点）
    } else {
      if (channelChanged) setRoomMeta({ name: '', bg: '' });
    }
    setRoomSearchQuery('');
    setPlayingMedia(null);
    // internal 切换：保留上一帧消息直接覆盖（秒切，不闪「暂无消息」、无割裂）；
    // enter 跨房间：清空上一帧避免旧成员消息残影，由 ListEmptyComponent 的「加载中」转圈替代骨架。
    if (mode === 'internal') {
      // 不清 roomMessages；且【不设 loading/roomLoadedOnce=false】——
      // 否则切换粉丝/成员发言时 loading 态会让消息区闪转圈、整段请求期间卡住（用户实测切换慢）。
      // 上一帧消息持续可见，网络回来直接静默替换，最顺滑。仅更新模式类状态。
    } else if (channelChanged) {
      setRoomMessages([]);
      setLoading(true);
      setRoomLoadedOnce(false);
    }
    setRoomMsgError('');
    setRoomNextTime(0);
    setHasMoreMessages(false);
    setRoomMode(nextMode);
    setShowFanMessages(includeFans);
    try {
      const userInfo = includeFans && !currentUserId
        ? await pocketApi.getNimLoginInfo().catch(() => null)
        : null;
      const nextCurrentUserId = currentUserId || currentUserIdFrom(userInfo);
      if (nextCurrentUserId) setCurrentUserId(nextCurrentUserId);
      const res = await pocketApi.getRoomMessages({
        channelId,
        serverId: room.serverId,
        nextTime: 0,
        fetchAll: includeFans,
        fallbackChannelId: nextMode === 'small' ? room.channelId : undefined,
      });
      const list = unwrapList(res, ['content.messageList', 'content.message', 'content.messages', 'content.list', 'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list']);
      const sorted = sortMessagesNewestFirst(list.filter(Boolean));
      diagnoseUndefined(sorted, 'OPEN');
      // Y22: 进房竞态——用户已切到别的房间/模式，丢弃慢响应，避免旧房间消息覆盖新房间
      if (openSeq !== roomSeqRef.current) return;
      setRoomMessages(sorted);
      // 恢复该房间（大/小）各自上次滑动位置；无记忆则停留顶部（最新）
      const cidNow = activeChannelRef.current;
      const saved = cidNow ? scrollPosCache.current[cidNow] || 0 : 0;
      setTimeout(() => {
        if (openSeq !== roomSeqRef.current) return; // 期间已切房则放弃
        msgListRef.current?.scrollToOffset?.({ offset: saved, animated: false });
      }, 60);
      setRoomLoadedOnce(true);
      setRoomMsgError('');
      logInfo(`[room] 进房 ${room.ownerName || channelId} ${nextMode} 消息加载耗时 ${Date.now() - roomOpenStart}ms (${sorted.length}条)`, 'room');
      const nextTime = getNextTime(res, list);
      setRoomNextTime(nextTime);
      setHasMoreMessages(nextTime > 0 && list.length > 0);
      // 房间名 + 背景图：room/info -> channelInfo.channelName / channelInfo.bgImg（按 channelId 缓存，异步拉取不阻塞消息）
      const cachedMeta = roomMetaCache.current[channelId];
      if (cachedMeta !== undefined) {
        // 背景优先走本地缓存（瞬时显示，避免二次进房间重新联网/解码跳变）
        setRoomMeta({ ...cachedMeta, bg: getBgDisplayUri(cachedMeta.bg) });
        if (cachedMeta.bg) ensureBgCached(cachedMeta.bg); // 后台补齐/校验本地副本
      } else {
        roomMetaCache.current[channelId] = { name: '', bg: '' };
        // 小房间 room/info 服务端 2001 无权限（实测）→ 塞纳河 server/detail 拿 channelInfoList 房间名 + 背景墙图
        pocketApi.getRoomMeta(channelId, nextMode === 'small' ? room.channelId : undefined, room.serverId)
          .then((meta) => {
            // Y22: 期间已切房（seq 过期或 channelId 变化）则丢弃，避免旧房间标题/背景覆盖
            if (openSeq !== roomSeqRef.current || activeChannelRef.current !== channelId) return;
            roomMetaCache.current[channelId] = meta;
            setRoomMeta({ ...meta, bg: getBgDisplayUri(meta.bg) });
            if (meta.bg) ensureBgCached(meta.bg); // 后台落盘，下次进房间直接本地显示
          })
          .catch(() => { roomMetaCache.current[channelId] = { name: '', bg: '' }; });
      }
      // 进入房间后立即检测该成员上麦状态（驱动房间内上麦按钮；单成员扫描不影响其它成员）
      const ocChannel = roomChannelId(room, nextMode);
      if (ocChannel) {
        useOnMicStore.getState().scan([{
          memberId: String(room.id || ''),
          name: String(room.ownerName || room.id || ''),
          channelId: ocChannel,
          serverId: String(room.serverId || ''),
          smallChannelId: String(nextMode === 'small' ? (room.yklzId || '') : (room.channelId || '')),
        }]);
      }
    } catch (error) {
      showToast(t('加载失败：{msg}', { msg: errorMessage(error) }));
      setRoomMessages([]);
      setRoomMsgError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [currentUserId, roomMode, showFanMessages, showToast, t]);

  const loadMoreRoomMessages = useCallback(async () => {
    if (!selectedRoom || loading || loadingMoreMessages || loadingMoreMessagesRef.current || refreshingRef.current || !hasMoreMessages || !roomNextTime) return;
    const channelId = roomChannelId(selectedRoom, roomMode);
    if (!channelId) return;
    loadingMoreMessagesRef.current = true;
    setLoadingMoreMessages(true);
    try {
      const res = await pocketApi.getRoomMessages({
        channelId,
        serverId: selectedRoom.serverId,
        nextTime: roomNextTime,
        fetchAll: showFanMessages,
        fallbackChannelId: roomMode === 'small' ? selectedRoom.channelId : undefined,
      });
      const list = unwrapList(res, ['content.messageList', 'content.message', 'content.messages', 'content.list', 'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list']);
      const nextTime = getNextTime(res, list);
      setRoomMessages((prev) => {
        const merged = mergeMessages(prev, list as RoomMessage[]);
        diagnoseUndefined(merged, 'LOADMORE');
        return merged;
      });
      setRoomNextTime(nextTime);
      setHasMoreMessages(nextTime > 0 && list.length > 0);
    } catch (error) {
      showToast(t('继续加载失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      loadingMoreMessagesRef.current = false;
      setLoadingMoreMessages(false);
    }
  }, [hasMoreMessages, loading, loadingMoreMessages, roomMode, roomNextTime, selectedRoom, showFanMessages, showToast, t]);

  // 房间内实时刷新：静默拉取最新消息并合并（不提示、不清空），供轮询调用
  const refreshRoomMessages = useCallback(async () => {
    if (!selectedRoom || refreshingRef.current) return;
    const channelId = roomChannelId(selectedRoom, roomMode);
    if (!channelId) return;
    refreshingRef.current = true;
    try {
      const res = await pocketApi.getRoomMessages({
        channelId,
        serverId: selectedRoom.serverId,
        nextTime: 0, // 实时刷新永远拉「最新页」，只用于把新消息合并进顶部
        fetchAll: showFanMessages,
        fallbackChannelId: roomMode === 'small' ? selectedRoom.channelId : undefined,
      });
      const list = unwrapList(res, ['content.messageList', 'content.message', 'content.messages', 'content.list', 'data.messageList', 'data.message', 'messageList', 'message', 'messages', 'list']);
      if (!list || list.length === 0) return;
      const sorted = sortMessagesNewestFirst(list.filter(Boolean));
      // A 优化：无新消息时完全不触发 state 更新（零渲染开销轮询）。
      // 预判当前列表最新消息时间，若服务端最新条不比它新，直接 return，连 reducer 都不跑。
      const prevMsgs = roomMessagesRef.current;
      const prevNewest = prevMsgs.length ? getMessageTime(prevMsgs[0]) : 0;
      const hasFresh = sorted.some((m: any) => getMessageTime(m) > prevNewest);
      if (!hasFresh) return;
      // 关键：实时刷新【绝不改写 roomNextTime】—— roomNextTime 是「上拉加载更多」往前翻的游标，
      // 只能由 loadMoreRoomMessages 更新。否则会被反复重置成最新页游标，导致上拉加载更多拉回重叠/重复内容。
      setRoomMessages((prev) => {
        // 只合并比当前列表最新消息更新的条目，避免重复累积（双保险，配合 messageKey 去重）
        const newest = prev.length ? getMessageTime(prev[0]) : 0;
        const fresh = sorted.filter((m: any) => getMessageTime(m) >= newest || messageKey(m) === messageKey(prev[0]));
        if (!fresh.length) return prev;
        const merged = mergeMessages(prev, fresh);
        diagnoseUndefined(merged, 'REFRESH');
        return merged;
      });
    } catch {
      // 静默失败：实时刷新不打扰用户
    } finally {
      refreshingRef.current = false;
    }
  }, [roomMode, selectedRoom, showFanMessages]);

  // 房间内实时刷新：打开房间后每 15s 静默拉取一次最新消息（成员 + 粉丝）
  // B 优化：App 退到后台/锁屏时暂停轮询（避免后台空转耗电耗流量），回前台恢复。
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!selectedRoom) return;
    const startPoll = () => {
      if (pollTimerRef.current) return;
      pollTimerRef.current = setInterval(() => { refreshRoomMessages(); }, 15000);
    };
    const stopPoll = () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
    // 初始按当前前后台状态决定
    if (AppState.currentState === 'active') startPoll();
    // 前后台切换：前台启动、后台暂停
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') startPoll();
      else stopPoll();
    });
    return () => {
      sub.remove();
      stopPoll();
    };
  }, [selectedRoom, refreshRoomMessages]);

  /** 直播解析并开播（占位式）：点击即反馈，出地址后无缝换正式播放器 */
  const resolveLiveAndOpen = useCallback(async (media: RoomMedia) => {
    const key = String(media.liveId || media.url || 'live');
    // 同一路正在解析中：忽略重复点击（防连击并发网络风暴）
    if (liveResolve?.key === key && !liveResolve.error) return;
    const token = ++liveResolveToken.current;
    setLiveResolve({ key, error: '', media });
    try {
      const resolved = await resolveRoomLiveMediaWithRetry(media);
      if (token !== liveResolveToken.current) return; // 期间已关闭/改点其它：丢弃过期结果
      if (!resolved.url) {
        setLiveResolve({ key, error: t('解析直播地址失败，请检查网络后重试'), media });
        return;
      }
      setLiveResolve(null);
      // 统一按「是否录播」判定（见 roomTapIsVod：replayHint 回放 / m3u8-mp4 无 live 标记 → vod 可拖）
      const isVod = roomTapIsVod(resolved);
      setRoomPlayer({ ...resolved, isLive: !isVod, needsVlc: resolved.needsVlc || streamNeedsProxy(resolved.url) });
      // 默认竖屏播放（同视频）；用户手动点全屏才横屏——不要一进就横屏沉浸
      setRoomPlayerFullscreen(false);
    } catch (e) {
      if (token === liveResolveToken.current) {
        setLiveResolve({ key, error: errorMessage(e) || t('解析直播地址失败，请检查网络后重试'), media });
      }
    }
  }, [liveResolve, t]);

  const cancelLiveResolve = useCallback(() => {
    liveResolveToken.current += 1; // 使在途解析结果失效
    setLiveResolve(null);
  }, []);

  // 直播解析占位期间：Android 硬件返回 = 取消解析（不退出房间）
  useEffect(() => {
    if (!liveResolve) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      cancelLiveResolve();
      return true;
    });
    return () => sub.remove();
  }, [liveResolve, cancelLiveResolve]);

  const playMedia = useCallback(async (media: RoomMedia) => {
    if (media.type === 'link') {
      const url = media.url || media.title;
      if (url) Linking.openURL(url).catch(() => showToast(t('这个链接无法直接打开。')));
      return;
    }
    if (playingMedia?.url && playingMedia.url === media.url) {
      setPlayingMedia(null);
      return;
    }
    let next = media;
    try {
      if (media.type === 'live' || media.liveId) {
        // 已带可播地址：直接开播（零等待，不弹解析占位）
        if (media.url) {
          const isVod = roomTapIsVod(media);
          setRoomPlayer({ ...media, isLive: !isVod, needsVlc: media.needsVlc || streamNeedsProxy(media.url) });
          setRoomPlayerFullscreen(false);
          return;
        }
        if (!media.liveId) {
          showToast(t('无法解析直播地址，请重试'));
          return;
        }
        // 无流地址：交给占位式解析（立即弹「解析中」全屏层，首击即有反馈；失败留层内重试）。
        // 修复「有概率点不进去、连击多点才能加载」——此前 await 解析数秒无任何反馈，
        // 瞬时网络失败又只弹一次 toast，用户只能反复点卡片碰运气。
        resolveLiveAndOpen(media);
        return;
      }
      if (next.type === 'video') {
        // 视频点击进入播放器，但默认不强制全屏（竖屏播放，用户可手动点全屏按钮）
        setRoomPlayer({ ...next, needsVlc: streamNeedsProxy(next.url) });
        setRoomPlayerFullscreen(false);
        return;
      }
      setPlayingMedia(next);
    } catch (error) {
      Alert.alert(t('播放失败'), errorMessage(error));
    }
  }, [playingMedia, showToast, navigation, t, resolveLiveAndOpen]);

  const openRoomRankPanel = useCallback(async () => {
    if (!roomPlayer?.liveId) {
      setRankRows([]);
      setRankStatus(t('当前直播/回放缺少 liveId，不能获取贡献榜'));
      setRankVisible(true);
      return;
    }
    setRankVisible(true);
    setRankStatus('');
    try {
      const res = await pocketApi.getLiveRank(String(roomPlayer.liveId));
      const rows = normalizeLiveRank(res);
      setRankRows(rows);
      setRankStatus(rows.length ? t('已加载 {count} 位贡献用户', { count: rows.length }) : t('贡献榜为空'));
    } catch (error) {
      setRankRows([]);
      setRankStatus(t('贡献榜加载失败：{msg}', { msg: errorMessage(error) }));
    }
  }, [roomPlayer, t]);

  const downloadMedia = useCallback(async (media: RoomMedia) => {
    try {
      let next = media;
      if ((media.type === 'live' || media.liveId) && !media.url) {
        next = await resolveRoomLiveMedia(media);
      }
      const url = next.url || media.url;
      if (!url) {
        showToast(t('没有可下载地址'));
        return;
      }
      await enqueueDownload({
        url,
        type: next.type === 'live' ? 'replay' : next.type === 'audio' ? 'voice' : next.type === 'image' ? 'image' : next.type === 'video' ? 'video' : 'file',
        name: next.title,
      });
      showToast(t('已加入下载管理'));
    } catch (error) {
      showToast(t('下载失败：{msg}', { msg: errorMessage(error) }));
    }
  }, [showToast, t]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = followed;
    if (q) {
      list = followed.filter((item) => {
        const member = item.member;
        if (!member) return false;
        return memberSearchText(member).includes(q);
      });
    }
    const pinnedIds = new Set(pinned);
    // 置顶成员按 pinned 数组顺序排列（可调换），未置顶保持原序
    const pinIdx = (id: string) => pinned.indexOf(id);
    return [...list].sort((a, b) => {
      const pa = pinnedIds.has(a.memberId) ? pinIdx(a.memberId) : Number.MAX_SAFE_INTEGER;
      const pb = pinnedIds.has(b.memberId) ? pinIdx(b.memberId) : Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return 0;
    });
  }, [followed, searchQuery, pinned]);

  // 搜索时从全量成员库匹配（未关注的成员可直接在此关注）
  const memberHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return members
      .filter((m) => memberSearchText(m).includes(q))
      .sort((a, b) => {
        // 已关注排前，方便快速打开房间
        const af = followedIds.has(String((a as any).id || (a as any).userId || '')) ? 0 : 1;
        const bf = followedIds.has(String((b as any).id || (b as any).userId || '')) ? 0 : 1;
        return af - bf;
      })
      .slice(0, 10);
  }, [members, searchQuery, followedIds]);

  const filteredRoomMessages = useMemo(() => {
    const q = roomSearchQuery.trim().toLowerCase();
    if (!q || !selectedRoom) return roomMessages;
    return roomMessages.filter((item) => {
      const profile = senderProfile(item, selectedRoom);
      const text = messageText(item);
      return [
        text,
        profile.name,
        profile.id,
        selectedRoom.ownerName,
        selectedRoom.team,
        selectedRoom.groupName,
      ].some((value) => String(value || '').toLowerCase().includes(q));
    });
  }, [roomMessages, roomSearchQuery, selectedRoom]);

  // 消息流按日期分组：今天/昨天/月日 分隔条（消息是新→旧排序，分隔条插在换日处）
  const chatRows = useMemo(() => {
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const fmt = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const now = new Date();
    const todayStr = fmt(now.getTime());
    const yestStr = fmt(now.getTime() - 86400000);
    const rows: { type: 'date' | 'msg'; key: string; label?: string; item?: any; index?: number; groupStart?: boolean }[] = [];
    let lastDay = '';
    let lastGroupKey = '';
    let lastMsgTime = 0;
    filteredRoomMessages.filter(Boolean).forEach((item, index) => {
      const day = fmt(Number((item as any)?.msgTime || (item as any)?.ctime || 0) * (Number((item as any)?.msgTime) > 1e12 ? 1 : 1000));
      if (day !== lastDay) {
        lastDay = day;
        lastGroupKey = '';
        const label = day === todayStr ? t('今天') : day === yestStr ? t('昨天') : `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
        rows.push({ type: 'date', key: `d-${day}`, label });
      }
      // 同一发送者、间隔 < 3 分钟的消息合并为一组（组首带头像+名字，后续连排）
      const t0 = getMessageTime(item);
      // 用 senderProfile 的 id 做分组键（覆盖 senderUserId/senderId/fromUserId/user.userId 等全部来源）
      const sender = senderProfile(item, selectedRoom!).id || String((item as any)?.fromAccount || '');
      const sameSender = sender && sender === lastGroupKey;
      const withinGap = t0 > 0 && lastMsgTime > 0 && (lastMsgTime - t0) < 3 * 60000;
      const groupStart = !sameSender || !withinGap;
      if (groupStart) lastGroupKey = sender;
      if (t0 > 0) lastMsgTime = t0;
      rows.push({ type: 'msg', key: messageKey(item), item, index, groupStart });
    });
    return rows;
  }, [filteredRoomMessages, selectedRoom]);

  // 列表项渲染提取为 useCallback：避免每次 render 重建内联函数，配合 PerfFlatList 的 memo 提升长列表滚动性能
  const renderChatItem = useCallback(
    ({ item: row }: { item: any }) => {
      const item = row.item;
      const rowKey = String(row.key);
      // 最后一道防线：服务端偶发脏数据（undefined/null 元素）直接渲染空行，不崩
      if (!item) return <View />;
      const room = selectedRoom as Member;
      const role = messageRole(item, room, showFanMessages, currentUserId);
      const mine = role === 'mine';
      const idol = role === 'idol';
      const msgProfile = senderProfile(item, room);
      // 成员(idol)发言头像：优先用 API（消息携带）的真实头像；成员库 room.avatar 多为公式照，仅兜底
      const profile = idol
        ? { id: room.id, name: (msgProfile.name || '').trim() || shortName(room), avatar: msgProfile.avatar || room.avatar }
        : msgProfile;
      const media = roomMedia(item);
      const gift = roomGiftInfo(item);
      const payload = messagePayload(item) as any;
      const replyInfo = payload?.replyInfo || payload?.giftReplyInfo;
      const replyName = replyInfo?.replyName || '';
      const replyQuoted = replyInfo?.replyText || '';
      const body = messageText(item);
      let giftReplyText = '';
      if (gift) {
        const gr = payload?.giftReplyInfo || {};
        giftReplyText = gr.text || payload.text || payload.body || gr.replyName || gr.replyText || '';
        if (typeof giftReplyText === 'string') giftReplyText = giftReplyText.trim();
        else giftReplyText = '';
      }
      const isMediaLabel = /^\[(语音|图片|视频|链接|直播)\]/.test(body);
      const looksLikeFile = !media && /^https?:\/\//i.test(String(body || '')) || /\.(amr|mp3|m4a|aac|mp4|mov|jpg|jpeg|png|gif|webp)(\?|$)/i.test(String(body || ''));
      const bubbleText = gift ? giftReplyText : (media ? (!isMediaLabel ? body : '') : (looksLikeFile ? '' : body));
      const canInlinePlay = media?.type === 'audio' || media?.type === 'video' || media?.type === 'live';

      return (
        <View style={[styles.chatRow, mine && styles.chatRowMine, !row.groupStart && styles.chatRowTight]}>
          {!mine ? (
            row.groupStart ? (
              profile.avatar ? (
                <Image source={{ uri: profile.avatar }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatarFallback, { backgroundColor: palette.fill2 }]}><Text style={[styles.avatarText, { color: palette.tint }]}>{avatarInitial(profile.name)}</Text></View>
              )
            ) : (
              /* 组内连排：占位保持气泡左对齐 */
              <View style={styles.avatarPlaceholder} />
            )
          ) : null}
          <View style={[styles.msgBlock, mine && styles.msgBlockMine]}>
            {/* 组首显示名字 + HH:mm；组内不重复 */}
            {row.groupStart ? (
              <View style={[styles.msgMetaLine, mine && styles.msgMetaLineMine]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  {idol ? <MaterialCommunityIcons name="crown" size={11} color={palette.tint} /> : null}
                  <Text style={[styles.msgSender, { color: idol ? palette.tint : mine ? palette.tint : palette.labelSecondary }]} numberOfLines={1}>
                    {profile.name}
                  </Text>
                </View>
                <Text style={[styles.msgTime, { color: palette.labelTertiary }]}>
                  {formatTimestamp(item.msgTime).slice(11, 16)}
                </Text>
              </View>
            ) : null}
            <View
              style={[
                styles.msgBubble,
                !row.groupStart && styles.msgBubbleMid,
                row.groupStart && !mine && styles.msgBubbleTailLeft,
                row.groupStart && mine && styles.msgBubbleTailRight,
                {
                  backgroundColor: mine ? palette.tint : idol ? 'rgba(255,111,145,0.22)' : palette.surfaceGlass,
                  borderColor: idol ? 'rgba(232,62,140,0.35)' : palette.hairline,
                  borderWidth: mine ? 0 : StyleSheet.hairlineWidth,
                },
              ]}
            >
              {replyName || replyQuoted ? (
                <View style={[styles.replyCard, { backgroundColor: mine ? 'rgba(255,255,255,0.18)' : idol ? palette.tintSoft : palette.fill2, borderLeftColor: mine ? 'rgba(255,255,255,0.85)' : palette.tint }]}>
                  {replyName ? <Text style={[styles.replyName, { color: mine ? palette.onTint : idol ? palette.tint : palette.tint }]} numberOfLines={1}>{replyName}</Text> : null}
                  {replyQuoted ? <Text style={[styles.replyText, { color: mine ? 'rgba(255,255,255,0.85)' : idol ? palette.labelSecondary : palette.labelSecondary }]} numberOfLines={3}>{replyQuoted}</Text> : null}
                </View>
              ) : null}
              {bubbleText ? (
                <Text style={[styles.msgBody, (mine || idol) && styles.msgBodyHighlight, { color: mine ? palette.onTint : idol ? palette.label : palette.labelSecondary }]}>
                  {bubbleText}
                </Text>
              ) : null}
              {gift && !giftReplyText ? (
                <View style={[styles.giftCard, { backgroundColor: palette.fill2, borderColor: palette.tintSoft }, giftReplyText ? styles.giftCardCompact : null]}>
                  {!giftReplyText ? (gift.image ? <Image source={{ uri: gift.image }} style={[styles.giftImage, { backgroundColor: palette.surface }]} /> : <View style={[styles.giftImageFallback, { backgroundColor: palette.tint }]}><MaterialCommunityIcons name="gift" size={16} color={palette.onTint} /></View>) : null}
                  <View style={styles.giftTextWrap}>
                    <Text style={[styles.giftName, { color: palette.label }]} numberOfLines={1}>{idol ? t('感谢礼物') : t('送出礼物')}：{gift.name}</Text>
                    <Text style={[styles.giftMeta, { color: palette.labelSecondary }]}>{t('数量')} x{gift.num}{gift.total ? ` · ${gift.total}` : ''}</Text>
                  </View>
                </View>
              ) : null}
              {media ? (
                media.type === 'image' && media.url ? (
                <>
                  <TouchableOpacity onPress={() => setFullImageUrl(media.url)} onLongPress={() => downloadMedia(media)} activeOpacity={0.9}>
                    <Image source={{ uri: media.url }} style={media.title === t('表情') ? styles.inlineSticker : styles.inlineImage} resizeMode="cover" />
                  </TouchableOpacity>
                </>
              ) : media.type === 'live' && media.cover ? (
                <TouchableOpacity style={styles.liveCardWrap} onPress={() => playMedia(media)} onLongPress={() => downloadMedia(media)} activeOpacity={0.9}>
                  <LiveCoverImage uri={media.cover} palette={palette} />
                  <View style={styles.liveCardOverlay}>
                    <View style={styles.livePlayCircle}>
                      <MaterialCommunityIcons name="play" size={22} color="#FFFFFF" style={{ marginLeft: 3 }} />
                    </View>
                  </View>
                  <View style={styles.liveCardTitleBar}>
                    <Text style={styles.liveCardTitle} numberOfLines={1}>{media.title}</Text>
                  </View>
                </TouchableOpacity>
              ) : media.type === 'video' && media.url ? (
                (roomPlayerFullscreen || roomPlayer?.url === media.url || playingMedia?.url === media.url) ? null : (
                  <VideoCoverCard media={media} onPress={() => playMedia(media)} onLongPress={() => downloadMedia(media)} />
                )
              ) : media.type === 'audio' ? (
                // 音频播放时不返回 null（否则整张卡片塌缩成小方块）：AudioMediaCard 自带播放中态（暂停按钮）。
                // 隐藏探测 Video 在 AudioMediaCard 内部，无需外部 inlineAudio 撑高。
                <AudioMediaCard
                  media={media}
                  idol={idol}
                  mine={mine}
                  palette={palette}
                  playing={!!(playingMedia?.url && media.url && playingMedia.url === media.url)}
                  onPlay={() => playMedia(media)}
                  onLongPress={() => downloadMedia(media)}
                />
              ) : (
                <TouchableOpacity style={[styles.mediaCard, { backgroundColor: (idol || mine) ? palette.tint : palette.surfaceGlass, borderColor: (idol || mine) ? 'rgba(255,255,255,0.38)' : palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]} activeOpacity={0.92} onLongPress={() => downloadMedia(media)}>
                  {media.cover ? (
                    <Image source={{ uri: media.cover }} style={styles.liveCover} resizeMode="cover" />
                  ) : null}
                  <View style={styles.mediaMeta}>
                    <Text style={[styles.mediaIcon, (idol || mine) ? { color: palette.onTint } : { color: palette.tint }]}>{t(mediaLabel(media.type))}</Text>
                    {media.type !== 'video' && media.title ? (
                      <Text style={[styles.mediaTitle, (idol || mine) ? { color: palette.onTint } : { color: palette.label }]} numberOfLines={2}>{media.title}</Text>
                    ) : null}
                    {media.duration ? <Text style={[styles.mediaDuration, (idol || mine) ? { color: palette.onTint } : { color: palette.labelSecondary }]}>{media.duration}s</Text> : null}
                  </View>
                  <TouchableOpacity
                    style={[styles.mediaPlayBtn, { backgroundColor: palette.tint, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }]}
                    onPress={() => playMedia(media)}
                    activeOpacity={0.85}
                  >
                    <MaterialCommunityIcons
                      name={playingMedia?.url && media.url && playingMedia.url === media.url ? 'pause' : 'play'}
                      size={14}
                      color={palette.onTint}
                    />
                    <Text style={[styles.mediaPlayText, { color: palette.onTint }]}>
                      {playingMedia?.url && media.url && playingMedia.url === media.url ? t('暂停') : media.duration ? `${media.duration}s` : t('播放')}
                    </Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              )) : (!bubbleText && !gift) ? (
                <Text style={[styles.msgBody, (idol || mine) && styles.msgBodyHighlight, (idol || mine) ? { color: palette.onTint } : { color: palette.labelSecondary }]}>{t('[空消息]')}</Text>
              ) : null}
              {media?.url && playingMedia?.url === media.url ? (
                media.type === 'link' ? (
                  <TouchableOpacity style={styles.openLinkBtn} onPress={() => Linking.openURL(media.url).catch(() => {})} activeOpacity={0.85}>
                    <Text style={[styles.openLinkText, { color: palette.tint }]} numberOfLines={1}>{media.url}</Text>
                  </TouchableOpacity>
                ) : (
                  /* 统一播放器（重写）：房间消息音视频 → 内嵌 PlayerScreen（比例自适应） */
                  <RoomMediaPlayer media={media} />
                )
              ) : null}
            </View>
          </View>
        </View>
      );
    },
    [selectedRoom, showFanMessages, currentUserId, roomPlayerFullscreen, roomPlayer, playingMedia, palette, t, playMedia, downloadMedia, setFullImageUrl, setPlayingMedia]
  );

  if (selectedRoom) {
    const fid = String(selectedRoom.id || '');
    const isFollowingRoom = followedIds.has(fid);
    const followBusyRoom = followBusy.has(fid);
    // 房间名加载前用中性占位「房间」，不回退成员名 —— 避免「先显示成员名再被真实房间名替换」的闪烁
    const headerTitle = roomMeta.name ? capText(roomMeta.name, 18) : t('房间');
    const roomBgUri = roomMeta.bg || '';
    const roomScrim = resolvedTheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.42)';
    return (
      <View style={[styles.container]}>
        {roomBgUri ? (
          <>
            <Animated.View style={[styles.roomBgLayer, { opacity: bgOpacity }]}>
              <ImageBackground source={{ uri: roomBgUri }} resizeMode="cover" style={StyleSheet.absoluteFill} onLoad={() => { Animated.timing(bgOpacity, { toValue: 1, duration: 280, useNativeDriver: true }).start(); }} onError={(e) => { setRoomMeta((m) => ({ ...m, bg: '' })); }} />
            </Animated.View>
            <View pointerEvents="none" style={[styles.roomBgLayer, { backgroundColor: roomScrim }]} />
          </>
        ) : null}
        {roomPlayer ? (
          /* 统一播放器（重写）：房间直播/录播 → PlayerScreen（控制条/全屏/内核路由/小窗/贡献榜） */
          <View style={[styles.roomPlayerPage, { backgroundColor: '#000' }]}>
            <PlayerScreen
              source={{
                kind: roomPlayer.isLive ? 'live' : 'vod',
                url: roomPlayer.url,
                liveId: roomPlayer.liveId,
                needsNativeExo: roomPlayer.needsVlc,
                headers: { 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)', Referer: 'https://h5.48.cn/' },
              }}
              meta={{ title: roomPlayer.title, cover: roomPlayer.cover }}
              features={{ kernelSwitch: true, rate: !roomPlayer.isLive }}
              extraActions={[
                { key: 'pip', icon: 'picture-in-picture-bottom-right-outline', label: t('小窗'), onPress: handleRoomMiniPlayer },
                { key: 'rank', icon: 'trophy', label: t('贡献榜'), onPress: openRoomRankPanel },
              ]}
              onClose={closeRoomPlayer}
              persistent
            />
            <Modal visible={rankVisible} transparent animationType="slide" onRequestClose={() => setRankVisible(false)}>
              <View style={styles.roomModalShade}>
                <View style={[styles.roomRankPanel, { backgroundColor: palette.surface }]}>
                  {/* 顶部 handle */}
                  <View style={styles.roomRankHandleWrap}>
                    <View style={[styles.roomRankHandle, { backgroundColor: palette.fill3 }]} />
                  </View>
                  <View style={styles.roomRankHeader}>
                    <Text style={[styles.roomRankTitle, { color: palette.label }]}>{t('贡献榜')}</Text>
                    <ScalePressable onPress={() => setRankVisible(false)} pressedScale={0.92} activeOpacity={0.8} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                      <View style={[styles.roomRankClose, { backgroundColor: palette.fill2 }]}>
                        <MaterialCommunityIcons name="close" color={palette.labelSecondary} size={18} />
                      </View>
                    </ScalePressable>
                  </View>
                  <Text style={[styles.roomRankStatus, { color: palette.labelSecondary }]}>{rankStatus}</Text>
                  <ScrollView style={styles.roomRankList} showsVerticalScrollIndicator={false}>
                    {(() => {
                      // 归一化进度条：取最高贡献值作为基准
                      const maxValue = rankRows.reduce((max, r) => Math.max(max, Number(r.value) || 0), 0);
                      return rankRows.map((row, index) => {
                        const valNum = Number(row.value) || 0;
                        const progress = maxValue > 0 ? Math.max(0, Math.min(1, valNum / maxValue)) : 0;
                        return (
                          <View key={String(row.userId || row.id || index)} style={[styles.roomRankRow, { borderBottomColor: palette.hairline }]}>
                            <Text style={[styles.roomRankNo, { color: palette.tint }]}>{row.rank || index + 1}</Text>
                            {row.avatar ? <Image source={{ uri: row.avatar }} style={[styles.roomRankAvatar, { backgroundColor: palette.fill3 }]} /> : <View style={[styles.roomRankAvatar, { backgroundColor: palette.fill3 }]} />}
                            <View style={styles.roomRankInfo}>
                              <Text style={[styles.roomRankName, { color: palette.label }]} numberOfLines={1}>{row.name}</Text>
                              <View style={[styles.roomRankProgressTrack, { backgroundColor: palette.fill3 }]}>
                                <View style={[styles.roomRankProgressFill, { width: `${progress * 100}%`, backgroundColor: palette.tint }]} />
                              </View>
                            </View>
                            <Text style={[styles.roomRankValue, { color: palette.labelSecondary }]} numberOfLines={1}>{row.value ? t('贡献 {value}', { value: row.value }) : t('贡献用户')}</Text>
                          </View>
                        );
                      });
                    })()}
                  </ScrollView>
                </View>
              </View>
            </Modal>
          </View>
        ) : null}
        {liveResolve ? (
          /* 直播解析占位：无流地址直播卡点击后立即反馈（转圈/失败重试），出地址后由正式播放器接管 */
          <View style={[styles.roomPlayerPage, { backgroundColor: '#000' }]}>
            <TouchableOpacity style={styles.liveResolveClose} onPress={cancelLiveResolve} activeOpacity={0.8} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <View style={styles.liveResolveCloseBtn}>
                <MaterialCommunityIcons name="close" color="#fff" size={20} />
              </View>
            </TouchableOpacity>
            <View style={styles.liveResolveWrap}>
              {liveResolve.error ? (
                <>
                  <MaterialCommunityIcons name="alert-decagram-outline" color="#ff8fa3" size={46} />
                  <Text style={styles.liveResolveTitle}>{t('直播地址解析失败')}</Text>
                  <Text style={styles.liveResolveText}>{liveResolve.error}</Text>
                  <View style={styles.liveResolveBtns}>
                    <ScalePressable style={[styles.liveResolveBtn, { backgroundColor: '#ff6f91' }]} pressedScale={0.96} activeOpacity={0.85} onPress={() => resolveLiveAndOpen(liveResolve.media)}>
                      <Text style={styles.liveResolveBtnText}>{t('重试')}</Text>
                    </ScalePressable>
                    <ScalePressable style={[styles.liveResolveBtnGhost, { borderColor: 'rgba(255,255,255,0.35)' }]} pressedScale={0.96} activeOpacity={0.85} onPress={cancelLiveResolve}>
                      <Text style={styles.liveResolveBtnGhostText}>{t('关闭')}</Text>
                    </ScalePressable>
                  </View>
                </>
              ) : (
                /* 解析中：只转圈不给过程说明（用户反馈「没必要写明出来」；40s 列表缓存+4s 超时已大幅提速） */
                <ActivityIndicator color="#ff6f91" size="large" />
              )}
            </View>
          </View>
        ) : null}
        <ZoomImageModal url={fullImageUrl} onClose={() => setFullImageUrl('')} />
        <ScreenHeader title={headerTitle} onBack={closeRoom} overlay={!!roomBgUri} right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              style={[styles.followBtn, { backgroundColor: isFollowingRoom ? palette.tintSoft : palette.tint }]}
              disabled={followBusyRoom}
              onPress={() => toggleFollow(selectedRoom)}
              activeOpacity={0.85}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              {followBusyRoom ? (
                <ActivityIndicator color={isFollowingRoom ? palette.tint : palette.onTint} size="small" />
              ) : (
                <Text style={[styles.followBtnText, { color: isFollowingRoom ? palette.tint : palette.onTint }]}>{isFollowingRoom ? t('已关注') : t('关注')}</Text>
              )}
            </TouchableOpacity>
          </View>
        } />

          {/* 聊天工具条：高斯模糊玻璃（按深浅色 tint，不挡房间背景）*/}
          <View style={[styles.chatToolsClip, { borderColor: palette.innerStroke }]}>
            <BlurView
              intensity={70}
              tint={resolvedTheme === 'dark' ? 'dark' : 'light'}
              experimentalBlurMethod="dimezisBlurView"
              style={styles.chatTools}
            >
          {/* 分段切换：大房间 / 小房间 */}
          <View style={[styles.segment, { backgroundColor: palette.fill2 }]}>
            <TouchableOpacity
              style={[styles.segmentItem, roomMode === 'big' && { backgroundColor: palette.tint }]}
              onPress={() => openRoom(selectedRoom, 'big', showFanMessages, 'internal')}
              activeOpacity={0.85}
            >
              <Text style={[styles.segmentText, { color: roomMode === 'big' ? palette.onTint : palette.labelSecondary }]}>{t('大房间')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentItem, roomMode === 'small' && { backgroundColor: palette.tint }]}
              onPress={() => openRoom(selectedRoom, 'small', showFanMessages, 'internal')}
              activeOpacity={0.85}
            >
              <Text style={[styles.segmentText, { color: roomMode === 'small' ? palette.onTint : palette.labelSecondary }]}>{t('小房间')}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1 }} />
          <ScalePressable
            style={[styles.chatToolCircle, { backgroundColor: roomSearchOpen ? palette.tint : palette.fill2 }]}
            onPress={() => setRoomSearchOpen((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            pressedScale={0.9}
          >
            <MaterialCommunityIcons
              name={roomSearchOpen ? 'close' : 'magnify'}
              size={18}
              color={roomSearchOpen ? palette.onTint : palette.labelSecondary}
            />
          </ScalePressable>
          <ScalePressable
            style={[styles.chatToolCircle, { backgroundColor: showFanMessages ? palette.tint : palette.fill2 }]}
            onPress={() => openRoom(selectedRoom, roomMode, !showFanMessages, 'internal')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            pressedScale={0.9}
          >
            <MaterialCommunityIcons
              name="account-group"
              size={18}
              color={showFanMessages ? palette.onTint : palette.labelSecondary}
            />
          </ScalePressable>
          {!!onMicMap[String(selectedRoom.id || (selectedRoom as any).userId || '')] ? (
            <ScalePressable
              style={[styles.chatToolCircle, { backgroundColor: palette.tint }]}
              onPress={() => (navigation as any).navigate('RoomRadioScreen', { member: selectedRoom })}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              pressedScale={0.9}
            >
              <MaterialCommunityIcons name="microphone" size={18} color={palette.onTint} />
            </ScalePressable>
          ) : null}
            </BlurView>
          </View>

        {roomSearchOpen ? (
          <View style={[styles.roomSearchBar, { backgroundColor: palette.fill2, borderColor: palette.hairline }]}>
            <MaterialCommunityIcons name="magnify" size={17} color={palette.labelTertiary} />
            <TextInput
              style={[styles.roomSearchInput, { color: palette.label }]}
              placeholder={t('搜索聊天记录、成员名、粉丝名...')}
              placeholderTextColor={palette.labelTertiary}
              value={roomSearchQuery}
              onChangeText={setRoomSearchQuery}
              autoFocus
              returnKeyType="search"
            />
            {roomSearchQuery ? (
              <TouchableOpacity onPress={() => setRoomSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.7}>
                <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
          <PerfFlatList
            ref={msgListRef}
            // 始终用 chatRows：internal 切换保留上一帧（秒切，无割裂）；
            // enter 跨房间时 roomMessages 已被 openRoom 清空，自然走 ListEmptyComponent 的「加载中」
            data={chatRows}
            onScroll={onMsgScroll}
            scrollEventThrottle={120}
            keyExtractor={(row: any) => String(row.key)}
            contentContainerStyle={styles.chatContent}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews
            onEndReached={loadMoreRoomMessages}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
            roomMessages.length ? (
              <View style={styles.chatFooter}>
                {hasMoreMessages ? (
                  <Text style={[styles.empty, { color: palette.labelTertiary }]}>{t('上滑加载更多')}</Text>
                ) : (
                  <Text style={[styles.empty, { color: palette.labelTertiary }]}>{t('没有更多消息')}</Text>
                )}
              </View>
            ) : null
          }
          ListEmptyComponent={
            // 进入房间（enter，跨成员）：roomMessages 已清空，显示「加载中」转圈 —— 用户认可的进房间 loading，
            // 不再用骨架屏（骨架会造成消息区从上一帧突跳到骨架再跳回的割裂感）。
            // internal 同房间切换：保留上一帧消息，不会进入此分支。
            !roomLoadedOnce && loading && !roomMsgError ? (
              <CenterSpinner />
            ) : !roomLoadedOnce && !roomMsgError ? null : roomSearchQuery.trim() ? (
              <Text style={[styles.empty, { color: palette.labelTertiary }]}>{t('没有匹配的消息')}</Text>
            ) : roomMsgError ? (
              <ErrorState title={t('加载失败')} hint={roomMsgError} onAction={() => selectedRoom && openRoom(selectedRoom, roomMode, showFanMessages)} />
            ) : (
              <EmptyState icon="message-text-outline" title={t('暂无消息，切换大/小房间试试')} />
            )
          }
          renderItem={renderChatItem}
          />
        </FadeInView>
      </View>
    );
  }

  return (
    <View style={[styles.container]}>
      <ScreenHeader title={t('房间')} hideBack right={
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={() => { if (searchOpen) setSearchQuery(''); setSearchOpen((v) => !v); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
            <MaterialCommunityIcons
              name={searchOpen ? 'close' : 'magnify'}
              size={22}
              color={palette.label}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => loadFollowed()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
            <MaterialCommunityIcons name="refresh" size={22} color={palette.label} />
          </TouchableOpacity>
        </View>
      } />

      {searchOpen ? (
        <View style={[styles.searchBar, { backgroundColor: palette.fill2, borderColor: palette.hairline }]}>
          <MaterialCommunityIcons name="magnify" size={18} color={palette.labelTertiary} />
          <TextInput
            style={[styles.searchInput, { color: palette.label }]}
            placeholder={t('搜索成员...')}
            placeholderTextColor={palette.labelTertiary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
            returnKeyType="search"
          />
          {searchQuery ? (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
              <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
        {searchOpen && searchQuery.trim() ? (
          /* 搜索态：成员库结果直接走 FlatList（可滚动、虚拟化） */
          memberHits.length === 0 ? (
            <Text style={[styles.memberHitsEmpty, { color: palette.labelTertiary }]}>{t('没有匹配的成员')}</Text>
          ) : (
          <PerfFlatList
            data={memberHits}
            keyExtractor={(member: any) => String((member as any).id || (member as any).userId || member.ownerName)}
            contentContainerStyle={styles.memberHitsListContent}
            numColumns={2}
            columnWrapperStyle={styles.memberGridRow}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: member, index }) => {
              const mid = String((member as any).id || (member as any).userId || '');
              const isFollowing = followedIds.has(mid);
              const busy = followBusy.has(mid);
              const name = shortName(member, mid);
              return (
                <FadeInView delay={index < 12 ? 80 + index * 30 : 0} duration={300} style={styles.memberGridItem}>
                  <TouchableOpacity
                    style={[
                      styles.memberHitCard,
                      { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth },
                    ]}
                    onPress={() => openRoom(member)}
                    activeOpacity={0.88}
                  >
                    <View style={[styles.memberHitAvatar, { backgroundColor: palette.tintSoft, borderColor: palette.hairline }]}>
                      {member.avatar ? (
                        <Image source={{ uri: member.avatar }} style={styles.memberHitAvatarImg} />
                      ) : (
                        <Text style={[styles.memberHitAvatarText, { color: palette.tint }]}>{avatarInitial(name)}</Text>
                      )}
                    </View>
                    <Text style={[styles.memberHitName, { color: palette.label }]} numberOfLines={1}>{name}</Text>
                    <Text style={[styles.memberHitTeam, { color: palette.labelTertiary }]} numberOfLines={1}>
                      {member.team || member.groupName || t('成员')}
                    </Text>
                    <TouchableOpacity
                      style={[styles.memberHitBtn, { backgroundColor: isFollowing ? palette.tintSoft : palette.tint }]}
                      disabled={busy}
                      onPress={() => toggleFollow(member)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      activeOpacity={0.85}
                    >
                      {busy ? (
                        <ActivityIndicator color={isFollowing ? palette.tint : palette.onTint} size="small" />
                      ) : (
                        <Text style={[styles.memberHitBtnText, { color: isFollowing ? palette.tint : palette.onTint }]}>
                          {isFollowing ? t('已关注') : t('关注')}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </TouchableOpacity>
                </FadeInView>
              );
            }}
          />
          )
        ) : (
        <PerfFlatList
          key="rooms-list"
          data={filtered}
          keyExtractor={(item) => String(item.memberId)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item, index }) => {
            const fid = String(item.member?.id || item.memberId);
            const isFollowing = followedIds.has(fid);
            const busy = followBusy.has(fid);
            const isPinned = pinned.includes(item.memberId);
            const name = shortName(item.member, item.memberId);
            const team = item.member?.team || item.member?.groupName || '';
            const lastTime = Number(item.lastMessage?.msgTime || item.lastMessage?.ctime || 0);
            const lastText = item.lastMessage ? messageText(item.lastMessage) : '';
            // 直播中判定：以直播列表接口为准（id / liveRoomId / account / 昵称命中关注成员）
            const mid = String(item.member?.id || item.memberId);
            const mroom = String((item.member as any)?.liveRoomId || '');
            const macct = String((item.member as any)?.account || '');
            const mnick = String(item.member?.ownerName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/i, '').trim().toLowerCase();
            const isLiveNow = liveNow.ids.has(mid) || (mroom && liveNow.ids.has(mroom)) || (macct && liveNow.ids.has(macct)) || (mnick && liveNow.names.has(mnick));
            // 上麦中：与直播中互斥（一个房间不可能同时直播和上麦），复用直播中徽标槽位
            const isOnMic = !isLiveNow && !!onMicMap[mid];
            return (
            <FadeInView delay={index < 12 ? 80 + index * 30 : 0} duration={300} style={styles.roomRow}>
              <View style={[styles.roomRowCard, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
                <ScalePressable
                  style={styles.roomRowMain}
                  onPress={() => item.member && openRoom(item.member)}
                  pressedScale={0.98}
                  activeOpacity={0.9}
                >
                  {/* 封面 56 圆角 12 */}
                  <View style={[styles.roomCover, { backgroundColor: palette.tintSoft, borderColor: palette.hairline }]}>
                    {item.member?.avatar ? (
                      <Image source={{ uri: item.member.avatar }} style={styles.roomCoverImg} />
                    ) : (
                      <Text style={[styles.roomCoverText, { color: palette.tint }]} numberOfLines={1}>{avatarInitial(name)}</Text>
                    )}
                  </View>
                  <View style={styles.roomInfo}>
                    <View style={styles.roomNameRow}>
                      <Text style={[styles.roomName, { color: palette.label }]} numberOfLines={1}>{name}</Text>
                      {/* 在线状态点：有最近消息视为在线 */}
                      <View style={[styles.statusDot, { backgroundColor: isLiveNow ? palette.success : palette.labelTertiary }]} />
                      {isLiveNow ? (
                        <View style={[styles.liveBadgeChip, { backgroundColor: palette.tint }]}>
                          <MaterialCommunityIcons name="broadcast" size={10} color={palette.onTint} />
                          <Text style={styles.liveBadgeChipText}>{t('直播中')}</Text>
                        </View>
                      ) : isOnMic ? (
                        <View style={[styles.liveBadgeChip, { backgroundColor: palette.tint }]}>
                          <MaterialCommunityIcons name="microphone" size={10} color={palette.onTint} />
                          <Text style={styles.liveBadgeChipText}>{t('上麦中')}</Text>
                        </View>
                      ) : null}
                      {isPinned ? (
                        <View style={[styles.pinTagChip, { backgroundColor: palette.tintSoft }]}>
                          <MaterialCommunityIcons name="pin" size={10} color={palette.tint} />
                          <Text style={[styles.pinTagChipText, { color: palette.tint }]}>{t('置顶')}</Text>
                        </View>
                      ) : null}
                    </View>
                    {team ? (
                      <Text style={[styles.roomTeam, { color: palette.labelTertiary }]} numberOfLines={1}>{team}</Text>
                    ) : null}
                    {/* 最新消息：大/小房间分开显示（小房间有消息时第二条） */}
                    {lastText ? (
                      <View style={styles.lastRow}>
                        <View style={[styles.lastTag, { backgroundColor: palette.tintSoft }]}>
                          <Text style={[styles.lastTagText, { color: palette.tint }]}>{t('大')}</Text>
                        </View>
                        <Text style={[styles.roomLast, { color: palette.labelSecondary, marginTop: 0, flex: 1 }]} numberOfLines={1}>
                          {lastText}
                        </Text>
                      </View>
                    ) : (
                      <Text style={[styles.roomLast, { color: palette.labelSecondary }]} numberOfLines={1}>
                        {t('点击查看房间消息')}
                      </Text>
                    )}
                    {(() => {
                      const sMsg = item.lastSmallMessage;
                      if (!sMsg) return null;
                      const sText = messageText(sMsg);
                      if (!sText || sText === lastText) return null;
                      const sTime = Number(sMsg?.msgTime || sMsg?.ctime || 0);
                      return (
                        <View style={styles.lastRow}>
                          <View style={[styles.lastTag, { backgroundColor: palette.fill2 }]}>
                            <Text style={[styles.lastTagText, { color: palette.labelSecondary }]}>{t('小')}</Text>
                          </View>
                          <Text style={[styles.roomLastSmall, { color: palette.labelTertiary }]} numberOfLines={1}>
                            {sText}
                          </Text>
                          {sTime ? (
                            <Text style={[styles.lastTimeSmall, { color: palette.labelTertiary }]} numberOfLines={1}>
                              {formatTimestamp(sTime).slice(5, 16)}
                            </Text>
                          ) : null}
                        </View>
                      );
                    })()}
                    <View style={styles.roomFoot}>
                      <Text style={[styles.roomTime, { color: palette.labelTertiary }]} numberOfLines={1}>
                        {lastTime ? formatTimestamp(lastTime).slice(5, 16) : ''}
                      </Text>
                    </View>
                  </View>
                </ScalePressable>
                <View style={styles.roomActions}>
                  {isPinned && pinned.length > 1 ? (
                    /* 排序胶囊：单个圆角方块内竖向排列 ↑ / ↓，整体像一个排序手柄 */
                    <View style={[styles.sortCapsule, { backgroundColor: palette.fill2, borderColor: palette.hairline }]}>
                      <ScalePressable
                        style={styles.sortHalfV}
                        onPress={() => movePin(item.memberId, -1)}
                        pressedScale={0.8}
                        hitSlop={{ top: 4, bottom: 1, left: 6, right: 6 }}
                        disabled={pinned.indexOf(item.memberId) === 0}
                      >
                        <MaterialCommunityIcons name="chevron-up" size={14} color={pinned.indexOf(item.memberId) === 0 ? palette.labelTertiary : palette.labelSecondary} />
                      </ScalePressable>
                      <View style={[styles.sortDividerV, { backgroundColor: palette.innerStroke }]} />
                      <ScalePressable
                        style={styles.sortHalfV}
                        onPress={() => movePin(item.memberId, 1)}
                        pressedScale={0.8}
                        hitSlop={{ top: 1, bottom: 4, left: 6, right: 6 }}
                        disabled={pinned.indexOf(item.memberId) === pinned.length - 1}
                      >
                        <MaterialCommunityIcons name="chevron-down" size={14} color={pinned.indexOf(item.memberId) === pinned.length - 1 ? palette.labelTertiary : palette.labelSecondary} />
                      </ScalePressable>
                    </View>
                  ) : null}
                  <ScalePressable
                    style={[styles.roomPinBtn, { backgroundColor: isPinned ? palette.tintSoft : palette.fill2 }]}
                    onPress={() => togglePin(item.memberId)}
                    pressedScale={0.9}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <MaterialCommunityIcons
                      name={isPinned ? 'pin' : 'pin-outline'}
                      size={15}
                      color={isPinned ? palette.tint : palette.labelTertiary}
                    />
                  </ScalePressable>
                  <ScalePressable
                    style={[styles.roomFollowBtn, { backgroundColor: isFollowing ? palette.tintSoft : palette.fill2 }]}
                    disabled={busy}
                    pressedScale={0.9}
                    activeOpacity={0.85}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    onPress={() => {
                      if (isFollowing) {
                        Alert.alert(
                          t('取消关注'),
                          t('确定不再关注 {name} 吗？', { name: shortName(item.member, item.memberId) }),
                          [
                            { text: t('保留'), style: 'cancel' },
                            { text: t('取消关注'), style: 'destructive', onPress: () => item.member && toggleFollow(item.member) },
                          ],
                        );
                      } else if (item.member) {
                        toggleFollow(item.member);
                      }
                    }}
                  >
                    {busy ? (
                      <ActivityIndicator color={palette.tint} size="small" />
                    ) : (
                      <MaterialCommunityIcons
                        name={isFollowing ? 'heart' : 'heart-outline'}
                        size={17}
                        color={isFollowing ? palette.tint : palette.labelTertiary}
                      />
                    )}
                  </ScalePressable>
                </View>
              </View>
            </FadeInView>
            );
          }}
          ListEmptyComponent={
            searchOpen && searchQuery.trim() ? null : followedLoading ? (
            <CenterSpinner />
          ) : !token ? (
            <EmptyState
              icon="account-key-outline"
              title={t('登录后可查看关注房间和最新消息')}
              actionLabel={t('去登录')}
              onAction={() => navigation.navigate('LoginScreen')}
            />
          ) : followedError ? (
            <ErrorState title={t('加载失败')} hint={followedError} onAction={() => loadFollowed(true)} />
          ) : (
            <EmptyState icon="heart-outline" title={t('暂无关注房间')} />
          )}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
        />
        )}
      </FadeInView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  roomBgLayer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  chatToolsClip: { marginHorizontal: 12, marginBottom: 8, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  chatTools: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 6, borderRadius: 18 },
  segment: {
    flexDirection: 'row',
    borderRadius: radii.pill,
    padding: 3,
    gap: 2,
  },
  segmentItem: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
  },
  segmentText: { fontSize: 12, fontWeight: '800' },
  chatToolCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatDateRow: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  chatDatePill: {
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.pill,
  },
  chatDateText: { fontSize: 11, fontWeight: '600' },
  roomSearchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  roomSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: radiiAlias.input,
    borderWidth: StyleSheet.hairlineWidth,
  },
  roomSearchInput: { flex: 1, fontSize: 14, padding: 0, height: 40 },
  input: { flex: 1, padding: 10, borderRadius: radiiAlias.input, borderWidth: StyleSheet.hairlineWidth },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: radiiAlias.input,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  memberHitsListContent: { paddingHorizontal: 8, paddingBottom: 112 },
  memberHitCard: {
    flex: 1,
    padding: 14,
    borderRadius: 18,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
    marginBottom: 8,
  },
  memberHitAvatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  memberHitAvatarImg: { width: 68, height: 68, borderRadius: 34 },
  memberHitAvatarText: { fontSize: 22, fontWeight: '800' },
  memberHitName: { fontSize: 16, fontWeight: '800', marginTop: 10, maxWidth: '90%' },
  memberHitTeam: { fontSize: 12, marginTop: 3 },
  memberHitBtn: {
    paddingHorizontal: 18,
    paddingVertical: 7,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
    marginTop: 10,
  },
  memberHitBtnText: { fontSize: 13, fontWeight: '800' },
  memberHitsEmpty: { textAlign: 'center', marginTop: 40, fontSize: 14 },
  memberGridRow: { paddingHorizontal: 8 },
  memberGridItem: { width: '50%', padding: 4 },
  memberCard: {
    flex: 1,
    padding: 14,
    borderRadius: 18,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
  },
  memberPin: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  memberAvatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  memberAvatarImg: { width: 76, height: 76, borderRadius: 38 },
  memberAvatarText: { fontSize: 26, fontWeight: '800' },
  memberInfo: { alignSelf: 'stretch', marginTop: 12 },
  memberNameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  memberName: { fontSize: 17, fontWeight: '800', flexShrink: 1 },
  memberTeam: { fontSize: 12, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  memberLast: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  memberFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  memberTime: { fontSize: 12 },
  listContent: { paddingBottom: 112, paddingTop: 4 },
  /** 房间行卡：封面 56 圆角 12 + 房间名 + 状态点 + 直播中徽标 */
  roomRow: { paddingHorizontal: 16, marginBottom: 8 },
  roomRowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  roomRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  roomCover: {
    width: 56,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  roomCoverImg: { width: 56, height: 56, borderRadius: 12 },
  roomCoverText: { fontSize: 22, fontWeight: '800' },
  roomInfo: { flex: 1, minWidth: 0, marginLeft: 12 },
  roomNameRow: { flexDirection: 'row', alignItems: 'center' },
  roomName: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 6 },
  liveBadgeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  liveBadgeChipText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
  roomTeam: { fontSize: 11, marginTop: 3, fontWeight: '600' },
  roomLast: { fontSize: 12, marginTop: 4, lineHeight: 16 },
  lastRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  lastTag: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 16,
    borderRadius: 5,
    marginRight: 6,
    paddingHorizontal: 3,
  },
  lastTagText: { fontSize: 10, fontWeight: '800', lineHeight: 14 },
  roomLastSmall: { fontSize: 11, lineHeight: 15, flex: 1 },
  lastTimeSmall: { fontSize: 10, marginLeft: 6 },
  roomFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  roomTime: { fontSize: 11 },
  roomPinTag: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  pinTagChip: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    marginLeft: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
  },
  pinTagChipText: { fontSize: 9, fontWeight: '800' },
  roomActions: { marginLeft: 6, gap: 6, alignItems: 'center', paddingRight: 12, paddingVertical: 10 },
  /* 排序胶囊：单个圆角方块内竖向排列 ↑ / ↓ */
  sortCapsule: {
    width: 32, height: 32, borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden',
  },
  sortHalfV: { width: 32, height: 15, alignItems: 'center', justifyContent: 'center' },
  sortDividerV: { width: 14, height: StyleSheet.hairlineWidth, alignSelf: 'center' },
  roomPinBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  roomFollowBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  chatContent: { paddingBottom: 132, paddingTop: 4 },
  followBtn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: radiiAlias.button, alignItems: 'center', justifyContent: 'center', minWidth: 52, height: 26 },
  followBtnText: { fontSize: 11, fontWeight: '800' },
  chatFooter: { paddingVertical: 16, alignItems: 'center' },
  chatRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 12, marginTop: 7, marginBottom: 2 },
  chatRowTight: { marginTop: 2, marginBottom: 1 },
  chatRowMine: { justifyContent: 'flex-end' },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 9 },
  avatarPlaceholder: { width: 40, height: 40, marginRight: 9 },
  avatarFallback: { width: 40, height: 40, borderRadius: 20, marginRight: 9, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '900', fontSize: 15 },
  msgBlock: { maxWidth: '78%', minWidth: 48 },
  msgBlockMine: { alignItems: 'flex-end' },
  replyCard: { marginBottom: 6, padding: 8, borderRadius: radii.sm, borderLeftWidth: 3, borderLeftColor: '#ff6f91' },
  replyName: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  replyText: { fontSize: 13, lineHeight: 18 },
  msgMetaLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4, paddingHorizontal: 6 },
  msgMetaLineMine: { justifyContent: 'flex-end' },
  msgSender: { fontSize: 12, fontWeight: '600', maxWidth: 150 },
  msgTime: { fontSize: 10 },
  msgBubble: { paddingVertical: 9, paddingHorizontal: 13, borderRadius: 18 },
  msgBubbleMid: { borderTopLeftRadius: 6, borderTopRightRadius: 6 },
  msgBubbleTailLeft: { borderBottomLeftRadius: 6 },
  msgBubbleTailRight: { borderBottomRightRadius: 6 },
  msgBody: { fontSize: 15, lineHeight: 22 },
  msgBodyHighlight: {},
  giftCard: { marginTop: 8, minWidth: 210, padding: 10, borderRadius: radiiAlias.cardCompact, backgroundColor: 'rgba(255,240,246,0.88)', borderWidth: 1, borderColor: 'rgba(255,111,145,0.24)', flexDirection: 'row', alignItems: 'center', gap: 10 },
  giftCardCompact: { minWidth: 0, padding: 8, gap: 0 } as any,
  giftImage: { width: 34, height: 34, borderRadius: radii.xs, backgroundColor: '#fff' },
  giftImageFallback: { width: 34, height: 34, borderRadius: radii.xs, backgroundColor: '#ff6f91', alignItems: 'center', justifyContent: 'center' },
  giftEmoji: { color: '#fff', fontSize: 13, fontWeight: '800' },
  giftTextWrap: { flex: 1, minWidth: 0 },
  giftName: { fontSize: 13, fontWeight: '800' },
  giftMeta: { marginTop: 3, fontSize: 11 },
  mediaCard: { marginTop: 8, minWidth: 214, padding: 10, borderRadius: radiiAlias.cardCompact, borderWidth: StyleSheet.hairlineWidth },
  liveCover: { width: '100%', height: 130, borderRadius: 10, marginBottom: 8, backgroundColor: 'rgba(128,128,128,0.1)' },
  liveCardWrap: { marginTop: 8, width: 228, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.1)' },
  liveCardImg: { width: 228, height: 228, borderRadius: 14 },
  liveCardOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 36, alignItems: 'center', justifyContent: 'center' },
  videoCoverWrap: { marginTop: 8, width: '100%', maxWidth: 228, aspectRatio: 1, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center' },
  videoCoverImg: { width: '100%', aspectRatio: 1, borderRadius: 14 },
  videoCoverOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  videoCoverDuration: { position: 'absolute', right: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.5)' },
  videoCoverDurationText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  videoCoverPlaceholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.05)' },
  videoCoverPlaceholderText: { color: '#ff6f91', fontSize: 13, fontWeight: '800' },
  livePlayCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  livePlayIcon: { color: '#fff', fontSize: 24, marginLeft: 4 },
  liveCardTitleBar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(0,0,0,0.5)' },
  liveCardTitle: { color: '#fff', fontSize: 13, fontWeight: '700' },
  mediaMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mediaIcon: { fontSize: 12, fontWeight: '900' },
  mediaTitle: { flex: 1, fontSize: 13, fontWeight: '800', lineHeight: 18 },
  mediaDuration: { fontSize: 11, fontWeight: '700' },
  mediaPlayBtn: { marginTop: 9, minHeight: 38, paddingVertical: 9, borderRadius: radiiAlias.button, alignItems: 'center', justifyContent: 'center' },
  mediaPlayText: { fontSize: 13, fontWeight: '900' },
  inlineAudio: { height: 52, minWidth: 224, marginTop: 8 },
  inlineAudioWrap: { height: 0, overflow: 'hidden' },
  inlineAudioHidden: { height: 0, width: 0 },
  // 内联视频已交给 <AdaptiveAspectVideo /> 处理真实宽高比，不再用固定 height/minWidth。
  // （保留 inlineImage / inlineSticker 等其它媒体类型的固定尺寸样式。）
  inlineImage: { width: '100%', maxWidth: 228, aspectRatio: 1, marginTop: 8, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.10)' },
  inlineSticker: { width: 120, height: 120, marginTop: 6, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.05)' },
  openLinkBtn: { marginTop: 8, padding: 8, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.10)', maxWidth: '100%', alignSelf: 'flex-start' },
  openLinkText: { color: '#ff6f91', fontSize: 11, fontWeight: '800' },
  roomPlayerPage: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 1000, elevation: 1000, backgroundColor: '#000' },
  roomPlayerPageFullscreen: { paddingTop: 0 },
  roomPlayerHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: 44, paddingHorizontal: 10, paddingBottom: 8, backgroundColor: '#080808' },
  roomPlayerBack: { padding: 8 },
  roomPlayerBackText: { color: '#ff6f91', fontSize: 14, fontWeight: '900' },
  roomPlayerTitle: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '800' },
  roomPlayerTool: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.12)', marginLeft: 6 },
  roomPlayerToolText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  exitRoomFullscreenBtn: { position: 'absolute', top: 14, right: 14, zIndex: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.58)' },
  exitRoomFullscreenText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  roomNativeVideo: { flex: 1, backgroundColor: '#000' },
  liveResolveClose: { position: 'absolute', top: 48, right: 14, zIndex: 10 },
  liveResolveCloseBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
  liveResolveWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 12 },
  liveResolveTitle: { color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  liveResolveText: { color: 'rgba(255,255,255,0.72)', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  liveResolveBtns: { flexDirection: 'row', gap: 12, marginTop: 10 },
  liveResolveBtn: { paddingHorizontal: 26, paddingVertical: 10, borderRadius: 22 },
  liveResolveBtnText: { color: '#fff', fontSize: 14, fontWeight: '900' },
  liveResolveBtnGhost: { paddingHorizontal: 26, paddingVertical: 10, borderRadius: 22, borderWidth: 1 },
  liveResolveBtnGhostText: { color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: '800' },
  roomModalShade: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  roomRankPanel: { maxHeight: '82%', padding: 14, paddingBottom: 24, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet },
  roomRankHandleWrap: { alignItems: 'center', paddingTop: 2, paddingBottom: 10 },
  roomRankHandle: { width: 40, height: 5, borderRadius: 3 },
  roomRankHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  roomRankClose: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  roomRankTitle: { fontSize: 18, fontWeight: '900' },
  roomRankStatus: { fontSize: 12, marginBottom: 10 },
  roomRankList: { maxHeight: 420 },
  roomRankRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  roomRankNo: { width: 24, fontSize: 13, fontWeight: '900', textAlign: 'center' },
  roomRankAvatar: { width: 34, height: 34, borderRadius: 17 },
  roomRankInfo: { flex: 1, minWidth: 0 },
  roomRankName: { fontSize: 13, fontWeight: '800' },
  roomRankProgressTrack: { height: 4, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  roomRankProgressFill: { height: 4, borderRadius: 2 },
  roomRankValue: { fontSize: 11, fontWeight: '700', marginLeft: 6, flexShrink: 1 },
  empty: { textAlign: 'center', marginTop: 60, fontSize: 14, paddingHorizontal: 24, lineHeight: 20 },
});
