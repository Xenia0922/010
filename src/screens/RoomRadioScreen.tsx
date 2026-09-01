import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, Platform, Animated, Easing,
} from 'react-native';
import Video from 'react-native-video';
import { Member } from '../types';
import MemberPicker from '../components/MemberPicker';
import ScreenHeader from '../components/ScreenHeader';
import { useI18n } from '../i18n';
import { RouteProp, useRoute } from '@react-navigation/native';
import { RootStackParamList } from '../navigation/types';
import { FadeInView, ScalePressable } from '../components/Motion';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { Pill } from '../components/Pill';
import { NetworkImage } from '../components/NetworkImage';
import { Skeleton } from '../components/Skeleton';
import { errorMessage, pickText } from '../utils/data';
import pocketApi from '../api/pocket48';
import { resolveMemberRooms } from '../services/roomMapCache';
import { useMemberStore } from '../store';
import { LiveExoView, startRadioForeground, stopRadioForeground, onRadioStopRequested } from '../native/LivePlayer';
import { ensureNotificationPermission } from '../utils/notifications';
import { usePalette, makeShadows } from '../theme';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

/** 上麦/电台流是否 rtmp（react-native-video 不支持，需原生 LiveExoView） */
function isRtmpUrl(url: string): boolean {
  return String(url || '').toLowerCase().startsWith('rtmp://');
}

export default function RoomRadioScreen() {
  const palette = usePalette();
  const shadows = makeShadows(palette.name === 'dark');
  const { t } = useI18n();
  const route = useRoute<RouteProp<RootStackParamList, 'RoomRadioScreen'>>();
  const [selectedMember, setSelectedMember] = useState<Member | null>(route.params?.member || null);
  const [radioUrl, setRadioUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [loadError, setLoadError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [roomMode, setRoomMode] = useState<'big' | 'small'>(route.params?.initialMode || 'big');
  // v2.7.4：纯音频模式（上麦/电台流为声音，缺省开启）。
  // 原生 LiveExoView audioOnly：不渲染画面(避免黑屏)、音频焦点+WAKE_LOCK(切后台/锁屏续播)
  const [audioOnly, setAudioOnly] = useState(true);

  // 播放态 refs：供后台换流定时器使用，避免闭包过期
  const selectedMemberRef = useRef<Member | null>(null);
  const roomModeRef = useRef<'big' | 'small'>(roomMode);
  const playingRef = useRef(false);
  const fetchingRef = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  roomModeRef.current = roomMode;
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { selectedMemberRef.current = selectedMember; }, [selectedMember]);

  // 纯音频模式下的旋转播放指示（绕封面旋转的细环）
  const spinAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (audioOnly && playing) {
      spinAnim.setValue(0);
      loop = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 8000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      loop.start();
    } else {
      spinAnim.stopAnimation();
      spinAnim.setValue(0);
    }
    return () => { loop?.stop(); };
  }, [audioOnly, playing, spinAnim]);
  const spinRotate = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  /** 拉取电台流地址（房间映射缺失时自动补齐；返回 null 表示未拿到流） */
  const fetchRadioUrl = async (member: Member, mode: 'big' | 'small'): Promise<string | null> => {
    // 语义保持 2.7.3：小房间=member.yklzId（channelInfoList[1]），大房间=member.channelId（channelInfoList[0]）
    let channelId = mode === 'small' ? (member.yklzId || member.channelId) : member.channelId;
    let serverId = member.serverId;
    // 只要「目标频道缺失」就尝试补全（缓存优先 → serverJump → seine），而不是直接 fallback 大房间
    const needResolve = !channelId || channelId === '0' || channelId === 'undefined'
      || (mode === 'small' && (!member.yklzId || member.yklzId === '0' || member.yklzId === 'undefined'));
    if (needResolve) {
      const room = await resolveMemberRooms(String(member.id || ''), {
        name: member.ownerName,
        knownChannelId: member.channelId,
        knownYklzId: member.yklzId,
        knownServerId: member.serverId,
      });
      channelId = mode === 'small' ? (room.yklzId || room.channelId) : room.channelId;
      serverId = room.serverId || member.serverId;
      if (channelId) {
        useMemberStore.getState().patchMemberByUserId(String(member.id || ''), {
          channelId: room.channelId || member.channelId,
          yklzId: room.yklzId || member.yklzId,
          serverId,
        });
      }
    }
    if (!channelId || channelId === '0' || channelId === 'undefined') {
      const err: any = new Error('NO_CHANNEL');
      err.code = 'NO_CHANNEL';
      throw err;
    }
    const res = await pocketApi.operateRoomVoice({ channelId, serverId });
    if (res?.status && Number(res.status) !== 200) return null;
    const url = pickText(res, ['content.streamUrl', 'content.url', 'content.streamPath', 'content.playUrl', 'data.streamUrl', 'data.url', 'streamUrl', 'url']);
    return url || null;
  };

  /** 应用流地址并强制重建播放器（url 变化 → LiveExoView key 变化 → 热换流） */
  const applyStreamUrl = (url: string, member: Member, mode: 'big' | 'small') => {
    console.warn(`[radio] ${member.ownerName} ${mode} 流地址=${String(url).slice(0, 160)} (rtmp=${isRtmpUrl(url)})`);
    setRadioUrl(url);
    setStatus(t('已连接，正在缓冲...'));
    setPlaying(true);
    // 前台保活：通知栏 + WAKE_LOCK，后台/锁屏续播，通知可一键停止
    // （先请求 Android 13+ 通知权限，否则前台服务通知不可见，无法从通知栏停止）
    ensureNotificationPermission().then(() => startRadioForeground(member.ownerName || ''));
  };

  /** 播放期间每 5 分钟后台取新流：wsSecret 签名过期/断流时自动换流 */
  const scheduleStreamRefresh = () => {
    if (refreshTimer.current) return;
    refreshTimer.current = setInterval(() => {
      const m = selectedMemberRef.current;
      if (!m || !playingRef.current || fetchingRef.current) return;
      fetchingRef.current = true;
      fetchRadioUrl(m, roomModeRef.current)
        .then((fresh) => {
          if (!playingRef.current) return;
          if (fresh) {
            // 新地址与当前不同 → setRadioUrl 触发 LiveExoView key 重建换流
            setRadioUrl((cur) => (cur && cur === fresh ? cur : fresh));
            console.warn(`[radio] ${m.ownerName} 自动换流${fresh ? '' : ''}`);
          } else {
            // 后台取不到新流：保留当前流（服务端可能已停但流仍可解码）
            console.warn(`[radio] ${m.ownerName} 后台刷新未拿到新流（保留当前）`);
          }
        })
        .catch((e: any) => console.warn(`[radio] 后台换流失败：${e?.message || String(e)}`))
        .finally(() => { fetchingRef.current = false; });
    }, 5 * 60 * 1000);
  };

  const startRadio = async (member: Member, opts: { instantUrl?: string } = {}) => {
    setSelectedMember(member);
    setLoading(true);
    setStatus(t('获取电台地址...'));
    setLoadError('');
    // 秒开：上麦扫描已拿到的流地址直接开播，不重复请求
    if (opts.instantUrl) {
      applyStreamUrl(opts.instantUrl, member, roomMode);
      scheduleStreamRefresh();
      setLoading(false);
      // 后台校验一次：拿到的若是新地址立即热换，避免扫描结果过期
      fetchingRef.current = true;
      fetchRadioUrl(member, roomModeRef.current)
        .then((fresh) => {
          if (!playingRef.current) return;
          if (fresh) setRadioUrl((cur) => (cur && cur === fresh ? cur : fresh));
          else console.warn(`[radio] ${member.ownerName} 校验未拿到新流（秒开继续播放）`);
        })
        .catch(() => {})
        .finally(() => { fetchingRef.current = false; });
      return;
    }
    setRadioUrl('');
    setPlaying(false);
    try {
      const url = await fetchRadioUrl(member, roomMode);
      if (url) {
        applyStreamUrl(url, member, roomMode);
        scheduleStreamRefresh();
      } else {
        console.warn(`[radio] ${member.ownerName} ${roomMode} 未开启电台`);
        setStatus(t('该房间当前没有开启语音电台'));
      }
    } catch (error: any) {
      if (error?.code === 'NO_CHANNEL') {
        setLoadError(t('该成员缺少房间映射（channelId），已尝试自动解析仍未成功'));
        setStatus(t('获取失败：{error}', { error: t('缺少房间映射') }));
      } else {
        setLoadError(errorMessage(error));
        setStatus(t('获取失败：{error}', { error: errorMessage(error) }));
      }
    } finally {
      setLoading(false);
    }
  };

  const stopRadio = () => {
    if (refreshTimer.current) { clearInterval(refreshTimer.current); refreshTimer.current = null; }
    setPlaying(false);
    setRadioUrl('');
    setStatus(t('已停止'));
    stopRadioForeground();
  };

  const subtitle = audioOnly && playing
    ? `${t('纯音频')} · ${t('正在播放')}`
    : (muted ? t('已静音') : (playing ? t('正在播放') : (status || t('暂无电台地址'))));

  // 从上麦页 / 房间内按键带入成员时，进入页面自动开播（2.7.3 语义）。
  // 有扫描缓存的流地址（route.params.streamUrl）→ 秒开；否则正常请求。
  const autoStartedRef = useRef(false);
  useEffect(() => {
    const m = route.params?.member;
    if (m && !autoStartedRef.current) {
      autoStartedRef.current = true;
      startRadio(m, { instantUrl: route.params?.streamUrl || '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 通知栏「停止」→ 停播；离开页面时清理保活服务（避免幽灵通知）
  useEffect(() => {
    const off = onRadioStopRequested(() => stopRadio());
    return () => {
      off();
      stopRadioForeground();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('房间电台')} />

      <FadeInView delay={60} duration={360} style={{ flex: 1 }}>
        <View style={styles.pickerWrap}>
          <MemberPicker selectedMember={selectedMember} onSelect={startRadio} placeholder={t('选择成员获取上麦音频...')} />
          <View style={styles.modeRow}>
            <Pill
              label={t('大房间')}
              selected={roomMode === 'big'}
              onPress={() => { setRoomMode('big'); if (selectedMember) startRadio(selectedMember); }}
            />
            <Pill
              label={t('小房间')}
              selected={roomMode === 'small'}
              onPress={() => { setRoomMode('small'); if (selectedMember) startRadio(selectedMember); }}
            />
            <View style={styles.modeDivider} />
            <Pill
              label={t('纯音频')}
              selected={audioOnly}
              onPress={() => {
                const next = !audioOnly;
                setAudioOnly(next);
                console.warn(`[radio] ${selectedMember?.ownerName || ''} 切换${next ? '纯音频模式(无画面)' : '视频模式(渲染画面)'}`);
              }}
            />
          </View>
        </View>

        {/* 状态胶囊条：加载中 / 失败 */}
        {status && !loading ? (
          <View style={styles.statusWrap}>
            <View
              style={[
                styles.statusCapsule,
                {
                  backgroundColor: loadError ? 'rgba(255,59,48,0.12)' : palette.tintSoft,
                },
              ]}
            >
              <MaterialCommunityIcons
                name={loadError ? 'alert-circle-outline' : 'radio'}
                size={13}
                color={loadError ? palette.danger : palette.tint}
                style={{ marginRight: 4 }}
              />
              <Text style={[styles.statusText, { color: loadError ? palette.danger : palette.tint }]}>{status}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.scroll}>
          {/* 播放器大卡 */}
          <View style={[styles.playerCard, { backgroundColor: palette.surface, borderColor: palette.hairline }, shadows.sm]}>
            {/* 封面 120 圆角 20 居中；纯音频播放时环绕旋转细环 + 耳机角标 */}
            {selectedMember ? (
              <View style={styles.coverWrap}>
                {audioOnly && playing ? (
                  <Animated.View
                    pointerEvents="none"
                    style={[styles.spinRing, { borderColor: palette.tint, transform: [{ rotate: spinRotate }] }]}
                  />
                ) : null}
                <NetworkImage
                  source={{ uri: selectedMember.avatar }}
                  style={[styles.cover, { backgroundColor: palette.fill3 }]}
                  resizeMode="cover"
                />
                {audioOnly && playing ? (
                  <View style={[styles.audioBadge, { backgroundColor: palette.tint }]}>
                    <MaterialCommunityIcons name="headphones" size={12} color={palette.onTint} />
                    <Text style={[styles.audioBadgeText, { color: palette.onTint }]}>{t('纯音频')}</Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <View style={[styles.cover, styles.coverPlaceholder, { backgroundColor: palette.tintSoft }]}>
                <MaterialCommunityIcons name="radio" size={44} color={palette.tint} />
              </View>
            )}

            <Text style={[styles.playerTitle, { color: palette.label }]} numberOfLines={1}>
              {selectedMember?.ownerName || t('选择成员')}
            </Text>
            <Text style={[styles.subtitle, { color: palette.labelSecondary }]} numberOfLines={1}>{subtitle}</Text>

            {loading ? (
              <View style={styles.inlineLoading}>
                <CenterSpinner text={t('正在获取电台地址…')} />
              </View>
            ) : null}

            {!loading && loadError ? (
              <ErrorState
                title={t('获取失败')}
                hint={loadError}
                onAction={() => selectedMember && startRadio(selectedMember)}
                style={styles.inlineError}
              />
            ) : null}

            {!loading && !loadError && !selectedMember ? (
              <EmptyState icon="broadcast" title={t('搜索并选择成员')} hint={t('选择成员获取房间上麦音频')} style={styles.inlineEmpty} />
            ) : null}

            {!loading && !loadError && selectedMember && !radioUrl ? (
              <ScalePressable
                onPress={() => startRadio(selectedMember!)}
                pressedScale={0.96}
                style={[styles.fetchBtn, { backgroundColor: palette.tint }]}
                activeOpacity={0.85}
              >
                <MaterialCommunityIcons name="play" size={20} color={palette.onTint} style={{ marginRight: 6 }} />
                <Text style={[styles.fetchBtnText, { color: palette.onTint }]}>{t('开始播放')}</Text>
              </ScalePressable>
            ) : null}

            {radioUrl ? (
              <>
                {/* 控制行：播放/暂停 56 tint 底白字 + 停止/重播 36 fill2 底 */}
                <View style={styles.controlsRow}>
                  <ScalePressable
                    onPress={playing ? stopRadio : () => setPlaying(true)}
                    pressedScale={0.9}
                    style={[styles.primaryCtrl, { backgroundColor: palette.tint, ...shadows.sm }]}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                  >
                    <MaterialCommunityIcons
                      name={playing ? 'pause' : 'play'}
                      size={26}
                      color={palette.onTint}
                    />
                  </ScalePressable>
                  <ScalePressable
                    onPress={() => startRadio(selectedMember!)}
                    pressedScale={0.9}
                    style={[styles.secondaryCtrl, { backgroundColor: palette.fill2 }]}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons name="replay" size={20} color={palette.label} />
                    <Text style={[styles.secondaryCtrlText, { color: palette.label }]}>{t('重播')}</Text>
                  </ScalePressable>
                  <ScalePressable
                    onPress={() => setMuted(v => !v)}
                    pressedScale={0.9}
                    style={[styles.secondaryCtrl, { backgroundColor: palette.fill2 }]}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons name={muted ? 'volume-off' : 'volume-high'} size={20} color={palette.label} />
                    <Text style={[styles.secondaryCtrlText, { color: palette.label }]}>{muted ? t('已静音') : t('静音')}</Text>
                  </ScalePressable>
                  <ScalePressable
                    onPress={stopRadio}
                    pressedScale={0.9}
                    style={[styles.secondaryCtrl, { backgroundColor: palette.fill2 }]}
                    activeOpacity={0.7}
                  >
                    <MaterialCommunityIcons name="stop" size={20} color={palette.label} />
                    <Text style={[styles.secondaryCtrlText, { color: palette.label }]}>{t('停止')}</Text>
                  </ScalePressable>
                </View>
                {playing ? (
                  // v2.7.4：上麦流多为 rtmp（48tools 类型定义 VoiceOperate.streamUrl = rtmp://），
                  // react-native-video 播不了 → 用原生 LiveExoView（内置 ExoPlayer RTMP 扩展）播放
                  isRtmpUrl(radioUrl) && Platform.OS === 'android' && LiveExoView ? (
                    <LiveExoView
                      style={styles.hiddenPlayer}
                      url={radioUrl}
                      audioOnly={audioOnly}
                      key={`${radioUrl}|${audioOnly ? 'a' : 'v'}`}
                      onSize={() => {}}
                    />
                  ) : (
                    <Video
                      source={{ uri: radioUrl }}
                      style={styles.hiddenPlayer}
                      paused={!playing}
                      muted={muted}
                      controls={false}
                      ignoreSilentSwitch="ignore" playInBackground playWhenInactive
                      onLoad={() => setStatus(t('正在播放'))}
                      onError={(e: any) => setStatus(t('播放失败：{error}', { error: JSON.stringify(e?.error || e).slice(0, 120) }))}
                      onEnd={() => { setStatus(t('上麦已结束')); setPlaying(false); }}
                    />
                  )
                ) : null}
              </>
            ) : null}
          </View>
        </View>
      </FadeInView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  pickerWrap: { padding: 16, paddingBottom: 4 },
  modeRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 12 },
  modeDivider: { width: StyleSheet.hairlineWidth, height: 20, backgroundColor: 'rgba(127,127,127,0.35)' },
  statusWrap: { alignItems: 'center', paddingVertical: 6 },
  statusCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  statusText: { fontSize: 12, fontWeight: '600' },
  scroll: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  playerCard: {
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  cover: { width: 120, height: 120, borderRadius: 20, marginTop: 8 },
  coverPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  coverWrap: { alignItems: 'center', justifyContent: 'center' },
  spinRing: {
    position: 'absolute',
    width: 132,
    height: 132,
    borderRadius: 24,
    borderWidth: 2,
    marginTop: 8,
  },
  audioBadge: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    left: 0,
    bottom: -6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  audioBadgeText: { fontSize: 10, fontWeight: '700' },
  playerTitle: { fontSize: 18, fontWeight: '700', marginTop: 16 },
  subtitle: { fontSize: 12, marginTop: 6, textAlign: 'center' },
  inlineLoading: { minHeight: 88 },
  inlineError: { paddingVertical: 20 },
  inlineEmpty: { paddingVertical: 20 },
  fetchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 26,
    paddingVertical: 11,
    borderRadius: 999,
    marginTop: 18,
  },
  fetchBtnText: { fontSize: 15, fontWeight: '700' },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginTop: 22,
  },
  primaryCtrl: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryCtrl: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    width: 60,
    height: 40,
    borderRadius: 20,
  },
  secondaryCtrlText: { fontSize: 11, fontWeight: '600' },
  hiddenPlayer: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});

export function RoomRadioSkeleton() {
  const palette = usePalette();
  return (
    <View style={{ padding: 16 }}>
      <Skeleton width="100%" height={40} radius={14} />
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 12 }}>
        <Skeleton width={80} height={32} radius={999} />
        <Skeleton width={80} height={32} radius={999} />
      </View>
      <View style={{ marginTop: 16, alignItems: 'center' }}>
        <View style={{ backgroundColor: palette.surface, borderRadius: 20, padding: 24, width: '100%', alignItems: 'center' }}>
          <Skeleton width={120} height={120} radius={20} />
          <Skeleton width="40%" height={18} style={{ marginTop: 16 }} />
          <Skeleton width="25%" height={12} style={{ marginTop: 8 }} />
        </View>
      </View>
    </View>
  );
}
