import React, { useEffect, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import PlayerScreen, { buildPocketHeaders } from '../player';
import officialMediaApi from '../api/officialMedia';
import { useI18n } from '../i18n';
import { FadeInView, ScalePressable } from '../components/Motion';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { Skeleton } from '../components/Skeleton';
import { NetworkImage } from '../components/NetworkImage';
import { errorMessage, normalizeUrl, unwrapList } from '../utils/data';
import { formatTimestamp, formatDuration } from '../utils/format';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { usePalette } from '../theme';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

function normalizeTalks(res: any): any[] {
  return unwrapList(res, ['content.data', 'content.list', 'data.data', 'data.list', 'list']);
}

function mergeUniqueTalks(current: any[], next: any[]): any[] {
  const seen = new Set(current.map((item) => String(item.talkId || item.id)).filter(Boolean));
  const merged = [...current];
  next.forEach((item) => {
    const key = String(item.talkId || item.id || '');
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

function audioUrls(path: string): string[] {
  if (!path) return [];
  if (path.startsWith('http')) return [path];
  const clean = path.replace(/^\/+/, '');
  const urls = [
    `https://mp4.48.cn/nightwords/${clean}`,
    `https://mp4.48.cn/${clean}`,
    `https://source.48.cn/audio/${clean}`,
    `https://source.48.cn/${clean}`,
    normalizeUrl(path),
  ];
  return Array.from(new Set(urls));
}

/** 提取节目封面缩略图地址（只展示用） */
function programCover(item: any): string {
  return normalizeUrl(item.cover || item.coverUrl || item.picPath || item.imageUrl || item.thumb || '');
}

function programDate(item: any): string {
  return formatTimestamp(item.ctime).slice(0, 10);
}

/** 节目时长（秒），仅展示用，无则返回空串 */
function programDuration(item: any): string {
  const n = programDurationSec(item);
  return n > 0 ? formatDuration(n) : '';
}

function programDurationSec(item: any): number {
  const n = Number(
    item.duration || item.audioDuration || item.audioTime || item.length
    || item.playTime || item.time,
  );
  // Y19: playTime/time 等兜底字段可能是时间戳/播放量 → 仅接受 24h 内合理音频时长
  return Number.isFinite(n) && n > 0 && n < 86400 ? n : 0;
}

export default function AudioProgramsScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const [programs, setPrograms] = useState<any[]>([]);
  const [playing, setPlaying] = useState<any | null>(null);
  const [playUrls, setPlayUrls] = useState<string[]>([]);
  const [urlIndex, setUrlIndex] = useState(0);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [nextCtime, setNextCtime] = useState(0);
  const [loadError, setLoadError] = useState('');
  const loadingRef = useRef(false);
  const nextCtimeRef = useRef(0);

  const load = async (refresh = true) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const cursor = refresh ? 0 : nextCtimeRef.current;
    if (refresh) setLoading(true); else setLoadingMore(true);
    setStatus(refresh ? '' : '');
    if (refresh) setLoadError('');
    try {
      const res = await officialMediaApi.getTalkList({ ctime: cursor, groupId: 0, limit: 20 });
      const list = normalizeTalks(res);
      setPrograms((prev) => (refresh ? mergeUniqueTalks([], list) : mergeUniqueTalks(prev, list)));
      const nct = nextCtimeFrom(list);
      nextCtimeRef.current = nct;
      setNextCtime(nct);
      setHasMore(list.length >= 20 && nct > 0);
      const loadedCount = refresh ? list.length : mergeUniqueTalks(programs, list).length;
      setStatus(loadedCount ? t('已加载 {count} 个节目', { count: loadedCount }) : t('官方接口暂无电台资源'));
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
    setPlayUrls([]);
    setUrlIndex(0);
    setStatus(t('正在解析音频地址...'));
    try {
      const res = await officialMediaApi.getTalk(String(item.talkId || item.id));
      const data = res?.content?.data || res?.content || res?.data || {};
      const urls = audioUrls(String(data.filePath || data.talkPath || data.url || ''));
      if (!urls.length) throw new Error(t('未返回音频文件地址'));
      setPlayUrls(urls);
      setStatus(t('正在播放：{title}', { title: item.title || data.title || t('电台节目') }));
    } catch (error) {
      setStatus(t('播放失败：{error}', { error: errorMessage(error) }));
    }
  };

  const active = playing ? (playing.talkId ?? playing.id) : undefined;

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('电台')} right={
        <HeaderAction label={t('刷新')} onPress={() => load(true)} loading={loading} disabled={loading} />
      } />

      {playUrls[urlIndex] ? (
        <View style={[styles.playerBar, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <Text style={[styles.playerTitle, { color: palette.label }]} numberOfLines={1}>
            {playing?.title || t('正在播放')}
          </Text>
          {/* 统一播放器（重写）：电台节目 → 内嵌 PlayerScreen（线路切换保留在 children 按钮） */}
          <View style={styles.audioPlayer}>
            <PlayerScreen
              inline
              source={{ kind: 'audio', url: playUrls[urlIndex], headers: buildPocketHeaders() }}
              meta={{ title: playing?.title || t('正在播放') }}
              features={{ kernelSwitch: true, rate: true }}
              persistent
            >
              {playUrls.length > 1 ? (
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.switchLineBtn}
                  onPress={() => {
                    if (urlIndex + 1 < playUrls.length) setUrlIndex((prev) => prev + 1);
                    else setStatus(t('已无更多备用线路'));
                  }}
                >
                  <Text style={styles.switchLineText}>{t('切换线路')} ({urlIndex + 1}/{playUrls.length})</Text>
                </TouchableOpacity>
              ) : null}
            </PlayerScreen>
          </View>
        </View>
      ) : null}

      {status && !loading ? <Text style={[styles.status, { color: palette.labelSecondary }]}>{status}</Text> : null}
      {loading && programs.length === 0 ? (
        <AudioSkeletonList />
      ) : loadError && programs.length === 0 ? (
        <View style={{ flex: 1 }}>
          <ErrorState title={t('加载失败')} hint={loadError} onAction={() => load(true)} />
        </View>
      ) : programs.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState icon="radio" title={t('暂无电台节目')} hint={t('官方电台资源暂不可用，可点击右上角刷新重试')} />
        </View>
      ) : (
      <FadeInView delay={60} duration={300} style={{ flex: 1 }}>
        <PerfFlatList
          data={programs.length > 1 ? programs.slice(1) : []}
          keyExtractor={(item, index) => String(item.talkId || item.id || index)}
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
            programs.length > 0 ? (
              <HeroCard
                program={programs[0]}
                isActive={String(active || '') === String(programs[0].talkId || programs[0].id)}
                isResolving={String(active || '') === String(programs[0].talkId || programs[0].id) && playUrls.length === 0}
                onPress={() => play(programs[0])}
              />
            ) : null
          }
          ListFooterComponent={null}
          renderItem={({ item, index }) => {
            const isActive = String(active || '') === String(item.talkId || item.id);
            return (
              <FadeInView delay={index < 12 ? 60 + index * 25 : 0} distance={8}>
                <ScalePressable
                  style={[styles.progItem, isActive && { backgroundColor: palette.tintSoft }]}
                  onPress={() => play(item)}
                  pressedScale={0.97}
                >
                  <View style={[styles.iconWrap, { backgroundColor: palette.fill3 }]}>
                    {programCover(item) ? (
                      <NetworkImage source={{ uri: programCover(item) }} style={styles.rowCover} resizeMode="cover" />
                    ) : (
                      <MaterialCommunityIcons name="radio" size={20} color={palette.labelTertiary} />
                    )}
                  </View>
                  <View style={styles.infoWrap}>
                    <Text style={[styles.progTitle, { color: palette.label }]} numberOfLines={1}>{item.title || t('无标题')}</Text>
                    <Text style={[styles.progDesc, { color: palette.labelSecondary }]} numberOfLines={1}>
                      {[item.artist, item.album, item.guest].filter(Boolean).join(' · ') || programDate(item)}
                    </Text>
                  </View>
                  <View style={styles.rowTrailing}>
                    <MaterialCommunityIcons
                      name={isActive ? 'equalizer' : 'play-circle-outline'}
                      size={20}
                      color={isActive ? palette.tint : palette.labelTertiary}
                    />
                    {programDuration(item) ? (
                      <Text style={[styles.rowDuration, { color: palette.labelTertiary }]}>{programDuration(item)}</Text>
                    ) : null}
                  </View>
                </ScalePressable>
              </FadeInView>
            );
          }}
        />
      </FadeInView>
      )}
    </View>
  );
}

/** hero 播放卡：封面 96 圆角 16 + 标题 16/700 + 副标题 12 + 播放/暂停圆钮（tint 底白字 + 加载指示） */
function HeroCard({
  program,
  isActive,
  isResolving,
  onPress,
}: {
  program: any;
  isActive: boolean;
  isResolving: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  const { t } = useI18n();
  return (
    <FadeInView delay={60} distance={8}>
      <ScalePressable style={styles.heroCard} onPress={onPress} pressedScale={0.97}>
        <View style={[styles.heroCover, { backgroundColor: palette.fill3 }]}>
          {programCover(program) ? (
            <NetworkImage source={{ uri: programCover(program) }} style={styles.heroCoverImg} resizeMode="cover" />
          ) : (
            <MaterialCommunityIcons name="radio" size={28} color={palette.labelTertiary} />
          )}
        </View>
        <View style={styles.heroInfo}>
          <Text style={[styles.heroTitle, { color: palette.label }]} numberOfLines={2}>
            {program.title || t('无标题')}
          </Text>
          <Text style={[styles.heroMeta, { color: palette.labelSecondary }]} numberOfLines={1}>
            {[program.subTitle, program.guest].filter(Boolean).join(' · ') || t('口袋电台')}
          </Text>
          <Text style={[styles.heroDate, { color: palette.labelTertiary }]}>
            {programDate(program)}
            {programDuration(program) ? ` · ${programDuration(program)}` : ''}
          </Text>
        </View>
        <View style={[styles.heroPlayBtn, { backgroundColor: palette.tint }]}>
          {isResolving ? (
            <ActivityIndicator size="small" color={palette.onTint} />
          ) : (
            <MaterialCommunityIcons
              name={isActive ? 'pause' : 'play'}
              size={22}
              color={palette.onTint}
              style={isActive ? undefined : { paddingLeft: 2 }}
            />
          )}
        </View>
      </ScalePressable>
    </FadeInView>
  );
}

/** 首屏骨架列表：hero 大卡 + 行式占位 */
function AudioSkeletonList() {
  return (
    <View style={styles.skeletonWrap}>
      <Skeleton height={112} radius={16} style={styles.skeletonHero} />
      {[0, 1, 2, 3].map((r) => (
        <View key={r} style={styles.skeletonRow}>
          <Skeleton width={48} height={48} radius={10} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Skeleton width="70%" height={12} radius={6} style={{ marginBottom: 8 }} />
            <Skeleton width="45%" height={10} radius={5} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  playerBar: { marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  playerTitle: { fontSize: 14, fontWeight: '800', marginBottom: 8 },
  audioPlayer: { height: 48, width: '100%' },
  switchLineBtn: {
    position: 'absolute', right: 8, bottom: 10, zIndex: 20,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4,
  },
  switchLineText: { color: '#fff', fontSize: 10 },
  status: { marginHorizontal: 16, marginTop: 8, fontSize: 12, textAlign: 'center' },
  listContent: { paddingTop: 8, paddingHorizontal: 12, paddingBottom: 120 },
  // hero 播放卡
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 4,
    marginBottom: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  heroCover: {
    width: 96,
    height: 96,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  heroCoverImg: { width: '100%', height: '100%' },
  heroInfo: { flex: 1, marginLeft: 14, marginRight: 10, minWidth: 0 },
  heroTitle: { fontSize: 16, fontWeight: '700', lineHeight: 21 },
  heroMeta: { fontSize: 12, marginTop: 4 },
  heroDate: { fontSize: 11, marginTop: 3 },
  heroPlayBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 节目列表行
  progItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 4,
    marginVertical: 4,
    padding: 12,
    borderRadius: 16,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  rowCover: { width: '100%', height: '100%' },
  infoWrap: { flex: 1, marginLeft: 12, marginRight: 8, minWidth: 0 },
  progTitle: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  progDesc: { fontSize: 12, marginTop: 3 },
  rowTrailing: { alignItems: 'flex-end', justifyContent: 'center' },
  rowDuration: { fontSize: 11, marginTop: 6 },
  skeletonWrap: { paddingHorizontal: 12, paddingTop: 8 },
  skeletonHero: { marginBottom: 12 },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
});
