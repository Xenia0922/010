import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { ScalePressable } from '../components/Motion';
import { useMemberStore } from '../store';
import { updateMemberData, getMemberDataMeta } from '../services/memberData';
import { usePalette } from '../theme';
import { useI18n } from '../i18n';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

/** 状态分类的展示顺序与文案 key（与 memberData 的 state 值对应） */
const STATE_ORDER: { key: string; label: string }[] = [
  { key: 'active', label: '在团' },
  { key: 'graduated', label: '毕业' },
  { key: 'left', label: '退团' },
  { key: 'paused', label: '暂休' },
  { key: 'unknown', label: '未知' },
];

export default function DatabaseScreen() {
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const { t } = useI18n();
  const storeMembers = useMemberStore((s) => s.members);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [syncError, setSyncError] = useState('');
  const [savedAt, setSavedAt] = useState<number>(0);

  const refreshMeta = useCallback(() => {
    getMemberDataMeta().then((meta) => {
      if (meta?.savedAt) setSavedAt(meta.savedAt);
    }).catch(() => {});
  }, []);

  /** 双源合并刷新（与启动引导同一套逻辑：yk1z 库 + 官方补齐），不再用文件备份覆盖 */
  const syncMembers = useCallback(async () => {
    setSyncState('syncing');
    setSyncError('');
    try {
      await updateMemberData();
      refreshMeta();
      setSyncState('done');
    } catch (e: any) {
      setSyncState('error');
      setSyncError(e?.message || String(e));
    }
  }, [refreshMeta]);

  useEffect(() => {
    refreshMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const memberCount = storeMembers.length;

  const stateSummary = useMemo(() => {
    const map: Record<string, number> = {};
    for (const m of storeMembers) {
      const s = m.state || 'unknown';
      map[s] = (map[s] || 0) + 1;
    }
    return map;
  }, [storeMembers]);

  const groupSummary = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of storeMembers) {
      const g = String(m.groupName || '').trim();
      if (g) map.set(g, (map.get(g) || 0) + 1);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [storeMembers]);

  const teamSummary = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of storeMembers) {
      const team = String(m.team || '').trim();
      if (team) map.set(team, (map.get(team) || 0) + 1);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
  }, [storeMembers]);

  const roomCoverage = useMemo(() => {
    let server = 0, channel = 0, yklz = 0;
    for (const m of storeMembers) {
      if (m.serverId && m.serverId !== '0') server += 1;
      if (m.channelId && m.channelId !== '0') channel += 1;
      if (m.yklzId && m.yklzId !== '0') yklz += 1;
    }
    return { server, channel, yklz };
  }, [storeMembers]);

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('数据库')} onBack={() => navigation.goBack()} right={
        <HeaderAction label={t('刷新')} onPress={syncMembers} />
        } />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 同步状态条 */}
        <View style={[styles.syncBar, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <View style={[styles.syncIcon, { backgroundColor: palette.tintSoft }]}>
            <MaterialCommunityIcons name="database-sync-outline" size={18} color={palette.tint} />
          </View>
          <View style={styles.syncInfo}>
            <Text style={[styles.syncTitle, { color: palette.label }]}>{t('成员数据库')}</Text>
            {syncState === 'syncing' ? (
              <View style={styles.syncRow}>
                <ActivityIndicator size="small" color={palette.tint} style={{ marginRight: 6 }} />
                <Text style={[styles.syncText, { color: palette.labelSecondary }]}>{t('正在同步成员库…')}</Text>
              </View>
            ) : syncState === 'error' ? (
              <ScalePressable onPress={syncMembers} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} activeOpacity={0.6}>
                <Text style={[styles.syncError, { color: palette.tint }]} numberOfLines={1}>
                  {t('同步失败：{msg} · 点此重试', { msg: syncError || t('网络错误') })}
                </Text>
              </ScalePressable>
            ) : (
              <Text style={[styles.syncText, { color: palette.labelSecondary }]}>
                {t('双源合并：yk1z 库 + 官方接口 · 共 {count} 位', { count: memberCount })}
              </Text>
            )}
          </View>
        </View>

        {/* 状态分类 */}
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <Text style={[styles.cardTitle, { color: palette.label }]}>{t('状态分类（对齐 yk1z 库）')}</Text>
          <View style={styles.chipRow}>
            {STATE_ORDER.map(({ key, label }) => {
              const n = stateSummary[key] || 0;
              return (
                <View key={key} style={[styles.stateChip, { backgroundColor: palette.fill2 }]}>
                  <Text style={[styles.stateChipName, { color: palette.label }]}>{t(label)}</Text>
                  <Text style={[styles.stateChipCount, { color: palette.tint }]}>{n}</Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* 团体分布 */}
        {groupSummary.length > 0 ? (
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <Text style={[styles.cardTitle, { color: palette.label }]}>{t('团体分布')}</Text>
            <View style={styles.chipRow}>
              {groupSummary.map(([group, count]) => (
                <View key={group} style={[styles.groupChip, { backgroundColor: palette.tintSoft }]}>
                  <Text style={[styles.groupChipName, { color: palette.tint }]}>{group}</Text>
                  <Text style={[styles.groupChipCount, { color: palette.tint }]}>{count}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* 队伍分布 */}
        {teamSummary.length > 0 ? (
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <Text style={[styles.cardTitle, { color: palette.label }]}>{t('队伍分布')}</Text>
            <View style={styles.chipRow}>
              {teamSummary.map(([team, count]) => (
                <View key={team} style={[styles.teamChip, { backgroundColor: palette.fill2 }]}>
                  <Text style={[styles.teamChipName, { color: palette.label }]} numberOfLines={1}>{team}</Text>
                  <Text style={[styles.teamChipCount, { color: palette.tint }]}>{count}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* 房间映射覆盖（排查大小房间问题用） */}
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <Text style={[styles.cardTitle, { color: palette.label }]}>{t('房间映射覆盖')}</Text>
          <View style={styles.coverRow}>
            <View style={[styles.coverItem, { backgroundColor: palette.fill2 }]}>
              <MaterialCommunityIcons name="server" size={16} color={palette.tint} />
              <Text style={[styles.coverNum, { color: palette.label }]}>{roomCoverage.server}</Text>
              <Text style={[styles.coverLabel, { color: palette.labelTertiary }]}>{t('服务器')}</Text>
            </View>
            <View style={[styles.coverItem, { backgroundColor: palette.fill2 }]}>
              <MaterialCommunityIcons name="door-open" size={16} color={palette.tint} />
              <Text style={[styles.coverNum, { color: palette.label }]}>{roomCoverage.channel}</Text>
              <Text style={[styles.coverLabel, { color: palette.labelTertiary }]}>{t('大房间')}</Text>
            </View>
            <View style={[styles.coverItem, { backgroundColor: palette.fill2 }]}>
              <MaterialCommunityIcons name="door" size={16} color={palette.tint} />
              <Text style={[styles.coverNum, { color: palette.label }]}>{roomCoverage.yklz}</Text>
              <Text style={[styles.coverLabel, { color: palette.labelTertiary }]}>{t('小房间')}</Text>
            </View>
          </View>
        </View>

        {/* 数据源信息 */}
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <Text style={[styles.cardTitle, { color: palette.label }]}>{t('数据源')}</Text>
          <Text style={[styles.sourceLine, { color: palette.labelSecondary }]}>
            {t('成员与状态：{src}', { src: 'yk1z 数据库(成员库底座)' })}
          </Text>
          <Text style={[styles.sourceLine, { color: palette.labelSecondary }]}>
            {t('档案与状态分类补齐：{src}', { src: '口袋48 官方接口(group_team_star / server_map)' })}
          </Text>
          {savedAt ? (
            <Text style={[styles.sourceLine, { color: palette.labelTertiary }]}>
              {t('数据更新时间：{time}', { time: new Date(savedAt).toLocaleString() })}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  scroll: { paddingBottom: 24 },
  syncBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  syncIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncInfo: { flex: 1, marginLeft: 12, minWidth: 0 },
  syncTitle: { fontSize: 15, fontWeight: '700' },
  syncRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5, minHeight: 16 },
  syncText: { fontSize: 12, marginTop: 3 },
  syncError: { fontSize: 12, fontWeight: '700', marginTop: 3 },
  card: {
    marginHorizontal: 16,
    marginTop: 10,
    padding: 14,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', marginBottom: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stateChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, gap: 5,
  },
  stateChipName: { fontSize: 12, fontWeight: '600' },
  stateChipCount: { fontSize: 12, fontWeight: '800' },
  groupChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, gap: 5,
  },
  groupChipName: { fontSize: 12, fontWeight: '700' },
  groupChipCount: { fontSize: 12, fontWeight: '800' },
  teamChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, gap: 5,
  },
  teamChipName: { fontSize: 12, fontWeight: '600', maxWidth: 110 },
  teamChipCount: { fontSize: 12, fontWeight: '800' },
  coverRow: { flexDirection: 'row', gap: 10 },
  coverItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    gap: 4,
  },
  coverNum: { fontSize: 20, fontWeight: '800' },
  coverLabel: { fontSize: 11 },
  sourceLine: { fontSize: 12, marginTop: 4, lineHeight: 18 },
});