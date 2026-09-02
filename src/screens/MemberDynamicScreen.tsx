import React, { useCallback, useEffect, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';
import { usePaginator } from '../hooks/usePaginator';

import {
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import { FadeInView, ScalePressable } from '../components/Motion';
import MemberPicker from '../components/MemberPicker';
import ZoomImageModal from '../components/ZoomImageModal';
import pocketApi from '../api/pocket48';
import { errorMessage, parseMaybeJson } from '../utils/data';
import { formatCount, formatTimestamp } from '../utils/format';
import { Member } from '../types';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { HeaderAction } from '../components/HeaderAction';
import { Skeleton } from '../components/Skeleton';
import { usePalette } from '../theme';
import { useI18n } from '../i18n';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

interface DynItem {
  key: string;
  title: string;
  content: string;
  coverUrls: string[];
  time: number;
  ownerName: string;
  ownerAvatar: string;
  likeCount: number;
  forwardCount: number;
}

function parseExt(raw: any) {
  try {
    const ext = typeof raw === 'string' ? (() => {
      try { return JSON.parse(raw); } catch {
        const fixed = String(raw).replace(/:\s*([0-9]{15,})/g, ':"$1"');
        return parseMaybeJson(fixed) || {};
      }
    })() : (raw || {});
    const coverList = Array.isArray(ext.coverUrlList) ? ext.coverUrlList
      : Array.isArray(ext.body?.coverUrlList) ? ext.body.coverUrlList : [];
    const statLike = Number(ext.likeCount ?? ext.likeNum ?? ext.reactionCount ?? ext.reactionNum ?? 0);
    const statForward = Number(ext.forwardCount ?? ext.forwardNum ?? ext.shareCount ?? ext.transmitCount ?? 0);
    return {
      title: String(ext.title || ext.body?.title || '').trim(),
      content: String(ext.content || ext.body?.text || ext.text || '').trim(),
      coverUrls: coverList.map((u: any) => String(u?.url || u || '').trim()).filter(Boolean),
      ownerName: String(ext.user?.nickname || ext.nickname || '').trim(),
      ownerAvatar: String(ext.user?.avatar || ext.avatar || '').trim(),
      likeCount: Number.isFinite(statLike) ? statLike : 0,
      forwardCount: Number.isFinite(statForward) ? statForward : 0,
    };
  } catch { return { title: '', content: '', coverUrls: [], ownerName: '', ownerAvatar: '', likeCount: 0, forwardCount: 0 }; }
}

function normalizeItem(raw: any, index: number): DynItem | null {
  const ext = parseExt(raw?.extInfo || raw?.bodys || raw?.msgContent);
  const time = Number(raw?.msgTime || raw?.ctime || 0);
  if (!ext.title && !ext.content && !ext.coverUrls.length) return null;
  return { key: String(raw?.msgId || raw?.id || `dyn-${index}`), ...ext, time: Number.isFinite(time) ? time : 0 };
}

export default function MemberDynamicScreen() {
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const { t } = useI18n();
  const [member, setMember] = useState<Member | null>(null);
  const [error, setError] = useState('');
  const [zoomUrl, setZoomUrl] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // 翻页串行化：
  // 用同步 ref 锁挡住 onEndReached 连发，再用 runId 丢弃过期响应，避免重复请求/重复追加/cursor 漂移
  const fetchPage = useCallback(async (cursor: number) => {
    if (!member) return { items: [] as DynItem[], nextCursor: cursor, hasMore: false };
    setError('');
    try {
      const res = await pocketApi.getMemberDynamic({ ownerId: member.id, nextTime: cursor });
      const data = res?.content || res?.data || {};
      const list = Array.isArray(data?.messageList || data?.message || data?.list || data)
        ? (data?.messageList || data?.message || data?.list || data) : [];
      const normalized = list.map((item: any, idx: number) => normalizeItem(item, idx)).filter(Boolean) as DynItem[];
      const nextCursor = Number(data?.nextTime || data?.next || 0);
      return { items: normalized, nextCursor, hasMore: nextCursor > 0 && normalized.length > 0 };
    } catch (e: any) {
      setError(errorMessage(e));
      return { items: [] as DynItem[], nextCursor: cursor, hasMore: false };
    }
  }, [member]);

  const pag = usePaginator<DynItem>({ fetchPage, initialCursor: 0 });
  const { items, loading, hasMore, refresh, loadMore, loadingRef } = pag;

  useEffect(() => {
    if (member) refresh();
  }, [member, refresh]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const renderItem = ({ item, index }: { item: DynItem; index: number }) => (
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
        {item.title ? <Text style={[styles.dynTitle, { color: palette.label }]} numberOfLines={2}>{item.title}</Text> : null}
        {item.content ? <Text style={[styles.dynContent, { color: palette.label }]} numberOfLines={6}>{item.content}</Text> : null}
        {item.coverUrls.length > 0 && (
          <View style={styles.imageGrid}>
            {item.coverUrls.slice(0, 9).map((url, idx) => (
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
                <MaterialCommunityIcons name="heart-outline" size={13} color={palette.labelSecondary} />
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
        <View style={[styles.hairline, { backgroundColor: palette.hairline }]} />
      </View>
    </FadeInView>
  );

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('成员动态')} onBack={() => navigation.goBack()} right={
        <HeaderAction label={t('刷新')} disabled={!member || loading} onPress={() => refresh()} />
      } />
      <MemberPicker selectedMember={member} onSelect={setMember} placeholder={t('搜索成员查看动态...')} />
      <PerfFlatList
        data={items}
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
        onEndReached={() => { if (hasMore && !loadingRef.current) loadMore(); }}
        onEndReachedThreshold={0.35}
        renderItem={renderItem}
        ListFooterComponent={
          items.length ? <Text style={[styles.footer, { color: palette.labelSecondary }]}>
            {loading ? '' : hasMore ? t('上滑继续加载') : t('没有更多了')}
          </Text> : null
        }
        ListEmptyComponent={
          loading && !items.length ? (
            <CenterSpinner />
          ) : error ? (
            <ErrorState title={t('加载失败')} hint={error} onAction={() => refresh()} />
          ) : (
            <EmptyState
              icon="star-circle-outline"
              title={member ? t('暂无动态') : t('请搜索选择成员查看动态')}
            />
          )
        }
      />
      <ZoomImageModal url={zoomUrl} onClose={() => setZoomUrl('')} />
    </View>
  );
}

const avatarSize = 40;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  list: { padding: 8, paddingBottom: 40 },
  card: { borderRadius: 16, padding: 14, marginVertical: 4 },
  ownerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  ownerAvatar: { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2, marginRight: 10, overflow: 'hidden' },
  ownerMeta: { flex: 1, minWidth: 0 },
  ownerName: { fontSize: 14, fontWeight: '700', lineHeight: 18 },
  ownerTime: { fontSize: 11, marginTop: 2 },
  dynTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6, lineHeight: 21 },
  dynContent: { fontSize: 15, lineHeight: 22, marginBottom: 10 },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4 },
  gridItem: { flexBasis: '31%', flexGrow: 1, aspectRatio: 1, borderRadius: 10, overflow: 'hidden' },
  gridImage: { width: '100%', height: '100%' },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 10 },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { fontSize: 12 },
  hairline: { height: StyleSheet.hairlineWidth, marginTop: 12 },
  footer: { textAlign: 'center', fontSize: 12, paddingVertical: 10 },
  skeletonWrap: { padding: 8 },
  skeletonCard: { borderRadius: 16, padding: 14, marginVertical: 4, borderWidth: StyleSheet.hairlineWidth },
  skeletonHead: { flexDirection: 'row' },
});
