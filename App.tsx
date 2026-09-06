import React, { useRef, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, ImageBackground, Modal, Image, TouchableOpacity, Linking, StyleSheet, Animated, Easing, AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AppNavigator from './src/navigation';
import { loadSettings } from './src/services/settings';
import { useResolvedTheme } from './src/hooks/useAppTheme';
import { useSettingsStore, useMemberStore, useAnnouncementStore, useUpdateStore } from './src/store';
import { loadMembers } from './src/utils/members';
import { fetchJson } from './src/utils/network';
import { loadCachedMemberData } from './src/services/memberData';
import { prefetchR2Music } from './src/api/r2Music';
import { initWasm, WebViewSigner } from './src/auth';
import { startRadioForeground, stopRadioForeground, updateRadioLyric, onRadioStopRequested, onRadioControlRequested , syncRadioPosition } from './src/native/LivePlayer';
import {
  subscribeExo,
  exoPlayTrack,
  exoControl,
  exoSetSkipHints,
  setNativeExoActive,
  setNativeExoDisabled,
  isNativeExoActive,
  isNativeExoDisabled,
} from './src/native/RadioExo';
import { ensureNotificationPermission } from './src/utils/notifications';
import { useMusicPlayerStore, flushMusicPlayerStorage, PlayMode } from './src/store/musicPlayerStore';
import { MusicEngine } from './src/services/musicPlayer';
import { FadeInView } from './src/components/Motion';
import { runAutoCheckinIfNeeded } from './src/services/autoCheckin';
import { NOTICE_URL } from './src/constants';
import { initRuntimeLog, logCrash, logInfo } from './src/utils/runtimeLog';
import { fetchCoverToFile, normalizeCoverUrl } from './src/utils/coverToFile';
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
    try {
      // 同步打到 logcat（ReactNativeJS tag），崩溃瞬间也能留下函数链
      const e = error as any;
      console.error('[yaya-crash] ' + String(e && (e.message || e)));
      if (e && e.stack) console.error('[yaya-crash] ' + String(e.stack).slice(0, 1200));
    } catch {
      /* ignore */
    }
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

// 封面落盘逻辑已抽至 src/utils/coverToFile.ts（音乐页 Exo art 与旧通知共用，行为与历史一致）

installGlobalErrorHandler();
initRuntimeLog().catch(() => {});

/**
 * 音乐前台保活桥（A2）：音乐库/全屏播放器播放时启动 RadioForegroundService
 * （通知栏「停止」+ WAKE_LOCK，后台/锁屏续播、防进程被杀），停止播放时结束服务。
 * 电台（RoomRadioScreen）自带前台服务，两路共用同一 Service，不会同时播放冲突。
 */
/** 取 pos 时刻命中的歌词行下标（-1 = 无歌词/未开始） */
function currentLyricIndex(lines: Array<{ time: number; text: string }>, pos: number): number {
  if (!lines || lines.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= pos + 0.4) idx = i;
    else break;
  }
  return idx;
}

/** 向原生下发当前曲（切歌/恢复的全局兜底：先立即起播不卡封面，封面就绪后补发更新元数据） */
async function pushExoAfterSwitch() {
  try {
    const st = useMusicPlayerStore.getState();
    const url = st.url;
    const track = st.queue[st.currentIndex];
    // guard：本次会话已判原生不可用（error/超时）则不再尝试（RNV 兜底路径由页面 nativeOk 接管）
    if (isNativeExoDisabled() || st.error || st.playbackState !== 'playing' || !url || !track) return;
    setNativeExoActive(true); // 企图接管即标记（冷启 Home 恢复等首推场景，等待 progress 确认）
    const headers = {
      'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
      Referer: 'https://h5.48.cn/',
      Origin: 'https://h5.48.cn',
    };
    // 续播点：resume(记忆恢复)时引擎写入 seekTarget；切歌/点歌恒 0。消费后防重复 seek
    let resumeAt = 0;
    if (Number(st.seekTarget) > 0) {
      resumeAt = Number(st.seekTarget);
      useMusicPlayerStore.setState({ seekTarget: 0 });
    }
    const vol = /(gnz\.hk|gnz-music|music\.gnz)/i.test(url) ? 0.86 : 1;
    const rep = st.playMode === 'single' ? 1 : 0;
    const send = (art: string) => {
      console.warn(`[push-global] ${art ? 'art-refresh' : 'initial'} url=${String(url).slice(0, 50)} resumeAt=${resumeAt}`);
      exoPlayTrack({
        url,
        title: String(track.title || '音乐'),
        artist: String((track as any).artist || (track as any).groupLabel || ''),
        album: String((track as any).album || ''),
        art,
      }, art ? 0 : resumeAt, true, headers, vol, rep);
    };
    send(''); // 立即起播（不等封面）
    const coverRaw = String((track as any).coverUrl || (track as any).cover || (track as any).thumbPath || '') || '';
    if (coverRaw) {
      let art = '';
      try {
        art = await Promise.race([
          fetchCoverToFile(normalizeCoverUrl(coverRaw)),
          new Promise<string>((res) => setTimeout(() => res(''), 1500)),
        ]);
      } catch { art = ''; }
      const st2 = useMusicPlayerStore.getState();
      if (st2.url === url && st2.playbackState === 'playing' && !isNativeExoDisabled()) {
        send(art || String((track as any).coverUrl || (track as any).cover || '')); // 同曲补发仅刷封面
      }
    }
  } catch {}
}

// ---------- 系统卡 skip hints（上一首/下一首后台本地切歌，2026-09-06） ----------
// 与 store.next()/prev() 相同的引擎语义（手动切歌）：
//  - prev：回绕到队尾（idx<=0 → len-1）
//  - next：single → 重播当前；random → 排除当前的均匀随机；其余 → (idx+1)%len
function skipHintIndex(dir: 'next' | 'prev', cur: number, len: number, mode: PlayMode): number {
  if (len <= 0) return -1;
  if (dir === 'prev') return cur <= 0 ? len - 1 : cur - 1;
  if (mode === 'single') return cur;
  if (mode === 'random') {
    if (len <= 1) return cur;
    let n = Math.floor(Math.random() * (len - 1));
    if (n >= cur) n += 1;
    return n;
  }
  return (cur + 1) % len;
}

/** 封面落盘缓存：hint 目标曲封面 file://（后台本地切歌直接展示，不再等回前台 JS 补推） */
const skipHintArts: { next: string; prev: string } = { next: '', prev: '' };

/**
 * 向 YayaExoService 推送当前播放语义下的上一首/下一首 hint（url 已解析可直接播）。
 * 触发：播放确立/url/下标/队列/模式任一变化（MusicForegroundBridge effect）。
 * 两段式：先无封面立即推（切歌不等待下载）→ 目标封面落盘后带 art 重推（覆盖同槽位）。
 * 前台执行；停播/切歌竞态时丢弃不推。
 */
async function pushSkipHints() {
  try {
    const st = useMusicPlayerStore.getState();
    if (st.playbackState !== 'playing' || !st.url || st.queue.length === 0) return;
    const q = st.queue;
    const ni = skipHintIndex('next', st.currentIndex, q.length, st.playMode);
    const pi = skipHintIndex('prev', st.currentIndex, q.length, st.playMode);
    if (ni < 0 && pi < 0) return;
    const snapUrl = st.url;
    const nTrack = ni >= 0 ? q[ni] : null;
    const pTrack = pi >= 0 ? q[pi] : null;
    const mk = (t: any, u: string | null, i: number, dir: 'next' | 'prev') =>
      t && u
        ? { url: u, title: String(t.title || '音乐'), artist: String(t.artist || t.groupLabel || ''), album: String(t.album || ''), index: i, art: skipHintArts[dir] }
        : null;
    const [nUrl, pUrl] = await Promise.all([
      nTrack ? MusicEngine.resolvePlayUrl(nTrack) : Promise.resolve(null),
      pTrack ? MusicEngine.resolvePlayUrl(pTrack) : Promise.resolve(null),
    ]);
    // 在途校验：期间已停/已切走 → 丢弃（防旧 hint 覆盖 + 防 stop 竞态 startService 崩溃）
    const s2 = useMusicPlayerStore.getState();
    if (s2.playbackState !== 'playing' || s2.url !== snapUrl) return;
    // Phase 1：无封面立即推（后台切歌即时性优先）
    exoSetSkipHints(mk(nTrack, nUrl, ni, 'next'), mk(pTrack, pUrl, pi, 'prev'));
    // Phase 2：目标封面落盘后带 art 重推（同槽位覆盖；两首并行下载，共 2.5s 上限）
    const coverRawOf = (t: any) => String((t && (t.coverUrl || t.cover || t.thumbPath)) || '') || '';
    const refreshArt = async (t: any, dir: 'next' | 'prev') => {
      if (!t) return;
      const raw = coverRawOf(t);
      if (!raw) return;
      let art = '';
      try {
        art = await Promise.race([
          fetchCoverToFile(normalizeCoverUrl(raw)),
          new Promise<string>((res) => setTimeout(() => res(''), 2500)),
        ]);
      } catch { art = ''; }
      if (art) skipHintArts[dir] = art;
      const s3 = useMusicPlayerStore.getState();
      if (s3.playbackState !== 'playing' || s3.url !== snapUrl) return;
      exoSetSkipHints(mk(nTrack, nUrl, ni, 'next'), mk(pTrack, pUrl, pi, 'prev'));
    };
    await Promise.all([
      nTrack ? refreshArt(nTrack, 'next') : Promise.resolve(),
      pTrack ? refreshArt(pTrack, 'prev') : Promise.resolve(),
    ]);
  } catch {}
}

function MusicForegroundBridge() {
  // 全局滞回同步（页面无关）：系统卡/媒体键暂停恢复 → App 播放状态跟随
  // 单向安全：paused 900ms 连续、playing 1.2s 连续才回写，杜绝 pause/resume 自激
  const lastNativePlayingRef = useRef(false);
  const syncPauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncResumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSyncPause = () => { if (syncPauseTimer.current) { clearTimeout(syncPauseTimer.current); syncPauseTimer.current = null; } };
  const clearSyncResume = () => { if (syncResumeTimer.current) { clearTimeout(syncResumeTimer.current); syncResumeTimer.current = null; } };
  const armSyncPause = () => {
    if (syncPauseTimer.current) return;
    syncPauseTimer.current = setTimeout(() => {
      syncPauseTimer.current = null;
      const s = useMusicPlayerStore.getState();
      if (s.playbackState === 'playing' && !lastNativePlayingRef.current) s.setPlaybackState('paused');
    }, 900);
  };
  const armSyncResume = () => {
    if (syncResumeTimer.current) return;
    syncResumeTimer.current = setTimeout(() => {
      syncResumeTimer.current = null;
      const s = useMusicPlayerStore.getState();
      if (s.playbackState === 'paused' && s.queue.length && lastNativePlayingRef.current) s.setPlaybackState('playing');
    }, 1200);
  };
  // 原生下发触发（全局兜底）：播放态/曲目变化 → 补推原生（页面未挂载时切歌/恢复不丢）。
  // 与页面 push 并存；同曲重复由 service 去重（不重载/不打断）
  const lastPushKeyRef = useRef('');
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackStateG = useMusicPlayerStore((s) => s.playbackState);
  const playUrlG = useMusicPlayerStore((s) => s.url);
  const currentIndexG = useMusicPlayerStore((s) => s.currentIndex);
  const queueLenG = useMusicPlayerStore((s) => s.queue.length);
  const playModeG = useMusicPlayerStore((s) => s.playMode);
  useEffect(() => {
    if (playbackStateG !== 'playing' || !playUrlG) return;
    const key = `${playUrlG}|${currentIndexG}`;
    if (key === lastPushKeyRef.current) return;
    lastPushKeyRef.current = key;
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    // 延迟到解析完成/当前 tick 稳定后再发（避免与页面同 tick 双发前一方吞 seekTarget）
    pushTimerRef.current = setTimeout(() => { pushExoAfterSwitch().catch(() => {}); }, 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackStateG, playUrlG, currentIndexG]);
  // 播放确立/url/下标/队列/模式变化 → 重推 skip hints（原生本地切歌依赖，须在最新语义后推送）
  useEffect(() => {
    if (playbackStateG !== 'playing' || !playUrlG) return;
    const t = setTimeout(() => { pushSkipHints().catch(() => {}); }, 40);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackStateG, playUrlG, currentIndexG, queueLenG, playModeG]);
  useEffect(() => {
    if (playbackStateG === 'idle') {
      lastPushKeyRef.current = '';
      // 停止后可重新尝试原生（error/超时禁用仅限单次播放会话）
      setNativeExoActive(false);
      setNativeExoDisabled(false);
      // ⚠️ 停止必须全局兜底：主页 ✕ 关闭/任何页面清空播放都置 idle，
      // 停 Exo 服务的逻辑若只在音乐页 effect，页面未挂载时音乐会继续响（22:56 实测）
      try { exoControl('stop'); } catch {}
    } else if (playbackStateG !== 'playing') {
      lastPushKeyRef.current = '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackStateG]);

  // 播放态 → 原生 单向镜像（App 级常驻，页面无关；替代原音乐页私有 mirror effect）：
  // 应用内 暂停/继续（全屏播放器/迷你条/主页"继续播放"）必须落到原生 ExoPlayer；
  // 仅当原生已知状态确实相反才下发（系统卡操作走原生回调已同步的状态不重复下发 → 防回声自激）。
  useEffect(() => {
    if (isNativeExoDisabled()) return; // RNV 降级：声音/会话由页面 Video + 旧自管服务负责
    if (playbackStateG === 'paused' && lastNativePlayingRef.current) {
      exoControl('pause');
    } else if (playbackStateG === 'playing' && !lastNativePlayingRef.current) {
      exoControl('resume');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackStateG]);

  // M2：Exo 原生会话事件全局单点 —— 进度/位置实时写 store（离开音乐页后台播放时也同步）、
  // 播完自动切歌、系统卡上一首/下一首命令、暂停恢复滞回 —— 全部常驻，不依赖音乐页挂载。
  useEffect(() => subscribeExo((type, p: any) => {
    try {
      if (type === 'progress') {
        // Exo 激活（原声在播）→ 旧自管服务立即停用（双会话会让 ColorOS 绑旧会话）
        const playingN = !!p?.playing;
        lastNativePlayingRef.current = playingN;
        if (playingN) {
          if (!isNativeExoActive()) setNativeExoActive(true);
          // 原生在播确认 → 旧自管服务必须停。⚠️ 旧守卫 `!isNativeExoActive()` 实际永不触发：
          // pushExoAfterSwitch 在尝试期已 setNativeExoActive(true)，导致残留 RadioForegroundService
          // 双会话 → ColorOS/通知栏把媒体卡绑到旧会话 → 系统控件"失灵/像在打架"。
          try { stopRadioForeground(); } catch {}
        }
        // 真实位置/时长全局同步（后台播放时 store 常真，回音乐页即见实际进度）
        const st = useMusicPlayerStore.getState();
        // 切歌竞态防护：旧曲心跳(url≠当前)不写位置/时长（防进度条回跳/脏数据）
        const staleUrl = !!p?.url && !!st.url && String(p.url) !== String(st.url);
        if (!staleUrl) {
          if (Number(p?.duration) > 0) st.setDuration(Number(p.duration));
          if (typeof p?.position === 'number') st.setPosition(p.position);
        }
        if (playingN) {
          clearSyncPause();
          armSyncResume();
        } else {
          clearSyncResume();
          armSyncPause();
        }
      } else if (type === 'ended') {
        clearSyncPause();
        clearSyncResume();
        if (useMusicPlayerStore.getState().playbackState === 'playing') {
          // 播完自动切歌：watch effect 会在 url 就绪后补发原生
          MusicEngine.next().catch(() => {});
        }
      } else if (type === 'skipped') {
        // 原生已本地切歌（系统卡/媒体键在后台点按，JS 被冻结时事件排队、恢复后按序到达）：
        // 按 hint 携带的 index 把 store 对账到目标曲，防止 UI/状态停留旧曲。
        const urlN = String(p?.url || '');
        clearSyncPause();
        clearSyncResume();
        if (!urlN) return;
        const st0 = useMusicPlayerStore.getState();
        if (st0.queue.length === 0) return;
        const rawIdx = Number(p?.index);
        const idx = Number.isFinite(rawIdx) && Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < st0.queue.length ? rawIdx : -1;
        const track = idx >= 0 ? st0.queue[idx] : null;
        if (idx < 0 || !track) return; // 队列与 hint 对不上（旧快照/队列被替换）→ 原生继续播，不强改 UI
        // 使在途 playTrack 失效：防其 URL 解析完成后回写覆盖本次本地切歌
        (MusicEngine as any)._playSeq += 1;
        useMusicPlayerStore.setState({
          currentIndex: idx,
          url: urlN,
          playbackState: 'playing',
          position: 0,
          duration: 0,
          seekTarget: 0,
          error: null,
          lyrics: [],
        });
        // watch effect 会因 url|index 变化补推原生（同曲去重不重载）；这里补歌词/预热下一首
        MusicEngine._fetchLyrics(track);
        MusicEngine._prewarmNextTrack();
      } else if (type === 'cmd') {
        const c = String(p?.cmd || '');
        if (c === 'next') MusicEngine.next().catch(() => {});
        else if (c === 'prev') MusicEngine.prev().catch(() => {});
      } else if (type === 'error') {
        clearSyncPause();
        clearSyncResume();
        setNativeExoDisabled(true); // 本会话原生判不可用（RNV 降级路径接管）
      }
    } catch {}
  }), []);
  useEffect(() => () => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    clearSyncPause();
    clearSyncResume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A: 切后台/失活立即落盘音乐播放记忆（30s 节流窗口内的切歌/进度不丢）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') flushMusicPlayerStorage();
    });
    return () => sub.remove();
  }, []);
  const playbackState = useMusicPlayerStore((s) => s.playbackState);
  const currentIndex = useMusicPlayerStore((s) => s.currentIndex);
  const position = useMusicPlayerStore((s) => s.position);
  const duration = useMusicPlayerStore((s) => s.duration);
  // 媒体通知（MediaStyle 控制）：只在 切歌/状态变化 时更新通知（不再每 5s 重建——
  // ColorOS 媒体卡疑似每次通知重建都重置进度观感；进度由服务端 1s ticker 持续推送 session）
  const lastNotifySig = useRef('');
  // 真实位置 500ms 同步到旧自管会话（仅电台/RNV 降级路径；Exo 激活后旧服务已停，禁止再拉活——
  // 否则 syncPosition 的 startService 会把已 stop 的 RadioForegroundService 复活 → 双会话，ColorOS 绑旧卡死）
  useEffect(() => {
    if (playbackState !== 'playing') return;
    const id = setInterval(() => {
      if (!isNativeExoDisabled()) return; // Exo 可用（含尝试窗口）时旧桥不得掺和；仅 RNV 降级路径走旧桥
      try { syncRadioPosition(useMusicPlayerStore.getState().position); } catch {}
    }, 500);
    return () => clearInterval(id);
  }, [playbackState]);
  useEffect(() => {
    if (playbackState === 'playing') {
      if (!isNativeExoDisabled()) return; // Exo 负责系统卡与通知；旧桥不掺和
      const st = useMusicPlayerStore.getState();
      const track = st.queue[st.currentIndex];
      const sig = `${st.currentIndex}|${playbackState}|${st.url || ''}`;
      if (sig === lastNotifySig.current && track?.title) return;
      lastNotifySig.current = sig;
      const cover = normalizeCoverUrl(String((track as any)?.coverUrl || (track as any)?.cover || (track as any)?.thumbPath || ''));
      const artistText = String((track as any)?.artist || (track as any)?.groupLabel || '');
      const albumText = String((track as any)?.album || '');
      const lyrIdx = currentLyricIndex(st.lyrics, st.position);
      const lyricText = lyrIdx >= 0 && st.lyrics[lyrIdx] ? st.lyrics[lyrIdx].text : '';
      ensureNotificationPermission().then(async () => {
        const finalCover = await fetchCoverToFile(cover);
        startRadioForeground({
          title: track?.title || '音乐',
          cover: finalCover,
          artist: artistText,
          album: albumText,
          lyric: lyricText,
          isPlaying: true,
          position: st.position,
          duration: st.duration,
        });
        try {
          logInfo(`[media] notify start title=${String(track?.title || '').slice(0, 20)} dur=${st.duration} pos=${st.position} cover=${finalCover ? (finalCover.startsWith('data:') ? 'DATA' : finalCover.slice(0, 60)) : 'EMPTY'}`, 'media');
        } catch {}
      }).catch((err: any) => {
        try { logInfo(`[media] notify perm rejected: ${String(err && err.message || err).slice(0, 120)}`, 'media'); } catch {}
      });
    } else if (playbackState === 'paused') {
      if (!isNativeExoDisabled()) return; // Exo 已接管暂停态（含尝试窗口）；旧桥不掺和
      // 暂停态必须同步给服务（isPlaying=false + PAUSED 会话 + 暂停图标）：
      // 否则服务/系统一直以为在播 → ColorOS 上播放/暂停按钮失效、UI 不重绘
      const st = useMusicPlayerStore.getState();
      const track = st.queue[st.currentIndex];
      const sigP = `paused|${st.currentIndex}`;
      if (sigP !== lastNotifySig.current && track?.title) {
        lastNotifySig.current = sigP;
        const st2 = useMusicPlayerStore.getState();
        const coverP = normalizeCoverUrl(String((st2 as any).currentTrack?.coverUrl || (track as any)?.coverUrl || (track as any)?.cover || (track as any)?.thumbPath || ''));
        ensureNotificationPermission().then(async () => {
          const finalCover = await fetchCoverToFile(coverP);
          startRadioForeground({
            title: track?.title || '音乐',
            cover: finalCover,
            artist: String((track as any)?.artist || (track as any)?.groupLabel || ''),
            album: String((track as any)?.album || ''),
            lyric: String(st2.lyrics && st2.lyrics[currentLyricIndex(st2.lyrics, st2.position)]?.text || ''),
            isPlaying: false,
            position: st2.position,
            duration: st2.duration,
          });
        }).catch(() => {});
      }
    } else if (playbackState === 'idle') {
      stopRadioForeground();
    }
  }, [playbackState, currentIndex, position]);
  // 歌词行变化 → 更新通知展开区歌词（行切换才发，节流无碍）
  const lyrics = useMusicPlayerStore((s) => s.lyrics);
  const lastLyricIdx = useRef(-1);
  const playing = playbackState === 'playing';
  useEffect(() => {
    if (!playing) {
      lastLyricIdx.current = -1;
      return;
    }
    if (!isNativeExoDisabled()) {
      // Exo 接管（含尝试窗口）：旧服务已停，updateLyric 的 startForegroundService 会拉活旧服务（双会话），跳过
      lastLyricIdx.current = -1;
      return;
    }
    const idx = currentLyricIndex(lyrics, position);
    if (idx !== lastLyricIdx.current) {
      lastLyricIdx.current = idx;
      const text = idx >= 0 && lyrics[idx] ? lyrics[idx].text : '';
      updateRadioLyric(text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, lyrics, position]);
  // 通知栏「停止」→ 暂停音乐 + 结束前台服务
  useEffect(() => onRadioStopRequested(() => {
    stopRadioForeground();
    const st = useMusicPlayerStore.getState();
    if (st.playbackState === 'playing' || st.playbackState === 'paused') {
      st.setPlaybackState('paused');
    }
  }), []);
  // 通知栏媒体控制（播放/暂停、上一首、下一首）→ 驱动 MusicEngine
  useEffect(() => onRadioControlRequested((action, value) => {
    const st = useMusicPlayerStore.getState();
    if (action === 'play') {
      if (st.playbackState === 'paused' && st.queue.length) MusicEngine.resume();
    } else if (action === 'pause') {
      if (st.playbackState === 'playing') st.setPlaybackState('paused');
    } else if (action === 'play_pause') {
      if (st.playbackState === 'playing') st.setPlaybackState('paused');
      else if (st.playbackState === 'paused') MusicEngine.resume();
      else if (!st.queue.length) return;
    } else if (action === 'seek' && value) {
      // 系统媒体条拖动 seek（value=毫秒）→ 交给 MusicEngine（消费后清 seekTarget）
      st.setSeekTarget(Math.max(0, Number(value) / 1000));
    } else if (action === 'next') {
      MusicEngine.next();
    } else if (action === 'prev') {
      MusicEngine.prev();
    } else if (action === 'stop') {
      stopRadioForeground();
      if (st.playbackState === 'playing' || st.playbackState === 'paused') st.setPlaybackState('paused');
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
    // R2 音乐列表预取（1MB/gnz.hk 慢）：延迟到启动完全就绪后静默拉取写缓存，
    // 进音乐库秒开；任何异常均被吞，不影响启动（如 Hermes 无 AbortController polyfill 也仅拉取失败）
    const r2Timer = setTimeout(() => {
      prefetchR2Music().catch(() => {});
    }, 15000);
    return () => {
      clearTimeout(timer);
      clearTimeout(r2Timer);
    };
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
    <GestureHandlerRootView style={{ flex: 1 }}>
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
    </GestureHandlerRootView>
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
