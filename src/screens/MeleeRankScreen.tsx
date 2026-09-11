import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  ActivityIndicator,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useNavigation } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import { FadeInView } from '../components/Motion';
import { Pill } from '../components/Pill';
import MemberPicker from '../components/MemberPicker';
import pocketApi from '../api/pocket48';
import { useI18n } from '../i18n';
import { errorMessage, normalizeUrl } from '../utils/data';
import { Member } from '../types';
import { extractRankList, extractWeeks, WeekItem } from '../utils/meleeParse';
import { usePalette, radiiAlias } from '../theme';
import { EmptyState, ErrorState } from '../components/StateViews';
import { Skeleton } from '../components/Skeleton';

// 参考电脑版鸡腿榜：周榜 / 总榜 / 年榜 + 成员贡献榜
type ViewMode = 'week' | 'total' | 'year' | 'person';

const MODES: { key: ViewMode; label: string }[] = [
  { key: 'week', label: '周榜' },
  { key: 'total', label: '总榜' },
  { key: 'year', label: '年榜' },
  { key: 'person', label: '成员贡献' },
];

export default function MeleeRankScreen() {
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const { t } = useI18n();
  const [mode, setMode] = useState<ViewMode>('week');
  const [member, setMember] = useState<Member | null>(null);
  const [weeks, setWeeks] = useState<WeekItem[]>([]);
  const [selectedWeek, setSelectedWeek] = useState<WeekItem | null>(null);
  const selectedWeekRef = useRef(selectedWeek);
  selectedWeekRef.current = selectedWeek;
  const [ranks, setRanks] = useState<any[]>([]);
  const [personRanks, setPersonRanks] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const nextIdRef = useRef('');
  const hasMoreRef = useRef(false);
  const reqIdRef = useRef(0); // Y31: 请求序号（切榜/切周时丢弃过期响应）

  const switchMode = (m: ViewMode) => {
    setRanks([]);
    setPersonRanks([]);
    setError('');
    nextIdRef.current = '';
    hasMoreRef.current = false;
    setMode(m);
  };

  const loadRank = useCallback(async () => {
    const rid = ++reqIdRef.current;
    setLoading(true);
    setError('');
    try {
      let res: any;
      if (mode === 'year') res = await pocketApi.getMeleeYearRankPage();
      else if (mode === 'total') res = await pocketApi.getMeleeRankPage();
      else if (mode === 'week') {
        res = selectedWeekRef.current
          ? await pocketApi.getMeleeWeekRank(selectedWeekRef.current.weekRankId)
          : await pocketApi.getMeleeRankPage();
      } else {
        return;
      }
      const data = res?.content ?? res?.data ?? res ?? {};
      // 优先从返回体补齐周列表（部分接口把 weekList 挂在 content 下）
      const ws = extractWeeks(data);
      if (ws.length) {
        setWeeks((prev) => (prev.length ? prev : ws));
        if (!selectedWeekRef.current) setSelectedWeek(ws[ws.length - 1]);
      }
      const list = extractRankList(data);
      // Y31: 过期响应丢弃（期间已切榜/切周）
      if (rid !== reqIdRef.current) return;
      setRanks(list);
      // 分页游标：getMeleeRankPage / getMeleeYearRankPage 支持 nextId
      const nextId = String(data?.nextId || data?.next || '');
      nextIdRef.current = nextId;
      hasMoreRef.current = !!nextId && list.length > 0;
      // Y31: 空数据不 setError（否则错误态与空态同时渲染）——列表自显空态
      if (rid !== reqIdRef.current) return;
    } catch (e: any) {
      if (rid !== reqIdRef.current) return; // Y31
      setError(errorMessage(e));
      setRanks([]);
    } finally {
      if (rid === reqIdRef.current) setLoading(false);
    }
  }, [mode, t]);

  const loadMoreRank = useCallback(async () => {
    if (loading || loadingMore || !hasMoreRef.current || !nextIdRef.current) return;
    setLoadingMore(true);
    try {
      let res: any;
      if (mode === 'year') res = await pocketApi.getMeleeYearRankPage(0, nextIdRef.current);
      else if (mode === 'total') res = await pocketApi.getMeleeRankPage(0, nextIdRef.current);
      else if (mode === 'week') {
        res = selectedWeekRef.current
          ? await pocketApi.getMeleeWeekRank(selectedWeekRef.current.weekRankId, nextIdRef.current)
          : await pocketApi.getMeleeRankPage(0, nextIdRef.current);
      } else {
        return;
      }
      const data = res?.content ?? res?.data ?? res ?? {};
      const list = extractRankList(data);
      const nextId = String(data?.nextId || data?.next || '');
      setRanks((prev) => {
        const seen = new Set(prev.map((it) => String(it.userId || it.rankNum || it.resId || it.id)));
        const fresh = list.filter((it) => !seen.has(String(it.userId || it.rankNum || it.resId || it.id)));
        return [...prev, ...fresh];
      });
      nextIdRef.current = nextId;
      hasMoreRef.current = !!nextId && list.length > 0;
    } catch {
      hasMoreRef.current = false;
    } finally {
      setLoadingMore(false);
    }
  }, [loading, loadingMore, mode, t]);

  const loadPerson = useCallback(async (m: Member) => {
    if (!m?.id) {
      setPersonRanks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await pocketApi.getPersonMeleeRankPage(Number(m.id));
      const data = res?.content ?? res?.data ?? {};
      const list = Array.isArray(data?.charmInfo) ? data.charmInfo : extractRankList(data);
      setPersonRanks(list);
      if (!list.length) setError(t('暂无鸡腿贡献数据'));
    } catch (e: any) {
      setError(errorMessage(e));
      setPersonRanks([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (mode === 'person') {
      if (member) loadPerson(member);
      else {
        setPersonRanks([]);
        setLoading(false);
      }
    } else {
      loadRank();
    }
  }, [mode, selectedWeek, member, loadRank, loadPerson]);

  const renderWeekChip = ({ item }: { item: WeekItem }) => {
    const active = selectedWeek?.weekRankId === item.weekRankId;
    return (
      <Pill
        label={item.weekRankName}
        selected={active}
        onPress={() => { setRanks([]); setSelectedWeek(item); }}
        style={styles.weekChip}
      />
    );
  };

  const rankMax = useMemo(() => {
    let m = 1;
    for (const it of ranks) {
      const v = Number(it.melee || it.meleeValue || it.score || it.total || it.charm || 0);
      if (v > m) m = v;
    }
    return m;
  }, [ranks]);

  const renderRank = useCallback(
    ({ item, index }: { item: any; index: number }) => (
      <RankCard item={item} index={index} max={rankMax} />
    ),
    [rankMax],
  );
  const renderPerson = useCallback(
    ({ item, index }: { item: any; index: number }) => (
      <PersonCard item={item} index={index} />
    ),
    [],
  );

  const showSkeleton = loading && ranks.length === 0 && mode !== 'person';
  const showPersonSkeleton = loading && personRanks.length === 0 && mode === 'person';

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('鸡腿榜')} onBack={() => navigation.goBack()} />

      <View style={styles.modeRow}>
        {MODES.map((m) => (
          <View key={m.key} style={styles.modeWrap}>
            <Pill
              label={t(m.label)}
              selected={mode === m.key}
              onPress={() => switchMode(m.key)}
              style={styles.modePill}
            />
          </View>
        ))}
      </View>

      {mode === 'person' && (
        <MemberPicker selectedMember={member} onSelect={(m) => { setPersonRanks([]); setMember(m); }} placeholder={t('搜索成员查看鸡腿贡献...')} />
      )}

      {mode === 'week' && weeks.length > 0 && (
        <PerfFlatList
          horizontal
          data={weeks}
          keyExtractor={(item) => String(item.weekRankId)}
          renderItem={renderWeekChip}
          style={styles.weekList}
          contentContainerStyle={styles.weekListContent}
          showsHorizontalScrollIndicator={false}
        />
      )}

      {error ? (
        <ErrorState title={error} onAction={() => (mode === 'person' && member ? loadPerson(member) : loadRank())} />
      ) : null}

      {mode === 'person' ? (
        showPersonSkeleton ? (
          <SkeletonRankList />
        ) : (
          <PerfFlatList
            data={personRanks}
            keyExtractor={(item: any, index: number) => String(item.userId || item.id || item.uid || item.resId || `p${index}`)}
            contentContainerStyle={styles.list}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            renderItem={renderPerson}
            refreshControl={
              <RefreshControl
                refreshing={loading}
                onRefresh={() => (member ? loadPerson(member) : setLoading(false))}
                tintColor={palette.tint}
                colors={[palette.tint]}
              />
            }
            ListEmptyComponent={
              <EmptyState
                icon="account-heart"
                title={member ? t('暂无鸡腿贡献数据') : t('请选择成员查看贡献榜')}
              />
            }
          />
        )
      ) : showSkeleton ? (
        <SkeletonRankList />
      ) : (
        <PerfFlatList
          data={ranks}
          keyExtractor={(item: any, index: number) => String(item.userId || item.rankNum || item.resId || item.id || `r${index}`)}
          contentContainerStyle={styles.list}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          renderItem={renderRank}
          onEndReached={loadMoreRank}
          onEndReachedThreshold={0.35}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => loadRank()}
              tintColor={palette.tint}
              colors={[palette.tint]}
            />
          }
          ListHeaderComponent={ranks.length >= 3 ? <Podium ranks={ranks.slice(0, 3)} /> : null}
          ListEmptyComponent={
            <EmptyState icon="trophy-outline" title={t('暂无排名数据')} />
          }
          ListFooterComponent={null}
        />
      )}
    </View>
  );
}

/**
 * 前三名领奖台（结构升级）：第 1 名居中放大 + tint 强调，第 2/3 名两侧；
 * 让用户一眼看到头部格局，而不是从第一行往下数。
 */
const Podium = React.memo(function Podium({ ranks }: { ranks: any[] }) {
  const palette = usePalette();
  const { t } = useI18n();
  const medal = (i: number) => (i === 0 ? 'trophy' : i === 1 ? 'medal-outline' : 'medal-outline');
  const order = [ranks[1], ranks[0], ranks[2]]; // 2nd | 1st | 3rd
  // 柱高按「名次」索引（0=第1名），此前写成 order 顺序 [76,96,64] 却用 realIndex 取值，
  // 导致第 2 名柱子比第 1 名还高（领奖台排版错乱）
  const heights = [96, 76, 64];
  const tones = [palette.fill2, palette.tintSoft, palette.fill2];
  return (
    <FadeInView delay={60} duration={320} style={{ marginBottom: 12 }}>
      <View style={[styles.podiumCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
        <Text style={[styles.podiumTitle, { color: palette.label }]}>{t('领奖台')}</Text>
        <View style={styles.podiumRow}>
          {order.map((item: any, idx: number) => {
            const realIndex = idx === 0 ? 1 : idx === 1 ? 0 : 2;
            const u = item.baseUserInfo || item.userInfo || item.user || item;
            const name = String(u.userName || u.nickname || u.nickName || u.name || t('用户 {rank}', { rank: realIndex + 1 }));
            const avatar = normalizeUrl(String(u.userAvatar || u.avatar || u.headImg || u.headUrl || u.picPath || ''));
            const melee = Number(item.melee || item.meleeValue || item.score || item.total || item.charm || 0);
            const isFirst = realIndex === 0;
            return (
              <View key={realIndex} style={[styles.podiumCell, { flex: isFirst ? 1.15 : 1 }]}>
                <View style={[styles.podiumAvatarWrap, { backgroundColor: tones[realIndex] }]}>
                  {avatar ? (
                    <Image source={{ uri: avatar }} style={styles.podiumAvatar} />
                  ) : (
                    <MaterialCommunityIcons name="account" size={26} color={palette.labelTertiary} />
                  )}
                </View>
                <MaterialCommunityIcons name={medal(realIndex) as any} size={18} color={isFirst ? palette.warning : palette.labelTertiary} style={{ marginTop: 6 }} />
                <Text style={[styles.podiumName, { color: palette.label, fontWeight: isFirst ? '800' : '600' }]} numberOfLines={1}>{name}</Text>
                <View style={[styles.podiumBar, { height: heights[realIndex], backgroundColor: isFirst ? palette.tint : palette.fill3 }]}>
                  <Text style={[styles.podiumMelee, { color: isFirst ? palette.onTint : palette.labelTertiary }]} numberOfLines={1}>
                    {melee >= 10000 ? `${(melee / 10000).toFixed(1)}w` : String(melee)}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>
    </FadeInView>
  );
});

/** 首屏榜单骨架：与真实榜单行同构的 Skeleton（spec §8） */
function SkeletonRankList() {
  const palette = usePalette();
  return (
    <View style={styles.list}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View key={i} style={[styles.rankCard, { backgroundColor: palette.surface }]}>
          <Skeleton width={30} height={30} radius={10} style={{ marginRight: 10 }} />
          <Skeleton width={44} height={44} radius={22} style={{ marginRight: 10 }} />
          <View style={[styles.rankInfo, { gap: 6 }]}>
            <Skeleton width="55%" height={14} radius={6} />
            <Skeleton width="80%" height={4} radius={2} />
          </View>
          <Skeleton width={52} height={14} radius={6} />
        </View>
      ))}
    </View>
  );
}

const RankCard = React.memo(function RankCard({ item, index, max }: { item: any; index: number; max: number }) {
  const palette = usePalette();
  const { t } = useI18n();
  const rankNum = Number(item.rankNum || item.rank || item.no || index + 1);
  const u = item.baseUserInfo || item.userInfo || item.user || item;
  const topU = item.topUserInfo || item.topUser || {};
  const name = String(u.userName || u.nickname || u.nickName || u.name || '');
  const avatar = normalizeUrl(String(u.userAvatar || u.avatar || u.headImg || u.headUrl || u.picPath || ''));
  const topUser = String(topU.userName || topU.nickname || '');
  const melee = Number(item.melee || item.meleeValue || item.score || item.total || item.charm || '0');
  const isTop = rankNum <= 3;
  // 除零保护：max 为 0（全榜 0 值/异常）时此前会产生 Infinity% → RN 宽度告警 + 进度条错乱
  const pct = max > 0 ? Math.max(2, Math.min(100, (melee / max) * 100)) : 2;

  return (
    <FadeInView delay={60 + (index < 12 ? index * 25 : 0)} duration={300}>
      <View style={[styles.rankCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
        {/* 名次徽标：前三名 tint 实底白字 16/900，其余 fill2 底 14/800 */}
        <View
          style={[
            styles.rankBadge,
            isTop
              ? { backgroundColor: palette.tint }
              : { backgroundColor: palette.fill2 },
          ]}
        >
          <Text style={[styles.rankBadgeText, { color: isTop ? palette.onTint : palette.labelSecondary, fontSize: isTop ? 16 : 14, fontWeight: isTop ? '900' : '800' }]}>
            {rankNum}
          </Text>
        </View>
        {avatar ? (
          <Image source={{ uri: avatar }} style={[styles.avatar, { backgroundColor: palette.fill2 }]} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder, { backgroundColor: palette.fill3 }]}>
            <MaterialCommunityIcons name="account" size={20} color={palette.labelTertiary} />
          </View>
        )}
        <View style={styles.rankInfo}>
          <Text style={[styles.rankName, { color: palette.label }]} numberOfLines={1}>{name || t('用户 {rank}', { rank: rankNum })}</Text>
          {topUser ? (
            <View style={styles.rankMetaRow}>
              <MaterialCommunityIcons name="crown" size={12} color={palette.warning} />
              <Text style={[styles.rankMeta, { color: palette.labelSecondary }]} numberOfLines={1}>{t('榜首: {topUser}', { topUser })}</Text>
            </View>
          ) : null}
          <View style={[styles.miniTrack, { backgroundColor: palette.fill3 }]}>
            <View style={[styles.miniFill, { backgroundColor: palette.tint, width: `${pct}%` }]} />
          </View>
        </View>
        <View style={styles.meleeWrap}>
          <MaterialCommunityIcons name="food-drumstick-outline" size={16} color={palette.tint} />
          {/* 大数值缩写 + 单行：此前长数字会挤压名字列/换行破版 */}
          <Text style={[styles.meleeValue, { color: palette.tint }]} numberOfLines={1}>
            {melee >= 10000 ? `${(melee / 10000).toFixed(1)}w` : String(melee)}
          </Text>
        </View>
      </View>
    </FadeInView>
  );
});

const PersonCard = React.memo(function PersonCard({ item, index }: { item: any; index: number }) {
  const palette = usePalette();
  const { t } = useI18n();
  const name = String(item.userName || item.nickname || item.nickName || item.name || '');
  const u = item.baseUserInfo || item.userInfo || item.user || item;
  const avatar = normalizeUrl(String(u.userAvatar || u.avatar || u.headImg || u.headUrl || u.picPath || item.userAvatar || item.avatar || item.headImg || ''));
  const userId = String(item.userId || item.id || item.uid || '');
  const charm = Number(item.charm || item.charmValue || item.total || item.score || item.melee || '0');

  return (
    <FadeInView delay={60 + (index < 12 ? index * 25 : 0)} duration={300}>
      <View style={[styles.rankCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
        <View style={[styles.rankBadge, { backgroundColor: palette.fill2 }]}>
          <Text style={[styles.rankBadgeText, { color: palette.labelSecondary, fontSize: 14, fontWeight: '800' }]}>{index + 1}</Text>
        </View>
        {avatar ? (
          <Image source={{ uri: avatar }} style={[styles.avatar, { backgroundColor: palette.fill2 }]} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder, { backgroundColor: palette.fill3 }]}>
            <MaterialCommunityIcons name="account" size={20} color={palette.labelTertiary} />
          </View>
        )}
        <View style={styles.rankInfo}>
          <Text style={[styles.rankName, { color: palette.label }]} numberOfLines={1}>{name || t('未知用户')}</Text>
          <Text style={[styles.rankMeta, { color: palette.labelSecondary }]} numberOfLines={1}>{t('ID: {id}', { id: userId })}</Text>
        </View>
        <View style={styles.meleeWrap}>
          <MaterialCommunityIcons name="food-drumstick-outline" size={16} color={palette.tint} />
          <Text style={[styles.meleeValue, { color: palette.tint }]}>{charm}</Text>
        </View>
      </View>
    </FadeInView>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  modeRow: { flexDirection: 'row', paddingHorizontal: 16, marginBottom: 8, gap: 6 },
  modeWrap: { flex: 1 },
  modePill: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  weekList: { maxHeight: 46, marginBottom: 4 },
  weekListContent: { paddingHorizontal: 16, alignItems: 'center', gap: 6 },
  weekChip: { marginRight: 0 },
  list: { padding: 14, paddingBottom: 40 },
  podiumCard: {
    borderRadius: radiiAlias.card,
    padding: 14,
    marginBottom: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  podiumTitle: { fontSize: 13, fontWeight: '700', marginBottom: 10 },
  podiumRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  podiumCell: { alignItems: 'center', minWidth: 0 },
  podiumAvatarWrap: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  podiumAvatar: { width: 64, height: 64, borderRadius: 32 },
  podiumName: { fontSize: 12, marginTop: 4, width: '100%', textAlign: 'center' },
  podiumBar: {
    marginTop: 6,
    width: '100%',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 6,
    minHeight: 40,
  },
  podiumMelee: { fontSize: 11, fontWeight: '800', maxWidth: '92%' },
  rankCard: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: radiiAlias.card, padding: 12, marginBottom: 5,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rankBadge: {
    width: 30, height: 30, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  rankBadgeText: { fontWeight: '900' },
  avatar: { width: 44, height: 44, borderRadius: radiiAlias.avatar, marginRight: 10 },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  rankInfo: { flex: 1, minWidth: 0 },
  rankName: { fontSize: 14, fontWeight: '600' },
  rankMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  rankMeta: { fontSize: 12, marginTop: 2, flex: 1 },
  miniTrack: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 6 },
  miniFill: { height: 4, borderRadius: 2 },
  meleeWrap: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 8 },
  meleeValue: { fontSize: 13, fontWeight: '800' },
});
