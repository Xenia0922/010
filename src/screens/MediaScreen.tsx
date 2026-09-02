import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  DeviceEventEmitter,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import * as ScreenOrientation from 'expo-screen-orientation';
import { RouteProp, useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { TabParamList } from '../navigation/types';
import { useSettingsStore, useUiStore, useMemberStore } from '../store';
import { setPipPlaying, setPipAspect } from '../utils/pip';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import { FadeInView } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { VODItem, Member } from '../types';
import { formatTimestamp, formatDuration } from '../utils/format';
import { errorMessage, normalizeUrl, pickText, unwrapList } from '../utils/data';
import { getResumePosition } from '../utils/resumePosition';
import { logWarn } from '../utils/runtimeLog';
import pocketApi from '../api/pocket48';
import { setLiveImmersiveMode } from '../native/LivePlayer';
import PlayerScreen from '../player';
import { usePlayerStore } from '../player/store/playerStore';
import { DanmakuOverlay } from '../components/DanmakuOverlay';
import DanmakuSettingsSheet from '../components/DanmakuSettingsSheet';
import { parseDanmaku, DanmakuItem } from '../utils/danmaku';
import { memberSearchText } from '../utils/members';
import { EmptyState } from '../components/StateViews';
import { LoginPrompt } from '../components/LoginPrompt';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { usePalette, radii, radiiAlias } from '../theme';
import { translate, useI18n } from '../i18n';

/** 回放列表加载占位：居中低调研度指示，无微光闪烁，避免「转圈 + 文字」混排打架 */
type MediaRouteProp = RouteProp<TabParamList, 'Media'>;

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
  'recordUrl',
  'mediaUrl',
  'filePath',
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
  'content.playStreams.0.streamPath',
  'data.playStreams.0.streamPath',
];

function streamScore(url: string): number {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return 100;
  if (lower.startsWith('https://') && lower.includes('.flv')) return 60;
  if (lower.startsWith('http://') && lower.includes('.flv')) return 50;
  if (lower.startsWith('rtmp://')) return 20;
  return 40;
}

function liveStreamScore(url: string): number {
  const lower = url.toLowerCase();
  if (lower.startsWith('rtmp://')) return 120;
  if (lower.startsWith('https://') && lower.includes('.flv')) return 105;
  if (lower.startsWith('http://') && lower.includes('.flv')) return 95;
  if (lower.includes('.m3u8') || lower.includes('format=hls')) return 80;
  return streamScore(url);
}

/**
 * 为直播/录播项构造可搜索文本 + 数字串，支持「时间搜索」。
 * 数字串同时给出「补零」与「不补零」两种形态，使 2026-07-20 / 0720 / 7-20 / 2026/7/20
 * 等自然输入都能命中，解决原先只能匹配 YYYY-MM-DD HH:mm:ss 单一格式的问题。
 */
function buildMediaSearchText(item: any): { text: string; digits: string } {
  const ts = formatTimestamp(item.startTime);
  const d = new Date(String(item.startTime || '').replace(/-/g, '/'));
  let padded = '';
  let loose = '';
  if (!Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hh = d.getHours();
    const mm = d.getMinutes();
    const ss = d.getSeconds();
    padded = `${y}${String(m).padStart(2, '0')}${String(day).padStart(2, '0')}${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}${String(ss).padStart(2, '0')}`;
    loose = `${y}${m}${day}${hh}${mm}${ss}`;
  }
  const text = [item.title, item.nickname, item.liveRoomTitle, String(item.liveId || ''), ts]
    .filter(Boolean).join(' ').toLowerCase();
  const digits = [ts.replace(/\D/g, ''), padded, loose].filter(Boolean).join('');
  return { text, digits };
}

// 取录制时间的日期键 YYYY-MM-DD，用于日历筛选精确匹配
function dateKeyOf(startTime: any): string {
  let v: any = startTime;
  if (v === null || v === undefined || v === '') return '';
  // 录播接口 startTime 实际是「字符串形式的毫秒时间戳」（如 "1787214699552"），
  // 直接 new Date("1787214699552") 是 Invalid Date → 解析成秒/毫秒数字再 new Date
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{10}$/.test(s)) v = Number(s) * 1000; // 10 位秒
    else if (/^\d{13}$/.test(s)) v = Number(s); // 13 位毫秒
    else v = s.replace(/-/g, '/');
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e10) v *= 1000;
  const d = new Date(v as any);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 录播日历选择弹层（纯 RN 月历，零依赖，对标 pocket48_lite 的 CalendarMonth 按钮 + DatePicker）
function CalendarSheet({
  visible,
  initial,
  onSelect,
  onClose,
}: {  visible: boolean;
  initial: Date | null;
  onSelect: (d: Date) => void;
  onClose: () => void;
}) {
  const palette = usePalette();
  const { t } = useI18n();
  const base = initial || new Date();
  const [view, setView] = useState(() => new Date(base.getFullYear(), base.getMonth(), 1));
  const year = view.getFullYear();
  const month = view.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'].map((w) => t(w));
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.calMask} activeOpacity={1} onPress={onClose}>
        <View style={[styles.calSheet, { backgroundColor: palette.surface, borderColor: palette.innerStroke }]} onStartShouldSetResponder={() => true}>
          <View style={styles.calHeader}>
            <TouchableOpacity onPress={() => setView(new Date(year, month - 1, 1))} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }} activeOpacity={0.7}>
              <MaterialCommunityIcons name="chevron-left" size={24} color={palette.label} />
            </TouchableOpacity>
            <Text style={[styles.calTitle, { color: palette.label }]}>{t('{year} 年 {month} 月', { year, month: month + 1 })}</Text>
            <TouchableOpacity onPress={() => setView(new Date(year, month + 1, 1))} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }} activeOpacity={0.7}>
              <MaterialCommunityIcons name="chevron-right" size={24} color={palette.label} />
            </TouchableOpacity>
          </View>
          <View style={styles.calWeekRow}>
            {weekdays.map((w) => (
              <Text key={w} style={[styles.calWeek, { color: palette.labelTertiary }]}>{w}</Text>
            ))}
          </View>
          <View style={styles.calGrid}>
            {cells.map((d, i) =>
              d ? (
                <TouchableOpacity key={i} style={styles.calDay} onPress={() => onSelect(new Date(year, month, d))} activeOpacity={0.7}>
                  <Text style={[styles.calDayText, { color: palette.label }]}>{d}</Text>
                </TouchableOpacity>
              ) : (
                <View key={i} style={styles.calDay} />
              ),
            )}
          </View>
          <View style={styles.calFooter}>
            <TouchableOpacity onPress={onClose} style={styles.calCancel}>
              <Text style={[styles.calCancelText, { color: palette.tint }]}>{t('取消')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { onSelect(new Date()); onClose(); }}
              style={[styles.calToday, { backgroundColor: palette.tint }]}
              activeOpacity={0.85}
            >
              <Text style={[styles.calTodayText, { color: palette.onTint }]}>{t('今天')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

function pickPlayableUrls(raw: any, preferLive = false): string[] {
  const candidates: string[] = [];
  const direct = normalizeUrl(pickText(raw, PLAY_URL_FIELDS));
  if (direct) candidates.push(direct);
  const streamList = unwrapList(raw, [
    'streams',
    'playStreams',
    'liveStreams',
    'urls',
    'content.streams',
    'content.playStreams',
    'content.urls',
    'data.streams',
    'data.playStreams',
    'content.liveStreams',
    'content.streamList',
    'content.playStreamList',
    'data.liveStreams',
    'data.streamList',
    'data.playStreamList',
    'data.urls',
  ]);
  for (const stream of streamList) {
    const url = normalizeUrl(pickText(stream, PLAY_URL_FIELDS));
    if (url) candidates.push(url);
  }
  const score = preferLive ? liveStreamScore : streamScore;
  return Array.from(new Set(candidates.filter(Boolean))).sort((a, b) => score(b) - score(a));
}

function pickPlayableUrl(raw: any): string {
  return pickPlayableUrls(raw)[0] || '';
}

function streamNeedsProxy(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv');
}

function normalizeLiveList(res: any): VODItem[] {
  const source = unwrapList(res, [
    'content.liveList',
    'content.list',
    'content.data',
    'content.records',
    'data.liveList',
    'liveList',
    'list',
    'data',
  ]);

  return source.map((raw: any, index: number) => ({
    ...raw,
    liveId: String(pickText(raw, ['liveId', 'id', 'live_id', 'roomId'], String(index))),
    title: pickText(raw, ['title', 'liveTitle', 'liveRoomTitle', 'roomName', 'subject'], translate('无标题')),
    liveRoomTitle: pickText(raw, ['liveRoomTitle', 'title', 'liveTitle']),
    nickname: pickText(raw, ['nickname', 'nickName', 'userInfo.nickname', 'userInfo.nickName', 'ownerName']),
    startTime: raw.startTime || raw.stime || raw.start_time || raw.ctime || raw.liveStartTime || raw.beginTime,
    endTime: raw.endTime || raw.etime || raw.end_time || raw.liveEndTime,
    liveCover: normalizeUrl(pickText(raw, [
      'liveCover',
      'coverPath',
      'cover',
      'coverUrl',
      'picPath',
      'picturePath',
      'imageUrl',
      'poster',
      'thumb',
      'userInfo.avatar',
    ])),
    coverPath: normalizeUrl(pickText(raw, ['coverPath', 'cover', 'coverUrl'])),
    playUrl: pickPlayableUrl(raw),
    playPath: normalizeUrl(pickText(raw, ['playPath', 'playUrl', 'url'])),
    liveType: Number(pickText(raw, ['liveType', 'type', 'mediaType'], '1')),
    screenDirection: Number(pickText(raw, ['screenDirection', 'orientation'], '0')),
  })) as VODItem[];
}

/** 按 liveId 在直播/录播列表（首屏）中查找条目，作为详情接口解析失败的兜底 */
async function findLiveItemInLists(liveId: string, record: boolean) {
  const calls: Promise<any>[] = [
    pocketApi.getLiveList({ record, debug: true, next: 0 }),
    pocketApi.getOpenLivePublicList({ record, next: 0 }),
  ];
  for (const p of calls) {
    try {
      const res = await p;
      const list = unwrapList(res, ['content.liveList', 'content.list', 'data.liveList', 'liveList', 'list', 'data']);
      const found = list.find((it: any) => String(it.liveId || it.id || it.live_id || '') === String(liveId));
      if (found) return found;
    } catch {
      /* 尝试下一个源 */
    }
  }
  return null;
}

function mergeUniqueLiveItems(prev: VODItem[], next: VODItem[]) {
  const seen = new Set(prev.map((item: any, index) => String(item.liveId || item.id || item.title || index)));
  const merged = [...prev];
  for (const item of next as any[]) {
    const key = String(item.liveId || item.id || item.title || merged.length);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function playerSource(url: string) {
  return {
    uri: url,
    headers: {
      'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
      Referer: 'https://h5.48.cn/',
    },
  };
}

function normalizeGiftList(res: any): any[] {
  const categories = unwrapList(res, ['content', 'content.list', 'data.content', 'data.list', 'list']);
  const gifts: any[] = [];
  for (const item of categories) {
    const nested = unwrapList(item, ['giftList', 'gifts', 'list']);
    if (nested.length) gifts.push(...nested);
    else if (item?.giftId || item?.id) gifts.push(item);
  }
  const seen = new Set<string>();
  return gifts.filter((gift) => {
    const id = String(gift.giftId || gift.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function normalizeLiveRank(res: any): any[] {
  let list = unwrapList(res, [
    'content.rankList',
    'content.userRankList',
    'content.userRankingList',
    'content.contributionList',
    'content.list',
    'content.data',
    'content.data.list',
    'content.data.rankList',
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
    if (content && typeof content === 'object') {
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
  }
  return list.map((item: any, index: number) => ({
    ...item,
    userId: pickText(item, ['userId', 'uid', 'id', 'account', 'userInfo.userId', 'userInfo.id', 'user.userId', 'user.id', 'user.userIdStr', 'user.userAccount', 'memberInfo.userId', 'memberInfo.id']),
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
    ], '\u7528\u6237 ' + (index + 1)),
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

function rankNameIsFallback(row: any, index: number) {
  const name = String(row.name || '').trim();
  const fallbackPrefix = '\u7528\u6237';
  return !name || name === `${fallbackPrefix} ${index + 1}` || new RegExp(`^${fallbackPrefix}\\s*\\d+$`).test(name);
}
function profileFromUserRes(res: any) {
  const info = res?.content?.userInfo || res?.content?.user || res?.content || res?.data?.userInfo || res?.data?.user || res?.data || res || {};
  return {
    name: pickText(info, [
      'nickName', 'nickname', 'userName', 'name',
      'profile.nickName', 'profile.nickname',
      'userInfo.nickName', 'userInfo.nickname',
      'user.nickName', 'user.nickname', 'user.userName',
    ]),
    avatar: normalizeUrl(pickText(info, [
      'avatar', 'headImg', 'headUrl', 'picPath',
      'profile.avatar', 'profile.headImg',
      'userInfo.avatar', 'userInfo.headImg',
      'user.avatar', 'user.headImg', 'user.userAvatar',
    ])),
  };
}

function giftName(gift: any): string {
  return String(gift.giftName || gift.name || translate('未知礼物'));
}

function giftCost(gift: any): number {
  return Number(gift.money ?? gift.cost ?? gift.canSendNum ?? 0) || 0;
}

function giftImage(gift: any): string {
  return normalizeUrl(gift.picPath || gift.icon || gift.giftPic || gift.url || '');
}

function acceptUserId(item: any): string {
  return String(item?.userInfo?.userId || item?.user?.userId || item?.userId || item?.ownerId || item?.memberId || '');
}


/** 直播中呼吸红点（Animated + native driver） */
function LivePulseDot({ size = 7 }: { size?: number }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: '#ff4d4f',
        marginRight: 4,
        opacity: pulse,
      }}
    />
  );
}

/** 回放/直播列表首屏骨架：banner 块 + 2 列网格块 */
function MediaGridSkeleton() {
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4 }}>
      <Skeleton width="100%" height={170} radius={16} style={{ marginBottom: 12 }} />
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
          <View style={{ flex: 1 }}><Skeleton width="100%" height={110} radius={14} /></View>
          <View style={{ flex: 1 }}><Skeleton width="100%" height={110} radius={14} /></View>
        </View>
      ))}
    </View>
  );
}

export default function MediaScreen() {
  const route = useRoute<MediaRouteProp>();
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const { t } = useI18n();
  const setTabBarHidden = useUiStore((state) => state.setTabBarHidden);
  const showToast = useUiStore((state) => state.showToast);
  const members = useMemberStore((state) => state.members);
  const [tab, setTab] = useState<'live' | 'vod'>(route.params?.mode ?? 'live');
  const token = useSettingsStore((s) => s.settings.p48Token);
  const [showSearch, setShowSearch] = useState(false);
  const [vodList, setVodList] = useState<VODItem[]>([]);
  const [liveList, setLiveList] = useState<VODItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [nextCursor, setNextCursor] = useState(0);
  const nextCursorRef = useRef(0); // 翻页游标 ref：避免自动翻页闭包读到旧游标重复拉同一页
  const [pageVersion, setPageVersion] = useState(0); // 每次拉取完成 +1：驱动自动翻页 effect 续链
  const [error, setError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [useWebPlayer, setUseWebPlayer] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 横屏/竖屏切换（仅旋转，独立于「全屏」沉浸；方向锁由下方统一 effect 处理）
  const [isLandscape, setIsLandscape] = useState(false);
  // 画面旋转（翻转）：0/90/180/270，每按一次步进 90°
  const [videoRotate, setVideoRotate] = useState(0);
  // 用户是否手动切过方向：手动后 onLoad 不再自动覆盖（尊重用户选择）
  const manualOrientRef = useRef(false);
  const [playing, setPlaying] = useState<{ url: string; urls: string[]; title: string; cover?: string; item: any; isLive: boolean; needsVlc: boolean; resolving?: boolean } | null>(null);
  // 续播位置：打开回放时读取上次进度，播放中由 WebView 回传进度落盘
  const [webResumeTime, setWebResumeTime] = useState(0);
  const [giftVisible, setGiftVisible] = useState(false);
  const [gifts, setGifts] = useState<any[]>([]);
  const [selectedGift, setSelectedGift] = useState<any | null>(null);
  const [giftNum, setGiftNum] = useState('1');
  const [giftStatus, setGiftStatus] = useState('');
  const [balance, setBalance] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [rankVisible, setRankVisible] = useState(false);
  const [rankRows, setRankRows] = useState<any[]>([]);

  // 续播 key 用稳定 id（liveId）而非播放 URL：URL 换线路/带签名/拼接参数会变，
  // 用 URL 做 key 会导致同一视频换线路后续播进度丢失
  const resumeKey = React.useMemo(
    () => String(playing?.item?.liveId || playing?.item?.id || playing?.url || ''),
    [playing],
  );

  // 打开回放时读取上次观看进度，用于 WebView 续播
  useEffect(() => {
    if (!playing?.url) {
      setWebResumeTime(0);
      return;
    }
    let alive = true;
    getResumePosition(resumeKey)
      .then((t) => { if (alive) setWebResumeTime(t); })
      .catch((e) => { logWarn('读取续播进度失败: ' + errorMessage(e), 'MediaScreen.resume'); });
    return () => { alive = false; };
  }, [resumeKey]);

  // 拉取/轮询弹幕并解析；失败静默，不拖垮播放
  useEffect(() => {
    if (!playing) {
      setDanmaku([]);
      setShowDanmaku(false);
      return;
    }
    const lid = String(playing.item?.liveId || playing.item?.id || '');
    if (!lid) { setDanmaku([]); setShowDanmaku(false); return; }
    let alive = true;
    const seenMsg = new Set<string>();
    const collect = (infos: any[]): DanmakuItem[] => {
      const flat: DanmakuItem[] = [];
      for (const b of infos) {
        const parsed = parseDanmaku(b.content);
        if (parsed.length) flat.push(...parsed);
        else flat.push({ time: Number(b.time) || 0, text: String(b.content || ''), ...(b.user ? { nick: b.user } : {}) });
      }
      let items = flat.filter((d) => d && d.text) as DanmakuItem[];
      if (!items.length) return items;
      // 时间轴归一化：覆盖接口返回的多种 time 形态，保证弹幕能对上视频相对进度飘出来
      //  1) 毫秒时间戳（>1e6）：先转秒
      //  2) 绝对秒时间戳（>1e7，远超任何视频时长）：以最早弹幕为 0 做相对偏移
      //  3) 全 0 / 异常（maxT<=0）：按序均匀分配，至少保证弹幕能飘
      const rangeOf = (arr: DanmakuItem[]) => arr.reduce(
        (acc, d) => ({ max: Math.max(acc.max, d.time), min: Math.min(acc.min, d.time) }),
        { max: 0, min: Infinity },
      );
      let { max: maxT, min: minT } = rangeOf(items);
      if (maxT > 1e6) {
        items.forEach((d) => { d.time = d.time / 1000; });
        ({ max: maxT, min: minT } = rangeOf(items));
      }
      if (maxT > 1e7) {
        const base = minT;
        items.forEach((d) => { d.time = d.time - base; });
        ({ max: maxT } = rangeOf(items));
      }
      if (maxT <= 0) {
        items.forEach((d, i) => { d.time = i * 1.2; });
      }
      items.sort((a, b) => a.time - b.time);
      return items;
    };
    if (playing.isLive) {
      // 直播：轮询 barrage/list 累积实时弹幕
      const poll = async () => {
        try {
          const infos = await pocketApi.getLiveBarrage(lid);
          if (!alive) return;
          const items = collect(infos);
          if (!items.length) return;
          setDanmaku((prev) => {
            const merged = [...prev];
            for (const it of items) {
              const key = it.nick ? `${it.nick}:${it.text}` : it.text;
              if (!seenMsg.has(key)) {
                seenMsg.add(key);
                // 长播防泄漏：去重集超出窗口后重建（最多短暂放行少量重复，避免无限增长直至 OOM）
                if (seenMsg.size > 3000) {
                  seenMsg.clear();
                  seenMsg.add(key);
                }
                merged.push(it);
              }
            }
            merged.sort((a, b) => a.time - b.time);
            return merged.slice(-800);
          });
          setShowDanmaku(true);
        } catch {}
      };
      poll();
      const id = setInterval(poll, 5000);
      return () => { alive = false; clearInterval(id); };
    }
    // 回放：从 LRC 文件拉取（参考 pocket48_lite：录播弹幕在 getLiveOne 的
    // content.msgFilePath 指向的 LRC 文件，而非 barrage/list；格式 [hh:mm:ss.fff]昵称\t内容，
    // 已由 parseDanmaku 解析为「秒」对上 playbackTime）
    pocketApi.getLiveLrc(lid)
      .then((text) => {
        if (!alive) return;
        if (!text) {
          setDanmaku([]);
          setShowDanmaku(false);
          showToast(t('该视频暂无弹幕'));
          return;
        }
        const items = parseDanmaku(text);
        setDanmaku(items);
        setShowDanmaku(items.length > 0);
        showToast(items.length > 0 ? t('弹幕 {count} 条', { count: items.length }) : t('该视频暂无弹幕'));
      })
      .catch(() => { if (alive) setDanmaku([]); });
    return () => { alive = false; };
  }, [playing?.url, playing?.isLive]);

  // R1: 弹幕时间轴统一由 playerStore.position 驱动（统一播放器接管后原生 onProgress 实时上报，
  //     无需本地插值；旧 useWebPlayer 插值路径已随内核切换删除）
  const [rankStatus, setRankStatus] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [announceVisible, setAnnounceVisible] = useState(false);
  const [announceExpanded, setAnnounceExpanded] = useState(false);
  const loadingRef = useRef(false);
  const playingRef = useRef<typeof playing>(null);
  // v2.6: group filter + search
  const [groupId, setGroupId] = useState(0);
  const [search, setSearch] = useState('');
  // 弹幕：解析后的弹幕数组 + 是否显示 + 当前播放进度（驱动弹幕发射）
  const [danmaku, setDanmaku] = useState<DanmakuItem[]>([]);
  const [showDanmaku, setShowDanmaku] = useState(false);
  // 关注成员 id 集合：「关注」tag 实时筛选（60s 同步一次）
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [playbackTime, setPlaybackTime] = useState(0);
  // R1: 弹幕时钟 = 统一播放器上报的真实进度（live 也在播中持续推进，对齐 poll 弹幕时间轴）
  const danmakuClock = usePlayerStore((s) => s.position);
  const playerDanmakuOn = usePlayerStore((s) => s.danmakuOn);
  // 播放器控制（哔哩哔哩风格自定义控制条）
  const videoRef = useRef<any>(null);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  // 画中画（悬浮窗）状态同步：正在播放且未暂停时置位，切后台自动进悬浮窗
  useEffect(() => {
    // 应用内小窗已接管 PiP 标志时不覆盖（防小窗切后台不进悬浮窗）
    if (useMiniPlayerStore.getState().visible) return;
    setPipPlaying(!!playing && !paused && !useWebPlayer);
  }, [playing, paused, useWebPlayer]);
  // 搜索：选中成员后，搜索框转为「该成员的标题/日期」过滤
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [dateFilter, setDateFilter] = useState<Date | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showDanmakuSettings, setShowDanmakuSettings] = useState(false);
  const [moreVisible, setMoreVisible] = useState(false);
  // 播放器控制条（B站式沉浸：点击视频区显隐，播放中自动隐藏）
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  // 公告面板 top 偏移：顶栏可见时位于顶栏之下（不重叠），顶/底栏自动隐藏后平滑上滑贴近顶部
  const announceTopAnim = useRef(new Animated.Value(96)).current;
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(paused);
  const seekLockRef = useRef(0);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  const showControls = useCallback((autoHide = true) => {
    setControlsVisible(true);
    Animated.timing(controlsOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    // 顶栏可见 → 公告面板停在顶栏之下（top≈96）
    Animated.timing(announceTopAnim, { toValue: 96, duration: 180, useNativeDriver: true }).start();
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
    if (autoHide && !pausedRef.current) {
      hideControlsTimer.current = setTimeout(() => {
        setControlsVisible(false);
        Animated.timing(controlsOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start();
        // 顶/底栏自动隐藏 → 公告面板上滑贴近顶部（top≈12）
        Animated.timing(announceTopAnim, { toValue: 12, duration: 180, useNativeDriver: true }).start();
      }, 3000);
    }
  }, [controlsOpacity]);
  const toggleControls = useCallback(() => {
    if (controlsVisible) {
      setControlsVisible(false);
      Animated.timing(controlsOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start();
      Animated.timing(announceTopAnim, { toValue: 12, duration: 180, useNativeDriver: true }).start();
    } else {
      showControls();
    }
  }, [controlsVisible, showControls]);
  // 新视频载入即显示控制条，播放中 3 秒无操作自动隐藏（B站式沉浸）
  useEffect(() => { if (playing?.url) showControls(true); }, [playing?.url, showControls]);

  const GROUPS: { label: string; id: number; match: string }[] = [
    { label: '全部', id: 0, match: '' },
    { label: 'SNH48', id: 1, match: 'SNH48' },
    { label: 'BEJ48', id: 2, match: 'BEJ48' },
    { label: 'GNZ48', id: 3, match: 'GNZ48' },
    { label: 'CKG48', id: 4, match: 'CKG48' },
    { label: 'CGT48', id: 6, match: 'CGT48' },
  ];
  // 分组 chips：最前面加「关注」（id=-1，按关注成员 id 过滤）
  const groupChips: { label: string; id: number; match: string }[] = [
    { label: t('关注'), id: -1, match: '' },
    ...GROUPS,
  ];
  // 关注成员的昵称集合：录播/直播接口字段不一，id 匹配不到时按昵称兜底（大小写不敏感、去空白）
  const followedNames = useMemo(() => {
    const names = new Set<string>();
    members.forEach((m) => {
      const mid = String((m as any).id || (m as any).userId || '');
      if (mid && followedIds.has(mid) && m.ownerName) names.add(String(m.ownerName).trim().toLowerCase());
    });
    return names;
  }, [members, followedIds]);
  const list = useMemo(() => {
    let raw = tab === 'live' ? liveList : vodList;
    // 关注筛选：命中关注成员 id 或昵称 的在播直播/录播（id 字段因接口而异，昵称兜底保证录播也能打通）
    if (groupId === -1) {
      raw = raw.filter((item: any) => {
        const owner = String(
          item.userId || item.ownerId || item.memberId || item.userInfo?.userId || item.userInfo?.id
          || item.user?.userId || item.owner?.userId || item.memberInfo?.userId || item.hostId || item.account || ''
        );
        if (owner && followedIds.has(owner)) return true;
        const nick = String(item.nickname || item.nickName || '').trim().toLowerCase();
        return !!nick && followedNames.has(nick);
      });
    } else if (groupId !== 0) {
      const g = GROUPS.find((x) => x.id === groupId);
      if (g && g.match) {
        raw = raw.filter((item) =>
          (item.nickname || '').includes(g.match) ||
          (item.title || '').includes(g.match) ||
          (item.liveRoomTitle || '').includes(g.match)
        );
      }
    }
    // 选中成员时数据已在服务端按 userId 直查（见 doFetch），此处无需内存筛选；
    // 保留 selectedMember 依赖以在成员切换时触发重算（raw 源 vodList 已换为成员数据）。
    // 日历日期筛选：按录制日期(YYYY-MM-DD)精确过滤
    if (dateFilter) {
      const key = dateKeyOf(dateFilter);
      raw = raw.filter((item: any) => dateKeyOf(item.startTime) === key);
    }
    if (!search.trim()) return raw;
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/[^0-9]/g, '');
    return raw.filter((item) => {
      const { text, digits } = buildMediaSearchText(item);
      // 数字优先：时间搜索（2026-07-20 / 0720 / 7-20 / 2026/7/20 等自然输入都能命中）
      if (qDigits.length >= 3 && digits.includes(qDigits)) return true;
      if (text.includes(q)) return true;
      return false;
    });
  }, [tab, liveList, vodList, search, groupId, selectedMember, dateFilter, followedIds]);

  // 录播按日期分组（今天/昨天/更早），live tab 不用
  const vodRows = useMemo(() => {
    if (tab !== 'vod') return null;
    // 纯网格：不再按「今天/昨天/更早」分组（接口 startTime 为字符串毫秒，日期分组易出错），
    // 时间直接显示在卡片内（带年份、缩小字体适配），列表按时间倒序连续排列
    const flat: { type: 'header' | 'row'; key: string; title?: string; left?: any; right?: any }[] = [];
    for (let i = 0; i < list.length; i += 2) {
      flat.push({ type: 'row', key: `r-${i}`, left: list[i], right: list[i + 1] });
    }
    return flat;
  }, [tab, list]);

  // 成员联想：未选成员时，输入命中成员名/缩写则弹出选择框
  const memberHits = useMemo(() => {
    if (selectedMember || !search.trim()) return [];
    const q = search.trim().toLowerCase();
    return members.filter((m) => memberSearchText(m).includes(q)).slice(0, 8);
  }, [members, search, selectedMember]);
  const selectedGiftTotal = useMemo(
    () => (selectedGift ? giftCost(selectedGift) * (Number(giftNum) || 1) : 0),
    [giftNum, selectedGift],
  );

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // v2.6: auto-play when navigated from room with playLiveId/playUrl
  useEffect(() => {
    const lid = route.params?.playLiveId;
    const directUrl = route.params?.playUrl;
    if (!lid && !directUrl) return;
    const isLive = route.params?.mode !== 'vod';
    (async () => {
      try {
        if (directUrl) {
          // 房间页已解析出可用地址：直接播放，不再二次请求接口
          const title = route.params?.playTitle || t('直播');
          const cover = route.params?.playCover || '';
          setPlaying({
            url: directUrl,
            urls: [directUrl],
            title,
            cover: normalizeUrl(cover),
            item: { liveId: lid || '', title, liveCover: cover },
            isLive,
            needsVlc: streamNeedsProxy(directUrl),
          });
          if (!isLive && tab !== 'vod') switchTab('vod');
          return;
        }
        if (!lid) return;
        // 点击即进播放器：先以「解析中」状态渲染播放器 shell，解析完成后无缝播放；
        // 失败在播放器内提示（含重试），不再停留在列表页干等或弹窗
        const guessTitle = route.params?.playTitle || t('直播');
        const guessCover = route.params?.playCover || '';
        setPlaying({
          url: '',
          urls: [],
          title: guessTitle,
          cover: normalizeUrl(guessCover),
          item: { liveId: lid, title: guessTitle, liveCover: guessCover },
          isLive,
          needsVlc: false,
          resolving: true,
        });
        // 解析：详情接口 → 公开详情 → 直播/录播列表按 liveId 查找（多层兜底）
        let detail: any = await pocketApi.getLiveOne(lid).catch(() => null);
        if (!detail) detail = await pocketApi.getOpenLiveOne(lid).catch(() => null);
        const item = (detail?.content || detail?.data || detail || {}) as any;
        let urls = pickPlayableUrls(item, isLive);
        if (!urls.length) {
          const found = await findLiveItemInLists(lid, isLive).catch(() => null);
          if (found) urls = pickPlayableUrls(found, isLive);
        }
        const url = urls[0] || '';
        if (!url) {
          setPlayerError(t('未解析到播放地址，请点击重试。'));
          setPlaying((p) => (p ? { ...p, resolving: false } : p));
          return;
        }
        const title = route.params?.playTitle || item.title || item.liveRoomTitle || t('直播');
        const cover = route.params?.playCover || item.liveCover || item.coverPath || '';
        setPlaying({
          url,
          urls,
          title,
          cover: normalizeUrl(cover),
          item: { ...item, liveId: lid, title, liveCover: cover },
          isLive,
          needsVlc: streamNeedsProxy(url),
          resolving: false,
        });
        // Switch tab to match mode
        if (!isLive && tab !== 'vod') switchTab('vod');
      } catch (e) {
        setPlayerError(errorMessage(e));
        setPlaying((p) => (p ? { ...p, resolving: false } : p));
      }
    })();
  }, [route.params?.playLiveId, route.params?.playUrl, route.params?.playNonce]);

  useEffect(() => {
    setTabBarHidden(!!playing);
    return () => setTabBarHidden(false);
  }, [playing, setTabBarHidden]);

  // 从房间导航进来时，房间页失焦会把 tabBarHidden 重置为 false；
  // 这里在获得焦点时兜底一次，确保播放状态下底部导航始终隐藏。
  useFocusEffect(useCallback(() => {
    if (playing) setTabBarHidden(true);
  }, [playing, setTabBarHidden]));

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!playing) return false;
      setIsFullscreen(false);
      setIsLandscape(false);
      setLiveImmersiveMode(false);
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      setPlaying(null);
      return true;
    });
    return () => subscription.remove();
  }, [playing]);

  const doFetch = useCallback(async (mode: 'live' | 'vod', cursor = 0, append = false, silent = false, userId?: string | number) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!silent) setLoading(true);
    setError('');
    try {
      let finalCursor = cursor;
      // 官方坑（桌面基线 fetchLiveList / 48tools 同款修复）：next=0 时带 userId 查询拿不到数据，
      // 需先发一次不带 userId 的请求取列表最新 liveId 作为 next，再按成员直查。
      if (userId !== undefined && userId !== null && userId !== '' && Number(cursor) === 0) {
        const probe = await pocketApi.getLiveList({ next: 0, record: mode === 'vod', debug: true }).catch(() => null);
        if (probe) {
          const probeList = normalizeLiveList(probe);
          const probeNext = Number((probe as any)?.content?.next ?? (probe as any)?.data?.next ?? 0) || 0;
          if (probeList[0]?.liveId) finalCursor = Number(probeList[0].liveId) || probeNext || 0;
          else if (probeNext) finalCursor = probeNext;
        }
      }
      const res = await pocketApi.getLiveList({ next: finalCursor, record: mode === 'vod', debug: true, userId });
      const next = normalizeLiveList(res);
      const nextToken = Number((res as any)?.content?.next ?? (res as any)?.data?.next ?? (res as any)?.next ?? 0) || 0;
      setNextCursor(nextToken);
      nextCursorRef.current = nextToken; // 同步 ref：翻页用最新游标，避免闭包读到旧值重复拉同一页
      // 翻页终止条件：本页有数据 且 游标确有前进（nextToken>0 且不等于本次请求的 cursor）。
      // 加 `nextToken !== cursor` 兜底，防止接口返回不变游标却持续吐相同数据导致的死循环。
      setHasMore(next.length > 0 && nextToken > 0 && nextToken !== cursor);
      if (mode === 'live') setLiveList((prev) => (append ? mergeUniqueLiveItems(prev, next) : next));
      else setVodList((prev) => (append ? mergeUniqueLiveItems(prev, next) : next));
    } catch (err) {
      setError(errorMessage(err));
      setHasMore(false);
    } finally {
      loadingRef.current = false;
      if (!silent) setLoading(false);
      setRefreshing(false);
      setPageVersion((v) => v + 1); // 通知自动翻页 effect：本次拉取完成，可继续下一页
    }
  }, []); // stable ref, reads groupId from groupIdRef

  const reloadList = useCallback(() => {
    // 刷新时保留当前列表内容，避免列表被清空导致骨架屏闪一下；
    // 仅当列表本就为空（首屏）时才走骨架屏逻辑。
    setNextCursor(0); setHasMore(true);
    doFetch(tab, 0);
  }, [doFetch, tab]);

  // initial load
  useEffect(() => { doFetch(tab, 0); }, [doFetch, tab]);

  // 选中成员时切到「回放」并重置列表，立即触发首屏加载。
  // 用 setTimeout(0) 让上面的 setState 先提交，避免读到切换前的旧 tab；
  // 覆盖「已在 vod tab 时初始加载 effect 不触发」以及「切 tab 时 loadingRef 把自动翻页挡掉」两种情况。
  // 成员检索改为服务端 userId 直查（对齐桌面基线/48tools）：getLiveList 带 userId 即返回该成员
  // 完整直播/录播，替代「全量加载全局列表再前端筛选」——旧实现只能筛到已加载页面内的数据，
  // 成员较早的录播永远搜不到。
  useEffect(() => {
    if (!selectedMember) return;
    const mid = String(selectedMember.id || (selectedMember as any).userId || (selectedMember as any).memberId || '');
    setVodList([]); setNextCursor(0); setHasMore(true);
    setTab('vod');
    const id = setTimeout(() => doFetch('vod', 0, false, false, mid), 0);
    return () => clearTimeout(id);
  }, [selectedMember, doFetch]);

  // 退出成员筛选（selectedMember 清空）时恢复全局录播列表：成员模式下 vodList 存的是该成员数据，
  // 不恢复会导致后续「全部/团/关注」看到的是残留的成员列表。
  const prevMemberRef = useRef<any>(null);
  useEffect(() => {
    if (prevMemberRef.current && !selectedMember && tab === 'vod') {
      setVodList([]); setNextCursor(0); setHasMore(true);
      doFetch('vod', 0);
    }
    prevMemberRef.current = selectedMember;
  }, [selectedMember, doFetch, tab]);

  // 搜索 / 选中成员 / 「关注」tag：自动翻页补齐更多数据（关注录播常分散在多页，只加载首屏会找不到）
  // 未筛选时（无搜索、无成员、非关注）不自动翻页，仅靠用户上滑 onEndReached 触发。
  const filterPages = useRef(0);
  // 并行翻页可用性（state 驱动：false 时本 effect 接管游标链）
  const [pageModeOk, setPageModeOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (loadingRef.current || loading) return;
    const haveFilter = !!search.trim() || !!selectedMember || groupId === -1;
    if (!haveFilter || !hasMore) return;
    if (selectedMember && tab !== 'vod') return; // 成员检索固定在录播页，等 tab 切到 vod 再翻
    // 「关注」录播：并行扫描进行中不重复走游标链；扫描完成后从最深处继续兜底补更老录播
    if (groupId === -1 && tab === 'vod' && pageModeOk !== false && !scanDoneRef.current) return;
    // 「关注」tag 翻页上限：最多补 60 页（1200 条），覆盖被新录播挤到深处的关注成员；静默加载不闪控件
    if (groupId === -1) {
      if (filterPages.current >= 60) return;
      filterPages.current += 1;
    }
    const id = setTimeout(() => loadMore(groupId === -1), 60);
    return () => clearTimeout(id);
  }, [search, selectedMember, hasMore, loading, tab, groupId, pageVersion, pageModeOk]);

  // 筛选条件变化时重置翻页计数
  useEffect(() => {
    filterPages.current = 0;
  }, [search, selectedMember, groupId]);

  // 「关注」录播快速并行扫描：
  // 实测口袋 getLiveList 的游标 = 上一页最后一条的 liveId，且 liveId 随时间近似线性增长（约 2^22/ms），
  // 因此可按「时间分片」一次性并行拉取近 48 小时的录播（每片约一页），再以相邻真实边界的中点闭合间隙；
  // 游标不可跳（探针失败）时自动退回上面的游标链。
  const followLoadingRef = useRef(false);
  const [followFetching, setFollowFetching] = useState(false);
  const scanDoneRef = useRef(false);
  // 关注成员录播：并发按 userId 服务端直查（用户指定实现）——
  // 不再"扫描全局流 48h 再前端筛选"（慢且命中率低），直接对每个关注成员的 userId 调
  // getLiveList({ userId }) 拿 TA 专属录播，合并去重。桌面基线/48tools 同款能力。
  const loadFollowVodFast = useCallback(async () => {
    if (followLoadingRef.current || groupId !== -1 || tab !== 'vod') return;
    if (!useSettingsStore.getState().settings.p48Token) { scanDoneRef.current = true; return; }
    followLoadingRef.current = true;
    setFollowFetching(true);
    const t0 = Date.now();
    const PAGE_SIZE = 100;
    const startTimeOf = (it: any) => Number(it?.startTime || it?.ctime || 0);
    const merge = (items: any[]) => setVodList((prev) => {
      const merged = mergeUniqueLiveItems(prev, items);
      return merged.sort((a: any, b: any) => (startTimeOf(b) - startTimeOf(a)) || 0);
    });
    try {
      // 1) 关注成员 id 列表
      const idsRes = await pocketApi.getFollowedIds().catch(() => null);
      const ids = idsRes ? unwrapList(idsRes, ['content.data', 'content', 'data', 'list']).map(String) : [];
      // 2) 从成员库提取关注成员 userId（多候选：id/userId/memberId）
      const userIds: string[] = [];
      const seen = new Set<string>();
      for (const m of members) {
        const mid = String((m as any).id || (m as any).userId || (m as any).memberId || '');
        if (mid && ids.includes(mid) && !seen.has(mid)) { seen.add(mid); userIds.push(mid); }
      }
      // 3) 并发按 userId 直查（每批 8 并发，防瞬间打爆接口）
      if (!userIds.length) {
        // 关注列表为空/未匹配到成员：兜底拉全局最新一页，避免"暂无"误导
        const page1 = await pocketApi.getLiveList({ next: 0, record: true, debug: true, size: PAGE_SIZE }).catch(() => null);
        if (page1) merge(normalizeLiveList(page1));
        scanDoneRef.current = true;
        return;
      }
      const BATCH = 8;
      for (let i = 0; i < userIds.length; i += BATCH) {
        if (groupId !== -1) return;
        const chunk = userIds.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          chunk.map((uid) => pocketApi.getLiveList({ next: 0, record: true, debug: true, size: PAGE_SIZE, userId: uid })),
        );
        let got = 0;
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const items = normalizeLiveList(r.value);
          if (items.length) { got += 1; merge(items); }
        }
        setPageVersion((v) => v + 1);
        console.info(`[FollowVod] userId 直查批次 ${i / BATCH + 1}/${Math.ceil(userIds.length / BATCH)} 命中成员=${got}/${chunk.length}`);
      }
      console.info(`[FollowVod] userId 并发直查完成 members=${userIds.length} 耗时=${Date.now() - t0}ms`);
    } catch (e) {
      console.warn('[FollowVod] userId 直查失败，退回游标链', e);
      setPageModeOk(false);
    } finally {
      followLoadingRef.current = false;
      setFollowFetching(false);
      scanDoneRef.current = true;
    }
  }, [groupId, tab, members]);

  // 进入「关注」录播视图或下拉刷新后触发并行扫描
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (groupId === -1 && tab === 'vod' && token) {
      scanDoneRef.current = false;
      loadFollowVodFast();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, tab, refreshTick]);

  // 关注成员 id 同步（60s 一次；state 声明在组件上部供「关注」tag 筛选使用）
  useEffect(() => {
    let alive = true;
    const load = () => pocketApi.getFollowedIds().then((res) => {
      if (!alive) return;
      const ids = unwrapList(res, ['content.data', 'content', 'data', 'list']).map(String);
      setFollowedIds(new Set(ids));
    }).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // 直播列表实时自动刷新：浏览直播 tab 且未播放时每 60s 静默重拉（关注成员开播即时可见）
  useEffect(() => {
    if (tab !== 'live' || playing) return;
    const id = setInterval(() => { doFetch('live', 0, false, true); }, 60000);
    return () => clearInterval(id);
  }, [tab, playing, doFetch]);

  useEffect(() => () => {
    setLiveImmersiveMode(false);
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);

  // 切到后台时复位横屏锁（防退到桌面/其它 App 仍锁横屏）；
  // 回到前台时按当前播放状态重新锁定（后台复位后上方 effect 不会再触发，需在此补锁）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      } else if (playing) {
        const wantLandscape = isFullscreen || isLandscape;
        ScreenOrientation.lockAsync(
          wantLandscape ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
        ).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [playing, isFullscreen, isLandscape]);

  const closePlayer = () => {
    setIsFullscreen(false);
    setIsLandscape(false);
    setLiveImmersiveMode(false);
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    setPlaying(null);
    setAnnouncement('');
    setAnnounceVisible(false);
    setAnnounceExpanded(false);
    // fromRoom 直达（房间点开）：关闭播放器 = 返回房间
    if (route.params?.fromRoom) navigation.goBack();
  };

  // 应用内小窗：当前播放交棒给悬浮小窗（小窗独立 Video 实例续播），关掉大播放器
  const handleMiniPlayer = useCallback(() => {
    const cur = playing;
    if (!cur?.url) return;
    const lower = String(cur.url || '').toLowerCase();
    const needsNativeLive = !!cur.isLive && (lower.startsWith('rtmp://') || lower.includes('.flv'));
    if (needsNativeLive) {
      // RTMP / FLV 直播流在小窗（原生 LiveExoView 小尺寸 SurfaceView）无法稳定播放，
      // 保持全屏观看，不进入小窗。
      setIsFullscreen(true);
      return;
    }
    useMiniPlayerStore.getState().open({
      url: cur.url,
      title: cur.title,
      cover: cur.cover,
      isLive: !!cur.isLive,
      position: playbackTime,
      backTo: {
        mode: cur.isLive ? 'live' : 'vod',
        playUrl: cur.url,
        playTitle: cur.title,
        playCover: cur.cover,
      },
    });
    closePlayer();
  }, [playing, playbackTime, closePlayer, setIsFullscreen]);

  // v2.6: came from room (explicit fromRoom flag) → hide list, back goes to room
  // 注意：不能仅凭 playLiveId 判断——首页直播卡跳转也带 playLiveId，
  // 无 fromRoom 标记时保持列表页（不误切 Rooms tab）
  // fromRoom 直达：不再"首帧未播放即弹回房间"——此前 playing 初始为 null（解析中）时
  // useEffect 立即 navigate('Rooms')，导致房间点录播/直播「第一次必进不去播放器」。
  // 播放失败由播放器错误态 + 重试呈现；关闭时 closePlayer 负责 goBack 回房间。
  const fromRoom = !!route.params?.fromRoom;

  const refreshAnnouncement = async () => {
    if (!playing || !playing.isLive) return;
    try {
      const detail = await pocketApi.getLiveOne(playing.item.liveId).catch(() => null);
      const detail2 = !detail ? await pocketApi.getOpenLiveOne(playing.item.liveId).catch(() => null) : null;
      const d = (detail || detail2 || {}) as any;
      const annText = d?.content?.announcement || d?.announcement || d?.data?.announcement || '';
      setAnnouncement(annText || t('暂无公告'));
      setAnnounceVisible(true);
      setAnnounceExpanded(true);
    } catch {
      setAnnouncement(t('公告加载失败'));
      setAnnounceVisible(true);
      setAnnounceExpanded(true);
    }
  };

  const switchTab = (next: 'live' | 'vod') => {
    setTab(next);
    setNextCursor(0);
    setHasMore(true);
    // rely on useEffect to trigger fetch
  };

  // 从首页快捷入口二次进入时，React Navigation 可能复用 MediaScreen 实例，
  // useState 初始值不会重算 → 手动切过的 tab 残留。这里用 params.mode 兜底同步，
  // 让用户「点回放进去就是录播、点直播进去就是直播」，与离开前停留的 tab 无关。
  useEffect(() => {
    const mode = route.params?.mode;
    if (mode === 'live' || mode === 'vod') {
      setTab((prev) => (prev === mode ? prev : mode));
      setNextCursor(0);
      setHasMore(true);
    }
  }, [route.params?.mode]);

  const refreshList = () => {
    setRefreshing(true);
    reloadList();
    // 关注录播下拉刷新后重新触发并行翻页（否则只剩第一页）
    setRefreshTick((v) => v + 1);
  };

  const loadMore = (silent = false) => {
    if (loading || loadingRef.current || !hasMore) return;
    const mid = selectedMember ? String(selectedMember.id || (selectedMember as any).userId || (selectedMember as any).memberId || '') : undefined;
    doFetch(tab, nextCursorRef.current, true, silent, mid || undefined);
  };

  const startPlay = async (item: VODItem) => {
    setError('');
    setPlayerError('');
    setUseWebPlayer(false);
    setIsFullscreen(false);
    setIsLandscape(false);
    setVideoRotate(0);
    manualOrientRef.current = false;
    setLiveImmersiveMode(false);
    setPaused(false);
    setDuration(0);
    setPlaybackTime(0);
    setLoading(true);
    // 点击即进播放器：解析完成前先以「解析中」状态渲染播放器 shell（loading 提示），
    // 解析完成后无缝替换为真实播放；不再让用户停留在列表页干等或失败弹窗
    setPlaying({
      url: '',
      urls: [],
      title: item.title || item.liveRoomTitle || t('直播 / 回放'),
      cover: item.liveCover || item.coverPath,
      item,
      isLive: tab === 'live',
      needsVlc: false,
      resolving: true,
    });
    try {
      let urls = pickPlayableUrls(item, tab === 'live');
      let detail: any = item;
      const initialUrl = urls[0] || '';
      if (initialUrl) {
        setPlaying({
          url: initialUrl,
          urls,
          title: item.title || item.liveRoomTitle || t('直播 / 回放'),
          cover: item.liveCover || item.coverPath,
          item,
          isLive: tab === 'live',
          needsVlc: streamNeedsProxy(initialUrl),
        });
      }
      if (item.liveId) {
        detail = await pocketApi.getLiveOne(item.liveId).catch(() => null);
        urls = [...pickPlayableUrls(detail, tab === 'live'), ...urls];
        const d = (detail || {}) as any;
        const annText = d?.content?.announcement || d?.announcement || d?.data?.announcement || '';
        if (annText) {
          setAnnouncement(annText);
          setAnnounceVisible(true);
        }
        else {
          const detail2 = await pocketApi.getOpenLiveOne(item.liveId).catch(() => null);
          if (detail2) {
            const d2 = detail2 as any;
            const annText2 = d2?.content?.announcement || d2?.announcement || d2?.data?.announcement || '';
            if (annText2) { setAnnouncement(annText2); setAnnounceVisible(true); setAnnounceExpanded(false); }
          }
        }
        if (!urls.filter(Boolean).length) {
          detail = await pocketApi.getOpenLiveOne(item.liveId).catch(() => null);
          urls = [...pickPlayableUrls(detail, tab === 'live'), ...urls];
        }
      }
      urls = Array.from(new Set(urls.filter(Boolean)));
      const baseUrl = urls[0] || '';
      if (!baseUrl) {
        // 播放器内提示（播放器已进入，用户可见错误与重试），不再只停留在列表页
        setPlayerError(t('未解析到播放地址，可点击重试'));
        setPlaying((p) => (p ? { ...p, resolving: false } : p));
        return;
      }
      setPlaying({
        url: baseUrl,
        urls,
        title: item.title || item.liveRoomTitle || t('直播 / 回放'),
        cover: item.liveCover || item.coverPath,
        item: { ...item, ...(detail?.content || detail?.data || detail) },
        isLive: tab === 'live',
        needsVlc: streamNeedsProxy(baseUrl),
        resolving: false,
      });
    } catch (err) {
      setError(errorMessage(err));
      setPlayerError(errorMessage(err));
      setPlaying((p) => (p ? { ...p, resolving: false } : p));
    } finally {
      setLoading(false);
    }
  };

  const openGiftPanel = async (source = playingRef.current || playing) => {
    if (!source?.item?.liveId) {
      setGiftStatus(t('当前直播缺少 liveId，不能送礼'));
      setGiftVisible(true);
      return;
    }
    setGiftVisible(true);
    setGiftStatus('');
    setSelectedGift(null);
    try {
      const [giftRes, moneyRes] = await Promise.all([
        pocketApi.getGiftList(String(source.item.liveId)),
        pocketApi.getUserMoney().catch(() => null),
      ]);
      const next = normalizeGiftList(giftRes);
      setGifts(next);
      setBalance(moneyRes?.content?.moneyTotal !== undefined ? String(moneyRes.content.moneyTotal) : '');
      setGiftStatus(next.length ? t('已加载 {count} 个礼物', { count: next.length }) : t('礼物列表为空'));
    } catch (err) {
      setGifts([]);
      setGiftStatus(t('加载礼物失败：{error}', { error: errorMessage(err) }));
    }
  };

  const sendGift = async () => {
    if (!playing || !selectedGift) {
      setGiftStatus(t('请先选择礼物'));
      return;
    }
    const num = Math.max(1, Math.floor(Number(giftNum) || 1));
    const targetUserId = acceptUserId(playing.item);
    if (!targetUserId) {
      setGiftStatus(t('无法获取主播 ID，不能送礼'));
      return;
    }
    setGiftStatus(t('正在发送...'));
    try {
      await pocketApi.sendGift({
        giftId: String(selectedGift.giftId || selectedGift.id),
        liveId: String(playing.item.liveId),
        acceptUserId: targetUserId,
        giftNum: num,
      });
      setGiftStatus(t('已送出 {num} 个 {giftName}', { num, giftName: giftName(selectedGift) }));
      const money = await pocketApi.getUserMoney().catch(() => null);
      if (money?.content?.moneyTotal !== undefined) setBalance(String(money.content.moneyTotal));
    } catch (err) {
      setGiftStatus(t('送礼失败：{error}', { error: errorMessage(err) }));
    }
  };

  const openRankPanel = async (source = playingRef.current || playing) => {
    if (!source?.item?.liveId) {
      setRankRows([]);
      setRankStatus(t('当前直播缺少 liveId，不能获取贡献榜'));
      setRankVisible(true);
      return;
    }
    setRankVisible(true);
    setRankStatus('');
    try {
      const res = await pocketApi.getLiveRank(String(source.item.liveId));
      const rows = normalizeLiveRank(res);
      setRankRows(rows);
      if (rows.some((row, index) => row.userId && (!row.avatar || rankNameIsFallback(row, index)))) {
        setRankStatus(t('正在补充 {count} 位贡献用户资料...', { count: rows.length }));
        const enriched = await Promise.all(rows.map(async (row, index) => {
          if (!row.userId || (row.avatar && !rankNameIsFallback(row, index))) return row;
          try {
            const profile = profileFromUserRes(await pocketApi.getUserProfile(String(row.userId)));
            return { ...row, name: profile.name || row.name, avatar: profile.avatar || row.avatar };
          } catch {
            return row;
          }
        }));
        setRankRows(enriched);
        setRankStatus(enriched.length ? t('已加载 {count} 位贡献用户', { count: enriched.length }) : t('贡献榜为空'));
      } else {
        setRankStatus(rows.length ? t('已加载 {count} 位贡献用户', { count: rows.length }) : t('贡献榜为空'));
      }
    } catch (err) {
      setRankRows([]);
      setRankStatus(t('贡献榜加载失败：{error}', { error: errorMessage(err) }));
    }
  };

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('LivePlayerGiftRequested', () => {
      const current = playingRef.current;
      if (!current?.isLive) {
        setGiftStatus(t('当前没有可送礼的直播上下文'));
        setGiftVisible(true);
        return;
      }
      openGiftPanel(current);
    });
    return () => sub.remove();
  }, []);

  // 画面旋转（翻转）：旋转 90° 时交换容器宽高，使视频填满屏幕且不裁剪
  const screen = useWindowDimensions();
  const videoRotated = videoRotate === 90 || videoRotate === 270;
  const videoBoxW = videoRotated ? screen.height : screen.width;
  const videoBoxH = videoRotated ? screen.width : screen.height;
  const videoRotateDeg = `${videoRotate}deg`;

  // 按视频内容自动横/竖屏：横屏内容（宽>高）自动横屏，竖屏内容自动竖屏。
  // 用户手动切过方向（manualOrientRef）则不覆盖；每次新开视频重置标记。
  const autoOrient = useCallback((e: any) => {
    const ns = e?.naturalSize;
    if (!ns) return;
    const w = Number(ns.width) || 0;
    const h = Number(ns.height) || 0;
    // 同步 PiP 窗口比例（切后台悬浮窗跟随内容方向）
    if (w > 0 && h > 0) setPipAspect(w, h);
    if (manualOrientRef.current) return;
    if (w > 0 && h > 0 && w !== h) {
      setIsLandscape(w > h);
    }
  }, []);

  if (playing) {
    return (
      <View style={[styles.playerPage, isFullscreen && styles.playerPageFullscreen]}>
        {announceExpanded && announceVisible && announcement ? (
          <Animated.View style={[styles.announcePanel, { transform: [{ translateY: announceTopAnim }] }]}>
            <View style={styles.announcePanelTop}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <MaterialCommunityIcons name="bullhorn" size={15} color="#FFFFFF" style={{ marginRight: 5 }} />
                <Text style={styles.announcePanelTitle} numberOfLines={1}>{t('公告')}</Text>
              </View>
              <View style={styles.announcePanelBtns}>
                <TouchableOpacity onPress={refreshAnnouncement} style={styles.announceSmallBtn}>
                  <Text style={styles.announceSmallBtnText}>{t('刷新')}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setAnnounceExpanded(false)} style={styles.announceSmallBtn}>
                  <Text style={styles.announceSmallBtnText}>{t('收起')}</Text>
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView style={styles.announcePanelBody}>
              <Text style={styles.announcePanelText}>{announcement}</Text>
            </ScrollView>
          </Animated.View>
        ) : null}

        {/* 解析中/解析失败：url 未就绪时渲染播放器 shell 内提示（点击即进播放器的等待态） */}
        {!playing.url ? (
          <View style={styles.player}>
            {playerError ? (
              <View style={styles.resolvingWrap}>
                <Text style={styles.resolvingText}>{playerError}</Text>
                <TouchableOpacity
                  style={[styles.webFallbackBtn, { backgroundColor: palette.tint }]}
                  onPress={() => startPlay(playing.item)}
                >
                  <Text style={styles.webFallbackText}>{t('重试')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.resolvingWrap}>
                <ActivityIndicator size="large" color="#FFFFFF" />
                <Text style={styles.resolvingText}>{t('正在解析播放地址…')}</Text>
              </View>
            )}
          </View>
        ) : (
          /* 统一播放器（重写）：口袋直播/录播 → PlayerScreen
             - 内核路由：rtmp/flv → Exo / HLS/mp4 → Native / 失败可切 Web（flv.js+hls.js）
             - 候选线路 urls：失败自动切下一候选
             - 弹幕：children 插槽挂 DanmakuOverlay（poll/LRC 数据源保留在页面）
             - 倍速/续播/内核切换/礼物/贡献榜/公告/弹幕设置全部经 features + extraActions */
          <PlayerScreen
            source={{
              kind: playing.isLive ? 'live' : 'vod',
              url: playing.url,
              urls: playing.urls,
              liveId: String(playing.item?.liveId || playing.item?.id || ''),
              needsNativeExo: playing.needsVlc,
              headers: { 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)', Referer: 'https://h5.48.cn/', Origin: 'https://h5.48.cn' },
            }}
            meta={{ title: playing.title, cover: playing.cover }}
            danmaku={playing.isLive ? { type: 'poll', liveId: String(playing.item?.liveId || playing.item?.id || '') } : { type: 'lrc', lrcUrl: '' }}
            features={{ rate: !playing.isLive, danmaku: true, kernelSwitch: true, resume: !playing.isLive }}
            resumeAt={webResumeTime}
            extraActions={[
              ...(playing.isLive ? [{ key: 'gift', icon: 'gift', label: t('礼物'), onPress: () => openGiftPanel() }] : []),
              { key: 'rank', icon: 'trophy', label: t('贡献榜'), onPress: () => openRankPanel() },
              ...((announceVisible && announcement) ? [{ key: 'announce', icon: 'bullhorn', label: t('公告'), active: announceExpanded, onPress: () => setAnnounceExpanded((v) => !v) }] : []),
              { key: 'danmaku', icon: 'cog', label: t('弹幕设置'), onPress: () => setShowDanmakuSettings(true) },
              { key: 'pip', icon: 'picture-in-picture-bottom-right-outline', label: t('小窗'), onPress: handleMiniPlayer },
            ]}
            onClose={() => { setPipPlaying(false); closePlayer(); }}
            // 直播流地址有时效（wsSecret）：失败重试 = 重新解析（startPlay），而非重播同 URL
            onRetry={() => startPlay(playing.item)}
            persistent
          >
            <DanmakuOverlay
              danmaku={danmaku}
              currentTime={danmakuClock}
              visible={playerDanmakuOn && showDanmaku && !!playing}
              live={!!playing?.isLive}
            />
          </PlayerScreen>
        )}

        <Modal visible={giftVisible} transparent animationType="slide" onRequestClose={() => setGiftVisible(false)}>
          <View style={styles.modalShade}>
            <View style={[styles.giftPanel, { backgroundColor: palette.surface }]}>
              <View style={styles.giftHeader}>
                <Text style={[styles.giftTitle, { color: palette.label }]}>{t('直播送礼')}</Text>
                <TouchableOpacity onPress={() => setGiftVisible(false)} activeOpacity={0.8}>
                  <Text style={[styles.backBtnText, { color: palette.tint }]}>{t('关闭')}</Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.giftTip, { color: palette.danger }]}>{t('直播送礼主播看不到赠送，仅能统计贡献值')}</Text>
              <Text style={[styles.giftStatus, { color: palette.labelSecondary }]}>
                {balance ? `${t('余额：{balance} 鸡腿', { balance })} · ` : ''}{giftStatus}
              </Text>
              <ScrollView style={styles.giftGrid}>
                <View style={styles.giftGridInner}>
                  {gifts.map((gift) => {
                    const active = String(selectedGift?.giftId || selectedGift?.id) === String(gift.giftId || gift.id);
                    return (
                      <TouchableOpacity
                        key={String(gift.giftId || gift.id)}
                        style={[
                          styles.giftItem,
                          active && styles.giftItemActive,
                          { backgroundColor: active ? palette.tintSoft : palette.fill2, borderColor: active ? palette.tint : palette.hairline },
                        ]}
                        onPress={() => setSelectedGift(gift)}
                        activeOpacity={0.85}
                      >
                        {giftImage(gift) ? <Image source={{ uri: giftImage(gift) }} style={styles.giftImage} /> : <View style={[styles.giftImage, { backgroundColor: palette.fill3 }]} />}
                        <Text style={[styles.giftName, { color: palette.label }]} numberOfLines={1}>{giftName(gift)}</Text>
                        <Text style={[styles.giftCost, { color: palette.tint }]}>{t('{count} 鸡腿', { count: giftCost(gift) })}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
              <View style={styles.giftFooter}>
                <TextInput
                  style={[styles.giftNum, { color: palette.label, borderColor: palette.hairline, backgroundColor: palette.fill2 }]}
                  keyboardType="numeric"
                  value={giftNum}
                  onChangeText={setGiftNum}
                />
                <TouchableOpacity style={[styles.sendGiftBtn, { backgroundColor: palette.tint }]} onPress={sendGift} activeOpacity={0.85}>
                  <Text style={[styles.sendGiftText, { color: palette.onTint }]}>
                    {selectedGift ? t('送出 · {count}', { count: selectedGiftTotal }) : t('选择礼物')}
                  </Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={styles.rechargeBtn}
                onPress={() => {
                  setGiftVisible(false);
                  (navigation as any).navigate('RechargeScreen');
                }}
                activeOpacity={0.8}
              >
                <Text style={[styles.rechargeText, { color: palette.tint }]}>{t('余额不足？去充值鸡腿')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
        <Modal visible={rankVisible} transparent animationType="slide" onRequestClose={() => setRankVisible(false)}>
          <View style={styles.modalShade}>
            <View style={[styles.giftPanel, { backgroundColor: palette.surface }]}>
              <View style={styles.giftHeader}>
                <Text style={[styles.giftTitle, { color: palette.label }]}>{t('贡献榜')}</Text>
                <TouchableOpacity onPress={() => setRankVisible(false)} activeOpacity={0.8}>
                  <Text style={[styles.backBtnText, { color: palette.tint }]}>{t('关闭')}</Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.giftStatus, { color: palette.labelSecondary }]}>{rankStatus}</Text>
              <ScrollView style={styles.rankList}>
                {rankRows.map((row, index) => (
                  <View key={String(row.userId || row.id || index)} style={[styles.rankRow, { borderBottomColor: palette.hairline }]}>
                    <Text style={[styles.rankNo, { color: palette.tint }]}>{row.rank || index + 1}</Text>
                    {row.avatar ? <Image source={{ uri: row.avatar }} style={[styles.rankAvatar, { backgroundColor: palette.fill3 }]} /> : <View style={[styles.rankAvatar, { backgroundColor: palette.fill3 }]} />}
                    <View style={styles.rankInfo}>
                      <Text style={[styles.rankName, { color: palette.label }]} numberOfLines={1}>{row.name}</Text>
                      <Text style={[styles.rankValue, { color: palette.labelSecondary }]} numberOfLines={1}>{row.value ? t('贡献 {value}', { value: row.value }) : t('贡献用户')}</Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            </View>
          </View>
        </Modal>
        <DanmakuSettingsSheet visible={showDanmakuSettings} onClose={() => setShowDanmakuSettings(false)} />
      </View>
    );
  }

  return (
    <View style={[styles.container]}>
      <ScreenHeader
        title={tab === 'live' ? t('直播') : t('录播')}
        hideBack
        right={
          <TouchableOpacity onPress={refreshList} hitSlop={{ top: 8, bottom: 8 }} activeOpacity={0.7}>
            <MaterialCommunityIcons name="refresh" size={22} color={palette.label} />
          </TouchableOpacity>
        }
      />
      {/* 直播/录播分段控件 */}
      <View style={[styles.segmentWrap, { backgroundColor: palette.fill2, borderColor: palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]}>
        {(['live', 'vod'] as const).map((key) => {
          const active = tab === key;
          return (
            <TouchableOpacity
              key={key}
              style={[styles.segmentCell, active && { backgroundColor: palette.tint }]}
              onPress={() => switchTab(key)}
              activeOpacity={0.8}
            >
              <Text style={[styles.segmentText, { color: active ? palette.onTint : palette.labelSecondary, fontWeight: active ? '800' : '600' }]}>
                {key === 'live' ? t('直播') : t('录播')}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {/* 单行筛选：分组 chips + 搜索图标 */}
      <View style={styles.filterRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.groupRowContent}>
          {groupChips.map((item) => (
            <TouchableOpacity
              key={String(item.id)}
              style={[
                styles.groupChip,
                { backgroundColor: groupId === item.id ? palette.tint : palette.fill2 },
              ]}
              onPress={() => setGroupId(item.id)}
              activeOpacity={0.85}
            >
              <Text style={[styles.groupChipText, { color: groupId === item.id ? palette.onTint : palette.labelSecondary }]}>{t(item.label)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity
          onPress={() => setShowSearch((v) => !v)}
          style={[styles.searchToggle, { backgroundColor: showSearch ? palette.tint : palette.fill2 }]}
          hitSlop={{ top: 8, bottom: 8 }}
          activeOpacity={0.85}
        >
          <MaterialCommunityIcons name={showSearch ? 'close' : 'magnify'} size={18} color={showSearch ? palette.onTint : palette.labelSecondary} />
        </TouchableOpacity>
      </View>
      {/* 搜索展开行 */}
      {showSearch ? (
        <View style={styles.searchWrap}>
          {selectedMember ? (
            <TouchableOpacity onPress={() => setSelectedMember(null)} style={[styles.memberChip, { backgroundColor: palette.tint }]} activeOpacity={0.85}>
              <Text style={[styles.memberChipText, { color: palette.onTint }]}>{selectedMember.ownerName}</Text>
              <MaterialCommunityIcons name="close" size={16} color={palette.onTint} style={{ marginLeft: 6 }} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => setShowCalendar(true)} style={[styles.calBtn, dateFilter && styles.calBtnActive]} hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}>
            <MaterialCommunityIcons name="calendar-month" size={20} color={dateFilter ? palette.tint : palette.labelSecondary} />
          </TouchableOpacity>
          <TextInput
            style={[
              styles.searchInput,
              {
                backgroundColor: palette.surfaceGlassStrong,
                borderColor: selectedMember ? palette.tint : palette.innerStroke,
                color: palette.label,
              },
            ]}
            placeholder={selectedMember ? t('搜索该成员的标题 / 日期...') : t('搜索成员名、标题、时间...')}
            placeholderTextColor={palette.labelTertiary}
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
          />
          {search.trim() ? (
            <TouchableOpacity onPress={() => setSearch('')} style={styles.searchClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialCommunityIcons name="close-circle" size={18} color={palette.labelTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      {dateFilter ? (
        <View style={styles.dateChipRow}>
          <TouchableOpacity style={[styles.dateChip, { backgroundColor: palette.tintSoft, borderColor: palette.tint }]} onPress={() => setShowCalendar(true)} activeOpacity={0.85}>
            <MaterialCommunityIcons name="calendar-month" size={14} color={palette.tint} />
            <Text style={[styles.dateChipText, { color: palette.tint }]}>{dateKeyOf(dateFilter)}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDateFilter(null)} style={styles.dateChipClear} activeOpacity={0.85}>
            <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
          </TouchableOpacity>
        </View>
      ) : null}
      {memberHits.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.memberHits} contentContainerStyle={styles.memberHitsContent}>
          {memberHits.map((m) => (
            <TouchableOpacity
              key={m.id}
              style={[styles.memberHitChip, { backgroundColor: palette.fill2, borderColor: palette.hairline }]}
              onPress={() => { setSelectedMember(m); setSearch(''); }}
            >
              <Text style={[styles.memberHitText, { color: palette.labelSecondary }]}>{m.ownerName.split('-').pop()}</Text>
              {m.team ? <Text style={[styles.memberHitTeam, { color: palette.labelTertiary }]}>{m.team}</Text> : null}
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}

      {error ? (
        <View style={[styles.errorRow, { backgroundColor: palette.surfaceGlass, borderColor: palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]}>
          <Text style={[styles.error, { color: palette.labelSecondary }]} numberOfLines={2}>{error}</Text>
          <Button title={t('重试')} variant="tinted" size="sm" onPress={reloadList} />
        </View>
      ) : null}

      <CalendarSheet
        visible={showCalendar}
        initial={dateFilter}
        onSelect={(d) => { setDateFilter(d); setShowCalendar(false); }}
        onClose={() => setShowCalendar(false)}
      />

      <View style={{ flex: 1 }}>
        <PerfFlatList
          key={tab === 'vod' ? 'vod-1col' : 'live-2col'}
          // 直播页去宣传栏（banner）：统一双列网格，即使只有 1 条直播也保持双列
          data={tab === 'vod' ? (vodRows ?? []) as any : list}
          keyExtractor={(item: any, index) => String(item?.liveId || item?.key || index)}
          numColumns={tab === 'vod' ? 1 : 2}
          columnWrapperStyle={tab === 'vod' ? null : styles.vodGridRow}
          renderItem={({ item, index }) => {
            // 录播：组头 / 双卡行
            if (tab === 'vod') {
              if (item.type === 'header') {
                return (
                  <Text style={[styles.vodGroupTitle, { color: palette.labelTertiary }]}>{item.title}</Text>
                );
              }
              const renderCard = (it: any) => {
                if (!it) return <View style={styles.vodGridItem} />;
                const coverUrl = it.liveCover || it.coverPath;
                const meta = [it.nickname, formatTimestamp(it.startTime).slice(0, 16)].filter(Boolean).join(' · ');
                return (
                  <FadeInView duration={300} style={styles.vodGridItem}>
                    <TouchableOpacity
                      style={[styles.vodGridCard, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}
                      onPress={() => startPlay(it)}
                      activeOpacity={0.88}
                    >
                      <View style={[styles.vodGridCover, { backgroundColor: palette.fill3 }]}>
                        {coverUrl ? (
                          <Image source={{ uri: coverUrl }} style={styles.vodGridCoverImg} resizeMode="cover" />
                        ) : (
                          <View style={styles.vodGridFallback}>
                            <MaterialCommunityIcons name="video" size={30} color={palette.labelTertiary} />
                          </View>
                        )}
                        <View style={[styles.v2Badge, styles.vodGridType, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                          <MaterialCommunityIcons
                            name={it.liveType === 2 ? 'radio' : 'video'}
                            size={10}
                            color="#FFFFFF"
                            style={{ marginRight: 3 }}
                          />
                          <Text style={styles.v2BadgeText}>{it.liveType === 2 ? t('电台') : t('视频')}</Text>
                        </View>
                        {/* 右上角徽标：时长（开播时间已显示在标题下方 meta） */}
                        <View style={styles.vodBadgeRow}>
                          {it.endTime && it.startTime ? (
                            <View style={[styles.v2Badge, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                              <Text style={styles.v2BadgeText}>
                                {formatDuration((it.endTime - it.startTime) / 1000)}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        {/* 底部平滑渐变遮罩（替代两层色阶） */}
                        <LinearGradient
                          pointerEvents="none"
                          colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
                          style={styles.vodShade}
                        />
                        <View style={styles.vodInfoOverlay}>
                          <Text style={styles.vodTitleOverlay} numberOfLines={2}>
                            {it.title || it.liveRoomTitle || t('无标题')}
                          </Text>
                          {meta ? (
                            <Text style={styles.vodMetaOverlay} numberOfLines={1}>{meta}</Text>
                          ) : null}
                        </View>
                      </View>
                    </TouchableOpacity>
                  </FadeInView>
                );
              };
              return (
                <View style={styles.vodRow}>
                  {renderCard(item.left)}
                  {renderCard(item.right)}
                </View>
              );
            }
            // 直播：单卡网格
            const coverUrl = item.liveCover || item.coverPath;
            const meta = [item.nickname, formatTimestamp(item.startTime).slice(0, 16)].filter(Boolean).join(' · ');
            return (
              <FadeInView delay={index < 16 ? 80 + index * 30 : 0} duration={300} style={styles.vodGridItem}>
                <TouchableOpacity
                  style={[styles.vodGridCard, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}
                  onPress={() => startPlay(item)}
                  activeOpacity={0.88}
                >
                  <View style={[styles.vodGridCover, { backgroundColor: palette.fill3 }]}>
                    {coverUrl ? (
                      <Image source={{ uri: coverUrl }} style={styles.vodGridCoverImg} resizeMode="cover" />
                    ) : (
                      <View style={styles.vodGridFallback}>
                        <MaterialCommunityIcons name="video" size={30} color={palette.labelTertiary} />
                      </View>
                    )}
                    <View style={[styles.v2Badge, styles.vodGridType, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                      <MaterialCommunityIcons
                        name={item.liveType === 2 ? 'radio' : 'video'}
                        size={10}
                        color="#FFFFFF"
                        style={{ marginRight: 3 }}
                      />
                      <Text style={styles.v2BadgeText}>{item.liveType === 2 ? t('电台') : t('视频')}</Text>
                    </View>
                    {/* 右上角徽标：直播中/电台（开播时间已显示在标题下方 meta） */}
                    <View style={styles.vodBadgeRow}>
                      <View style={[styles.v2Badge, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                        {item.liveType === 2 ? (
                          <>
                            <MaterialCommunityIcons name="radio" size={11} color="#FFFFFF" style={{ marginRight: 3 }} />
                            <Text style={styles.v2BadgeText}>{t('电台')}</Text>
                          </>
                        ) : (
                          <>
                            <LivePulseDot />
                            <Text style={styles.v2BadgeText}>{t('直播中')}</Text>
                          </>
                        )}
                      </View>
                    </View>
                    {/* 底部平滑渐变遮罩（替代两层色阶） */}
                    <LinearGradient
                      pointerEvents="none"
                      colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
                      style={styles.vodShade}
                    />
                    <View style={styles.vodInfoOverlay}>
                      <Text style={styles.vodTitleOverlay} numberOfLines={2}>
                        {item.title || item.liveRoomTitle || t('无标题')}
                      </Text>
                      {meta ? (
                        <Text style={styles.vodMetaOverlay} numberOfLines={1}>{meta}</Text>
                      ) : null}
                    </View>
                  </View>
                </TouchableOpacity>
              </FadeInView>
            );
          }}
          ListEmptyComponent={
            loading ? (
              <MediaGridSkeleton />
            ) : groupId === -1 && !token ? (
              <LoginPrompt hint={t('查看关注成员的直播/录播需要登录')} />
            ) : followFetching ? (
              <View style={styles.followScanWrap}>
                <ActivityIndicator size="small" color={palette.tint} />
                <Text style={[styles.followScanText, { color: palette.labelSecondary }]}>
                  {t('正在翻找关注成员的录播…')}
                </Text>
              </View>
            ) : (
              <EmptyState
                icon="file-cancel-outline"
                title={search.trim() ? t('没有匹配的直播/录播') : t('暂无数据')}
              />
            )
          }
          onEndReached={() => loadMore(groupId === -1)}
          onEndReachedThreshold={0.35}
          refreshControl={
            <RefreshControl
              refreshing={loading && list.length > 0}
              onRefresh={refreshList}
              colors={[palette.tint]}
              tintColor={palette.tint}
            />
          }
          ListFooterComponent={null}
          contentContainerStyle={list.length === 0 ? { flex: 1 } : styles.listContent}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  tabRow: { flexDirection: 'row', gap: 8 },
  toolbarRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 8, alignItems: 'center' },
  headerSwitch: { fontSize: 13, fontWeight: '800', minWidth: 34, textAlign: 'right' },
  // 直播/录播分段控件
  segmentWrap: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 3,
    borderRadius: radii.sm,
  },
  segmentCell: {
    flex: 1,
    height: 34,
    borderRadius: radii.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { fontSize: 14 },
  filterRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 6 },
  searchToggle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  playerToolbar: { flexDirection: 'row', paddingHorizontal: 8, paddingTop: 44, paddingBottom: 6, backgroundColor: 'rgba(10,10,10,0.55)', alignItems: 'center' },
  playerToolbarCenter: { flex: 1, flexDirection: 'row', justifyContent: 'center', gap: 6, flexWrap: 'wrap' },
  glassBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.15)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  glassBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  footer: { paddingVertical: 14, alignItems: 'center' },
  followScanWrap: { paddingVertical: 60, alignItems: 'center' },
  followScanText: { marginTop: 10, fontSize: 13 },
  listContent: { paddingBottom: 120 },
  error: { flex: 1, fontSize: 12, lineHeight: 18 },
  errorRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, padding: 10, borderRadius: radiiAlias.input },
  playerPage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 999, elevation: 999, backgroundColor: '#000' },
  playerPageFullscreen: { backgroundColor: '#000' },
  backBtnText: { fontSize: 13, fontWeight: '800' },
  giftBtnText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  switchPlayerBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 14, backgroundColor: '#222', marginLeft: 4 },
  retryPlayerText: { color: '#fff' },
  announceHeaderBtn: { backgroundColor: 'rgba(251,114,153,0.25)' },
  announceHeaderText: { color: '#fb7299' },
  exitFullscreenBtn: { position: 'absolute', top: 28, right: 16, zIndex: 1001, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.62)' },
  exitFullscreenText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  announcePill: { alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: 'rgba(251,114,153,0.20)', borderWidth: 1, borderColor: 'rgba(251,114,153,0.3)', marginVertical: 4 },
  announcePillText: { color: '#fb7299', fontSize: 11, fontWeight: '700' },
  announcePanel: { position: 'absolute', top: 0, left: 10, right: 10, zIndex: 29, borderRadius: radiiAlias.card, backgroundColor: 'rgba(18,18,20,0.92)', borderWidth: 1, borderColor: 'rgba(251,114,153,0.32)', marginHorizontal: 0, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
  announcePanelTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(251,114,153,0.18)' },
  announcePanelTitle: { color: '#fff', fontSize: 13, fontWeight: '800', flex: 1 },
  announcePanelBtns: { flexDirection: 'row', gap: 8 },
  announceSmallBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: 'rgba(251,114,153,0.16)' },
  announceSmallBtnText: { color: '#fb7299', fontSize: 11, fontWeight: '700' },
  announcePanelBody: { paddingHorizontal: 14, paddingVertical: 10, maxHeight: 150 },
  announcePanelText: { color: '#f2f2f2', fontSize: 12.5, lineHeight: 21 },
  player: { flex: 1, backgroundColor: '#000' },
  nativeVideo: { flex: 1, backgroundColor: '#000' },
  vlcGate: { flex: 1, backgroundColor: '#050505', justifyContent: 'center', padding: 22 },
  vlcGateTitle: { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 12 },
  vlcGateText: { color: '#d8d8d8', fontSize: 14, lineHeight: 22, marginBottom: 14 },
  vlcGateUrl: { color: '#d8d8d8', fontSize: 11, lineHeight: 16, marginBottom: 18 },
  vlcPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '900' },
  vlcSecondaryBtn: { backgroundColor: '#222', borderRadius: 16, paddingVertical: 13, alignItems: 'center' },
  vlcSecondaryText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  vlcGateError: { color: '#ffb3c2', fontSize: 12, marginTop: 12 },
  playerError: { position: 'absolute', left: 16, right: 16, bottom: 24, padding: 12, borderRadius: 16, backgroundColor: '#1C1C1F' },
  playerErrorText: { color: '#fff', fontSize: 12, lineHeight: 18 },
  // 播放器内解析中/失败视图
  resolvingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  resolvingText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  webFallbackBtn: { marginTop: 10, alignSelf: 'flex-start', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  webFallbackText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  // 哔哩哔哩风格底部控制条（停靠在 bottomDock 内）
  controlsBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: 'rgba(0,0,0,0.55)' },
  ctrlBtn: { paddingHorizontal: 8, paddingVertical: 4, minWidth: 30, alignItems: 'center', justifyContent: 'center' },
  ctrlIcon: { color: '#fff', fontSize: 18, fontWeight: '800' },
  ctrlRate: { color: '#fff', fontSize: 12, fontWeight: '800' },
  ctrlTime: { color: '#fff', fontSize: 11, minWidth: 34, textAlign: 'center' },
  // 进度条：外层是更高的触控区（跟手），内层才是 4px 视觉条
  ctrlTrack: { flex: 1, height: 24, justifyContent: 'center', marginHorizontal: 8, position: 'relative' },
  ctrlBar: { position: 'relative', height: 4, width: '100%', borderRadius: 2, backgroundColor: '#FFFFFF' },
  ctrlKnob: { position: 'absolute', top: -3, width: 10, height: 10, borderRadius: 5, backgroundColor: '#fff', marginLeft: -5 },
  // 底部控制坞（MSG48 风格：半透明黑底，进度/功能图标统一沉浸显隐）
  bottomDock: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20, paddingTop: 10, paddingBottom: 16, paddingHorizontal: 12, backgroundColor: 'rgba(0,0,0,0.55)' },
  funcRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-around', alignItems: 'center', marginTop: 10, gap: 4 },
  funcBtn: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 4, minWidth: 48 },
  funcBtnActive: { opacity: 1 },
  funcBtnText: { color: '#fff', fontSize: 11, fontWeight: '700', marginTop: 3 },
  liveBadgeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 6, gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ff4d4f' },
  liveBadgeText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  topChrome: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 44, paddingHorizontal: 12, paddingBottom: 8, pointerEvents: 'box-none' },
  // v2 内容卡：大封面 + 信息区（2026-08-15 布局重建）
  v2Card: {
    marginHorizontal: 12,
    marginVertical: 6,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  v2Cover: { height: 208, overflow: 'hidden' },
  v2CoverImg: { width: '100%', height: '100%' },
  v2CoverFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  v2Shade1: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 108, backgroundColor: 'rgba(0,0,0,0.16)' },
  v2Shade2: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 72, backgroundColor: 'rgba(0,0,0,0.28)' },
  v2Shade3: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 44, backgroundColor: 'rgba(0,0,0,0.48)' },
  v2InfoOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingBottom: 10 },
  v2TitleOverlay: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', lineHeight: 21, textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  v2MetaRowOverlay: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  v2MetaOverlay: { color: 'rgba(255,255,255,0.88)', fontSize: 12, marginLeft: 4, textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  // 录播 2 列网格卡
  vodGroupTitle: { paddingHorizontal: 14, paddingTop: 18, paddingBottom: 6, fontSize: 13, fontWeight: '700' },
  vodRow: { flexDirection: 'row', paddingHorizontal: 8 },
  vodGridRow: { paddingHorizontal: 8 },
  // 固定 50% 宽而非 flex:1：numColumns=2 下末行奇数项不会把单卡撑成整行宽
  vodGridItem: { width: '50%', padding: 4 },
  vodGridCard: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  vodGridCover: { width: '100%', aspectRatio: 1, overflow: 'hidden' },
  vodGridCoverImg: { width: '100%', height: '100%' },
  vodGridFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  vodGridType: { position: 'absolute', top: 8, left: 8 },
  /* 右上角徽标行（录播时长 / 指定直播中） */
  vodBadgeRow: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
  },
  // 底部平滑渐变遮罩：顶部透明 → 底部 0.55 黑，替代两层色阶（vodShade1/vodShade2）
  vodShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 88 },
  vodInfoOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 8, paddingBottom: 7 },
  vodTitleOverlay: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', lineHeight: 17, textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  vodMetaOverlay: { color: 'rgba(255,255,255,0.85)', fontSize: 9, marginTop: 2, flexShrink: 1, textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  // 直播首条 banner
  liveBanner: {
    marginHorizontal: 8,
    marginBottom: 8,
    marginTop: 4,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 3,
  },
  liveBannerCover: { width: '100%', height: 200, overflow: 'hidden' },
  liveBannerImg: { width: '100%', height: '100%' },
  liveBannerFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  v2Badges: { position: 'absolute', top: 10, left: 10, flexDirection: 'row', gap: 6 },
  v2Badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  v2BadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  v2Duration: { position: 'absolute', right: 10, bottom: 10 },
  // v2.6: group + search
  groupRow: { maxHeight: 44, marginBottom: 4 },
  groupRowContent: { paddingHorizontal: 12, alignItems: 'center', gap: 6 },
  groupChip: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radii.pill },
  groupChipText: { fontSize: 13, fontWeight: '700' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginBottom: 4 },
  searchInput: {
    flex: 1, padding: 10, borderRadius: radiiAlias.input,
    borderWidth: StyleSheet.hairlineWidth, fontSize: 13,
  },
  searchClear: { paddingHorizontal: 8, paddingVertical: 8 },
  // 成员选择框
  memberChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: radii.pill, marginRight: 8 },
  memberChipText: { fontSize: 12, fontWeight: '700' },
  memberHits: { maxHeight: 52, marginBottom: 2 },
  memberHitsContent: { paddingHorizontal: 12, alignItems: 'center', gap: 6 },
  memberHitChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: radii.pill, borderWidth: 1 },
  memberHitText: { fontSize: 12, fontWeight: '700' },
  memberHitTeam: { fontSize: 9, marginLeft: 6, opacity: 0.85 },
  modalShade: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.72)' },
  giftPanel: { maxHeight: '82%', borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet, padding: 14 },
  giftHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  giftTitle: { fontSize: 18, fontWeight: '800' },
  giftStatus: { fontSize: 12, marginBottom: 10 },
  giftTip: { fontSize: 11, marginBottom: 6, textAlign: 'center', fontWeight: '600' },
  giftGrid: { maxHeight: 360 },
  giftGridInner: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  giftItem: { width: '31%', padding: 8, borderRadius: radiiAlias.input, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  giftItemActive: {},
  giftImage: { width: 44, height: 44, borderRadius: radiiAlias.button, backgroundColor: '#ddd', marginBottom: 6 },
  giftName: { fontSize: 11, fontWeight: '700' },
  giftCost: { fontSize: 10, marginTop: 2 },
  giftFooter: { flexDirection: 'row', gap: 10, paddingTop: 12 },
  giftNum: { width: 82, borderRadius: radiiAlias.input, borderWidth: 1, paddingHorizontal: 12 },
  sendGiftBtn: { flex: 1, borderRadius: radiiAlias.button, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  sendGiftText: { fontSize: 14, fontWeight: '800' },
  rechargeBtn: { marginTop: 10, alignItems: 'center', paddingVertical: 10 },
  rechargeText: { fontSize: 13, fontWeight: '800' },
  rankList: { maxHeight: 430 },
  rankRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  rankNo: { width: 32, fontSize: 15, fontWeight: '900' },
  rankAvatar: { width: 38, height: 38, borderRadius: 19, marginRight: 10 },
  rankInfo: { flex: 1 },
  rankName: { fontSize: 14, fontWeight: '800' },
  rankValue: { fontSize: 11, marginTop: 2 },
  // 日历筛选
  calBtn: { padding: 6, marginRight: 2, justifyContent: 'center' },
  calBtnActive: { borderRadius: radii.sm },
  dateChipRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginTop: 8 },
  dateChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radii.pill, borderWidth: StyleSheet.hairlineWidth },
  dateChipText: { fontSize: 12, fontWeight: '700' },
  dateChipClear: { marginLeft: 6 },
  calMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  calSheet: { width: '88%', maxWidth: 360, borderRadius: radiiAlias.input, padding: 16, elevation: 8 },
  calHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  calTitle: { fontSize: 17, fontWeight: '800' },
  calWeekRow: { flexDirection: 'row', marginBottom: 6 },
  calWeek: { flex: 1, textAlign: 'center', fontSize: 12, color: '#999', fontWeight: '700' },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calDay: { width: '14.28%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  calDayText: { fontSize: 15 },
  calFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#eee' },
  calCancel: { paddingHorizontal: 14, paddingVertical: 6 },
  calCancelText: { fontSize: 14 },
  calToday: { borderRadius: radiiAlias.button, paddingHorizontal: 18, paddingVertical: 6 },
  calTodayText: { fontSize: 14, fontWeight: '800' },
});
