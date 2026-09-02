import React, { useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import { Image, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import PlayerScreen, { buildPocketHeaders } from '../player';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '../navigation/types';
import { Member } from '../types';
import MemberPicker from '../components/MemberPicker';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { FadeInView, ScalePressable } from '../components/Motion';
import { CenterSpinner } from '../components/Loaders';
import { Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/StateViews';
import { LoginPrompt } from '../components/LoginPrompt';
import { Pill } from '../components/Pill';
import { useSettingsStore, useUiStore } from '../store';
import pocketApi from '../api/pocket48';
import { errorMessage, messagePayload, messageText, pickText, unwrapList } from '../utils/data';
import { formatTimestamp } from '../utils/format';
import { parseDurationSeconds } from '../utils/duration';
import { usePalette, radii } from '../theme';
import { useI18n } from '../i18n';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

type Nav = StackNavigationProp<RootStackParamList, 'AnalysisScreen'>;
type TabKey = 'room' | 'flip';

// 报告式收敛（结构升级）：不再用 6 个平级 tab 拆散画像——
// 「消息画像」一页呈现（概览/日期/排行/媒体全部并入），翻牌统计独立成页。
const TABS: { key: TabKey; label: string }[] = [
  { key: 'room', label: '消息画像' },
  { key: 'flip', label: '翻牌统计' },
];

function msgTime(item: any) {
  const t = Number(item.msgTime || item.ctime || item.time || item.timestamp || item.createTime || 0);
  // Y25: 秒级(10位)时间戳 → 毫秒（否则日期分布落 1970、过期恒判）
  return t > 0 && t < 10000000000 ? t * 1000 : t;
}

function msgDate(item: any) {
  const time = msgTime(item);
  if (!time) return '';
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseJsonField(raw: any): any {
  if (!raw || typeof raw === 'object') return raw || {};
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw); } catch {
    try { return JSON.parse(raw.replace(/:\s*([0-9]{15,})/g, ':"$1"')); } catch { return {}; }
  }
}

function senderName(item: any, unknownLabel = '未知用户') {
  const ext = parseJsonField(item?.extInfo || item?.ext);
  const body = parseJsonField(item?.bodys || item?.body);
  const paths = ['senderName', 'senderNickName', 'nickName', 'nickname', 'userName', 'name',
    'user.nickName', 'sender.nickName', 'userInfo.nickName'];
  for (const obj of [item, ext, body]) {
    if (!obj || typeof obj !== 'object') continue;
    for (const path of paths) {
      const v = pickText(obj, [path]);
      if (v) return v;
    }
  }
  return unknownLabel;
}

function senderId(item: any) {
  const ext = parseJsonField(item?.extInfo || item?.ext);
  const body = parseJsonField(item?.bodys || item?.body);
  const paths = ['senderId', 'senderUserId', 'fromUserId', 'userId', 'uid', 'account',
    'sender.userId', 'user.userId'];
  for (const obj of [item, ext, body]) {
    if (!obj || typeof obj !== 'object') continue;
    for (const path of paths) {
      const v = pickText(obj, [path]);
      if (v) return v;
    }
  }
  return '';
}

function isIdolMessage(item: any, member: Member | null) {
  if (!member) return false;
  const sid = senderId(item);
  if (!sid) return false;
  // Only compare against member's user IDs, not room IDs (serverId/channelId)
  const ownerIds = [member.id, (member as any).userId, (member as any).memberId]
    .map(String).filter(Boolean);
  return ownerIds.includes(String(sid));
}

function messageKey(item: any, index: number) {
  return String(item.messageId || item.msgId || item.id || `${msgTime(item)}-${senderId(item)}-${messageText(item)}-${index}`);
}

function isMedia(item: any, kind: 'image' | 'audio' | 'video') {
  const type = String(item.msgType || item.type || '').toUpperCase();
  const payload = messagePayload(item);
  const url = pickText(payload, ['url', 'imageUrl', 'audioUrl', 'videoUrl', 'message.url', 'msg.url']);
  if (kind === 'image') return type.includes('IMAGE') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
  if (kind === 'audio') return type.includes('AUDIO') || type.includes('VOICE') || /\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(url);
  return type.includes('VIDEO') || /\.(mp4|mov|m4v|3gp|flv|m3u8)(\?|$)/i.test(url);
}

function countBy<T>(items: T[], keyOf: (item: T) => string, unknownLabel = '未知') {
  const map = new Map<string, { key: string; count: number; sample?: T }>();
  items.forEach((item) => {
    const key = keyOf(item) || unknownLabel;
    const old = map.get(key);
    map.set(key, { key, count: (old?.count || 0) + 1, sample: old?.sample || item });
  });
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export default function AnalysisScreen() {
  const navigation = useNavigation<Nav>();
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((s) => s.showToast);
  const token = useSettingsStore((s) => s.settings.p48Token);
  const [member, setMember] = useState<Member | null>(null);
  const [tab, setTab] = useState<TabKey>('room');
  const [messages, setMessages] = useState<any[]>([]);
  const [flips, setFlips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(t('暂无数据'));
  const [loadError, setLoadError] = useState('');
  const [mediaFullUrl, setMediaFullUrl] = useState('');
  // 成员切换竞态防护：快速切换成员时丢弃慢响应（房间统计循环翻页较久，旧响应不得覆盖新成员）
  const statsReqRef = useRef(0);
  const [playMedia, setPlayMedia] = useState<{ url: string; type: string } | null>(null);
  const [flipPlayUrl, setFlipPlayUrl] = useState('');
  const [flipMemberFilter, setFlipMemberFilter] = useState('');

  const flipMemberNames = useMemo(() => {
    const set = new Set<string>();
    for (const item of flips) {
      const rec = item as Record<string, any>;
      set.add(pickText(rec, ['memberName', 'starName', 'baseUserInfo.nickname'], '成员'));
    }
    return ['全部成员', ...Array.from(set).sort()];
  }, [flips]);

  const summary = useMemo(() => {
    const total = messages.length;
    const idol = member ? messages.filter((item) => isIdolMessage(item, member)).length : 0;
    const fan = Math.max(0, total - idol);
    const images = messages.filter((item) => isMedia(item, 'image')).length;
    const audios = messages.filter((item) => isMedia(item, 'audio')).length;
    const videos = messages.filter((item) => isMedia(item, 'video')).length;
    const gifts = messages.filter((item) => String(item.msgType || '').toUpperCase().includes('GIFT')).length;
    return { total, idol, fan, images, audios, videos, gifts };
  }, [member, messages]);

  const dateStats = useMemo(() => {
    const map = new Map<string, { total: number; member: number }>();
    messages.forEach((item) => {
      const date = msgDate(item);
      if (!date) return;
      const entry = map.get(date) || { total: 0, member: 0 };
      entry.total++;
      if (member && String(senderId(item)) === String(member.id)) entry.member++;
      map.set(date, entry);
    });
    return [...map.entries()].map(([date, value]) => ({ date, ...value })).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  }, [member, messages]);

  const dateMax = Math.max(1, ...dateStats.map((d) => d.total));

  const senders = useMemo(() => countBy(messages, senderName, t('未知')).slice(0, 30), [messages, t]);
  // 成员排行前 8 名用于横向条形图；senders 已按 count 降序，maxCount 取首名
  const memberRankTop8 = useMemo(() => senders.slice(0, 8), [senders]);
  const sendersMax = memberRankTop8.length ? memberRankTop8[0].count : 1;
  const recent = useMemo(() => messages.slice().sort((a, b) => msgTime(b) - msgTime(a)).slice(0, 20), [messages]);
  // 媒体消息列表（避免每次渲染内联 filter 生成新引用导致全列表重渲染）
  const mediaMessages = useMemo(
    () => messages.filter((item) => isMedia(item, 'image') || isMedia(item, 'audio') || isMedia(item, 'video')),
    [messages],
  );

  const filteredFlips = useMemo(() => {
    if (!flipMemberFilter || flipMemberFilter === '全部成员') return flips;
    return flips.filter((item: any) => {
      const mn = pickText(item, ['memberName', 'starName', 'baseUserInfo.nickname'], '成员');
      return mn === flipMemberFilter;
    });
  }, [flips, flipMemberFilter]);

  const flipStats = useMemo(() => {
    let totalCost = 0;
    let durSum = 0;
    let answeredCount = 0;
    let minDur = Infinity;
    let maxDur = 0;
    let typeStats = { text: 0, audio: 0, video: 0 };
    const memberMap = new Map<string, any>();
    for (const item of filteredFlips) {
      const rec = item as Record<string, any>;
      const cost = Number(rec['cost']) || 0;
      totalCost += cost;
      const at = Number(rec['answerType']);
      if (at === 1) typeStats.text += 1;
      else if (at === 2) typeStats.audio += 1;
      else if (at === 3) typeStats.video += 1;
      const mn = pickText(rec, ['memberName', 'starName', 'baseUserInfo.nickname'], '成员');
      if (!memberMap.has(mn)) memberMap.set(mn, { name: mn, count: 0, cost: 0, durSum: 0, answeredCount: 0, minDur: Infinity, maxDur: 0, minCost: Infinity, maxCost: 0, typeCounts: { text: 0, audio: 0, video: 0 } });
      const m = memberMap.get(mn)!;
      m.count += 1;
      m.cost += cost;
      if (at === 1) m.typeCounts.text += 1;
      else if (at === 2) m.typeCounts.audio += 1;
      else if (at === 3) m.typeCounts.video += 1;
      if (cost > m.maxCost) m.maxCost = cost;
      if (cost < m.minCost) m.minCost = cost;
      if (rec['status'] === 2 && rec['qtime'] && rec['answerTime']) {
        const diff = Number(rec['answerTime']) - Number(rec['qtime']);
        if (diff > 0) {
          durSum += diff;
          answeredCount += 1;
          if (diff < minDur) minDur = diff;
          if (diff > maxDur) maxDur = diff;
          m.durSum += diff;
          m.answeredCount += 1;
          if (diff < m.minDur) m.minDur = diff;
          if (diff > m.maxDur) m.maxDur = diff;
        }
      }
    }
    const avgDur = answeredCount > 0 ? durSum / answeredCount : 0;
    const memberRank = [...memberMap.values()].sort((a, b) => b.cost - a.cost);
    const topCost = memberRank[0]?.cost || 1;
    return { totalCount: filteredFlips.length, totalCost, typeStats, avgDur, minDur: minDur === Infinity ? 0 : minDur, maxDur, answeredCount, memberRank, topCost };
  }, [filteredFlips]);

  // 翻牌类型分布小条形图的最大值
  const flipTypeMax = Math.max(1, flipStats.typeStats.text, flipStats.typeStats.audio, flipStats.typeStats.video);

  function formatDurationMs(ms: number): string {
    if (ms <= 0) return '-';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return t('{d}天{h}小时{m}分', { d, h, m });
    if (h > 0) return t('{h}小时{m}分', { h, m });
    return t('{m}分', { m });
  }

  const loadRoomStats = async (nextMember: Member) => {
    const requestId = ++statsReqRef.current;
    setMember(nextMember);
    setLoading(true);
    setStatus('');
    setLoadError('');
    setMessages([]);
    try {
      let nextTime = 0;
      const collected: any[] = [];
      for (let page = 0; page < 20; page += 1) {
        if (requestId !== statsReqRef.current) return; // 已切换成员，丢弃慢响应
        const res = await pocketApi.getRoomMessages({
          channelId: String(nextMember.channelId || ''),
          serverId: String(nextMember.serverId || ''),
          nextTime,
          fetchAll: true,
          limit: 100,
        });
        const list = unwrapList(res, ['content.messageList', 'content.message', 'content.list', 'content.messages', 'data.messageList', 'data.message', 'messageList', 'message', 'list']);
        if (!list.length) break;
        collected.push(...list);
        const contentNext = Number(res?.content?.nextTime || res?.data?.nextTime || 0);
        nextTime = Number.isFinite(contentNext) && contentNext > 0 ? contentNext : 0;
        if (!nextTime) break;
      }
      if (requestId !== statsReqRef.current) return; // 已切换成员，丢弃慢响应
      const seen = new Set<string>();
      const unique = collected.filter((item, index) => {
        const key = messageKey(item, index);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setMessages(unique);
      setStatus(unique.length ? t('已加载 {count} 条房间消息', { count: unique.length }) : t('没有可统计的房间消息'));
      showToast(unique.length ? t('已加载 {count} 条消息', { count: unique.length }) : t('无房间消息可统计'));
    } catch (error) {
      if (requestId !== statsReqRef.current) return;
      setMessages([]);
      setLoadError(errorMessage(error));
      setStatus(t('加载失败：{err}', { err: errorMessage(error) }));
      showToast(t('加载失败：{err}', { err: errorMessage(error) }));
    } finally {
      if (requestId === statsReqRef.current) setLoading(false);
    }
  };

  const loadFlipStats = async () => {
    setLoading(true);
    try {
      // 循环拉取直到拉完，移除原先 [0,50,100,150] 的 200 条上限
      const collected: any[] = [];
      let begin = 0;
      let failed = false;
      for (let i = 0; i < 24; i++) {
        let res: any = null;
        try {
          res = await pocketApi.getFlipList(begin, 100);
        } catch {
          failed = true;
          break;
        }
        const list = res ? unwrapList(res, ['content.questions', 'content.list', 'content.data', 'data.questions', 'questions', 'list']) : [];
        if (!list.length) break;
        collected.push(...list);
        const next = Number((res as any)?.content?.next ?? (res as any)?.data?.next ?? 0);
        if (!next || next <= begin) break;
        begin = next;
      }
      setFlips(collected);
      if (failed) {
        setStatus(t('翻牌记录加载不完整：{err}', { err: t('中途请求失败，已显示已获取的部分') }));
        showToast(t('翻牌记录加载不完整'));
      } else {
        setStatus(collected.length ? t('已加载 {count} 条翻牌记录', { count: collected.length }) : t('暂无翻牌记录'));
        showToast(collected.length ? t('已加载 {count} 条翻牌', { count: collected.length }) : t('无翻牌记录'));
      }
    } catch (error) {
      setStatus(t('翻牌统计失败：{err}', { err: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  const cards = [
    { label: '消息', value: summary.total },
    { label: '成员发言', value: summary.idol },
    { label: '粉丝发言', value: summary.fan },
    { label: '图片', value: summary.images },
    { label: '语音', value: summary.audios },
    { label: '视频', value: summary.videos },
    { label: '礼物', value: summary.gifts },
  ];

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('数据统计')} right={
        <HeaderAction label={t('刷新')} onPress={() => { setLoadError(''); setLoading(true); loadRoomStats(member!).finally(() => loadFlipStats().finally(() => setLoading(false))); }} disabled={!member || loading} loading={loading} />
      } />

      <View style={styles.pickerWrap}>
        <MemberPicker selectedMember={member} onSelect={loadRoomStats} />
        {/* 未登录引导：选了成员但缺 token 时显示，避免"全 0"误导 */}
        {(member && !token) ? (
          <LoginPrompt hint={t('统计该成员的互动画像需要登录')} />
        ) : (
          <Text style={[styles.statusText, { color: palette.labelSecondary }]}>{status}</Text>
        )}
        {loadError && !loading ? (
          <ErrorState title={t('加载失败')} hint={loadError} onAction={() => { setLoadError(''); loadRoomStats(member!).finally(() => loadFlipStats()); }} />
        ) : null}
      </View>
      {/* 分段控件：fill2 底 + 选中白胶囊（spec §7 Segmented） */}
      <View style={[styles.segmented, { backgroundColor: palette.fill2 }]}>
        {TABS.map((item) => {
          const active = tab === item.key;
          return (
            <ScalePressable
              key={item.key}
              activeOpacity={0.8}
              pressedScale={0.97}
              style={[styles.segItem, active && { backgroundColor: palette.surface }]}
              onPress={() => { setTab(item.key); if (item.key === 'flip' && !flips.length) loadFlipStats(); }}
            >
              <Text
                numberOfLines={1}
                style={[styles.segText, { color: active ? palette.label : palette.labelSecondary }]}
              >
                {t(item.label)}
              </Text>
            </ScalePressable>
          );
        })}
      </View>

      {tab === 'room' ? (
        <FadeInView delay={80} duration={300}>
          {loading && messages.length === 0 ? (
            // 首屏加载占位：与真实内容同构的 Skeleton（spec §8）
            <View style={styles.content}>
              <View style={styles.statsGrid}>
                {[0, 1, 2, 3].map((i) => (
                  <View key={i} style={[styles.statCard, { backgroundColor: palette.surface }]}>
                    <Skeleton width={44} height={20} radius={6} />
                    <Skeleton width={40} height={11} radius={5} style={{ marginTop: 8 }} />
                  </View>
                ))}
              </View>
              <View style={[styles.rankCard, { backgroundColor: palette.surface }]}>
                <Skeleton width={90} height={15} radius={6} />
                <Skeleton width={130} height={11} radius={5} style={{ marginTop: 8 }} />
                {[0, 1, 2, 3].map((i) => (
                  <View key={i} style={[styles.rankRow, { marginTop: 8 }]}>
                    <Skeleton width={72} height={13} radius={6} />
                    <Skeleton width="55%" height={10} radius={3} style={{ flex: 1, marginHorizontal: 8 }} />
                    <Skeleton width={28} height={11} radius={5} />
                  </View>
                ))}
              </View>
            </View>
          ) : (
          <ScrollView contentContainerStyle={styles.content}>
            {/* 成员聚焦 hero（结构升级）：成员发言占比一眼可见，统计不再只是数字陈列 */}
            {member && summary.total > 0 ? (
              <View style={[styles.heroCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                <View style={styles.heroHead}>
                  <View style={[styles.heroAvatar, { backgroundColor: palette.tintSoft }]}>
                    <MaterialCommunityIcons name="account-star" size={22} color={palette.tint} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.heroTitle, { color: palette.label }]} numberOfLines={1}>{member.ownerName}</Text>
                    <Text style={[styles.heroSub, { color: palette.labelSecondary }]}>{t('共 {total} 条消息 · 成员发言 {idol} 条', { total: summary.total, idol: summary.idol })}</Text>
                  </View>
                  <Text style={[styles.heroPct, { color: palette.tint }]}>
                    {summary.total > 0 ? `${Math.round((summary.idol / summary.total) * 100)}%` : '0%'}
                  </Text>
                </View>
                <View style={[styles.heroTrack, { backgroundColor: palette.fill2 }]}>
                  <View style={[styles.heroFill, { width: `${summary.total > 0 ? (summary.idol / summary.total) * 100 : 0}%`, backgroundColor: palette.tint }]} />
                </View>
                <View style={styles.heroLegend}>
                  <View style={styles.heroLegendItem}>
                    <View style={[styles.heroDot, { backgroundColor: palette.tint }]} />
                    <Text style={[styles.heroLegendText, { color: palette.labelSecondary }]}>{t('成员发言 {count}', { count: summary.idol })}</Text>
                  </View>
                  <View style={styles.heroLegendItem}>
                    <View style={[styles.heroDot, { backgroundColor: palette.fill3 }]} />
                    <Text style={[styles.heroLegendText, { color: palette.labelSecondary }]}>{t('粉丝发言 {count}', { count: summary.fan })}</Text>
                  </View>
                </View>
              </View>
            ) : null}

            {/* 概览区：2 列统计卡（数值 20/800 + 标签 11） */}
            <View style={styles.statsGrid}>
              {cards.map((item) => (
                <View key={item.label} style={[styles.statCard, { backgroundColor: palette.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.hairline }]}>
                  <Text style={[styles.statValue, { color: palette.tint }]}>{item.value}</Text>
                  <Text style={[styles.statLabel, { color: palette.labelSecondary }]}>{t(item.label)}</Text>
                </View>
              ))}
            </View>

            {/* 成员排行 · 横向条形图（轨道 fill2 + 填充 tint 圆角 3） */}
            <View style={[styles.rankCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
              <Text style={[styles.rankHeaderTitle, { color: palette.label }]}>{t('成员排行')}</Text>
              <Text style={[styles.rankHeaderSub, { color: palette.labelSecondary }]}>{t('按发言次数 Top {count}', { count: memberRankTop8.length })}</Text>
              {memberRankTop8.map((item, index) => {
                const pct = (item.count / sendersMax) * 100;
                return (
                  <View key={item.key} style={styles.rankRow}>
                    <Text style={[styles.rankRowName, { color: palette.label }]} numberOfLines={1}>{index + 1}. {item.key}</Text>
                    <View style={[styles.rankTrack, { backgroundColor: palette.fill2 }]}>
                      <View style={[styles.rankBar, { width: `${pct}%`, backgroundColor: palette.tint }]} />
                    </View>
                    <Text style={[styles.rankRowCount, { color: palette.labelTertiary }]}>{item.count}</Text>
                  </View>
                );
              })}
            </View>

            {recent.map((item, index) => (
              <View key={`${msgTime(item)}-${index}`} style={[styles.rowCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                <View style={[styles.rowIcon, { backgroundColor: palette.tintSoft }]}>
                  <MaterialCommunityIcons name="message-text-outline" size={20} color={palette.tint} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={[styles.rowTitle, { color: palette.label }]} numberOfLines={1}>{senderName(item, t('未知用户'))}</Text>
                  <Text style={[styles.rowSub, { color: palette.labelSecondary }]} numberOfLines={2}>{messageText(item)}</Text>
                </View>
                <Text style={[styles.rowMeta, { color: palette.labelTertiary }]}>{formatTimestamp(msgTime(item))}</Text>
              </View>
            ))}

            {/* 日期分布（并入画像：近 8 天成员/总数双条） */}
            {dateStats.length > 0 ? (
              <View style={[styles.rankCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                <Text style={[styles.rankHeaderTitle, { color: palette.label }]}>{t('日期分布')}</Text>
                <Text style={[styles.rankHeaderSub, { color: palette.labelSecondary }]}>{t('近 {count} 天发言节奏', { count: Math.min(8, dateStats.length) })}</Text>
                {dateStats.slice(0, 8).map((item: any) => {
                  const totalPct = (item.total / dateMax) * 100;
                  const memberPct = (item.member / dateMax) * 100;
                  return (
                    <View key={item.date} style={styles.rankRow}>
                      <Text style={[styles.rankRowName, { color: palette.label }]} numberOfLines={1}>{item.date.slice(5)}</Text>
                      <View style={[styles.rankTrack, { backgroundColor: palette.fill2 }]}>
                        <View style={[styles.rankBar, { width: `${totalPct}%`, backgroundColor: palette.tint, opacity: 0.25 }]} />
                        <View style={[styles.rankBarAbs, { width: `${memberPct}%`, backgroundColor: palette.tint }]} />
                      </View>
                      <Text style={[styles.rankRowCount, { color: palette.labelTertiary }]}>{item.total}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {/* 发送者排行（并入画像：Top 8） */}
            {senders.length > 0 ? (
              <View style={[styles.rankCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                <Text style={[styles.rankHeaderTitle, { color: palette.label }]}>{t('发言排行')}</Text>
                <Text style={[styles.rankHeaderSub, { color: palette.labelSecondary }]}>{t('Top {count} 发言者', { count: Math.min(8, senders.length) })}</Text>
                {senders.slice(0, 8).map((item: any, index: number) => {
                  const pct = (item.count / sendersMax) * 100;
                  return (
                    <View key={item.key} style={styles.rankRow}>
                      <Text style={[styles.rankRowName, { color: palette.label }]} numberOfLines={1}>{index + 1}. {item.key}</Text>
                      <View style={[styles.rankTrack, { backgroundColor: palette.fill2 }]}>
                        <View style={[styles.rankBar, { width: `${pct}%`, backgroundColor: palette.tint }]} />
                      </View>
                      <Text style={[styles.rankRowCount, { color: palette.labelTertiary }]}>{item.count}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {/* 媒体消息（并入画像：最近 10 条，可点击预览/播放） */}
            {mediaMessages.length > 0 ? (
              <View style={[styles.rankCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                <Text style={[styles.rankHeaderTitle, { color: palette.label }]}>{t('媒体消息')}</Text>
                <Text style={[styles.rankHeaderSub, { color: palette.labelSecondary }]}>{t('图片/语音/视频 最近 {count} 条', { count: Math.min(10, mediaMessages.length) })}</Text>
                {mediaMessages.slice(0, 10).map((item: any, index: number) => {
                  const isImg = isMedia(item, 'image');
                  const isAud = isMedia(item, 'audio');
                  const isVid = isMedia(item, 'video');
                  const payload = messagePayload(item);
                  const url = pickText(payload, ['url', 'imageUrl', 'audioUrl', 'videoUrl', 'message.url']);
                  const label = isImg ? t('图片') : isAud ? t('语音') : t('视频');
                  const mediaIcon = isVid ? 'video-outline' : isAud ? 'microphone-outline' : 'image-outline';
                  return (
                    <TouchableOpacity
                      key={`media-${msgTime(item)}-${index}`}
                      style={styles.rankRow}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (url) {
                          if (isImg) setMediaFullUrl(url);
                          else setPlayMedia({ url, type: isAud ? 'audio' : 'video' });
                        }
                      }}
                    >
                      <View style={[styles.rowIcon, { backgroundColor: palette.tintSoft }]}>
                        <MaterialCommunityIcons name={mediaIcon as any} size={16} color={palette.tint} />
                      </View>
                      <Text style={[styles.rankRowName, { color: palette.label }]} numberOfLines={1}>{label} · {senderName(item, t('未知用户'))}</Text>
                      <Text style={[styles.rankRowCount, { color: palette.labelTertiary }]}>{formatTimestamp(msgTime(item)).slice(5, 16)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}
          </ScrollView>
          )}
        </FadeInView>
      ) : null}

      {tab === 'flip' ? (
        <PerfFlatList
          data={filteredFlips}
          keyExtractor={(item, index) => String(item.questionId || item.id || item.answerId || index)}
          contentContainerStyle={styles.content}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          ListHeaderComponent={
            <View>
              {/* 成员过滤：Pill 横滑 chips */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.flipChipScroll} contentContainerStyle={styles.flipChipRow}>
                {flipMemberNames.map((name: string) => (
                  <Pill
                    key={name}
                    label={name === '全部成员' || name === '成员' ? t(name) : name}
                    selected={flipMemberFilter === name || (name === '全部成员' && !flipMemberFilter)}
                    onPress={() => setFlipMemberFilter(name === '全部成员' ? '' : name)}
                    style={styles.flipChip}
                  />
                ))}
              </ScrollView>
              {/* 概览统计：2 列卡 */}
              <View style={styles.statsGrid}>
                <View style={[styles.statCard, { backgroundColor: palette.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.hairline }]}>
                  <Text style={[styles.statValue, { color: palette.tint }]}>{flipStats.totalCount}</Text>
                  <Text style={[styles.statLabel, { color: palette.labelSecondary }]}>{t('总翻牌数')}</Text>
                </View>
                <View style={[styles.statCard, { backgroundColor: palette.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.hairline }]}>
                  <Text style={[styles.statValue, { color: palette.tint }]}>{flipStats.totalCost}</Text>
                  <Text style={[styles.statLabel, { color: palette.labelSecondary }]}>{t('总消耗(鸡腿)')}</Text>
                </View>
                <View style={[styles.statCard, { backgroundColor: palette.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.hairline }]}>
                  <Text style={[styles.statValue, { color: palette.tint }]}>{formatDurationMs(flipStats.avgDur)}</Text>
                  <Text style={[styles.statLabel, { color: palette.labelSecondary }]}>{t('平均耗时')}</Text>
                  {flipStats.minDur > 0 ? <Text style={[styles.flipCardRange, { color: palette.labelTertiary }]}>{formatDurationMs(flipStats.minDur)} ~ {formatDurationMs(flipStats.maxDur)}</Text> : null}
                </View>
              </View>
              <View style={[styles.blockCard, { backgroundColor: palette.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.hairline }]}>
                <Text style={[styles.sectionSub, { color: palette.labelSecondary }]}>{t('回复类型分布')}</Text>
                {[
                  { key: 'text', label: t('文字'), count: flipStats.typeStats.text },
                  { key: 'audio', label: t('语音'), count: flipStats.typeStats.audio },
                  { key: 'video', label: t('视频'), count: flipStats.typeStats.video },
                ].map((row) => {
                  const tpct = (row.count / flipTypeMax) * 100;
                  return (
                    <View key={row.key} style={styles.rankRow}>
                      <Text style={[styles.rankRowName, { color: palette.label }]} numberOfLines={1}>{row.label}</Text>
                      <View style={[styles.rankTrack, { backgroundColor: palette.fill2 }]}>
                        <View style={[styles.rankBar, { width: `${tpct}%`, backgroundColor: palette.tint }]} />
                      </View>
                      <Text style={[styles.rankRowCount, { color: palette.labelTertiary }]}>{row.count}</Text>
                    </View>
                  );
                })}
              </View>
              <Text style={[styles.sectionSub, { color: palette.labelSecondary }]}>{t('成员排名 · {count} 人 · 共 {total} 条', { count: flipStats.memberRank.length, total: flipStats.totalCount })}</Text>
              {flipStats.memberRank.map((m, idx) => {
                const pct = (m.cost / flipStats.topCost) * 100;
                const avgPrice = m.count > 0 ? Math.round(m.cost / m.count) : 0;
                const avgTime = m.answeredCount > 0 ? formatDurationMs(m.durSum / m.answeredCount) : '';
                return (
                  <View key={m.name} style={[styles.rowCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                    <View style={[styles.rowIcon, styles.rankIconNo, { backgroundColor: palette.fill2 }]}>
                      <Text style={[styles.rankNo, { color: palette.labelTertiary }]}>{idx + 1}</Text>
                    </View>
                    <View style={styles.rowBody}>
                      <Text style={[styles.rowTitle, { color: palette.label }]} numberOfLines={1}>{m.name}</Text>
                      <Text style={[styles.rowSub, { color: palette.labelSecondary }]} numberOfLines={1}>
                        {t('共 {count} 条 · 均{avg}鸡腿', { count: m.count, avg: avgPrice })}
                      </Text>
                    </View>
                    <View style={styles.flipRankVal}>
                      <Text style={[styles.rankValue, { color: palette.tint }]}>{t('{cost} 鸡腿', { cost: m.cost })}</Text>
                      <View style={[styles.miniTrack, { backgroundColor: palette.fill3 }]}>
                        <View style={[styles.miniFill, { width: `${pct}%`, backgroundColor: palette.tint }]} />
                      </View>
                    </View>
                  </View>
                );
              })}
              <Text style={[styles.statusText, { color: palette.labelSecondary, marginBottom: 8, marginTop: 6 }]}>{t('翻牌明细 · 共 {count} 条', { count: filteredFlips.length })}</Text>
            </View>
          }
          renderItem={({ item, index }) => {
            const flipAnswerType = Number(item.answerType);
            const isText = flipAnswerType === 1;
            const isVoice = flipAnswerType === 2;
            const isVideo = flipAnswerType === 3;
            const answerRaw = pickText(item, ['answerContent', 'answer', 'answerText', 'replyContent'], '');
            let answerText = '';
            let answerUrl = '';
            let answerDuration = 0;
            if (answerRaw) {
              try { const j = JSON.parse(answerRaw); answerText = j?.text || j?.content || ''; answerUrl = (isVoice || isVideo) ? (j?.url || j?.mediaUrl || '') : ''; answerDuration = parseDurationSeconds(j?.duration || j?.time || j?.second || j?.audioTime || j?.length || 0); } catch { answerText = answerRaw; }
            }
            const qTime = Number(item.qtime || item.createTime || 0);
            const aTime = Number(item.answerTime || 0);
            const elapsed = aTime && qTime ? aTime - qTime : 0;
            const d = Math.floor(elapsed / 86400000);
            const h = Math.floor((elapsed % 86400000) / 3600000);
            const m = Math.floor((elapsed % 3600000) / 60000);
            const elapsedStr = elapsed > 0
              ? `${d ? t('{m}天', { m: d }) : ''}${h ? t('{m}小时', { m: h }) : ''}${t('{m}分', { m })}`
              : '';
            const isAnswered = item.status === 2;
            const deadline = qTime ? qTime + 7 * 86400000 : 0;
            const remaining = isAnswered ? 0 : (deadline - Date.now());
            const rd = Math.floor(remaining / 86400000);
            const rh = Math.floor((remaining % 86400000) / 3600000);
            const rm = Math.floor((remaining % 3600000) / 60000);
            const remainStr = remaining > 0 && !isAnswered
              ? `${rd ? t('{m}天', { m: rd }) : ''}${rh ? t('{m}小时', { m: rh }) : ''}${t('{m}分', { m: rm })}`
              : (!isAnswered && remaining <= 0 ? t('已过期') : '');
            return (
              <FadeInView delay={80 + index * 30} duration={300}>
                <View style={[styles.rowCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                  <View style={[styles.rowIcon, { backgroundColor: palette.tintSoft }]}>
                    <MaterialCommunityIcons
                      name={isVideo ? 'video-outline' : isVoice ? 'microphone-outline' : 'text-box-outline'}
                      size={20}
                      color={palette.tint}
                    />
                  </View>
                  <View style={styles.rowBody}>
                    <View style={styles.flipHeader}>
                      <Text style={[styles.rowTitle, { color: palette.label }]} numberOfLines={1}>
                        {pickText(item, ['memberName', 'starName', 'baseUserInfo.nickname'], t('成员'))}
                      </Text>
                      <Text style={[styles.rowMeta, { color: palette.labelTertiary }]}>{formatTimestamp(qTime)}</Text>
                    </View>
                    <Text style={[styles.flipQ, { color: palette.labelSecondary }]} numberOfLines={10}>{t('问：{text}', { text: pickText(item, ['content', 'questionContent', 'question', 'text'], '') || t('无提问内容') })}</Text>
                    {isAnswered && isText ? (
                      <Text style={[styles.flipAText, { color: palette.labelSecondary }]} numberOfLines={20}>
                        {t('答：{text}', { text: answerText || t('已翻牌') })}
                      </Text>
                    ) : isAnswered && (isVoice || isVideo) ? (
                      <View style={[styles.flipABlock, { backgroundColor: palette.fill2 }]}>
                        <Text style={[styles.flipA, { color: palette.labelSecondary }]} numberOfLines={20}>
                          {t('答：{text}', { text: answerText || (isVoice ? t('[语音回复]') : t('[视频回复]')) })}
                        </Text>
                        {answerUrl ? (
                          <ScalePressable style={[styles.flipPlayBtn, { backgroundColor: palette.tint }]} onPress={() => setFlipPlayUrl((prev) => prev === answerUrl ? '' : answerUrl)}>
                            <MaterialCommunityIcons name={flipPlayUrl === answerUrl ? 'chevron-up' : 'play'} size={14} color={palette.onTint} />
                            <Text style={[styles.flipPlayText, { color: palette.onTint }]}>{flipPlayUrl === answerUrl ? t('收起') : `${answerDuration > 0 ? (answerDuration < 60 ? `${answerDuration}s` : `${Math.floor(answerDuration / 60)}:${String(answerDuration % 60).padStart(2, '0')}`) : (isVoice ? t('语音') : t('视频'))}`}</Text>
                          </ScalePressable>
                        ) : null}
                        {flipPlayUrl === answerUrl && answerUrl ? (
                          <PlayerScreen
                            inline
                            source={{ kind: isVoice ? 'audio' : 'vod', url: answerUrl, headers: buildPocketHeaders() }}
                            meta={{ title: t('翻牌答案') }}
                            features={{ kernelSwitch: true }}
                            persistent
                          />
                        ) : null}
                      </View>
                    ) : !isAnswered ? (
                      <Text style={[styles.flipPending, { color: palette.tint }]}>{item.status === 1 ? t('等待回复中') : item.status === 3 ? t('已退款') : t('等待回复中')}</Text>
                    ) : null}
                    <View style={styles.flipMeta}>
                      <Text style={[styles.flipTag, { backgroundColor: palette.tintSoft, color: palette.tint }]}>{isText ? t('文字') : isVoice ? t('语音') : isVideo ? t('视频') : t('未知')}</Text>
                      <Text style={[styles.flipPrivacy, { color: palette.labelTertiary }]}>{item.type === 1 ? t('公开') : item.type === 2 ? t('私密') : item.type === 3 ? t('匿名') : t('未知')}</Text>
                      <Text style={[styles.flipCost, { color: palette.labelSecondary }]}>{t('{cost} 鸡腿', { cost: item.cost || 0 })}</Text>
                      {elapsedStr ? <Text style={[styles.flipElapsed, { color: palette.tint }]}>{t('耗时 {time}', { time: elapsedStr })}</Text> : null}
                      {remainStr ? <Text style={[styles.flipRemain, { color: palette.tint }]}>{t('剩 {time}', { time: remainStr })}</Text> : null}
                    </View>
                  </View>
                </View>
              </FadeInView>
            );
          }}
          ListEmptyComponent={<EmptyState icon="card-outline" title={t('暂无翻牌记录')} />}
        />
      ) : null}
      {mediaFullUrl ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setMediaFullUrl('')}>
          <TouchableOpacity style={styles.imgModal} activeOpacity={1} onPress={() => setMediaFullUrl('')}>
            <Image source={{ uri: mediaFullUrl }} style={styles.imgFull} resizeMode="contain" />
          </TouchableOpacity>
        </Modal>
      ) : null}
      {playMedia ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPlayMedia(null)}>
          <View style={styles.videoModal}>
            <TouchableOpacity onPress={() => setPlayMedia(null)} style={styles.videoClose}>
              <Text style={styles.videoCloseText}>{t('关闭')}</Text>
            </TouchableOpacity>
            <PlayerScreen
              source={{ kind: 'vod', url: playMedia.url, headers: buildPocketHeaders() }}
              meta={{ title: t('视频') }}
              features={{ kernelSwitch: true }}
              onClose={() => setPlayMedia(null)}
              persistent
            />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  pickerWrap: { paddingHorizontal: 16 },
  statusText: { marginTop: 8, fontSize: 12 },
  content: { padding: 14, paddingBottom: 112 },
  // 分段控件（spec §7）
  segmented: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 10,
    borderRadius: radii.md,
    padding: 3,
    backgroundColor: 'transparent',
  },
  segItem: {
    flex: 1,
    height: 40,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  segText: { fontSize: 13, fontWeight: '700' },
  // 概览统计卡（2 列，数值 20/800 + 标签 11）
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  heroCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 12,
  },
  heroHead: { flexDirection: 'row', alignItems: 'center' },
  heroAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  heroTitle: { fontSize: 15, fontWeight: '700' },
  heroSub: { fontSize: 12, marginTop: 2 },
  heroPct: { fontSize: 22, fontWeight: '900' },
  heroTrack: { height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 12 },
  heroFill: { height: 6, borderRadius: 3 },
  heroLegend: { flexDirection: 'row', gap: 16, marginTop: 10 },
  heroLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  heroDot: { width: 8, height: 8, borderRadius: 4 },
  heroLegendText: { fontSize: 12 },
  statCard: {
    width: '48.5%',
    marginHorizontal: '0.75%',
    marginBottom: 8,
    paddingVertical: 16,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '800' },
  statLabel: { fontSize: 11, marginTop: 4, fontWeight: '600' },
  // 统一列表行（spec §3 变体：28 圆角图标底 + 14/600 标题 + 12 副标题）
  rowCard: {
    flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 5,
    borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth,
  },  rowIcon: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  rankIconNo: { width: 28 },
  rowBody: { flex: 1, minWidth: 0, paddingRight: 8 },
  rowTitle: { fontSize: 14, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 3, lineHeight: 17 },
  rowMeta: { fontSize: 11 },
  rankNo: { fontSize: 14, fontWeight: '800' },
  rankValue: { fontSize: 13, fontWeight: '800' },
  dateHeader: { flex: 1, minWidth: 0 },
  dateMember: { fontWeight: '700' },
  barWrap: { position: 'relative', height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 8 },
  barFg: { position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: 3 },
  barFg2: { position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: 3 },
  // 条形图区块卡
  blockCard: {
    borderRadius: radii.md, padding: 14, marginBottom: 12,
  },
  rankCard: {
    borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12,
  },
  rankHeaderTitle: { fontSize: 15, fontWeight: '700' },
  rankHeaderSub: { fontSize: 11, marginTop: 3, marginBottom: 6 },
  rankRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 5 },
  rankRowName: { fontSize: 13, fontWeight: '700', flex: 1, marginRight: 8 },
  rankTrack: { flex: 1, height: 10, borderRadius: 3, overflow: 'hidden', backgroundColor: 'transparent' },
  rankBar: { height: 10, borderRadius: 3 },
  rankBarAbs: { position: 'absolute', top: 0, left: 0, height: 10, borderRadius: 3 },
  rankRowCount: { fontSize: 11, width: 28, textAlign: 'right', marginLeft: 8 },
  // 成员翻牌榜行右侧数值 + 迷你进度条
  flipRankVal: { alignItems: 'flex-end', maxWidth: 110 },
  miniTrack: { height: 3, borderRadius: 2, overflow: 'hidden', width: 60, marginTop: 4 },
  miniFill: { height: 3, borderRadius: 2 },
  flipHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  flipQ: { fontSize: 13, lineHeight: 20, marginBottom: 6 },
  flipABlock: { padding: 8, borderRadius: 12, marginBottom: 6 },
  flipA: { fontSize: 13, lineHeight: 20 },
  flipAText: { fontSize: 13, lineHeight: 20, marginBottom: 4 },
  flipPending: { fontSize: 12, fontWeight: '700' },
  flipMeta: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  flipTag: { fontSize: 10, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  flipPrivacy: { fontSize: 10, fontWeight: '700' },
  flipCost: { fontSize: 10 },
  flipElapsed: { fontSize: 10, fontWeight: '700' },
  flipRemain: { fontSize: 10, fontWeight: '700' },
  flipPlayBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18 },
  flipPlayText: { fontSize: 12, fontWeight: '800' },
  flipAudio: { height: 52, marginTop: 8, backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: 10 },
  flipVideo: { height: 150, marginTop: 8, backgroundColor: '#000', borderRadius: 10 },
  imgModal: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' },
  imgFull: { width: '96%', height: '80%' },
  videoModal: { flex: 1, backgroundColor: '#000' },
  videoClose: { paddingTop: 50, paddingHorizontal: 16, paddingBottom: 8, alignSelf: 'flex-start' },
  videoCloseText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  videoPlayer: { flex: 1, backgroundColor: '#000' },
  flipCardRange: { fontSize: 10, marginTop: 2 },
  sectionSub: { fontSize: 12, fontWeight: '700', marginBottom: 8 },
  flipChipScroll: { marginBottom: 10, marginTop: 4, flexGrow: 0 },
  flipChipRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14 },
  flipChip: { flexShrink: 0 },
});

