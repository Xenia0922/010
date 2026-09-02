import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  Image,
  Linking,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import ScreenHeader from '../components/ScreenHeader';
import { FadeInView, ScalePressable } from '../components/Motion';
import { HeaderAction } from '../components/HeaderAction';
import MemberPicker from '../components/MemberPicker';
import ZoomImageModal from '../components/ZoomImageModal';
import pocketApi from '../api/pocket48';
import { errorMessage, parseMaybeJson } from '../utils/data';
import { formatCount, formatTimestamp } from '../utils/format';
import { Member } from '../types';
import { usePalette } from '../theme';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useI18n } from '../i18n';
import { useUiStore } from '../store';
import { Skeleton } from '../components/Skeleton';

interface WbItem {
  key: string;
  title: string;
  content: string;
  imageUrls: string[];
  jumpUrl: string;
  time: number;
  ownerName: string;
  ownerAvatar: string;
  likeCount: number;
  forwardCount: number;
}

function parseWbExt(raw: any) {
  try {
    const ext = typeof raw === 'string' ? (() => {
      try { return JSON.parse(raw); } catch {
        const fixed = String(raw).replace(/:\s*([0-9]{15,})/g, ':"$1"');
        return parseMaybeJson(fixed) || {};
      }
    })() : (raw || {});
    const jp = String(ext.jumpPath || ext.body?.jumpPath || ext.url || ext.schemeUrl || '').trim();
    const imgList = Array.isArray(ext.imageList) ? ext.imageList : Array.isArray(ext.body?.imageList) ? ext.body.imageList : [];
    const statLike = Number(ext.likeCount ?? ext.likeNum ?? 0);
    const statForward = Number(ext.forwardCount ?? ext.forwardNum ?? ext.repostsCount ?? 0);
    return {
      title: String(ext.title || ext.body?.title || '').trim(),
      content: String(ext.text || ext.body?.text || ext.content || '').trim(),
      imageUrls: imgList.map((u: any) => String(u?.url || u || '').trim()).filter(Boolean),
      jumpUrl: jp.startsWith('http') ? jp : (jp ? `https://m.weibo.cn${jp.startsWith('/') ? '' : '/'}${jp}` : ''),
      ownerName: String(ext.user?.nickname || ext.nickname || '').trim(),
      ownerAvatar: String(ext.user?.avatar || ext.avatar || '').trim(),
      likeCount: Number.isFinite(statLike) ? statLike : 0,
      forwardCount: Number.isFinite(statForward) ? statForward : 0,
    };
  } catch { return { title: '', content: '', imageUrls: [], jumpUrl: '', ownerName: '', ownerAvatar: '', likeCount: 0, forwardCount: 0 }; }
}

function normalizeItem(raw: any, index: number): WbItem | null {
  const ext = parseWbExt(raw?.extInfo || raw?.bodys || raw?.msgContent);
  const rawTime = Number(raw?.msgTime || raw?.ctime || 0);
  // Y25: 秒级(10位)时间戳 → 毫秒
  const time = rawTime > 0 && rawTime < 10000000000 ? rawTime * 1000 : rawTime;
  if (!ext.content && !ext.imageUrls.length) return null;
  return { key: String(raw?.msgId || raw?.id || `wb-${index}`), ...ext, time: Number.isFinite(time) ? time : 0 };
}

export default function MemberWeiboScreen() {
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const { t } = useI18n();
  const [member, setMember] = useState<Member | null>(null);
  const [items, setItems] = useState<WbItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [nextTime, setNextTime] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [zoomUrl, setZoomUrl] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // 同步锁 + runId：防止快速切换成员/连发分页时旧响应覆盖新数据
  const fetchingRef = useRef(false);
  const runIdRef = useRef(0);

  const fetchData = useCallback(async (reset = false) => {
    if (!member || fetchingRef.current) return;
    fetchingRef.current = true;
    const runId = reset ? ++runIdRef.current : runIdRef.current;
    if (reset) { setLoading(true); setNextTime(0); } else { setLoadingMore(true); }
    setError('');
    try {
      const res = await pocketApi.getMemberWeibo({ ownerId: member.id, nextTime: reset ? 0 : nextTime });
      if (runId !== runIdRef.current) return;
      const data = res?.content || res?.data || {};
      const list = Array.isArray(data?.messageList || data?.message || data?.list || data)
        ? (data?.messageList || data?.message || data?.list || data) : [];
      const normalized = list.map((item: any, idx: number) => normalizeItem(item, idx)).filter(Boolean) as WbItem[];
      if (reset) setItems(normalized); else setItems((prev) => [...prev, ...normalized]);
      const cursor = Number(data?.nextTime || data?.next || 0);
      setNextTime(cursor);
      // 游标不前进（恒同本次请求值）即终止，防死循环
      setHasMore(cursor > 0 && normalized.length > 0 && cursor !== nextTime);
    } catch (e: any) {
      if (runId !== runIdRef.current) return;
      setError(errorMessage(e));
    } finally {
      fetchingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [member, nextTime]);

  useEffect(() => { if (member) fetchData(true); }, [member]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await fetchData(true); } finally { setRefreshing(false); }
  }, [fetchData]);

  // 时间分组（结构升级）：今天 / 昨天 / 更早 三组扁平化渲染，组头吸顶感 + 日期分组导航，替代无差别长流
  const wbRows = useMemo(() => {
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const keyOf = (ts: number) => {
      if (!ts) return '';
      const d = new Date(ts);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const yest = new Date(now.getTime() - 86400000);
    const yestStr = `${yest.getFullYear()}-${pad(yest.getMonth() + 1)}-${pad(yest.getDate())}`;
    const groupLabel = (k: string) => {
      if (!k) return t('未知时间');
      if (k === todayStr) return t('今天');
      if (k === yestStr) return t('昨天');
      return k.replace(/-/g, '/');
    };
    const order: string[] = [];
    const map = new Map<string, WbItem[]>();
    for (const it of items) {
      const k = keyOf(it.time) || 'unknown';
      if (!map.has(k)) { map.set(k, []); order.push(k); }
      map.get(k)!.push(it);
    }
    const rows: { type: 'header' | 'item'; key: string; title?: string; item?: WbItem }[] = [];
    for (const k of order) {
      rows.push({ type: 'header', key: `h-${k}`, title: groupLabel(k) });
      map.get(k)!.forEach((it, idx) => rows.push({ type: 'item', key: `i-${it.key}-${idx}`, item: it }));
    }
    return rows;
  }, [items, t]);

  const renderRow = ({ item, index }: { item: { type: 'header' | 'item'; key: string; title?: string; item?: WbItem }; index: number }) => {
    if (item.type === 'header') {
      return (
        <View style={[styles.groupHeader, { backgroundColor: palette.background }]}>
          <Text style={[styles.groupHeaderText, { color: palette.labelSecondary }]}>{item.title}</Text>
        </View>
      );
    }
    return renderItem({ item: item.item as WbItem, index });
  };

  const renderItem = ({ item, index }: { item: WbItem; index: number }) => (
    <FadeInView delay={index < 12 ? 60 + index * 25 : 0} duration={360}>
      <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
        {item.ownerName ? (
          <View style={styles.ownerRow}>
            {item.ownerAvatar ? (
              <Image source={{ uri: item.ownerAvatar }} style={[styles.ownerAvatar, { backgroundColor: palette.fill3 }]} />
            ) : (
              <View style={[styles.ownerAvatar, { backgroundColor: palette.fill3, alignItems: 'center', justifyContent: 'center' }]}>
                <MaterialCommunityIcons name="account" size={18} color={palette.labelTertiary} />
              </View>
            )}
            <View style={styles.ownerMeta}>
              <Text style={[styles.ownerName, { color: palette.label }]} numberOfLines={1}>{item.ownerName}</Text>
              {item.time > 0 ? <Text style={[styles.ownerTime, { color: palette.labelTertiary }]}>{formatTimestamp(item.time)}</Text> : null}
            </View>
          </View>
        ) : null}
        {item.title ? <Text style={[styles.wbTitle, { color: palette.label }]} numberOfLines={2}>{item.title}</Text> : null}
        {item.content ? <Text style={[styles.wbContent, { color: palette.label }]} numberOfLines={6}>{item.content}</Text> : null}
        {item.imageUrls.length > 0 && (
          <View style={styles.imageGrid}>
            {item.imageUrls.slice(0, 9).map((url, idx) => (
              <ScalePressable key={idx} onPress={() => setZoomUrl(url)} pressedScale={0.96} style={styles.gridItem}>
                <Image source={{ uri: url }} style={[styles.gridImage, { backgroundColor: palette.fill3 }]} resizeMode="cover" />
              </ScalePressable>
            ))}
          </View>
        )}
        {(item.likeCount > 0 || item.forwardCount > 0) && (
          <View style={styles.statsRow}>
            {item.likeCount > 0 ? (
              <View style={styles.statItem}>
                <MaterialCommunityIcons name="thumb-up-outline" size={13} color={palette.labelSecondary} />
                <Text style={[styles.statText, { color: palette.labelSecondary }]}>{formatCount(item.likeCount)}</Text>
              </View>
            ) : null}
            {item.forwardCount > 0 ? (
              <View style={styles.statItem}>
                <MaterialCommunityIcons name="share-outline" size={13} color={palette.labelSecondary} />
                <Text style={[styles.statText, { color: palette.labelSecondary }]}>{t('转发')} {formatCount(item.forwardCount)}</Text>
              </View>
            ) : null}
          </View>
        )}
        {item.jumpUrl ? (
          <ScalePressable
            style={[styles.linkBtn, { backgroundColor: palette.tintSoft }]}
            onPress={() => Linking.openURL(String(item.jumpUrl || '')).catch(() => useUiStore.getState().showToast(t('无法打开该链接')))}
            pressedScale={0.97}
          >
            <MaterialCommunityIcons name="open-in-new" size={14} color={palette.tint} style={styles.linkIcon} />
            <Text style={[styles.linkBtnText, { color: palette.tint }]}>{t('查看微博原文')}</Text>
          </ScalePressable>
        ) : null}
        <View style={[styles.hairline, { backgroundColor: palette.hairline }]} />
      </View>
    </FadeInView>
  );

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('成员微博')} onBack={() => navigation.goBack()} right={
        <HeaderAction label={t('刷新')} disabled={!member || loading} onPress={() => fetchData(true)} />
      } />
      <MemberPicker selectedMember={member} onSelect={setMember} placeholder={t('搜索成员查看微博...')} />
      <PerfFlatList
        data={wbRows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={palette.tint}
            colors={[palette.tint]}
            progressBackgroundColor={palette.surface}
          />
        }
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        onEndReached={() => { if (hasMore && !loadingMore) fetchData(false); }}
        onEndReachedThreshold={0.35}
        renderItem={renderRow}
        ListFooterComponent={
          items.length ? <Text style={[styles.footer, { color: palette.labelSecondary }]}>
            {loadingMore ? '' : hasMore ? t('上滑加载更多') : t('没有更多了')}
          </Text> : null
        }
        ListEmptyComponent={
          loading && !items.length ? (
            <CenterSpinner />
          ) : error ? (
            <ErrorState title={t('加载失败')} hint={error} onAction={() => fetchData(true)} />
          ) : (
            <EmptyState
              icon="web"
              title={member ? t('暂无微博') : t('请搜索选择成员查看微博')}
            />
          )
        }
      />
      <ZoomImageModal url={zoomUrl} onClose={() => setZoomUrl('')} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  list: { padding: 8, paddingBottom: 40 },
  groupHeader: { paddingHorizontal: 10, paddingVertical: 8, marginTop: 4 },
  groupHeaderText: { fontSize: 12, fontWeight: '700' },
  card: { borderRadius: 16, padding: 14, marginVertical: 4 },
  ownerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  ownerAvatar: { width: 40, height: 40, borderRadius: 20, marginRight: 10, overflow: 'hidden' },
  ownerMeta: { flex: 1, minWidth: 0 },
  ownerName: { fontSize: 14, fontWeight: '700', lineHeight: 18 },
  ownerTime: { fontSize: 11, marginTop: 2 },
  wbTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6, lineHeight: 21 },
  wbContent: { fontSize: 15, lineHeight: 22, marginBottom: 10 },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4 },
  gridItem: { flexBasis: '31%', flexGrow: 1, aspectRatio: 1, borderRadius: 10, overflow: 'hidden' },
  gridImage: { width: '100%', height: '100%' },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 10 },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { fontSize: 12 },
  linkBtn: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18, marginTop: 10 },
  linkIcon: { marginRight: 4 },
  linkBtnText: { fontSize: 13, fontWeight: '600' },
  hairline: { height: StyleSheet.hairlineWidth, marginTop: 12 },
  footer: { textAlign: 'center', fontSize: 12, paddingVertical: 10 },
  skeletonWrap: { padding: 8 },
  skeletonCard: { borderRadius: 16, padding: 14, marginVertical: 4, borderWidth: StyleSheet.hairlineWidth },
  skeletonHead: { flexDirection: 'row' },
});
