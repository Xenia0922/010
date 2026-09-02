import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  BackHandler,
  Image,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import PlayerScreen, { buildPocketHeaders } from '../player';
import { Member } from '../types';
import MemberPicker from '../components/MemberPicker';
import { useSettingsStore, useUiStore } from '../store';
import { FadeInView, ScalePressable } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/StateViews';
import pocketApi from '../api/pocket48';
import { translate, useI18n } from '../i18n';
import { enqueueDownload } from '../services/downloads';
import { errorMessage, normalizeUrl, parseMaybeJson, pickText, unwrapList } from '../utils/data';
import { formatTimestamp } from '../utils/format';
import { openNativeLivePlayer } from '../native/LivePlayer';
import { usePalette } from '../theme';

interface OpenLiveItem {
  key: string;
  liveId: string;
  pageId: string;
  title: string;
  nickname: string;
  cover: string;
  msgTime: number;
  raw: any;
}

function parseExtInfo(item: any) {
  const raw = item?.extInfo || item?.ext || item?.body || item?.bodys || item?.msgContent || '';
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  const fixed = String(raw).replace(/:\s*([0-9]{16,})/g, ':"$1"');
  return parseMaybeJson(fixed) || {};
}

function normalizeCover(value: string) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `https://source.48.cn${url.startsWith('/') ? '' : '/'}${url}`;
}

function messageTime(item: any) {
  const time = Number(item?.msgTime || item?.ctime || item?.time || 0);
  return Number.isFinite(time) ? time : 0;
}

function normalizeOpenLiveMessage(item: any, index: number): OpenLiveItem | null {
  const info = parseExtInfo(item);
  const liveId = String(info.liveId || info.live_id || info.videoId || '').trim();
  const pageId = String(info.id || info.openLivePageId || liveId || '').trim();
  if (!liveId && !pageId) return null;
  const title = String(info.title || info.liveTitle || item?.title || translate('公演记录'));
  const nickname = String(info.user?.nickname || info.nickname || info.memberName || info.ownerName || '');
  const msgTime = messageTime(item);
  const msgId = String(item?.msgidClient || item?.msgId || item?.messageId || item?.id || '');
  return {
    key: msgId || `${liveId || pageId}-${msgTime}-${index}`,
    liveId: liveId || pageId,
    pageId: pageId || liveId,
    title,
    nickname,
    cover: normalizeCover(String(info.coverUrl || info.coverPath || info.picPath || '')),
    msgTime,
    raw: item,
  };
}

function normalizeOpenLiveList(res: any): OpenLiveItem[] {
  const source = res?.content ?? res?.data ?? res;
  let list = Array.isArray(source?.message) ? source.message
    : Array.isArray(source?.messageList) ? source.messageList
    : unwrapList(res, [
      'content.message',
      'content.messageList',
      'content.list',
      'data.message',
      'data.messageList',
      'message',
      'messageList',
      'list',
    ]);
  return list
    .map((item: any, index: number) => normalizeOpenLiveMessage(item, index))
    .filter(Boolean) as OpenLiveItem[];
}

function nextTimeFrom(res: any) {
  const value = Number(pickText(res, ['content.nextTime', 'data.nextTime', 'nextTime']));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeOpenLive(prev: OpenLiveItem[], next: OpenLiveItem[]) {
  const seen = new Set(prev.map((item) => item.key || item.liveId));
  const merged = [...prev];
  next.forEach((item) => {
    const key = item.key || item.liveId;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

function scoreStream(url: string) {
  const lower = url.toLowerCase();
  if (lower.includes('.mp4')) return 100;
  if (lower.includes('.m3u8')) return 90;
  if (lower.includes('.flv')) return 70;
  if (lower.startsWith('rtmp://')) return 60;
  return 40;
}

function pickPlayableUrl(res: any) {
  const streams = unwrapList(res, ['content.playStreams', 'content.streams', 'data.playStreams', 'playStreams']);
  const highQuality = streams.find((stream: any) => Number(stream?.streamType) === 2);
  const highQualityUrl = normalizeUrl(pickText(highQuality, ['streamPath', 'playStreamPath', 'url', 'playUrl']));
  if (highQualityUrl) return highQualityUrl;
  const urls = [
    ...streams.map((item) => normalizeUrl(pickText(item, ['streamPath', 'playStreamPath', 'url', 'playUrl', 'flv', 'm3u8']))),
    normalizeUrl(pickText(res, [
      'content.playStreamPath',
      'content.streamPath',
      'content.playUrl',
      'content.url',
      'data.playStreamPath',
      'data.streamPath',
      'data.playUrl',
      'playStreamPath',
      'streamPath',
      'url',
    ])),
  ].filter(Boolean);
  return Array.from(new Set(urls)).sort((a, b) => scoreStream(b) - scoreStream(a))[0] || '';
}

function needsNative(url: string) {
  const lower = url.toLowerCase();
  return lower.startsWith('rtmp://') || lower.includes('.flv');
}

function shortMemberName(member?: Member | null) {
  return String(member?.ownerName || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48)-/, '');
}

export default function OpenLiveScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((state) => state.showToast);
  const [member, setMember] = useState<Member | null>(null);
  const [items, setItems] = useState<OpenLiveItem[]>([]);
  const [query, setQuery] = useState('');
  const [nextTime, setNextTime] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [listError, setListError] = useState('');
  const [playing, setPlaying] = useState<{ url: string; title: string } | null>(null);
  const loadingRef = useRef(false);

  // 播放器生命周期已由统一 PlayerScreen/FullscreenManager 管理（横屏/竖屏/PiP/返回键）

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!playing) return false;
      setPlaying(null);
      return true;
    });
    return () => subscription.remove();
  }, [playing]);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return items;
    return items.filter((item) => `${item.title} ${item.nickname} ${item.liveId}`.toLowerCase().includes(text));
  }, [items, query]);

  const loadMemberShows = async (nextMember: Member, append = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setMember(nextMember);
    if (!append) {
      setItems([]);
      setNextTime(0);
      setHasMore(false);
    }
    setStatus('');
    setListError('');
    try {
      const cursor = append ? nextTime : 0;
      const res = await pocketApi.getOpenLive({ memberId: nextMember.id, nextTime: cursor });
      const nextItems = normalizeOpenLiveList(res);
      const nextCursor = nextTimeFrom(res);
      const merged = append ? mergeOpenLive(items, nextItems) : nextItems;
      setItems((prev) => (append ? mergeOpenLive(prev, nextItems) : nextItems));
      setNextTime(nextCursor);
      setHasMore(nextItems.length > 0 && !!nextCursor && nextCursor !== cursor);
      const text = merged.length ? t('共 {count} 场', { count: merged.length }) : t('未找到相关记录');
      setStatus(text);
      showToast(text);
    } catch (error) {
      const text = t('加载失败：{error}', { error: errorMessage(error) });
      setListError(errorMessage(error));
      setStatus(text);
      showToast(text);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const loadMore = () => {
    if (!member || loading || loadingRef.current || !hasMore || !nextTime) return;
    loadMemberShows(member, true);
  };

  const resolveStream = async (item: OpenLiveItem) => {
    const detail = await pocketApi.getOpenLiveOne(item.liveId);
    const url = pickPlayableUrl(detail);
    if (!url) throw new Error(t('没有解析到播放地址'));
    return url;
  };

  const playItem = async (item: OpenLiveItem) => {
    setStatus(t('正在解析播放地址...'));
    try {
      const url = await resolveStream(item);
      if (needsNative(url)) {
        await openNativeLivePlayer(url, item.title, { liveId: item.liveId });
      } else {
        setPlaying({ url, title: item.title });
      }
      setStatus(t('播放地址已就绪'));
    } catch (error) {
      const text = t('播放失败：{error}', { error: errorMessage(error) });
      setStatus(text);
      showToast(text);
    }
  };

  const downloadItem = async (item: OpenLiveItem) => {
    try {
      const url = await resolveStream(item);
      await enqueueDownload({ url, type: 'replay', name: item.title });
      showToast(t('已加入下载管理'));
    } catch (error) {
      showToast(t('下载失败：{error}', { error: errorMessage(error) }));
    }
  };

  if (playing) {
    // 统一播放器（重写）：公演回放 → PlayerScreen（控制条/全屏/内核切换/错误重试内置）
    return (
      <View style={styles.playerPage}>
        <PlayerScreen
          source={{ kind: 'vod', url: playing.url, headers: buildPocketHeaders() }}
          meta={{ title: playing.title }}
          features={{ kernelSwitch: true }}
          onClose={() => setPlaying(null)}
          persistent
        >
          <TouchableOpacity activeOpacity={0.7} style={[styles.externalBtn, { backgroundColor: palette.tint }]} onPress={() => Linking.openURL(String(playing.url || '')).catch(() => {})}>
            <Text style={[styles.externalText, { color: palette.onTint }]}>{t('外部打开')}</Text>
          </TouchableOpacity>
        </PlayerScreen>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('公演记录')} right={
        <HeaderAction label={t('刷新')} disabled={!member || loading} onPress={() => member && loadMemberShows(member)} />
      } />

      <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
        <View style={styles.controls}>
          <MemberPicker selectedMember={member} onSelect={(next) => loadMemberShows(next, false)} placeholder={t('搜索成员并打开公演记录...')} />
          <View style={[styles.searchBar, { backgroundColor: palette.fill2 }]}>
            <MaterialCommunityIcons name="magnify" size={16} color={palette.labelTertiary} />
            <TextInput
              style={[styles.searchInput, { color: palette.label }]}
              placeholder={t('筛选标题、成员、liveId...')}
              placeholderTextColor={palette.labelTertiary}
              value={query}
              onChangeText={setQuery}
              returnKeyType="search"
            />
            {query ? (
              <ScalePressable onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.7}>
                <MaterialCommunityIcons name="close-circle" size={16} color={palette.labelTertiary} />
              </ScalePressable>
            ) : null}
          </View>
          {member && status ? (
            <Text style={[styles.status, { color: palette.labelSecondary }]}>{loading && !items.length ? '' : status}</Text>
          ) : null}
        </View>

        <PerfFlatList
          data={filtered}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.list}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          onEndReached={loadMore}
          onEndReachedThreshold={0.35}
          ListEmptyComponent={
            loading ? (
              <View style={styles.skeletonWrap}>
                {Array.from({ length: 4 }).map((_, i) => (
                  <View key={i} style={[styles.skeletonCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                    <Skeleton width={56} height={56} radius={12} />
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Skeleton width="70%" height={13} />
                      <Skeleton width="40%" height={10} style={{ marginTop: 8 }} />
                      <Skeleton width="50%" height={10} style={{ marginTop: 8 }} />
                    </View>
                  </View>
                ))}
              </View>
            ) : listError ? (
              <ErrorState title={t('加载失败')} hint={listError} onAction={() => member && loadMemberShows(member)} />
            ) : (
              <EmptyState
                icon="playlist-play"
                title={member ? t('暂无公演记录') : t('请搜索选择成员查看公演记录')}
              />
            )
          }
          ListFooterComponent={items.length ? (
            <Text style={[styles.footerText, { color: palette.labelTertiary }]}>
              {loading ? '' : hasMore ? t('上滑加载更多') : t('没有更多了')}
            </Text>
          ) : null}
          renderItem={({ item, index }) => (
            <FadeInView delay={index < 12 ? 60 + index * 25 : 0} duration={360}>
              <ScalePressable
                style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}
                activeOpacity={0.85}
                pressedScale={0.97}
                onPress={() => playItem(item)}
                onLongPress={() => downloadItem(item)}
              >
                {item.cover ? (
                  <Image source={{ uri: item.cover }} style={[styles.cover, { backgroundColor: palette.fill2 }]} resizeMode="cover" />
                ) : (
                  <View style={[styles.cover, styles.coverPlaceholder, { backgroundColor: palette.tintSoft }]}>
                    <MaterialCommunityIcons name="play" size={24} color={palette.tint} />
                  </View>
                )}
                <View style={styles.cardBody}>
                  <Text style={[styles.cardTitle, { color: palette.label }]} numberOfLines={2}>{item.title}</Text>
                  <Text style={[styles.meta, { color: palette.labelSecondary }]} numberOfLines={1}>{item.nickname || shortMemberName(member) || t('成员')}</Text>
                  <View style={styles.cardFoot}>
                    <Text style={[styles.time, { color: palette.labelSecondary }]}>{formatTimestamp(item.msgTime)}</Text>
                    <View style={[styles.badge, { backgroundColor: palette.tintSoft }]}>
                      <MaterialCommunityIcons name="play-circle-outline" size={12} color={palette.tint} />
                      <Text style={[styles.badgeText, { color: palette.tint }]}>{t('可看')}</Text>
                    </View>
                  </View>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={palette.labelTertiary} style={styles.chevron} />
              </ScalePressable>
            </FadeInView>
          )}
        />
      </FadeInView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  controls: { paddingHorizontal: 14, gap: 8, marginBottom: 8 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    borderRadius: 14,
    paddingHorizontal: 12,
    gap: 6,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0, margin: 0 },
  status: { fontSize: 12, lineHeight: 18 },
  list: { padding: 14, paddingBottom: 112 },
  card: { flexDirection: 'row', alignItems: 'center', padding: 10, marginVertical: 4, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  cover: { width: 56, height: 56, borderRadius: 12 },
  coverPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, minWidth: 0, paddingLeft: 12 },
  cardTitle: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  meta: { fontSize: 12, marginTop: 3 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  time: { fontSize: 11 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  chevron: { marginLeft: 6 },
  footerText: { marginVertical: 14, textAlign: 'center', fontSize: 12, fontWeight: '700' },
  playerPage: { flex: 1, backgroundColor: '#000000' },
  player: { flex: 1, backgroundColor: '#000000' },
  playerErrorWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  playerErrorText: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  playerRetryBtn: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 9, borderRadius: 18 },
  playerRetryText: { fontSize: 13, fontWeight: '800' },
  externalBtn: { margin: 16, minHeight: 44, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  externalText: { fontWeight: '900' },
  skeletonWrap: { padding: 4 },
  skeletonCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    marginVertical: 4,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
