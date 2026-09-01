import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, ImageBackground, Modal, Image, TouchableOpacity, Linking, StyleSheet, Animated, Easing } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AppNavigator from './src/navigation';
import { loadSettings } from './src/services/settings';
import { useResolvedTheme } from './src/hooks/useAppTheme';
import { useSettingsStore, useMemberStore, useAnnouncementStore, useUpdateStore } from './src/store';
import { loadMembers } from './src/utils/members';
import { fetchJson } from './src/utils/network';
import { loadCachedMemberData } from './src/services/memberData';
import { prefetchR2Music } from './src/api/r2Music';
import { initWasm, WebViewSigner } from './src/auth';
import { startRadioForeground, stopRadioForeground, onRadioStopRequested } from './src/native/LivePlayer';
import { ensureNotificationPermission } from './src/utils/notifications';
import { useMusicPlayerStore } from './src/store/musicPlayerStore';
import { FadeInView } from './src/components/Motion';
import { runAutoCheckinIfNeeded } from './src/services/autoCheckin';
import { NOTICE_URL } from './src/constants';
import { initRuntimeLog, logCrash } from './src/utils/runtimeLog';
import { usePalette } from './src/theme/colors';
import ErrorBoundary from './src/components/ErrorBoundary';
import { useSafeAreaInsets } from './src/hooks/useSafeAreaInsets';
// 仅用 JS 包的安全区上下文（不链接其 native 包）：react-navigation 的 BottomTabView 会无条件
// 包 SafeAreaProviderCompat，若无 insets 上下文它将渲染 RNCSafeAreaProvider 原生视图；
// 本工程已在 autolinking 排除 react-native-safe-area-context（无原生 Provider），
// 因此在顶层提供纯 JS 经验值上下文，让 react-navigation 走「已有 insets → 普通 View」分支。
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

// v2.6.5: 给 react-navigation 提供安全区上下文（纯 JS 经验值，无原生依赖）
function SafeAreaBridge({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <SafeAreaInsetsContext.Provider value={{ top: insets.top, right: 0, bottom: insets.bottom, left: 0 }}>
      {children}
    </SafeAreaInsetsContext.Provider>
  );
}

// 全局 JS 闪退捕获：生产环境红盒不可见，写入本地日志便于排查。
// 同时保留原有 handler（开发环境红盒 / 默认崩溃行为）。
function installGlobalErrorHandler() {
  const g = global as unknown as { ErrorUtils?: { setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void; getGlobalHandler?: () => ((e: unknown, isFatal?: boolean) => void) | undefined } };
  const eu = g.ErrorUtils;
  if (!eu || typeof eu.setGlobalHandler !== 'function') return;
  const prev = eu.getGlobalHandler ? eu.getGlobalHandler() : undefined;
  eu.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    logCrash(error, isFatal ? 'global:fatal' : 'global');
    if (prev) {
      try {
        prev(error, isFatal);
      } catch {
        /* ignore */
      }
    }
  });
}

installGlobalErrorHandler();
initRuntimeLog().catch(() => {});

/**
 * 音乐前台保活桥（A2）：音乐库/全屏播放器播放时启动 RadioForegroundService
 * （通知栏「停止」+ WAKE_LOCK，后台/锁屏续播、防进程被杀），停止播放时结束服务。
 * 电台（RoomRadioScreen）自带前台服务，两路共用同一 Service，不会同时播放冲突。
 */
function MusicForegroundBridge() {
  const playbackState = useMusicPlayerStore((s) => s.playbackState);
  const currentIndex = useMusicPlayerStore((s) => s.currentIndex);
  useEffect(() => {
    if (playbackState === 'playing') {
      const track = useMusicPlayerStore.getState().queue[currentIndex];
      ensureNotificationPermission().then(() => {
        startRadioForeground(track?.title || '音乐');
      });
    } else if (playbackState === 'idle') {
      stopRadioForeground();
    }
    // paused 保留前台服务（通知仍在，用户可一键停止）；error 由 MusicEngine 自动跳歌处理
  }, [playbackState, currentIndex]);
  // 通知栏「停止」→ 暂停音乐 + 结束前台服务
  useEffect(() => onRadioStopRequested(() => {
    stopRadioForeground();
    const st = useMusicPlayerStore.getState();
    if (st.playbackState === 'playing' || st.playbackState === 'paused') {
      st.setPlaybackState('paused');
    }
  }), []);
  return null;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('正在初始化...');
  const appTheme = useResolvedTheme();
  const palette = usePalette();
  const customBackgroundFile = useSettingsStore((state) => state.settings.customBackgroundFile);
  const customBackgroundUpdatedAt = useSettingsStore((state) => state.settings.customBackgroundUpdatedAt);
  const [backgroundLoadError, setBackgroundLoadError] = useState('');
  const splashBg = palette.background;

  // v2.6: Announcement modal
  const { seenIds, markSeen, lastFetched, hydrated } = useAnnouncementStore();
  const [announceModal, setAnnounceModal] = useState<{ title: string; header: string; content: string; imageUrl: string; link: string } | null>(null);
  // 公告卡片 spring 入场
  const announceAnim = React.useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (announceModal) {
      announceAnim.setValue(0);
      Animated.spring(announceAnim, {
        toValue: 1,
        damping: 16,
        mass: 0.9,
        stiffness: 190,
        overshootClamping: false,
        useNativeDriver: true,
      }).start();
    }
  }, [announceModal, announceAnim]);

  useEffect(() => {
    if (!hydrated) return;
    let mounted = true;
    (async () => {
      try {
        const notice = await fetchJson<any>(`${NOTICE_URL}?t=${Date.now()}`);
        if (!mounted || !notice?.show) return;
        const id = String(notice.id || notice.noticeId || notice.version || '');
        if (!id || seenIds.includes(id)) return;
        markSeen(id);
        setAnnounceModal({
          title: notice.title || '',
          header: notice.header || '公告',
          content: (notice.fullContent || '').replace(/\\n/g, '\n'),
          imageUrl: notice.imageUrl || '',
          link: notice.link || '',
        });
      } catch {}
    })();
    return () => { mounted = false; };
  }, [hydrated]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const settings = await loadSettings();
        useSettingsStore.getState().setSettings(settings);
      } catch (error: any) {
        if (mounted) setMessage(`设置加载失败：${error?.message || String(error)}`);
      }

      initWasm().catch((error: any) => {
        if (!mounted) return;
        setMessage((prev) => `${prev}\n签名模块初始化失败：${error?.message || String(error)}`);
      });

      // 性能：不等待成员库解析再进首页——设置加载完立即 ready，
      // 成员库在后台异步填充（首页问候数先显示 —，各页空态会自动更新）。
      if (mounted) setReady(true);

      try {
        const backup = require('./assets/members.json');
        const localMembers = await loadMembers(backup);
        useMemberStore.getState().setMembers(localMembers);
        if (mounted) setMessage(`已加载随包成员库 ${localMembers.length} 位`);

        // Prefer a previously downloaded update if it is at least as complete.
        const cached = await loadCachedMemberData();
        if (cached && cached.length >= localMembers.length) {
          useMemberStore.getState().setMembers(cached);
        }

      } catch (error: any) {
        if (mounted) setMessage(`成员数据加载失败：${error?.message || String(error)}`);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      runAutoCheckinIfNeeded().catch(() => {});
    }, 1200);
    // 启动静默检测最新版本：失败/无 Release 一律不打扰，设置页版本号红点由 store 驱动
    useUpdateStore.getState().checkUpdate().catch(() => {});
    // R2 音乐列表预取（1MB/gnz.hk 慢）：后台拉取写缓存，进音乐库秒开
    prefetchR2Music().catch(() => {});
    return () => clearTimeout(timer);
  }, [ready]);

  const backgroundUri = customBackgroundFile?.trim();
  const backgroundSource = backgroundUri
    ? { uri: backgroundUri.match(/^[a-z][a-z0-9+.-]*:/i) ? backgroundUri : `file://${backgroundUri}` }
    : null;

  const content = (
    <View style={{ flex: 1, backgroundColor: backgroundSource ? 'transparent' : palette.background }}>
      <StatusBar style={appTheme === 'dark' ? 'light' : 'dark'} />
      {backgroundLoadError ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 10, right: 10, top: 36, zIndex: 9999, padding: 8, borderRadius: 8, backgroundColor: 'rgba(180,0,0,0.82)' }}>
          <Text style={{ color: '#fff', fontSize: 11 }} numberOfLines={2}>{backgroundLoadError}</Text>
        </View>
      ) : null}
      <SafeAreaBridge>
        <AppNavigator />
      </SafeAreaBridge>
      {/* v2.6: Global announcement modal */}
      <Modal visible={!!announceModal} transparent animationType="fade" onRequestClose={() => setAnnounceModal(null)}>
        <View style={anStyles.overlay}>
          <Animated.View
            style={[
              anStyles.card,
              { backgroundColor: palette.surface },
              {
                opacity: announceAnim,
                transform: [
                  { scale: announceAnim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
                  { translateY: announceAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
                ],
              },
            ]}
          >
            {announceModal?.header ? (
              <Text style={[anStyles.header, { color: palette.tint }]}>{announceModal.header}</Text>
            ) : null}
            {announceModal?.title ? (
              <Text style={[anStyles.title, { color: palette.label }]}>{announceModal.title}</Text>
            ) : null}
            {announceModal?.imageUrl ? (
              <Image source={{ uri: announceModal.imageUrl }} style={anStyles.image} resizeMode="contain" />
            ) : null}
            {announceModal?.content ? (
              <Text style={[anStyles.content, { color: palette.labelSecondary }]}>{announceModal.content}</Text>
            ) : null}
            <View style={anStyles.btnRow}>
              {announceModal?.link ? (
                <TouchableOpacity style={[anStyles.btn, { backgroundColor: palette.tint }]} onPress={() => { if (announceModal?.link) Linking.openURL(announceModal.link); }}>
                  <Text style={anStyles.btnText}>查看详情</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={[anStyles.btn, { backgroundColor: 'rgba(128,128,128,0.2)' }]} onPress={() => setAnnounceModal(null)}>
                <Text style={[anStyles.btnText, { color: palette.label }]}>关闭</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </View>
      </Modal>
    </View>
  );

  return (
    <>
      {!ready ? (
        // 原生开屏已展示 app 图标（与开屏同色纯背景，避免黑屏闪烁）；签名 WebView 仍在后台预热。
        <View style={{ flex: 1, backgroundColor: splashBg }} />
      ) : backgroundSource ? (
        <ImageBackground
          key={`${backgroundSource.uri}-${customBackgroundUpdatedAt || 0}`}
          source={backgroundSource}
          style={{ flex: 1, backgroundColor: palette.background }}
          resizeMode="cover"
          onLoad={() => setBackgroundLoadError('')}
          onError={(event) => setBackgroundLoadError(`背景图加载失败：${backgroundSource.uri} ${event.nativeEvent?.error || ''}`)}
        >
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: appTheme === 'dark' ? 'rgba(11,11,15,0.88)' : 'rgba(245,245,247,0.92)' }} />
          {/* 错误边界外扩到 App 级：Modal/WebViewSigner/背景层渲染异常也有兜底（页面级由导航内的 ErrorBoundary 捕获） */}
          <ErrorBoundary>{content}</ErrorBoundary>
        </ImageBackground>
      ) : (
        <ErrorBoundary>{content}</ErrorBoundary>
      )}
      {/* WebViewSigner 常驻挂载：即使 JS 开屏仍在显示，也提前预热签名模块。 */}
      <WebViewSigner />
      {/* 音乐前台保活（后台播放通知栏控制 + 防进程被杀） */}
      <MusicForegroundBridge />
    </>
  );
}

// v2.6: Announcement modal styles
const anStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 20, maxWidth: 400, width: '100%', maxHeight: '80%' },
  header: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  title: { fontSize: 15, fontWeight: '600', marginBottom: 10, color: '#333' },
  image: { width: '100%', height: 160, borderRadius: 10, marginBottom: 10 },
  content: { fontSize: 14, lineHeight: 22, color: '#555', marginBottom: 16 },
  btnRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  btn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
