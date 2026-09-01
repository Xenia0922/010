import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';

import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { setPipPlaying } from '../utils/pip';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useSettingsStore } from '../store';
import { useMiniPlayerStore } from '../store/miniPlayerStore';
import PlayerScreen from '../player';
import { FadeInView, ScalePressable } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { EmptyState, ErrorState } from '../components/StateViews';
import { BilibiliLiveRoom } from '../types';
import { RootStackParamList } from '../navigation/types';
import { externalApi } from '../api/external';
import bilibiliApi from '../api/bilibili';
import { BilibiliDanmaku } from '../services/bilibiliDanmaku';
import { DanmakuOverlay } from '../components/DanmakuOverlay';
import DanmakuSettingsSheet from '../components/DanmakuSettingsSheet';
import { DanmakuItem } from '../utils/danmaku';
import { errorMessage, normalizeUrl } from '../utils/data';
import { NetworkImage } from '../components/NetworkImage';
import { setLiveImmersiveMode } from '../native/LivePlayer';
import { usePalette } from '../theme';
import type { Palette } from '../theme/colors';
import { useI18n } from '../i18n';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

/** 直播状态点：直播中 success 呼吸动画（原生驱动）+ 文字；未开播 labelTertiary */
function StatusDot({ live, palette, label }: { live: boolean; palette: Palette; label: string }) {
  const pulse = React.useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!live) { pulse.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [live, pulse]);

  return (
    <View style={styles.statusWrap}>
      <Animated.View
        style={[styles.statusHalo, { backgroundColor: live ? palette.success : 'transparent', opacity: live ? pulse : 1 }]}
      >
        <View style={[styles.statusDot, { backgroundColor: live ? palette.success : palette.labelTertiary }]} />
      </Animated.View>
      <Text style={[styles.statusLabel, { color: live ? palette.success : palette.labelTertiary }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export default function BilibiliLiveScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<RouteProp<RootStackParamList, 'BilibiliLiveScreen'>>();
  const palette = usePalette();
  const { t } = useI18n();
  const [rooms, setRooms] = useState<BilibiliLiveRoom[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [qualities, setQualities] = useState<{ qn: number; label: string }[]>([]);
  const [qualityQn, setQualityQn] = useState<number | null>(null);
  const [streamTitle, setStreamTitle] = useState('');
  const [activeRoom, setActiveRoom] = useState<BilibiliLiveRoom | null>(null);
  const [liveStatuses, setLiveStatuses] = useState<Record<string, boolean>>({});
  const [roomInfo, setRoomInfo] = useState<Record<string, { title: string; cover: string }>>({});
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [fetchError, setFetchError] = useState('');
  const [configError, setConfigError] = useState('');
  const [useWebPlayer, setUseWebPlayer] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [paused, setPaused] = useState(false);
  const [moreVisible, setMoreVisible] = useState(false);
  // B站直播弹幕：WebSocket 实时接收 → DanmakuOverlay（live 模式立即上屏）
  const [showDanmaku, setShowDanmaku] = useState(false);
  const [dmItems, setDmItems] = useState<DanmakuItem[]>([]);
  const [dmTick, setDmTick] = useState(0);
  const danmakuRef = useRef<BilibiliDanmaku | null>(null);
  const dmSeq = useRef(0);
  const dmBuffer = useRef<string[]>([]);
  const dmFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 缓冲/加载状态：黑屏期给用户明确反馈
  const [buffering, setBuffering] = useState(false);
  const [showDmSettings, setShowDmSettings] = useState(false);
  // 登录画质提示（一次）：未登录 B站时接口最高只给 720P，告知用户登录解锁
  const qualityHintShown = useRef(false);
  const [qualityHint, setQualityHint] = useState('');
  const qualityHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showQualityHint = useCallback((msg: string) => {
    setQualityHint(msg);
    if (qualityHintTimer.current) clearTimeout(qualityHintTimer.current);
    qualityHintTimer.current = setTimeout(() => setQualityHint(''), 5000);
  }, []);
  // 控制条沉浸显隐（B站式：点击画面切换，播放中 3 秒无操作自动隐藏）
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  const showControls = useCallback((autoHide = true) => {
    setControlsVisible(true);
    Animated.timing(controlsOpacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
    if (autoHide && !pausedRef.current) {
      hideControlsTimer.current = setTimeout(() => {
        setControlsVisible(false);
        Animated.timing(controlsOpacity, { toValue: 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      }, 3000);
    }
  }, [controlsOpacity]);
  const toggleControls = useCallback(() => {
    if (controlsVisible) {
      setControlsVisible(false);
      Animated.timing(controlsOpacity, { toValue: 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else {
      showControls();
    }
  }, [controlsVisible, showControls]);
  const videoRef = useRef<any>(null);
  // 画面旋转（翻转）：0/90/180/270，每按一次步进 90°
  const [videoRotate, setVideoRotate] = useState(0);
  const biliWindow = useWindowDimensions();
  const biliRotated = videoRotate === 90 || videoRotate === 270;
  const videoBoxW = biliRotated ? biliWindow.height : biliWindow.width;
  const videoBoxH = biliRotated ? biliWindow.width : biliWindow.height;
  const videoRotateDeg = `${videoRotate}deg`;
  // 按所选画质过滤线路；无匹配（画质切换瞬时空集）时回退全量
  const visibleCandidates = qualityQn == null
    ? candidates
    : (candidates.filter((c) => Number(c.currentQn) === qualityQn).length ? candidates.filter((c) => Number(c.currentQn) === qualityQn) : candidates);
  const safeIndex = Math.min(candidateIndex, Math.max(0, visibleCandidates.length - 1));
  const currentCandidate = visibleCandidates[safeIndex];
  const streamUrl = currentCandidate?.url || '';
  const qualityLabel = qualities.find((q) => q.qn === qualityQn)?.label || '';

  // 画中画（悬浮窗）状态同步：直播流解析成功且未暂停、非网页播放器时置位
  useEffect(() => {
    // 应用内小窗已接管 PiP 标志时不覆盖（防小窗切后台不进悬浮窗）
    if (useMiniPlayerStore.getState().visible) return;
    setPipPlaying(!!streamUrl && !paused && !useWebPlayer);
  }, [streamUrl, paused, useWebPlayer]);

  useEffect(() => {
    const parent = navigation.getParent?.();
    parent?.setOptions({ tabBarStyle: streamUrl ? { display: 'none' } : undefined });
    return () => parent?.setOptions({ tabBarStyle: undefined });
  }, [navigation, streamUrl]);

  const loadConfig = useCallback(async () => {
    try {
      const data = await externalApi.fetchBilibiliConfig();
      setRooms(data || []);
      setConfigError('');
      setStatus(data?.length ? t('已加载 {count} 个直播间', { count: data.length }) : t('没有加载到直播间配置'));
    } catch (error) {
      setConfigError(errorMessage(error));
      setStatus(t('直播间列表加载失败：{msg}', { msg: errorMessage(error) }));
    }
  }, [t]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => () => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);

  // 切到后台时复位横屏锁（防退到桌面/其它 App 仍锁横屏）；回到前台由上方 effect 按状态重新锁定
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // 横屏/全屏解耦：全屏=沉浸+横屏；横屏切换=仅旋转。两者任一为真即锁定横屏。
  useEffect(() => {
    const wantLandscape = isFullscreen || isLandscape;
    setLiveImmersiveMode(!!streamUrl && isFullscreen);
    ScreenOrientation.lockAsync(
      wantLandscape ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    ).catch(() => {});
  }, [isFullscreen, isLandscape, streamUrl]);

  const closePlayer = () => {
    danmakuRef.current?.disconnect();
    danmakuRef.current = null;
    if (dmFlushTimer.current) clearTimeout(dmFlushTimer.current);
    dmFlushTimer.current = null;
    dmBuffer.current = [];
    setDmItems([]);
    setDmTick(0);
    setShowDanmaku(false);
    setCandidates([]);
    setQualities([]);
    setQualityQn(null);
    setActiveRoom(null);
    setPlayerError('');
    setIsFullscreen(false);
    setIsLandscape(false);
    setLiveImmersiveMode(false);
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    // 从主页公演栏直达进来的：退出播放器直接回主页（不再落到 B站列表二级菜单）
    if (route.params?.roomId) navigation.goBack();
  };

  // 应用内小窗：直播流交棒给悬浮小窗
  const handleMiniPlayer = useCallback(() => {
    if (!streamUrl) return;
    useMiniPlayerStore.getState().open({
      url: streamUrl,
      title: streamTitle || t('B站直播'),
      cover: '',
      isLive: true,
      position: 0,
      backTo: { mode: 'live', playUrl: streamUrl, playTitle: streamTitle, playCover: '' },
    });
    closePlayer();
  }, [streamUrl, streamTitle, closePlayer]);

  const refreshingRef = useRef(false);
  const checkStatuses = useCallback(async (silent = false) => {
    if (!rooms.length || refreshingRef.current) return;
    refreshingRef.current = true;
    if (!silent) {
      setLoading(true);
      setStatus(t('正在刷新开播状态...'));
    }
    const next: Record<string, boolean> = {};
    for (const room of rooms) {
      try {
        const init = await bilibiliApi.getRoomInit(room.roomId);
        next[room.roomId] = Number(init.data?.live_status) === 1;
      } catch {
        next[room.roomId] = false;
      }
    }
    setLiveStatuses(next);
    // 在播房间并行抓取封面 + 场次标题（列表行展示真实封面与标题）
    const liveIds = rooms.filter((room) => next[room.roomId]).map((room) => room.roomId);
    if (liveIds.length) {
      const infoResults = await Promise.allSettled(liveIds.map((id) => bilibiliApi.getRoomInfo(id)));
      const infoMap: Record<string, { title: string; cover: string }> = {};
      infoResults.forEach((r, index) => {
        if (r.status === 'fulfilled' && r.value) {
          const d = r.value;
          infoMap[liveIds[index]] = {
            title: String(d.title || ''),
            cover: normalizeUrl(String(d.cover || d.user_cover || '')),
          };
        }
      });
      setRoomInfo(infoMap);
    }
    if (!silent) setStatus(t('状态刷新完成'));
    setLoading(false);
    refreshingRef.current = false;
  }, [rooms, t]);

  // 直播状态实时自动刷新：进入即静默查一次，之后每 30s 轮询；切回前台也立即刷新。
  // 播放中不轮询（播放器本身在播即代表开播），避免无谓请求。
  const didAutoCheck = useRef(false);
  useEffect(() => {
    if (rooms.length && !didAutoCheck.current) {
      didAutoCheck.current = true;
      checkStatuses(true);
    }
  }, [rooms, checkStatuses]);

  useEffect(() => {
    if (streamUrl || !rooms.length) return;
    const id = setInterval(() => { checkStatuses(true); }, 30000);
    return () => clearInterval(id);
  }, [rooms, streamUrl, checkStatuses]);

  // 切回前台时立即刷新开播状态（原 effect 只处理横屏锁复位）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !streamUrl) checkStatuses(true);
    });
    return () => sub.remove();
  }, [checkStatuses, streamUrl]);

  // 从主页公演栏带 roomId 进入：直接开播该房间，跳过列表
  useEffect(() => {
    const roomId = route.params?.roomId;
    if (!roomId) return;
    startWatch({ roomId, name: route.params?.roomName || '', isLive: true });
    // 只在进入时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startWatch = async (room: BilibiliLiveRoom) => {
    setLoading(true);
    setStatus(t('正在获取直播流：{name}', { name: room.name || room.roomId }));
    setPlayerError('');
    setUseWebPlayer(false);
    setCandidates([]);
    setCandidateIndex(0);
    setQualities([]);
    setQualityQn(null);
    setActiveRoom(room);
    setFetchError('');
    danmakuRef.current?.disconnect();
    danmakuRef.current = null;
    setDmItems([]);
    setDmTick(0);
    setShowDanmaku(false);
    try {
      const info = await bilibiliApi.resolveLive(room.roomId);
      if (!info.streamUrl && !info.streamCandidates?.length) {
        throw new Error(t('没有解析到可播放的直播流'));
      }
      const list = info.streamCandidates?.length ? info.streamCandidates : [{ url: info.streamUrl }];
      setStreamTitle(info.title || room.name || t('B站直播'));
      setCandidates(list);
      // 默认最高可用画质（resolveLive 已按画质降序排列候选）
      const qs = info.qualities || [];
      setQualities(qs);
      setQualityQn(qs.length ? qs[0].qn : null);
      // 未登录 B站时接口最高只给 720P：一次性轻提示告知登录解锁原画/蓝光
      if (!qualityHintShown.current && !useSettingsStore.getState().settings.bilibiliCookie && qs.length && qs[0].qn < 400) {
        qualityHintShown.current = true;
        showQualityHint(t('未登录B站，当前最高{label}；登录后自动解锁原画/蓝光', { label: qs[0].label }));
      }
      // 连接弹幕服务（失败静默，不影响播放）；消息节流：300ms 批量上屏，避免高频 setState 卡顿
      const dm = new BilibiliDanmaku();
      danmakuRef.current = dm;
      dm.connect(String(info.realRoomId || room.roomId), {
        onMessage: (text) => {
          dmBuffer.current.push(text);
          if (dmFlushTimer.current) return;
          dmFlushTimer.current = setTimeout(() => {
            dmFlushTimer.current = null;
            const batch = dmBuffer.current.splice(0, 24);
            if (!batch.length) return;
            dmSeq.current += batch.length;
            const tick = dmSeq.current * 0.12;
            setDmTick(tick);
            setDmItems((prev) => {
              const next = [...prev, ...batch.map((text) => ({ time: tick, text }))];
              return next.length > 300 ? next.slice(-300) : next;
            });
            setShowDanmaku(true);
          }, 300);
        },
      });
      setStatus('');
      showControls();
      setIsLandscape(true);
      setIsFullscreen(true); // 进入直播间即自动横屏+全屏沉浸（用户偏好：B站直播只看横屏）
    } catch (error) {
      setFetchError(errorMessage(error));
      setStatus(t('获取直播流失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  const switchToNextCandidate = useCallback((reason: string) => {
    // 完全静默换流：不弹任何提示，避免打断观看（用户明确不想要换流弹窗/提示）
    const canSwitch = candidateIndex + 1 < visibleCandidates.length;
    if (canSwitch) {
      setCandidateIndex((prev) => Math.min(prev + 1, visibleCandidates.length - 1));
      return;
    }
    // 全部线路都失败：静默切网页播放器兜底（H5 解码兼容性更好），仍失败才弹错误卡
    if (!useWebPlayer) {
      setUseWebPlayer(true);
      setPlayerError('');
      return;
    }
    setPlayerError(t('{reason}。所有线路都试过了，建议先确认该房间真的在播，或登录 B站账号后重试。', { reason }));
  }, [candidateIndex, visibleCandidates.length, t, useWebPlayer]);

  /** 切换画质：按 qn 过滤线路并回到第一条，Video 随 key 变化重新加载 */
  const pickQuality = (qn: number) => {
    if (qualityQn === qn) return;
    setQualityQn(qn);
    setCandidateIndex(0);
    setPlayerError('');
  };

  // 从主页公演栏直达：解析直播流期间显示全屏加载（避免闪一下列表页/长时间黑屏无反馈）
  if (route.params?.roomId && !streamUrl && !fetchError) {
    return (
      <View style={styles.playerPage}>
        <View style={styles.startingWrap}>
          <ActivityIndicator color="#ffffff" size="large" />
          <Text style={styles.startingText}>{t('正在进入直播间…')}</Text>
        </View>
      </View>
    );
  }

  if (streamUrl) {
    /* 统一播放器（重写）：B站直播 → PlayerScreen
       - 候选线路：urls 传全部线路，失败自动切下一线路（PlayerCore 内置）
       - 画质/弹幕设置/下一线路：extraActions（更多面板）
       - B站弹幕：children 插槽挂 DanmakuOverlay（WebSocket 数据源保留在页面）
       - 音量补偿 volume 1.5（B站流响度低） */
    return (
      <View style={styles.playerPage}>
        <PlayerScreen
          source={{
            kind: 'live',
            url: streamUrl,
            urls: visibleCandidates.map((c) => c.url),
            headers: bilibiliApi.headers(currentCandidate?.realRoomId),
            volume: 1.5,
          }}
          meta={{ title: streamTitle || t('B站直播') }}
          features={{ kernelSwitch: true, danmaku: true }}
          extraActions={[
            ...(qualities.length > 1
              ? qualities.map((q) => ({
                  key: `qn-${q.qn}`,
                  icon: 'high-definition-box',
                  label: q.label,
                  active: qualityQn === q.qn,
                  onPress: () => pickQuality(q.qn),
                }))
              : []),
            { key: 'dmsettings', icon: 'cog-outline', label: t('弹幕设置'), onPress: () => setShowDmSettings(true) },
            ...(safeIndex + 1 < visibleCandidates.length
              ? [{ key: 'next', icon: 'playlist-check', label: t('下一线路'), onPress: () => setCandidateIndex((prev) => Math.min(prev + 1, visibleCandidates.length - 1)) }]
              : []),
          ]}
          onClose={closePlayer}
          persistent
        >
          {/* B站直播弹幕：实时滚动（live 模式立即上屏） */}
          <DanmakuOverlay
            danmaku={dmItems}
            currentTime={dmTick}
            visible={showDanmaku && !!streamUrl}
            live
          />
        </PlayerScreen>

        {/* 登录画质提示：未登录时一次性告知（区别于换流提示，仅画质相关） */}
        {qualityHint ? (
          <Animated.View style={styles.qualityHintWrap} pointerEvents="none">
            <View style={styles.qualityHintPill}>
              <MaterialCommunityIcons name="account-key-outline" size={13} color="#ffd9e2" />
              <Text style={styles.qualityHintText} numberOfLines={2}>{qualityHint}</Text>
            </View>
          </Animated.View>
        ) : null}

        <DanmakuSettingsSheet visible={showDmSettings} onClose={() => setShowDmSettings(false)} />
      </View>
    );
  }

  // 首屏（列表为空且加载中）显示居中转圈；刷新时列表保持不变，仅头部显示加载指示，避免闪屏
  return (
    <View style={styles.container}>
      <ScreenHeader title={t('B站直播')} right={
        loading ? (
          <ActivityIndicator color={palette.tint} />
        ) : (
          <HeaderAction label={t('刷新状态')} onPress={checkStatuses} />
        )
      } />
      {status ? <Text style={[styles.status, { color: palette.labelSecondary, backgroundColor: palette.surface, borderColor: palette.hairline }]}>{status}</Text> : null}
      {fetchError ? (
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.retryBtn, { backgroundColor: palette.tint }]}
          onPress={() => activeRoom && startWatch(activeRoom)}
        >
          <Text style={[styles.retryBtnText, { color: palette.onTint }]}>{t('重试获取直播流')}</Text>
        </TouchableOpacity>
      ) : null}
      <PerfFlatList
        data={rooms}
        keyExtractor={(item, index) => item.roomId || String(index)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={checkStatuses}
            tintColor={palette.tint}
            colors={[palette.tint]}
            progressBackgroundColor={palette.surface}
          />
        }
        renderItem={({ item, index }) => {
          const live = !!liveStatuses[item.roomId];
          const info = roomInfo[item.roomId];
          return (
            <FadeInView delay={index < 12 ? 60 + index * 25 : 0} duration={360}>
              <ScalePressable
                activeOpacity={0.85}
                pressedScale={0.97}
                style={[styles.roomItem, { backgroundColor: palette.surface, borderColor: palette.hairline }]}
                onPress={() => startWatch(item)}
              >
                <View style={[styles.roomIcon, { backgroundColor: live ? palette.tintSoft : palette.fill2 }]}>
                  {info?.cover ? (
                    <NetworkImage source={{ uri: info.cover }} style={styles.roomIcon} resizeMode="cover" />
                  ) : (
                    <MaterialCommunityIcons name="television-classic" size={22} color={live ? palette.tint : palette.labelSecondary} />
                  )}
                </View>
                <View style={styles.roomInfo}>
                  <Text style={[styles.roomName, { color: palette.label }]} numberOfLines={2}>
                    {info?.title || item.name || t('房间号：{id}', { id: item.roomId })}
                  </Text>
                  <Text style={[styles.roomId, { color: palette.labelSecondary }]} numberOfLines={1}>
                    {item.name || ''}{item.name ? ' · ' : ''}{t('房间号：{id}', { id: item.roomId })}
                  </Text>
                </View>
                <StatusDot live={live} palette={palette} label={live ? t('直播中') : t('未开播')} />
              </ScalePressable>
            </FadeInView>
          );
        }}
        ListEmptyComponent={
          configError ? (
            <ErrorState title={t('加载失败')} hint={configError} onAction={loadConfig} />
          ) : (
            <EmptyState icon="broadcast" title={t('暂无直播间')} hint={t('下拉刷新或稍后再来看看')} />
          )
        }
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  status: { margin: 12, padding: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, fontSize: 12, textAlign: 'center' },
  retryBtn: {
    alignSelf: 'center',
    marginTop: -4,
    marginBottom: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 16,
  },
  retryBtnText: { fontSize: 13, fontWeight: '800' },
  playerPage: { flex: 1, backgroundColor: '#000' },
  player: { flex: 1, backgroundColor: '#000' },
  nativeVideo: { flex: 1, backgroundColor: '#000' },
  startingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  startingText: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '600' },
  bufferingWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center', gap: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  bufferingText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600' },
  qualityHintWrap: { position: 'absolute', top: 96, left: 0, right: 0, alignItems: 'center', zIndex: 40, pointerEvents: 'none' },
  qualityHintPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    backgroundColor: 'rgba(20,20,22,0.88)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,143,168,0.35)',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4,
    maxWidth: '86%',
  },
  qualityHintText: { color: '#ffd9e2', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  playerError: { position: 'absolute', left: 16, right: 16, bottom: 110, padding: 12, borderRadius: 16, backgroundColor: '#1C1C1F' },
  playerErrorText: { color: '#fff', fontSize: 12, lineHeight: 18 },
  playerActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  webFallbackBtn: { borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, alignSelf: 'flex-start' },
  webFallbackText: { fontSize: 12, fontWeight: '800' },
  roomItem: { flexDirection: 'row', alignItems: 'center', padding: 12, marginHorizontal: 4, marginVertical: 4, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  roomIcon: { width: 56, height: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 12, overflow: 'hidden' },
  roomInfo: { flex: 1, minWidth: 0 },
  roomName: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  roomId: { fontSize: 11, marginTop: 4 },
  statusWrap: { alignItems: 'flex-end', gap: 4, marginLeft: 8, minWidth: 44 },
  statusHalo: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: 10, fontWeight: '700' },
  list: { padding: 8, paddingBottom: 40 },
});
