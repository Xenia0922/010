import React, { useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MemberPicker from '../components/MemberPicker';
import ScreenHeader from '../components/ScreenHeader';
import { Button } from '../components/Button';
import { EmptyState } from '../components/StateViews';
import { useI18n } from '../i18n';
import pocketApi from '../api/pocket48';
import { CenterSpinner } from '../components/Loaders';
import { FadeInView } from '../components/Motion';
import { Member } from '../types';
import { errorMessage, messageText, unwrapList } from '../utils/data';
import { formatTimestamp } from '../utils/format';
import { usePalette, radii } from '../theme';

type MessageMode = 'all' | 'owner';
type RoomMode = 'big' | 'small';

function normalizeMessages(res: any): any[] {
  return unwrapList(res, [
    'content.messageList',
    'content.message',
    'content.messages',
    'content.list',
    'content.data',
    'data.content.messageList',
    'data.content.message',
    'data.messageList',
    'data.message',
    'data.list',
    'messageList',
    'message',
    'messages',
    'list',
  ]);
}

function nextTimeFrom(res: any): number {
  const v = Number(res?.content?.nextTime || res?.data?.nextTime || res?.nextTime || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function getChannelId(member: Member, roomMode: RoomMode): string {
  if (roomMode === 'small') return String(member.yklzId || member.channelId || '');
  return String(member.channelId || '');
}

export default function FetchScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [messageMode, setMessageMode] = useState<MessageMode>('all');
  const [roomMode, setRoomMode] = useState<RoomMode>('big');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  const fetchOnce = async (member: Member, targetRoomMode: RoomMode, nextTime = 0) => {
    const channelId = getChannelId(member, targetRoomMode);
    if (!channelId) throw new Error(targetRoomMode === 'small' ? t('该成员没有小房间 channelId') : t('该成员没有房间 channelId'));
    const res = await pocketApi.getRoomMessages({
      channelId,
      serverId: member.serverId,
      nextTime,
      fetchAll: messageMode === 'all',
    });
    return { list: normalizeMessages(res), next: nextTimeFrom(res) };
  };

  const startFetch = async () => {
    if (!selectedMember) {
      setStatus(t('请先选择成员'));
      return;
    }
    setLoading(true);
    setStatus(t('抓取中...'));
    try {
      // 循环抓取全部历史（成员消息模式同样分页，避免只取一页漏数据）
      let all: any[] = [];
      let usedRoomMode = roomMode;
      const seen = new Set<string>();
      let cursor = 0;
      let guard = 0;
      while (guard < 50) {
        guard += 1;
        const { list, next } = await fetchOnce(selectedMember, usedRoomMode, cursor);
        if (!list.length && usedRoomMode === 'big' && selectedMember.yklzId && all.length === 0) {
          setStatus(t('大房间没有返回消息，正在尝试小房间...'));
          usedRoomMode = 'small';
          cursor = 0;
          continue;
        }
        const fresh = list.filter((item: any) => {
          const key = String(item.id || item.msgId || item.messageId || item.clientMsgId || '');
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        all = all.concat(fresh);
        if (!next || next <= cursor || fresh.length === 0) break;
        cursor = next;
        if (guard % 5 === 0) setStatus(t('已抓取 {count} 条，继续...', { count: all.length }));
      }

      setResults(all);
      setStatus(t('抓取完成：{count} 条消息 · {room} · {mode}', {
        count: all.length,
        room: usedRoomMode === 'small' ? t('小房间') : t('大房间'),
        mode: messageMode === 'all' ? t('全部消息') : t('成员消息'),
      }));
    } catch (error) {
      setStatus(t('抓取失败：{error}', { error: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('抓取消息')} />

      <FadeInView delay={60} duration={300} style={{ flex: 1 }}>
        <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <MemberPicker selectedMember={selectedMember} onSelect={setSelectedMember} />

          {/* 消息范围分段 */}
          <Text style={[styles.groupLabel, { color: palette.label }]}>{t('消息范围')}</Text>
          <View style={[styles.segment, { backgroundColor: palette.fill2 }]}>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.segmentBtn, messageMode === 'all' && { backgroundColor: palette.surface }]}
              onPress={() => setMessageMode('all')}
            >
              <Text style={[styles.segmentText, { color: messageMode === 'all' ? palette.label : palette.labelTertiary, fontWeight: messageMode === 'all' ? '700' : '400' }]}>{t('全部消息')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.segmentBtn, messageMode === 'owner' && { backgroundColor: palette.surface }]}
              onPress={() => setMessageMode('owner')}
            >
              <Text style={[styles.segmentText, { color: messageMode === 'owner' ? palette.label : palette.labelTertiary, fontWeight: messageMode === 'owner' ? '700' : '400' }]}>{t('成员消息')}</Text>
            </TouchableOpacity>
          </View>

          {/* 房间分区分段 */}
          <Text style={[styles.groupLabel, { color: palette.label }]}>{t('房间分区')}</Text>
          <View style={[styles.segment, { backgroundColor: palette.fill2 }]}>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.segmentBtn, roomMode === 'big' && { backgroundColor: palette.surface }]}
              onPress={() => setRoomMode('big')}
            >
              <Text style={[styles.segmentText, { color: roomMode === 'big' ? palette.label : palette.labelTertiary, fontWeight: roomMode === 'big' ? '700' : '400' }]}>{t('大房间')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.segmentBtn, roomMode === 'small' && { backgroundColor: palette.surface }]}
              onPress={() => setRoomMode('small')}
            >
              <Text style={[styles.segmentText, { color: roomMode === 'small' ? palette.label : palette.labelTertiary, fontWeight: roomMode === 'small' ? '700' : '400' }]}>{t('小房间')}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.fetchBtn}>
            <Button title={t('开始抓取')} variant="filled" size="lg" onPress={startFetch} disabled={loading} loading={loading} fullWidth />
          </View>

          {/* 状态胶囊条 */}
          {status ? (
            /失败|错误/.test(status) ? (
              <View style={[styles.statusCapsule, { backgroundColor: 'rgba(255,59,48,0.12)' }]}>
                <Text style={[styles.statusText, { color: palette.danger }]}>{status}</Text>
              </View>
            ) : (
              <View style={[styles.statusCapsule, { backgroundColor: palette.tintSoft }]}>
                <Text style={[styles.statusText, { color: palette.tint }]}>{status}</Text>
              </View>
            )
          ) : null}
        </View>

        {results.length > 0 ? (
          <Text style={[styles.resultLabel, { color: palette.labelSecondary }]}>
            {t('共 {count} 条消息', { count: results.length })}
          </Text>
        ) : null}

        <PerfFlatList
          data={results}
          keyExtractor={(item, index) => String(item.id || item.msgId || item.messageId || item.clientMsgId || index)}
          contentContainerStyle={styles.list}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          renderItem={({ item, index }) => (
            <FadeInView delay={index < 12 ? 60 + index * 25 : 0} distance={8}>
              <View style={[styles.msgItem, { backgroundColor: palette.surface }]}>
                <View style={styles.msgHead}>
                  <Text style={[styles.msgSender, { color: palette.label }]} numberOfLines={1}>
                    {item.senderName || item.senderNickName || item.extInfo?.user?.nickName || t('成员')}
                  </Text>
                  <Text style={[styles.msgTime, { color: palette.labelTertiary }]}>
                    {String(formatTimestamp(item.msgTime || item.time || item.ctime)).slice(5, 16)}
                  </Text>
                </View>
                <Text style={[styles.msgText, { color: palette.labelSecondary }]} numberOfLines={4}>
                  {messageText(item) || t('[空消息]')}
                </Text>
              </View>
            </FadeInView>
          )}
          ListEmptyComponent={loading ? <CenterSpinner text={t('抓取中…')} /> : <EmptyState icon="message-text-outline" title={t('暂无数据')} hint={t('选择成员并点击"开始抓取"获取消息')} />}
        />
      </FadeInView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  panel: { padding: 14, marginHorizontal: 16, marginTop: 4, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 12 },
  groupLabel: { fontSize: 13, fontWeight: '700', marginTop: 4 },
  segment: { flexDirection: 'row', padding: 3, borderRadius: radii.sm, gap: 3 },
  segmentBtn: {
    flex: 1,
    minHeight: 40,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentText: { fontSize: 13, lineHeight: 18 },
  fetchBtn: { marginTop: 4 },
  statusCapsule: {
    alignSelf: 'center',
    borderRadius: radii.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginTop: 2,
  },
  statusText: { fontSize: 12, lineHeight: 16, fontWeight: '600', textAlign: 'center' },
  resultLabel: { marginHorizontal: 20, marginTop: 14, fontSize: 12, fontWeight: '600' },
  list: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 120 },
  msgItem: { padding: 12, marginHorizontal: 4, marginVertical: 4, borderRadius: 14 },
  msgHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 },
  msgSender: { fontSize: 13, fontWeight: '700', flex: 1, marginRight: 8 },
  msgTime: { fontSize: 10 },
  msgText: { fontSize: 14, lineHeight: 20 },
});
