import { StreamKind, PlayerSource } from '../types';
import { normalizeUrl, pickText, unwrapList } from '../../utils/data';

/**
 * 统一流解析器（重写核心）：
 * 合并现状三处重复实现 —— FollowedRoomsScreen（classifyMedia/streamScore/pickPlayableUrls/
 * streamNeedsProxy/isLiveStreamUrl）、MediaScreen（streamScore/liveStreamScore/pickPlayableUrls）、
 * musicPlayer（isPlayableHost）。新增流类型只改这里。
 */

// --- URL 分类（classifyMedia 全量规则，扩展名最高优先级） ---

const RE_VIDEO_EXT = /\.(mp4|mov|m4v|3gp)(\?|$)/i;
const RE_LIVE_EXT = /\.(m3u8|flv|ts)(\?|$)/i;
const RE_AUDIO_EXT = /\.(mp3|m4a|aac|amr|wav)(\?|$)/i;
const RE_IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)(\?|$)/i;

export function classifyUrl(url: string, msgType = '', text = ''): StreamKind {
  const lower = `${url} ${msgType} ${text}`.toLowerCase();
  if (RE_VIDEO_EXT.test(url)) return 'vod';
  if (RE_LIVE_EXT.test(url) || lower.startsWith('rtmp://')) return 'live';
  if (RE_AUDIO_EXT.test(url)) return 'audio';
  if (RE_IMAGE_EXT.test(url) || lower.includes('image') || lower.includes('expressimage')) return 'image';
  // 无扩展名关键字兜底
  if (lower.includes('live') || lower.includes('playback') || lower.includes('record') || lower.includes('replay')) return 'live';
  if (lower.includes('voice') || lower.includes('audio')) return 'audio';
  if (lower.includes('video')) return 'vod';
  return 'link';
}

// --- 流评分与候选排序（合并 FollowedRooms + MediaScreen 两版，preferLive 语义） ---

export function streamScore(url: string, preferLive = false): number {
  const lower = String(url || '').toLowerCase();
  if (preferLive && lower.startsWith('rtmp://')) return 130;
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return preferLive ? 100 : 90;
  if (lower.includes('.flv')) return preferLive ? 110 : 70;
  if (lower.startsWith('rtmp://')) return 60;
  if (RE_VIDEO_EXT.test(lower)) return 80;
  if (RE_AUDIO_EXT.test(lower)) return 80;
  return 40;
}

/** 从响应中按 40+ 字段名 + 嵌套流数组提取可播放地址（合并两份实现） */
const PLAY_URL_FIELDS = [
  'playStreamPath', 'playUrlPath', 'playPathUrl', 'streamUrl', 'streamURL',
  'playUrl', 'urlPath', 'playPath', 'streamPath', 'path', 'src',
  'pullStreamPath', 'liveStreamPath', 'livePlayStreamPath',
  'streamPathHd', 'streamPathHigh', 'streamPathNormal', 'streamPathOrigin',
  'url', 'liveUrl', 'm3u8Url', 'flvUrl', 'hlsUrl', 'videoUrl', 'audioUrl',
  'voiceUrl', 'recordUrl', 'mediaUrl', 'filePath', 'imageUrl', 'imagePath',
  'picPath', 'picturePath', 'cover',
  'content.playStreamPath', 'content.playUrlPath', 'content.playPathUrl',
  'content.streamUrl', 'content.playUrl', 'content.playPath', 'content.streamPath',
  'content.pullStreamPath', 'content.liveStreamPath', 'content.livePlayStreamPath',
  'content.url', 'content.imageUrl', 'content.imagePath', 'content.picPath',
  'data.playStreamPath', 'data.playUrlPath', 'data.playPathUrl', 'data.streamUrl',
  'data.playUrl', 'data.playPath', 'data.streamPath', 'data.pullStreamPath',
  'data.liveStreamPath', 'data.livePlayStreamPath', 'data.url',
  'content.playStreams.0.streamPath', 'data.playStreams.0.streamPath',
];

const STREAM_LIST_KEYS = [
  'streams', 'playStreams', 'liveStreams', 'urls',
  'content.streams', 'content.playStreams', 'content.liveStreams',
  'content.streamList', 'content.playStreamList', 'content.urls',
  'data.streams', 'data.playStreams', 'data.liveStreams',
  'data.streamList', 'data.playStreamList', 'data.urls',
];

function collectUrlsDeep(value: any, result: string[] = [], depth = 0): void {
  if (!value || depth > 5) return;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) result.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrlsDeep(item, result, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectUrlsDeep(item, result, depth + 1));
  }
}

export function pickPlayableUrls(raw: any, preferLive = false): string[] {
  const candidates: string[] = [];
  const direct = normalizeUrl(pickText(raw, PLAY_URL_FIELDS));
  if (direct) candidates.push(direct);
  const nested = unwrapList(raw, STREAM_LIST_KEYS);
  nested.forEach((item) => {
    const url = normalizeUrl(pickText(item, PLAY_URL_FIELDS));
    if (url) candidates.push(url);
  });
  const deep: string[] = [];
  collectUrlsDeep(raw, deep);
  deep.forEach((url) => candidates.push(url));
  return Array.from(new Set(candidates.filter(Boolean)))
    .sort((a, b) => streamScore(b, preferLive) - streamScore(a, preferLive));
}

// --- 直播/内核判定 ---

/** rtmp/http-flv → 必须走原生 ExoKernel（LiveExoView） */
export function needsNativeExo(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv');
}

export function isLiveStreamUrl(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv') || lower.includes('.m3u8');
}

export function isPlayableMediaUrl(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return lower.startsWith('rtmp://')
    || lower.includes('.m3u8')
    || lower.includes('.flv')
    || RE_VIDEO_EXT.test(lower)
    || RE_AUDIO_EXT.test(lower)
    || lower.includes('playstream')
    || lower.includes('streampath');
}

/** 口袋48 防盗链头（统一一份；playerSource 语义） */
export function buildPocketHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
    Referer: 'https://h5.48.cn/',
    Origin: 'https://h5.48.cn',
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/** 构建统一 PlayerSource（url 分类 + 内核标记 + 防盗链头） */
export function resolveSource(raw: any, opts: {
  preferLive?: boolean;
  kindHint?: StreamKind;
  title?: string;
  liveId?: string;
  replayHint?: boolean;
  headers?: Record<string, string>;
} = {}): PlayerSource | null {
  const urls = pickPlayableUrls(raw, opts.preferLive);
  if (!urls.length) return null;
  const url = urls[0];
  let kind = opts.kindHint || classifyUrl(url);
  // 消息明示回放且非 rtmp 推流 → 按录播处理
  if (opts.replayHint && kind === 'live' && !url.toLowerCase().startsWith('rtmp://')) {
    kind = 'vod';
  }
  return {
    kind,
    url,
    urls,
    liveId: opts.liveId,
    needsNativeExo: needsNativeExo(url),
    headers: opts.headers || (kind === 'live' || kind === 'vod' ? buildPocketHeaders() : undefined),
  };
}

export default {
  classifyUrl,
  streamScore,
  pickPlayableUrls,
  needsNativeExo,
  isLiveStreamUrl,
  isPlayableMediaUrl,
  buildPocketHeaders,
  resolveSource,
};
