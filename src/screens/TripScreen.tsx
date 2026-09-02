import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  Linking,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { CenterSpinner } from '../components/Loaders';
import { ErrorState, EmptyState } from '../components/StateViews';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { FadeInView, ScalePressable } from '../components/Motion';
import MemberPicker from '../components/MemberPicker';
import pocketApi from '../api/pocket48';
import { errorMessage, unwrapList } from '../utils/data';
import { Member, TripItem } from '../types';
import { usePalette } from '../theme';
import { useI18n } from '../i18n';
import { useUiStore } from '../store';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

function parseTripDate(raw: string): { date: string; time: string } {
  const str = String(raw || '');
  const parts = str.split(/\s+/);
  return { date: parts[0] || '', time: parts.slice(1).join(' ') || '' };
}

function normalizeTripItem(raw: any, index: number): TripItem | null {
  if (!raw || typeof raw !== 'object') return null; // Y27: unwrapList BFS 可能带 null 元素
  const id = String(raw.id || raw.tripId || raw.dataId || `trip-${index}`);
  const showDate = String(raw.showDate || raw.show_date || raw.date || '');
  const showTime = String(raw.showTime || raw.show_time || raw.time || '');
  const { date, time } = showDate
    ? parseTripDate(`${showDate} ${showTime}`)
    : { date: '', time: '' };
  return {
    id,
    title: String(raw.title || raw.tripName || '').trim(),
    subtitle: String(raw.subtitle || raw.subTitle || '').trim(),
    description: String(raw.description || raw.desc || '').trim(),
    date,
    time,
    showDate,
    showTime,
    members: Array.isArray(raw.members) ? raw.members.map(String) : [],
    location: String(raw.location || raw.place || '').trim(),
    liveText: String(raw.liveText || raw.live_text || '').trim(),
    ticketUrl: String(raw.ticketUrl || raw.ticket_url || '').trim(),
    groupId: Number(raw.groupId || raw.group_id || 0),
    memberId: String(raw.memberId || raw.member_id || ''),
    userId: String(raw.userId || raw.user_id || ''),
  };
}

function normalizeTripList(res: any): TripItem[] {
  const list = unwrapList(res?.content || res?.data || res);
  return (Array.isArray(list) ? list : [])
    .map((item: any, idx: number) => normalizeTripItem(item, idx))
    .filter(Boolean) as TripItem[];
}

/** 行程节点状态：today = 今天（粉实心），past = 已过期（灰），future = 未来（粉描边） */
type TripNodeState = 'today' | 'past' | 'future';

function tripDateKey(showDate: string): string {
  return String(showDate || '').trim().replace(/-/g, '/');
}

function tripNodeState(showDate: string, todayKey: string): TripNodeState {
  const key = tripDateKey(showDate);
  if (!key) return 'future';
  const t = todayKey.replace(/-/g, '/');
  if (key === t) return 'today';
  // 字符串比较 YYYY/MM/DD 可直接判断先后
  return key < t ? 'past' : 'future';
}

function todayKey(d = new Date()): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 行程分区：全部 / 即将 / 今天 / 过往（易用性：默认聚焦未来行程，不再上下翻找） */
type TripFilter = 'all' | 'upcoming' | 'today' | 'past';

const TRIP_FILTERS: { key: TripFilter; label: string }[] = [
  { key: 'upcoming', label: '即将' },
  { key: 'today', label: '今天' },
  { key: 'past', label: '过往' },
  { key: 'all', label: '全部' },
];

export default function TripScreen() {
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const { t } = useI18n();
  const [member, setMember] = useState<Member | null>(null);
  const [items, setItems] = useState<TripItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [lastTime, setLastTime] = useState('0');
  const [hasMore, setHasMore] = useState(true);
  const [tripFilter, setTripFilter] = useState<TripFilter>('upcoming');
  const today = todayKey();

  const fetchTrips = useCallback(async (reset = false) => {
    if (reset) { setLoading(true); setLastTime('0'); } else { setLoadingMore(true); }
    setError('');
    try {
      const res = await pocketApi.getTripList({
        memberId: member?.id || '',
        lastTime: reset ? '0' : lastTime,
        isMore: !reset,
      });
      const list = normalizeTripList(res);
      if (reset) setItems(list);
      else setItems((prev) => [...prev, ...list]);
      const cursor = res?.content?.nextTime || res?.content?.next || res?.content?.lastTime;
      // 翻页终止：本页有数据 且 游标确有前进（防止接口返回恒定游标导致死循环）。
      // Y30: 不依赖硬编码 20（接口实际返回条数可能 <20 → 永远停在第一页）
      setHasMore(list.length > 0 && !!cursor && String(cursor) !== lastTime);
      if (cursor) setLastTime(String(cursor));
    } catch (e: any) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [member, lastTime]);

  useEffect(() => { if (member) fetchTrips(true); }, [member]);

  // 分区过滤（纯内存，数据已在手）
  const filteredItems = useMemo(() => {
    if (!tripFilter || tripFilter === 'all') return items;
    return items.filter((item) => {
      const state = tripNodeState(item.showDate, today);
      if (tripFilter === 'today') return state === 'today';
      if (tripFilter === 'past') return state === 'past';
      return state !== 'past'; // upcoming：未来（含今天）
    });
  }, [items, tripFilter, today]);

  // 分区计数（显示在 chip 上，帮助用户感知数据量）
  const filterCounts = useMemo(() => {
    const c: Record<TripFilter, number> = { all: items.length, upcoming: 0, today: 0, past: 0 };
    for (const item of items) {
      const state = tripNodeState(item.showDate, today);
      if (state !== 'past') c.upcoming += 1;
      if (state === 'today') c.today += 1;
      if (state === 'past') c.past += 1;
    }
    return c;
  }, [items, today]);

  // Y32: 当前过滤视图为空但有更多数据 → 自动续拉（空列表时 onEndReached 永不触发，
  //     如 upcoming 过滤下前几页都是已过去行程——此前永远停在「暂无即将到来的行程」）
  useEffect(() => {
    if (filteredItems.length === 0 && hasMore && !loadingMore && !loading && tripFilter !== 'past') {
      fetchTrips(false);
    }
  }, [filteredItems.length, hasMore, loadingMore, loading, tripFilter, fetchTrips]);

  const renderItem = ({ item, index }: { item: TripItem; index: number }) => {
    const state = tripNodeState(item.showDate, today);
    const expired = state === 'past';
    const isToday = state === 'today';
    return (
      <FadeInView delay={index < 12 ? 80 + index * 30 : 0} duration={300}>
        <View style={styles.timelineRow}>
          {/* 左侧时间轴：竖线 + 圆形节点 */}
          <View style={styles.railWrap}>
            <View
              style={[
                styles.rail,
                {
                  backgroundColor: isToday ? palette.tint : palette.fill2,
                },
              ]}
            />
            <View
              style={[
                styles.nodeOuter,
                isToday
                  ? { borderColor: palette.tint }
                  : { borderColor: state === 'past' ? palette.fill3 : palette.tint },
              ]}
            >
              <View
                style={[
                  styles.nodeInner,
                  isToday ? { backgroundColor: palette.tint } : { backgroundColor: 'transparent' },
                ]}
              >
                {isToday ? <View style={[styles.nodeDot, { backgroundColor: '#FFFFFF' }]} /> : null}
              </View>
            </View>
          </View>

          {/* 右侧内容卡（实心白卡圆角16） */}
          <View
            style={[
              styles.card,
              {
                backgroundColor: palette.surface,
                borderColor: isToday ? palette.tint : palette.hairline,
                opacity: expired ? 0.55 : 1,
              },
            ]}
          >
            <View style={styles.cardHead}>
              {item.date ? (
                <View style={[styles.datePill, { backgroundColor: palette.fill2 }]}>
                  <MaterialCommunityIcons
                    name={isToday ? 'calendar-today' : 'calendar-blank-outline'}
                    size={13}
                    color={isToday ? palette.tint : palette.labelTertiary}
                    style={{ marginRight: 4 }}
                  />
                  <Text style={[styles.datePillText, { color: isToday ? palette.tint : palette.labelSecondary }]}>
                    {item.date}{item.time ? ` ${item.time}` : ''}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.cardTitle, { color: palette.label }]} numberOfLines={2}>{item.title}</Text>
            {item.subtitle ? (
              <Text style={[styles.cardSub, { color: palette.labelSecondary }]} numberOfLines={2}>{item.subtitle}</Text>
            ) : null}
            {item.location ? (
              <View style={styles.locationRow}>
                <MaterialCommunityIcons name="map-marker-outline" size={13} color={palette.labelTertiary} />
                <Text style={[styles.locationText, { color: palette.labelSecondary }]} numberOfLines={1}>{item.location}</Text>
              </View>
            ) : null}
            {item.description ? (
              <Text style={[styles.cardDesc, { color: palette.labelSecondary }]} numberOfLines={4}>{item.description}</Text>
            ) : null}
            {item.ticketUrl ? (
              <ScalePressable
                style={styles.linkRow}
                onPress={() => Linking.openURL(String(item.ticketUrl || '')).catch(() => useUiStore.getState().showToast(t('无法打开该链接')))}
                activeOpacity={0.7}
                pressedScale={0.98}
              >
                <Text style={[styles.linkRowText, { color: palette.tint }]}>{t('查看行程')}</Text>
                <MaterialCommunityIcons name="chevron-right" size={16} color={palette.tint} />
              </ScalePressable>
            ) : null}
          </View>
        </View>
      </FadeInView>
    );
  };

  const subtitle = member
    ? `${t('当前成员')}${items.length ? ` · ${t('{count} 行程', { count: items.length })}` : ''}`
    : '';

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('行程')} onBack={() => navigation.goBack()} right={
        <HeaderAction label={t('刷新')} disabled={!member || loading} onPress={() => fetchTrips(true)} />
      } />
      {subtitle ? (
        <Text style={[styles.subtitle, { color: palette.labelSecondary }]}>{subtitle}</Text>
      ) : null}
      <MemberPicker selectedMember={member} onSelect={setMember} placeholder={t('搜索成员查看行程...')} />

      {/* 行程分区页签：即将（默认）/ 今天 / 过往 / 全部 —— 结构升级：不再混排一条时间轴 */}
      {member ? (
        <View style={styles.filterRow}>
          {TRIP_FILTERS.map((f) => {
            const active = tripFilter === f.key;
            const count = filterCounts[f.key];
            return (
              <ScalePressable
                key={f.key}
                onPress={() => setTripFilter(f.key)}
                pressedScale={0.96}
                style={[
                  styles.filterChip,
                  { backgroundColor: active ? palette.tintSoft : palette.fill2, borderColor: active ? palette.tint : 'transparent' },
                ]}
              >
                <Text style={[styles.filterChipText, { color: active ? palette.tint : palette.labelSecondary, fontWeight: active ? '700' : '600' }]}>
                  {t(f.label)}{count > 0 ? ` ${count}` : ''}
                </Text>
              </ScalePressable>
            );
          })}
        </View>
      ) : null}

      <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
        <PerfFlatList
          data={filteredItems}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          onEndReached={() => { if (hasMore && !loadingMore && tripFilter !== 'past') fetchTrips(false); }}
          onEndReachedThreshold={0.35}
          renderItem={renderItem}
          ListFooterComponent={
            filteredItems.length ? <Text style={[styles.footer, { color: palette.labelTertiary }]}>
              {loadingMore ? '' : hasMore ? t('上滑加载更多') : t('没有更多了')}
            </Text> : null
          }
          ListEmptyComponent={
            loading ? <CenterSpinner text={t('加载中…')} />
            : error ? (
              <ErrorState title={t('加载失败')} hint={error} onAction={() => fetchTrips(true)} />
            ) : (
              <EmptyState
                icon="calendar-heart"
                title={member ? (tripFilter === 'past' ? t('暂无过往行程') : tripFilter === 'today' ? t('今天暂无行程') : tripFilter === 'upcoming' ? t('暂无即将到来的行程') : t('暂无行程')) : t('请搜索选择成员查看行程')}
                hint={member ? t('可切换分区或点击右上角刷新') : undefined}
              />
            )
          }
        />
      </FadeInView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  subtitle: { paddingHorizontal: 16, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  filterChipText: { fontSize: 12 },
  list: { padding: 16, paddingBottom: 40 },
  timelineRow: { flexDirection: 'row', alignItems: 'stretch', marginBottom: 5 },
  railWrap: { width: 22, alignItems: 'center' },
  rail: {
    position: 'absolute',
    left: 10,
    top: 0,
    bottom: 0,
    width: 2,
  },
  nodeOuter: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    marginTop: 20,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  nodeInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nodeDot: { width: 4, height: 4, borderRadius: 2 },
  card: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
    borderRadius: 16,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardHead: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  datePill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  datePillText: { fontSize: 11, fontWeight: '700' },
  cardTitle: { fontSize: 15, fontWeight: '700', lineHeight: 20 },
  cardSub: { fontSize: 12, marginTop: 3, lineHeight: 17 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  locationText: { fontSize: 12, flex: 1, fontWeight: '600' },
  cardDesc: { fontSize: 12, marginTop: 6, lineHeight: 17 },
  linkRow: {
    alignSelf: 'flex-start',
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 4,
  },
  linkRowText: { fontSize: 13, fontWeight: '700' },
  footer: { textAlign: 'center', fontSize: 12, paddingVertical: 10 },
});
