import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  Alert,
  Image,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '../navigation/types';
import { useSettingsStore, useUiStore } from '../store';
import { FadeInView } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { ScalePressable } from '../components/Motion';
import { Button } from '../components/Button';
import { EmptyState } from '../components/StateViews';
import { NetworkImage } from '../components/NetworkImage';
import { usePalette, radii } from '../theme';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useI18n } from '../i18n';
import {
  clearFinishedDownloads,
  deleteDownloadItem,
  DownloadItem,
  enqueueDownload,
  loadDownloadItems,
  openDownloadItem,
} from '../services/downloads';

type Nav = StackNavigationProp<RootStackParamList, 'DownloadScreen'>;

function formatBytes(value?: number) {
  if (value === undefined || value === null) return '--';
  const bytes = Number(value) || 0;
  if (bytes <= 0) return '0 B';
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function typeLabel(type: DownloadItem['type']) {
  if (type === 'replay') return '录播';
  if (type === 'voice') return '语音';
  if (type === 'image') return '图片';
  if (type === 'video') return '视频';
  if (type === 'audio') return '音频';
  return '文件';
}

function typeIcon(type: DownloadItem['type']): string {
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  if (type === 'audio') return 'music';
  if (type === 'voice') return 'microphone';
  if (type === 'replay') return 'replay';
  return 'file';
}

export default function DownloadScreen() {
  const navigation = useNavigation<Nav>();
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((s) => s.showToast);
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [imgPreview, setImgPreview] = useState('');

  const handleOpen = async (item: DownloadItem) => {
    if (item.type === 'image' && item.localUri) {
      setImgPreview(item.localUri);
      return;
    }
    try { await openDownloadItem(item); } catch (e: any) { showToast(t('打开失败：{msg}', { msg: e?.message || e })); }
  };

  const refresh = useCallback(async () => {
    setItems(await loadDownloadItems());
  }, []);

  useFocusEffect(useCallback(() => {
    refresh();
  }, [refresh]));

  // G2: 下载进度节流——每块进度都全表刷新太频（进度回调密集时列表持续重建）
  const lastRefreshRef = useRef(0);
  const throttledRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastRefreshRef.current < 400) return;
    lastRefreshRef.current = now;
    refresh();
  }, [refresh]);

  const startManualDownload = async () => {
    const target = url.trim();
    if (!target || busy) return;
    setBusy(true);
    try {
      await enqueueDownload({
        url: target,
        type: /\.(jpe?g|png|webp|gif)(\?|$)/i.test(target) ? 'image'
          : /\.(mp3|m4a|aac|amr|wav)(\?|$)/i.test(target) ? 'audio'
          : /\.(mp4|m3u8|flv|mov)(\?|$)/i.test(target) ? 'video'
          : 'file',
        onProgress: throttledRefresh,
      });
      setUrl('');
      showToast(t('下载完成'));
    } catch (error: any) {
      showToast(t('下载失败：{msg}', { msg: error?.message || error }));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const retryTask = async (task: DownloadItem) => {
    try {
      await enqueueDownload({
        url: task.url,
        type: task.type,
        name: task.name,
        onProgress: throttledRefresh,
      });
      // 删除原失败记录，避免同 URL 双任务
      try { await deleteDownloadItem(task.id); } catch { /* ignore */ }
      showToast(t('已重新加入下载'));
    } catch (error: any) {
      showToast(t('重试失败：{msg}', { msg: error?.message || error }));
    } finally {
      refresh();
    }
  };

  const remove = async (id: string) => {
    // 删除下载记录 + 本地文件不可恢复，二次确认
    Alert.alert(t('删除下载'), t('将删除该下载项及本地文件，确定？'), [
      { text: t('取消'), style: 'cancel' },
      {
        text: t('删除'),
        style: 'destructive',
        onPress: async () => {
          try { await deleteDownloadItem(id); } catch { /* ignore */ }
          refresh();
        },
      },
    ]);
  };

  const clearDone = async () => {
    // 清理全部已完成/失败项 + 本地文件，不可恢复，二次确认
    Alert.alert(t('清理完成'), t('将删除所有已完成和失败的下载项及本地文件，确定？'), [
      { text: t('取消'), style: 'cancel' },
      {
        text: t('清理'),
        style: 'destructive',
        onPress: async () => {
          try { await clearFinishedDownloads(); } catch { /* ignore */ }
          refresh();
        },
      },
    ]);
  };

  const doneCount = items.filter((item) => item.status === 'done').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const activeCount = items.length - doneCount - failedCount;

  // 任务按状态分组：下载中 → 已完成 → 失败（组头 + 任务行）
  const rows = useMemo(() => {
    const groups: { key: string; title: string; items: DownloadItem[] }[] = [
      { key: 'active', title: t('下载中'), items: [] },
      { key: 'done', title: t('已完成'), items: [] },
      { key: 'failed', title: t('失败'), items: [] },
    ];
    for (const it of items) {
      if (it.status === 'done') groups[1].items.push(it);
      else if (it.status === 'failed') groups[2].items.push(it);
      else groups[0].items.push(it);
    }
    const flat: { type: 'header' | 'item'; key: string; title?: string; item?: DownloadItem }[] = [];
    groups.forEach((g) => {
      if (!g.items.length) return;
      flat.push({ type: 'header', key: `h-${g.key}`, title: g.title });
      g.items.forEach((it) => flat.push({ type: 'item', key: `i-${it.id}`, item: it }));
    });
    return flat;
  }, [items, t]);

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('下载管理')} right={
        <HeaderAction label={t('清理完成')} onPress={clearDone} disabled={doneCount + failedCount === 0} />
      } />

      <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
        <View style={[styles.manualCard, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
          <View style={styles.manualHead}>
            <MaterialCommunityIcons name="link-variant" size={18} color={palette.tint} />
            <Text style={[styles.manualTitle, { color: palette.label }]}>{t('手动添加下载')}</Text>
          </View>
          <TextInput
            style={[styles.urlInput, { backgroundColor: palette.fill2, color: palette.label, borderColor: palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]}
            placeholder={t('粘贴图片、语音、视频或录播地址')}
            placeholderTextColor={palette.labelTertiary}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={startManualDownload}
            blurOnSubmit={false}
          />
          <Button title={t('添加下载')} onPress={startManualDownload} variant="filled" size="md" fullWidth loading={busy} disabled={busy} style={styles.addBtn} />
        </View>

        <PerfFlatList
          data={rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            items.length > 0 ? (
              <View style={[styles.overviewCard, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
                <View style={styles.overviewItem}>
                  <Text style={[styles.overviewNum, { color: palette.tint }]}>{activeCount}</Text>
                  <Text style={[styles.overviewLabel, { color: palette.labelSecondary }]}>{t('下载中')}</Text>
                </View>
                <View style={[styles.overviewDivider, { backgroundColor: palette.hairline }]} />
                <View style={styles.overviewItem}>
                  <Text style={[styles.overviewNum, { color: palette.success }]}>{doneCount}</Text>
                  <Text style={[styles.overviewLabel, { color: palette.labelSecondary }]}>{t('已完成')}</Text>
                </View>
                <View style={[styles.overviewDivider, { backgroundColor: palette.hairline }]} />
                <View style={styles.overviewItem}>
                  <Text style={[styles.overviewNum, { color: failedCount ? palette.danger : palette.label }]}>{failedCount}</Text>
                  <Text style={[styles.overviewLabel, { color: palette.labelSecondary }]}>{t('失败')}</Text>
                </View>
              </View>
            ) : null
          }
          ListEmptyComponent={<EmptyState icon="download-off" title={t('暂无下载项目')} hint={t('通过上方输入框粘贴链接下载')} />}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          renderItem={({ item, index }) => {
            if (item.type === 'header') {
              return (
                <Text style={[styles.groupTitle, { color: palette.labelTertiary }]}>{item.title}</Text>
              );
            }
            const task = item.item as DownloadItem;
            const progress = Math.round((task.progress || 0) * 100);
            const thumbUri = task.type === 'image' ? (task.localUri || task.url) : '';
            return (
              <FadeInView delay={index < 12 ? 60 + index * 25 : 0} duration={300}>
                <View style={[styles.task, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                  {/* 缩略图 44 圆角 10：图片用本地/网络缩略，其余回退为类型图标 */}
                  {thumbUri ? (
                    <NetworkImage source={{ uri: thumbUri }} style={[styles.taskThumb, { backgroundColor: palette.fill3 }]} />
                  ) : (
                    <View style={[styles.taskThumb, styles.taskThumbIcon, { backgroundColor: palette.tintSoft }]}>
                      <MaterialCommunityIcons name={typeIcon(task.type)} size={20} color={palette.tint} />
                    </View>
                  )}
                  <View style={styles.taskBody}>
                    <View style={styles.taskTitleRow}>
                      <Text style={[styles.taskName, { color: palette.label }]} numberOfLines={1}>{task.name}</Text>
                      <View style={[styles.taskTypePill, { backgroundColor: palette.fill2 }]}>
                        <Text style={[styles.taskTypeText, { color: palette.labelSecondary }]}>{t(typeLabel(task.type))}</Text>
                      </View>
                    </View>
                    <View style={[styles.progressTrack, { backgroundColor: palette.fill3 }]}>
                      <View
                        style={[
                          styles.progressFill,
                          { backgroundColor: task.status === 'failed' ? palette.danger : palette.tint, width: `${progress}%` },
                        ]}
                      />
                    </View>
                    <View style={styles.taskMetaRow}>
                      <Text style={[styles.taskStatus, { color: task.status === 'failed' ? palette.danger : palette.labelSecondary }]} numberOfLines={1}>
                        {task.status === 'done' ? t('完成') : task.status === 'failed' ? t('失败：{msg}', { msg: task.error || '' }) : t('下载中 {downloaded} / {total}', { downloaded: formatBytes(task.downloadedBytes), total: formatBytes(task.totalBytes) })}
                      </Text>
                      <Text style={[styles.taskPercent, { color: palette.labelTertiary }]}>{progress}%</Text>
                    </View>
                  </View>
                  <View style={styles.taskActions}>
                    {task.status === 'failed' ? (
                      <ScalePressable onPress={() => retryTask(task)} style={[styles.actionBtn, { backgroundColor: palette.tintSoft }]} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <MaterialCommunityIcons name="refresh" size={16} color={palette.tint} />
                      </ScalePressable>
                    ) : (
                      <ScalePressable onPress={() => handleOpen(task).catch((error: any) => showToast(t('打开失败：{msg}', { msg: error?.message || error })))} style={[styles.actionBtn, { backgroundColor: palette.tintSoft }]} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <MaterialCommunityIcons name="open-in-app" size={16} color={palette.tint} />
                      </ScalePressable>
                    )}
                    <ScalePressable onPress={() => remove(task.id)} style={styles.actionBtn} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <MaterialCommunityIcons name="delete-outline" size={16} color={palette.danger} />
                    </ScalePressable>
                  </View>
                </View>
              </FadeInView>
            );
          }}
        />
      </FadeInView>
      {imgPreview ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setImgPreview('')}>
          <ScalePressable style={styles.imgModal} activeOpacity={1} onPress={() => setImgPreview('')}>
            <Image source={{ uri: imgPreview }} style={styles.imgFull} resizeMode="contain" />
          </ScalePressable>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  manualCard: { marginHorizontal: 16, marginBottom: 8, padding: 14, borderRadius: 16 },
  manualHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  manualTitle: { fontSize: 15, fontWeight: '700', flex: 1 },
  urlInput: { minHeight: 42, paddingHorizontal: 14, borderRadius: 14, fontSize: 13 },
  addBtn: { marginTop: 10, alignSelf: 'stretch' },
  list: { padding: 4, paddingBottom: 112 },
  // 状态概览卡（3 列统计：value 20/800 + label 11，中间分隔）
  overviewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 6,
    paddingVertical: 16,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  overviewItem: { flex: 1, alignItems: 'center' },
  overviewNum: { fontSize: 20, fontWeight: '800' },
  overviewLabel: { fontSize: 11, marginTop: 2 },
  overviewDivider: { width: StyleSheet.hairlineWidth, height: 32, alignSelf: 'center' },
  groupTitle: { fontSize: 13, fontWeight: '800', marginTop: 12, marginBottom: 4, paddingLeft: 16 },
  task: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginVertical: 4,
    padding: 12,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  taskThumb: { width: 44, height: 44, borderRadius: 10, marginRight: 12 },
  taskThumbIcon: { alignItems: 'center', justifyContent: 'center' },
  taskBody: { flex: 1, minWidth: 0 },
  taskTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  taskName: { fontSize: 14, fontWeight: '600', flex: 1 },
  taskTypePill: { borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 2 },
  taskTypeText: { fontSize: 10, fontWeight: '700' },
  progressTrack: { height: 4, marginTop: 8, borderRadius: 2, overflow: 'hidden', backgroundColor: 'transparent' },
  progressFill: { height: 4, borderRadius: 2 },
  taskMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  taskStatus: { fontSize: 11, flex: 1 },
  taskPercent: { fontSize: 11, fontWeight: '800' },
  taskActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 10 },
  actionBtn: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
  },
  imgModal: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', alignItems: 'center', justifyContent: 'center' },
  imgFull: { width: '96%', height: '80%' },
});
