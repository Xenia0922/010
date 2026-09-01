import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';
import { NetworkImage } from '../components/NetworkImage';

import {
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import PlayerScreen, { buildPocketHeaders } from '../player';
import { useNavigation } from '@react-navigation/native';
import { Member } from '../types';
import MemberPicker from '../components/MemberPicker';
import ZoomImageModal from '../components/ZoomImageModal';
import { useSettingsStore, useUiStore } from '../store';
import { FadeInView, ScalePressable } from '../components/Motion';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { HeaderAction } from '../components/HeaderAction';
import { Skeleton } from '../components/Skeleton';
import pocketApi from '../api/pocket48';
import { enqueueDownload } from '../services/downloads';
import { errorMessage, normalizeUrl, parseMaybeJson, pickText, unwrapList } from '../utils/data';
import { formatTimestamp, formatDuration } from '../utils/format';
import ScreenHeader from '../components/ScreenHeader';
import { usePalette, radii, spacing } from '../theme';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { translate, useI18n } from '../i18n';

type RoomMode = 'big' | 'small';

type AlbumItem = {
  id: string;
  url: string;
  type: 'image' | 'video';
  title: string;
  time: any;
  roomMode: RoomMode;
  raw: any;
};

function parseAlbumBody(item: any) {
  const raw = item?.bodys ?? item?.body ?? item?.msgContent ?? item?.content ?? item?.message;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  const direct = parseMaybeJson(raw);
  if (direct && typeof direct === 'object') return direct;
  try {
    // Only attempt cleaning if JSON parse fails
    const direct = parseMaybeJson(raw);
    if (direct && typeof direct === 'object') return direct;
    // Clean double-escaped strings: \\" -> " and \\ -> \
    let clean = raw.replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\\\');
    if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
    try { return JSON.parse(clean) || {}; } catch { return {}; }
  } catch {
    return {};
  }
}

function mediaUrl(item: any) {
  const body = parseAlbumBody(item);
  return normalizeUrl(pickText(body, [
    'url',
    'imageUrl',
    'videoUrl',
    'mediaUrl',
    'msg.url',
    'message.url',
  ]) || pickText(item, ['url', 'imageUrl', 'videoUrl']));
}

function isVideoItem(item: any, url: string) {
  const body = parseAlbumBody(item);
  const marker = `${item?.sourceType || ''} ${item?.msgType || ''} ${body?.ext || ''} ${body?.type || ''} ${url}`.toUpperCase();
  return marker.includes('VIDEO') || /\.(mp4|mov|m4v|3gp|webm)(\?|$)/i.test(url);
}

/** 从条目里尝试提取视频时长（秒），无则 0 */
function mediaDuration(item: any): number {
  const body = parseAlbumBody(item);
  const n = Number(
    pickText(body, ['duration', 'time', 'videoDuration', 'videoTime', 'length'])
    || pickText(item, ['duration', 'videoDuration', 'videoTime', 'length']),
  );
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeAlbumItems(res: any, mode: RoomMode): AlbumItem[] {
  const list = unwrapList(res, [
    'content.messageList',
    'content.message',
    'content.list',
    'content.data',
    'data.messageList',
    'messageList',
    'message',
    'list',
  ]);

  return list.map((item, index) => {
    const body = parseAlbumBody(item);
    const url = mediaUrl(item);
    const type: AlbumItem['type'] = isVideoItem(item, url) ? 'video' : 'image';
    return {
      id: String(item.id || item.msgId || item.messageId || `${mode}-${item.createTime || item.msgTime || index}-${url}`),
      url,
      type,
      title: pickText(item, ['starName', 'senderName', 'senderNickName', 'nickName'], type === 'video' ? translate('房间视频') : translate('房间图片')),
      time: item.createTime || item.msgTime || item.ctime || body.time,
      roomMode: mode,
      raw: item,
    };
  }).filter((item) => item.url);
}

function nextTimeFrom(res: any, list: AlbumItem[]) {
  const direct = Number(pickText(res, ['content.nextTime', 'content.next', 'data.nextTime', 'nextTime']));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const times = list.map((item) => Number(item.time)).filter((time) => Number.isFinite(time) && time > 0);
  return times.length ? Math.min(...times) : 0;
}

function uniqueMerge(prev: AlbumItem[], next: AlbumItem[]) {
  const seen = new Set(prev.map((item) => `${item.roomMode}:${item.url || item.id}`));
  const merged = [...prev];
  next.forEach((item) => {
    const key = `${item.roomMode}:${item.url || item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged.sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
}

function channelFor(member: Member, mode: RoomMode) {
  return String(mode === 'small' ? (member.yklzId || '') : (member.channelId || ''));
}

export default function RoomAlbumScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((state) => state.showToast);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [roomMode, setRoomMode] = useState<RoomMode>('big');
  const [items, setItems] = useState<AlbumItem[]>([]);
  const [nextTime, setNextTime] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [playing, setPlaying] = useState<AlbumItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(t('暂无数据'));
  const [loadError, setLoadError] = useState('');
  // 小房间名字/背景解析（用户指定实现）：getRoomInfo → channelInfoList 匹配 channelId
  const [roomName, setRoomName] = useState('');
  const [roomBg, setRoomBg] = useState('');
  const loadingRef = useRef(false);

  const currentChannelId = useMemo(() => selectedMember ? channelFor(selectedMember, roomMode) : '', [roomMode, selectedMember]);

  const loadAlbum = async (member: Member, mode: RoomMode = roomMode, append = false) => {
    if (loadingRef.current) return;
    const channelId = channelFor(member, mode);
    if (!channelId) {
      setStatus(mode === 'small' ? t('这个成员没有小房间 channelId。') : t('这个成员没有大房间 channelId。'));
      setItems([]);
      setHasMore(false);
      return;
    }

    loadingRef.current = true;
    setSelectedMember(member);
    setRoomMode(mode);
    setLoading(true);
    setLoadError('');
    setStatus('');
    setRoomName(''); setRoomBg('');
    // 小房间/大房间名字 + 背景解析：room/info → 塞纳河 server/detail（channelInfoList 房间名 + 背景墙图）
    pocketApi.getRoomMeta(channelId, mode === 'small' ? member.channelId : undefined, member.serverId).then((meta) => {
      if (meta?.name) setRoomName(meta.name);
      if (meta?.bg) setRoomBg(meta.bg);
    }).catch(() => {});
    try {
      const res = await pocketApi.getRoomAlbum({ channelId, nextTime: append ? nextTime : 0 });
      const nextItems = normalizeAlbumItems(res, mode);
      const merged = append ? uniqueMerge(items, nextItems) : uniqueMerge([], nextItems);
      const next = nextTimeFrom(res, nextItems);
      setItems(merged);
      setNextTime(next);
      // 游标无前进（恒同本次请求值）即终止，防死循环
      setHasMore(nextItems.length > 0 && next > 0 && (append ? next !== nextTime : true));
      const imageCount = merged.filter((item) => item.type === 'image').length;
      const videoCount = merged.filter((item) => item.type === 'video').length;
      const text = t('已加载 {count} 条 · 图片 {image} · 视频 {video}', { count: merged.length, image: imageCount, video: videoCount });
      setStatus(text);
      showToast(text);
    } catch (error) {
      setLoadError(errorMessage(error));
      setStatus(t('加载失败：{msg}', { msg: errorMessage(error) }));
      if (!append) setItems([]);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const switchMode = (mode: RoomMode) => {
    if (!selectedMember || mode === roomMode) return;
    setItems([]);
    setNextTime(0);
    setHasMore(false);
    setRoomMode(mode); // update UI immediately, don't wait for loadAlbum
    loadAlbum(selectedMember, mode, false);
  };

  const loadMoreAlbum = () => {
    if (!selectedMember || loading || loadingRef.current || !hasMore) return;
    loadAlbum(selectedMember, roomMode, true);
  };

  const downloadItem = useCallback(async (item: AlbumItem) => {
    try {
      await enqueueDownload({
        url: item.url,
        type: item.type,
        name: selectedMember ? `${selectedMember.ownerName}-${item.roomMode}-${item.type}` : `room-${item.type}`,
      });
      showToast(t('已加入下载管理'));
    } catch (error) {
      showToast(t('下载失败：{msg}', { msg: errorMessage(error) }));
    }
  }, [selectedMember, showToast]);

  // 稳定回调：让网格行组件可被 React.memo 记忆，避免父组件状态变化引发整网格重渲染/重解码。
  const handleOpen = useCallback((item: AlbumItem) => {
    if (item.type === 'video') setPlaying(item);
    else setPreviewUrl(item.url);
  }, [setPlaying, setPreviewUrl]);

  const handleLong = useCallback((item: AlbumItem) => {
    downloadItem(item);
  }, [downloadItem]);

  const renderAlbumItem = useCallback(({ item, index }: { item: AlbumItem; index: number }) => (
    <AlbumGridItem item={item} index={index} palette={palette} onOpen={handleOpen} onLongPress={handleLong} />
  ), [palette, handleOpen, handleLong]);

  if (playing) {
    // 统一播放器（重写）：相册视频 → PlayerScreen（控制条/全屏/内核切换/错误重试内置）
    return (
      <View style={styles.playerPage}>
        <PlayerScreen
          source={{ kind: 'vod', url: playing.url, headers: buildPocketHeaders() }}
          meta={{ title: playing.title }}
          features={{ kernelSwitch: true }}
          onClose={() => setPlaying(null)}
          persistent
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('房间相册')} right={
        <HeaderAction label={t('刷新')} onPress={() => selectedMember && loadAlbum(selectedMember, roomMode, false)} />
      } />

      <FadeInView delay={60} duration={300} style={{ flex: 1 }}>
        <View style={styles.pickerWrap}>
          <MemberPicker selectedMember={selectedMember} onSelect={(member) => loadAlbum(member, 'big', false)} />
          <View style={styles.segmentRow}>
            {/* 分段控件：fill2 底 + 选中白胶囊 */}
            <View style={[styles.segment, { backgroundColor: palette.fill2 }]}>
              <TouchableOpacity
                activeOpacity={0.7}
                style={[styles.segmentBtn, roomMode === 'big' && { backgroundColor: palette.surface }]}
                onPress={() => switchMode('big')}
              >
                <Text style={[styles.segmentText, { color: roomMode === 'big' ? palette.label : palette.labelTertiary, fontWeight: roomMode === 'big' ? '700' : '400' }]}>{t('大房间')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.7}
                style={[styles.segmentBtn, roomMode === 'small' && { backgroundColor: palette.surface }, !selectedMember?.yklzId && styles.modeBtnDisabled]}
                onPress={() => switchMode('small')}
              >
                <Text style={[styles.segmentText, { color: roomMode === 'small' ? palette.label : palette.labelTertiary, fontWeight: roomMode === 'small' ? '700' : '400' }]}>{t('小房间')}</Text>
              </TouchableOpacity>
            </View>
          </View>
          {status && !loading ? <Text style={[styles.status, { color: palette.labelSecondary }]}>{status}</Text> : null}
          {(roomName || selectedMember) && !loadError ? (
            <View style={styles.roomMetaRow}>
              <MaterialCommunityIcons name="home-account" size={14} color={palette.tint} />
              <Text style={[styles.roomMetaText, { color: palette.labelSecondary }]} numberOfLines={1}>
                {t('{mode} · {name}', { mode: roomMode === 'small' ? t('小房间') : t('大房间'), name: roomName || selectedMember?.ownerName || '' })}
              </Text>
            </View>
          ) : null}
          {loadError && !loading ? (
            <ErrorState
              title={t('加载失败')}
              hint={loadError}
              onAction={() => selectedMember && loadAlbum(selectedMember, roomMode, false)}
            />
          ) : null}
        </View>

        {/* 房间背景横幅（小房间/大房间背景解析） */}
        {roomBg && !playing ? (
          <View style={[styles.roomBanner, { borderColor: palette.hairline }]}>
            <Image source={{ uri: roomBg }} style={styles.roomBannerBg} resizeMode="cover" />
            <View style={styles.roomBannerScrim} />
            <View style={styles.roomBannerInfo}>
              <MaterialCommunityIcons name="image-multiple" size={14} color="#FFFFFF" />
              <Text style={styles.roomBannerTitle} numberOfLines={1}>
                {roomName || (roomMode === 'small' ? t('小房间') : t('大房间'))}
              </Text>
            </View>
          </View>
        ) : null}

        <ZoomImageModal url={previewUrl} onClose={() => setPreviewUrl('')} />
        {loading && items.length === 0 ? (
          <AlbumSkeletonGrid />
        ) : (
        <PerfFlatList
          data={items}
          numColumns={2}
            keyExtractor={(item) => `${item.roomMode}-${item.id}`}
            contentContainerStyle={styles.grid}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews
            renderItem={renderAlbumItem}
          ListEmptyComponent={<EmptyState icon="image-multiple-outline" title={t('暂无相册内容')} hint={t('选择成员后查看房间相册')} />}
          onEndReached={loadMoreAlbum}
          onEndReachedThreshold={0.35}
          refreshControl={
            <RefreshControl
              refreshing={loading && items.length > 0}
              onRefresh={() => selectedMember && loadAlbum(selectedMember, roomMode, false)}
              tintColor={palette.tint}
              colors={[palette.tint]}
            />
          }
          ListFooterComponent={hasMore ? (
            <Text style={[styles.footerText, { color: palette.labelSecondary }]}>{loading ? '' : t('上滑加载更多')}</Text>
          ) : null}
        />
        )}
      </FadeInView>
    </View>
  );
}

// --- 模块级记忆化网格项：避免翻页/loading 状态变化引发整网格重渲染 ---
const AlbumGridItem = React.memo(function AlbumGridItem({
  item,
  index,
  palette,
  onOpen,
  onLongPress,
}: {
  item: AlbumItem;
  index: number;
  palette: any;
  onOpen: (item: AlbumItem) => void;
  onLongPress: (item: AlbumItem) => void;
}) {
  const { t } = useI18n();
  const duration = mediaDuration(item);
  return (
    <FadeInView delay={index < 12 ? 60 + index * 25 : 0} distance={8}>
      <ScalePressable
        style={[styles.mediaCard, { backgroundColor: palette.fill3 }]}
        onPress={() => onOpen(item)}
        onLongPress={() => onLongPress(item)}
        pressedScale={0.96}
      >
        {item.type === 'video' ? (
          <View style={[styles.videoThumb, { backgroundColor: palette.fill3 }]}>
            {item.url ? (
              <NetworkImage source={{ uri: item.url }} style={styles.photo} resizeMode="cover" />
            ) : (
              <MaterialCommunityIcons name="video-outline" size={26} color={palette.labelTertiary} />
            )}
            {/* 播放遮罩 + 播放按钮 */}
            <View pointerEvents="none" style={styles.playShade} />
            <View style={styles.playCenter}>
              <View style={styles.playBtn}>
                <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
              </View>
            </View>
            {duration > 0 ? (
              <View style={[styles.videoBadge, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                <MaterialCommunityIcons name="play-circle" size={10} color="#FFFFFF" style={{ marginRight: 2 }} />
                <Text style={styles.videoBadgeText}>{formatDuration(duration)}</Text>
              </View>
            ) : null}
          </View>
        ) : (
          item.url ? (
            <NetworkImage source={{ uri: item.url }} style={styles.photo} resizeMode="cover" />
          ) : (
            <View style={[styles.photo, styles.photoFallback, { backgroundColor: palette.fill3 }]}>
              <MaterialCommunityIcons name="image-off-outline" size={22} color={palette.labelTertiary} />
            </View>
          )
        )}
        {/* 底部渐变遮罩 + 标题上浮 */}
        <View pointerEvents="none" style={styles.gridShade} />
        <View style={styles.infoOverlay}>
          <Text style={styles.mediaTitleOverlay} numberOfLines={1}>
            {item.title || (item.roomMode === 'small' ? t('小房间') : t('大房间'))}
          </Text>
        </View>
      </ScalePressable>
    </FadeInView>
  );
});

/** 网格骨架占位（与 2 列 3:4 网格同构） */
function AlbumSkeletonGrid() {
  const palette = usePalette();
  const { t } = useI18n();
  return (
    <View style={styles.skeletonWrap}>
      {[0, 1, 2, 3].map((r) => (
        <View key={r} style={styles.skeletonRow}>
          {[0, 1].map((c) => (
            <Skeleton key={`${r}-${c}`} height={176} radius={16} style={{ flex: 1, marginHorizontal: 6 }} />
          ))}
        </View>
      ))}
      <Text style={[styles.footerText, { color: palette.labelSecondary }]}>{t('加载中…')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  pickerWrap: { paddingHorizontal: 16, gap: 12 },
  segmentRow: { flexDirection: 'row' },
  roomMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8, paddingHorizontal: 2 },
  roomMetaText: { fontSize: 12, flex: 1 },
  roomBanner: {
    marginHorizontal: 14,
    marginTop: 4,
    marginBottom: 2,
    height: 92,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  roomBannerBg: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, width: '100%', height: '100%' },
  roomBannerScrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
  roomBannerInfo: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 6 },
  roomBannerTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', flex: 1, textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  segment: { flex: 1, flexDirection: 'row', padding: 3, borderRadius: radii.sm, gap: 3 },
  segmentBtn: {
    flex: 1,
    minHeight: 40,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentText: { fontSize: 13, lineHeight: 18 },
  modeBtnDisabled: { opacity: 0.48 },
  status: { fontSize: 12, textAlign: 'center' },
  grid: { padding: 12, paddingBottom: 112 },
  mediaCard: { flex: 1, margin: 6, borderRadius: 16, overflow: 'hidden', aspectRatio: 3 / 4 },
  photo: { width: '100%', height: '100%' },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  videoThumb: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  videoBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  videoBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  // play 遮罩 + 中央播放按钮
  playShade: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.18)' },
  playCenter: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 底部渐变遮罩（模拟 0.55→0 由下而上收紧）+ 标题白字
  gridShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '45%',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  infoOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 10, paddingBottom: 8 },
  mediaTitleOverlay: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 17,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  footerText: { marginTop: 12, marginBottom: 6, textAlign: 'center', fontSize: 12, fontWeight: '600' },
  skeletonWrap: { paddingHorizontal: 12, paddingTop: 12 },
  skeletonRow: { flexDirection: 'row', marginBottom: 12 },
  playerPage: { flex: 1, backgroundColor: '#000000' },
  player: { flex: 1, backgroundColor: '#000000' },
  playerErrorWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  playerErrorText: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  playerRetryBtn: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 9, borderRadius: 18 },
  playerRetryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
});
