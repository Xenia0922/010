import React, { useEffect, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import PlayerScreen, { buildPocketHeaders } from '../player';
import officialMediaApi from '../api/officialMedia';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../store';
import { FadeInView, ScalePressable } from '../components/Motion';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { Skeleton } from '../components/Skeleton';
import { errorMessage, normalizeUrl, unwrapList } from '../utils/data';
import { formatTimestamp, formatDuration } from '../utils/format';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { usePalette } from '../theme';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

function normalizeVideos(res: any): any[] {
  return unwrapList(res, ['content.data', 'content.list', 'data.data', 'data.list', 'list']);
}

function mergeUniqueVideos(current: any[], next: any[]): any[] {
  const seen = new Set(current.map((item) => String(item.videoId || item.id)).filter(Boolean));
  const merged = [...current];
  next.forEach((item) => {
    const key = String(item.videoId || item.id || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

function nextCtimeFrom(list: any[]): number {
  const times = list.map((item) => Number(item.ctime)).filter((item) => Number.isFinite(item) && item > 0);
  return times.length ? Math.min(...times) : 0;
}

function mediaUrl(path: string): string {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return path.startsWith('/') ? `https://mp4.48.cn${path}` : normalizeUrl(path);
}

/** 从视频条目里提取可展示的时长（秒），无则返回空串（只展示，不参与业务判断） */
function videoDuration(item: any): string {
  const n = Number(
    item.duration || item.videoDuration || item.videoTime || item.videoLength
    || item.playTime || item.mediaDuration || item.length,
  );
  // Y19: playTime 可能是时间戳/播放量 → 仅接受 24h 内合理时长
  return Number.isFinite(n) && n > 0 && n < 86400 ? formatDuration(n) : '';
}

function videoMeta(item: any): string {
  return [item.typeName, formatTimestamp(item.ctime).slice(0, 10)].filter(Boolean).join(' · ');
}

function videoCoverUrl(item: any): string {
  return mediaUrl(item.cover || item.coverUrl || item.videoCover || item.picPath || '');
}

export default function VideoLibraryScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const [videos, setVideos] = useState<any[]>([]);
  const [playing, setPlaying] = useState<any | null>(null);
  const [playUrl, setPlayUrl] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [nextCtime, setNextCtime] = useState(0);
  const nextCtimeRef = useRef(0);
  const [loadError, setLoadError] = useState('');
  const loadingRef = useRef(false);

  const load = async (refresh = true) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const cursor = refresh ? 0 : nextCtimeRef.current;
    if (refresh) setLoading(true);
    else setLoadingMore(true);
    setStatus(refresh ? '' : '');
    if (refresh) setLoadError('');
    try {
      const res = await officialMediaApi.getVideoList({ ctime: cursor, typeId: 0, groupId: 0, limit: 20 });
      const list = normalizeVideos(res);
      setVideos((prev) => (refresh ? mergeUniqueVideos([], list) : mergeUniqueVideos(prev, list)));
      const nc = nextCtimeFrom(list);
      nextCtimeRef.current = nc;
      setNextCtime(nc);
      setHasMore(list.length >= 20 && nextCtimeFrom(list) > 0);
      const loadedCount = refresh ? list.length : mergeUniqueVideos(videos, list).length;
      setStatus(loadedCount ? t('已加载 {count} 条视频', { count: loadedCount }) : t('官方接口暂无视频资源'));
    } catch (error) {
      if (refresh) setLoadError(errorMessage(error));
      setStatus(t('加载失败：{error}', { error: errorMessage(error) }));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    load(true);
  }, []);

  const loadMore = () => {
    if (loading || loadingMore || loadingRef.current || !hasMore) return;
    load(false);
  };

  const play = async (item: any) => {
    setPlaying(item);
    setPlayUrl('');
    setStatus(t('正在解析视频地址...'));
    try {
      const res = await officialMediaApi.getVideo(String(item.videoId || item.id));
      const data = res?.content?.data || res?.content || res?.data || {};
      const url = mediaUrl(String(data.filePath || data.videoPath || data.url || ''));
      if (!url) throw new Error(t('未返回视频文件地址'));
      setPlayUrl(url);
      setStatus(t('正在播放：{title}', { title: item.title || data.title || t('视频') }));
    } catch (error) {
      setStatus(t('播放失败：{error}', { error: errorMessage(error) }));
    }
  };

  if (playUrl) {
    return (
      <View style={styles.playerPage}>
        {/* 统一播放器（重写）：官方视频 → PlayerScreen（控制条/全屏/内核切换/错误重试内置） */}
        <PlayerScreen
          source={{ kind: 'vod', url: playUrl, headers: buildPocketHeaders() }}
          meta={{ title: playing?.title || t('视频') }}
          features={{ kernelSwitch: true }}
          onClose={() => setPlayUrl('')}
          persistent
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('视频')} right={
        <HeaderAction label={t('刷新')} onPress={() => load(true)} disabled={loading} />
      } />
      {status && !loading ? <Text style={[styles.status, { color: palette.labelSecondary }]}>{status}</Text> : null}
      {loading && videos.length === 0 ? (
        <VideoSkeletonGrid />
      ) : loadError && videos.length === 0 ? (
        <View style={{ flex: 1 }}>
          <ErrorState title={t('加载失败')} hint={loadError} onAction={() => load(true)} />
        </View>
      ) : videos.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState icon="play-box-outline" title={t('暂无视频')} hint={t('官方视频资源暂不可用，可点击右上角刷新重试')} />
        </View>
      ) : (
      <FadeInView delay={60} duration={300} style={{ flex: 1 }}>
        <PerfFlatList
          data={videos.length > 1 ? videos.slice(1) : []}
          keyExtractor={(item, index) => String(item.videoId || item.id || `g${index}`)}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={styles.listContent}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          onEndReached={loadMore}
          onEndReachedThreshold={0.35}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => load(true)}
              tintColor={palette.tint}
              colors={[palette.tint]}
            />
          }
          ListHeaderComponent={
            videos.length > 0 ? (
              <FadeInView delay={60} distance={8}>
                <ScalePressable
                  style={styles.bannerCard}
                  onPress={() => play(videos[0])}
                  pressedScale={0.97}
                >
                  <View style={[styles.bannerCover, { backgroundColor: palette.fill3 }]}>
                    {videoCoverUrl(videos[0]) ? (
                      <Image source={{ uri: videoCoverUrl(videos[0]) }} style={styles.bannerCoverImg} resizeMode="cover" />
                    ) : (
                      <View style={styles.bannerCoverFallback}>
                        <MaterialCommunityIcons name="video" size={40} color={palette.labelTertiary} />
                      </View>
                    )}
                    {/* 渐变遮罩 + 信息上浮 + 播放按钮 + 时长 */}
                    <View pointerEvents="none" style={styles.bannerShade} />
                    <View style={styles.bannerInfoOverlay}>
                      <Text style={styles.bannerTitleOverlay} numberOfLines={2}>
                        {videos[0].title || t('无标题')}
                      </Text>
                      <Text style={styles.bannerMetaOverlay} numberOfLines={1}>
                        {videoMeta(videos[0])}
                      </Text>
                    </View>
                    <View style={styles.bannerPlay}>
                      <View style={styles.bannerPlayBtn}>
                        <MaterialCommunityIcons name="play" size={22} color="#FFFFFF" />
                      </View>
                    </View>
                    {videoDuration(videos[0]) ? (
                      <View style={[styles.bannerDuration, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
                        <MaterialCommunityIcons name="clock-outline" size={11} color="#FFFFFF" style={{ marginRight: 2 }} />
                        <Text style={styles.bannerDurationText}>{videoDuration(videos[0])}</Text>
                      </View>
                    ) : null}
                  </View>
                </ScalePressable>
              </FadeInView>
            ) : null
          }
          ListFooterComponent={loadingMore ? <CenterSpinner text={t('加载更多...')} /> : null}
          renderItem={({ item, index }) => (
            <FadeInView delay={index < 12 ? 60 + index * 25 : 0} distance={8} style={styles.gridItem}>
              <ScalePressable
                style={styles.gridCard}
                onPress={() => play(item)}
                pressedScale={0.96}
              >
                <View style={[styles.gridCover, { backgroundColor: palette.fill3 }]}>
                  {videoCoverUrl(item) ? (
                    <Image source={{ uri: videoCoverUrl(item) }} style={styles.gridCoverImg} resizeMode="cover" />
                  ) : (
                    <View style={styles.gridCoverFallback}>
                      <MaterialCommunityIcons name="video" size={24} color={palette.labelTertiary} />
                    </View>
                  )}
                  {videoDuration(item) ? (
                    <View style={[styles.gridDuration, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                      <Text style={styles.gridDurationText}>{videoDuration(item)}</Text>
                    </View>
                  ) : null}
                  {/* 播放遮罩 */}
                  <View pointerEvents="none" style={styles.gridPlayShade} />
                </View>
                <View style={styles.gridInfo}>
                  <Text style={[styles.gridTitle, { color: palette.label }]} numberOfLines={2}>
                    {item.title || t('无标题')}
                  </Text>
                  <Text style={[styles.gridDate, { color: palette.labelTertiary }]} numberOfLines={1}>
                    {formatTimestamp(item.ctime).slice(0, 10)}
                  </Text>
                </View>
              </ScalePressable>
            </FadeInView>
          )}
        />
      </FadeInView>
      )}
    </View>
  );
}

/** 首屏骨架：banner 大卡 + 2 列网格（与真实内容同构） */
function VideoSkeletonGrid() {
  return (
    <View style={styles.skeletonWrap}>
      <Skeleton height={190} radius={16} style={styles.skeletonBanner} />
      <View style={styles.skeletonRow}>
        {[0, 1].map((c) => (
          <Skeleton key={c} height={150} radius={16} style={{ flex: 1, marginHorizontal: 6 }} />
        ))}
      </View>
      <View style={styles.skeletonRow}>
        {[0, 1].map((c) => (
          <Skeleton key={c} height={150} radius={16} style={{ flex: 1, marginHorizontal: 6 }} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  status: { marginHorizontal: 16, marginTop: 8, fontSize: 12, textAlign: 'center' },
  listContent: { paddingTop: 8, paddingHorizontal: 12, paddingBottom: 120 },
  // 大 banner 卡（第一个视频 16:9）
  bannerCard: { marginHorizontal: 4, marginBottom: 12, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  bannerCover: { width: '100%', aspectRatio: 16 / 9, overflow: 'hidden' },
  bannerCoverImg: { width: '100%', height: '100%' },
  bannerCoverFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bannerShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '60%',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  bannerInfoOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingBottom: 10 },
  bannerTitleOverlay: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', lineHeight: 22, textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  bannerMetaOverlay: { color: 'rgba(255,255,255,0.88)', fontSize: 12, marginTop: 4, textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  bannerPlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  bannerPlayBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 3,
  },
  bannerDuration: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  bannerDurationText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  // 2 列 16:9 网格卡
  gridRow: { marginHorizontal: 4 },
  gridItem: { flex: 1, margin: 4 },
  gridCard: { flex: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  gridCover: { width: '100%', aspectRatio: 16 / 9, overflow: 'hidden' },
  gridCoverImg: { width: '100%', height: '100%' },
  gridCoverFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  gridPlayShade: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.12)' },
  gridDuration: {
    position: 'absolute',
    top: 6,
    right: 6,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: 'center',
  },
  gridDurationText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  gridInfo: { padding: 10 },
  gridTitle: { fontSize: 14, fontWeight: '600', lineHeight: 19 },
  gridDate: { fontSize: 11, marginTop: 4 },
  skeletonWrap: { paddingHorizontal: 12, paddingTop: 8 },
  skeletonBanner: { marginBottom: 12 },
  skeletonRow: { flexDirection: 'row', marginBottom: 12 },
  playerPage: { flex: 1, backgroundColor: '#000' },
  videoPlayer: { flex: 1, backgroundColor: '#000' },
});
