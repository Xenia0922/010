import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { usePalette } from '../theme';
import { useI18n } from '../i18n';
import { useMemberStore } from '../store';
import { FadeInView } from '../components/Motion';
import { EmptyState } from '../components/StateViews';
import ScreenHeader from '../components/ScreenHeader';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useOnMicStore, OnMicEntry } from '../store/onMicStore';
import { Member } from '../types';

export default function OnMicScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const navigation = useNavigation<any>();
  const members = useMemberStore((state: any) => state.members);
  const onMic = useOnMicStore((state: any) => state.onMic);
  const scanning = useOnMicStore((state: any) => state.scanning);
  const scanTotal = useOnMicStore((state: any) => state.total);
  const scanDone = useOnMicStore((state: any) => state.done);
  const [error, setError] = useState('');

  // v2.7.4：全部成员上麦扫描（有 serverId 或 channelId 的成员都纳入；channelId 缺失由 scan 内按需补齐；
  // 退团/暂休成员由 store 按官方分类过滤，不进扫描）
  const buildInputs = useCallback(() => {
    return members
      .map((item: any) => ({
        memberId: String(item.id || item.userId || ''),
        name: String(item.ownerName || item.realName || item.id || ''),
        channelId: String(item.channelId || ''),
        serverId: String(item.serverId || ''),
        smallChannelId: String(item.yklzId || ''),
        state: String(item.state || ''),
      }))
      .filter((m: any) => m.memberId && (m.channelId || m.serverId));
  }, [members]);

  const scan = useCallback((opts?: { force?: boolean }) => {
    const inputs = buildInputs();
    if (inputs.length) useOnMicStore.getState().scan(inputs, opts);
  }, [buildInputs]);

  useEffect(() => {
    setError('');
    if (!members.length) setError(t('暂无成员数据，请先刷新成员库'));
    // 进入页面强制扫描一次全部成员（force 绕过 60s 节流）
    scan({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // tab 可见时每 60s 静默刷新（store 内部节流 60s + 预算制增量：每轮 1/3 成员，约 3 轮全覆盖）
  useFocusEffect(
    useCallback(() => {
      const id = setInterval(() => scan(), 60000);
      return () => clearInterval(id);
    }, [scan]),
  );

  const entries: OnMicEntry[] = members
    .map((m: any) => onMic[String(m.id || m.userId || '')])
    .filter((e: OnMicEntry | undefined): e is OnMicEntry => !!e);

  const renderItem = ({ item, index }: { item: OnMicEntry; index: number }) => {
    const member = members.find((m: any) => String(m.id || m.userId) === item.memberId);
    return (
      <FadeInView delay={index < 12 ? 60 + index * 25 : 0} duration={300} style={{ marginHorizontal: 16, marginTop: index === 0 ? 12 : 8 }}>
        <TouchableOpacity
          style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}
          onPress={() => member && navigation.navigate('RoomRadioScreen', {
            member,
            initialMode: item.smallVoice ? 'small' : 'big',
            streamUrl: item.streamUrl || '',
          })}
          activeOpacity={0.9}
        >
          {member?.avatar ? (
            <Image source={{ uri: member.avatar }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, { backgroundColor: palette.tintSoft }]} />
          )}
          <View style={styles.info}>
            <Text style={[styles.name, { color: palette.label }]} numberOfLines={1}>{item.name}</Text>
            <View style={styles.tagRow}>
              <View style={[styles.tag, { backgroundColor: palette.tint }]}>
                <MaterialCommunityIcons name="microphone" size={11} color={palette.onTint} />
                <Text style={styles.tagText}>{t('上麦中')}</Text>
              </View>
              {item.hasRadio ? (
                <View style={[styles.tag, { backgroundColor: palette.tintSoft }]}>
                  <MaterialCommunityIcons name="radio" size={11} color={palette.tint} />
                  <Text style={[styles.tagText, { color: palette.tint }]}>{t('电台')}</Text>
                </View>
              ) : null}
              {item.onMicCount > 1 ? (
                <Text style={[styles.count, { color: palette.labelSecondary }]}>{t('{n} 人在麦', { n: item.onMicCount })}</Text>
              ) : null}
            </View>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color={palette.labelTertiary} />
        </TouchableOpacity>
      </FadeInView>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <ScreenHeader title={t('上麦')} />
      {scanning ? (
        <View style={[styles.scanBar, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <ActivityIndicator size="small" color={palette.tint} style={{ marginRight: 8 }} />
          <Text style={[styles.scanBarText, { color: palette.labelSecondary }]}>
            {t('正在扫描全部成员上麦状态 {done}/{total}...', { done: Math.min(scanDone, scanTotal), total: scanTotal })}
          </Text>
        </View>
      ) : null}
      {error && entries.length === 0 ? (
        <EmptyState icon="alert-circle-outline" title={t('加载失败')} hint={error} onAction={() => scan({ force: true })} />
      ) : entries.length === 0 ? (
        <EmptyState icon="microphone-off" title={t('暂无成员上麦')} hint={t('当前没有成员在语音麦上')} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.memberId}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scanBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  scanBarText: { fontSize: 12, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    padding: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#ccc',
  },
  info: {
    flex: 1,
    marginLeft: 12,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 6,
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    gap: 3,
  },
  tagText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
  count: {
    fontSize: 11,
    marginLeft: 2,
  },
});