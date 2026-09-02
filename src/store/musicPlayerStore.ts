import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 写节流包装：音乐 store 的 position 在 onProgress 下每 ~250ms 更新一次，
 * zustand persist 默认每次 set 都全量序列化（含整个 queue）写入 AsyncStorage——
 * 高频大写入伤 IO 与存储寿命。这里按 key 节流（30s trailing 合并），
 * 读取/删除不受影响；App 被杀时最多丢最近 30s 的进度（与 WebView 续播节流同级）。
 */
function createThrottleStorage(storage: { getItem: (name: string) => Promise<string | null>; setItem: (name: string, value: string) => Promise<void>; removeItem: (name: string) => Promise<void> }, ms = 30000) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, string>();
  const flushAll = () => {
    timers.forEach((timer, name) => { clearTimeout(timer); });
    timers.clear();
    pending.forEach((v, name) => {
      pending.delete(name);
      storage.setItem(name, v).catch(() => {});
    });
  };
  return {
    getItem: (name: string) => storage.getItem(name),
    setItem: (name: string, value: string) => {
      pending.set(name, value);
      if (!timers.has(name)) {
        timers.set(name, setTimeout(() => {
          timers.delete(name);
          const v = pending.get(name);
          pending.delete(name);
          if (v !== undefined) storage.setItem(name, v).catch(() => {});
        }, ms));
      }
    },
    removeItem: (name: string) => {
      pending.delete(name);
      const timer = timers.get(name);
      if (timer) {
        clearTimeout(timer);
        timers.delete(name);
      }
      return storage.removeItem(name);
    },
    // A: 切后台/杀进程前强制落盘（否则 30s 节流窗口内的切歌/进度丢失 →「记忆记不住」）
    flushAll,
  };
}
// A: 供 App 层在切后台时调用（throttle 拦截了 zustand persist.flush，需直通底层）
export function flushMusicPlayerStorage() {
  throttleFlushRef?.();
}
let throttleFlushRef: (() => void) | null = null;

export type PlayMode = 'sequential' | 'random' | 'single';
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/**
 * 精简后的曲目接口：不再包含 [key: string]: any。
 * 封面由 CoverArt 内部自决 raw 字段（coverUrl / cover / thumbPath），store 不参与拼 URL。
 */
export interface Track {
  musicId?: string;
  id?: string;
  title: string;
  subTitle?: string;
  albumName?: string;
  album?: string;
  joinMemberNames?: string;
  artist?: string;
  coverUrl?: string;
  cover?: string;
  thumbPath?: string;
  groupLabel?: string;
  mp3?: string;
  /** 其他字段（音轨/时长等）通过此兜底保留但不用 any 污染索引 */
  extra?: Record<string, unknown>;
}

export interface LyricLine {
  time: number;
  text: string;
}

interface MusicPlayerState {
  // Track list
  queue: Track[];
  currentIndex: number;
  // Playback
  playbackState: PlaybackState;
  playMode: PlayMode;
  // Timing
  url: string;
  duration: number;
  position: number;
  // Lyrics
  lyrics: LyricLine[];
  // Error
  error: string | null;
  // Favorites (persisted)
  favorites: string[];
  /**
   * Seek 指令：组件写，Video onLoad / effect 检测后执行 seek 并清零。
   * 不持久化（持久化 seek 位置通过 position 字段实现）。
   */
  seekTarget: number;

  // Actions
  setQueue: (tracks: Track[]) => void;
  addToQueue: (track: Track) => void;
  removeFromQueue: (id: string) => void;
  clearQueue: () => void;
  /** 载入曲目到队列并置为 loading 态（不自动播放）。URL 由 MusicEngine 异步解析后 setUrl。 */
  play: (track: Track, queue?: Track[], keepPosition?: boolean) => void;
  setUrl: (url: string) => void;
  setPlaybackState: (state: PlaybackState) => void;
  setMode: (mode: PlayMode) => void;
  setDuration: (d: number) => void;
  setPosition: (p: number) => void;
  setLyrics: (lines: LyricLine[]) => void;
  setError: (e: string | null) => void;
  setSeekTarget: (t: number) => void;
  isFavorite: (id: string) => boolean;
  toggleFavorite: (id: string) => void;
  next: () => Track | null;
  prev: () => Track | null;
}

function nextIndex(current: number, length: number, mode: PlayMode): number {
  if (length === 0) return -1;
  if (mode === 'single') return current;
  if (mode === 'random') {
    // 随机模式排除当前曲（否则可能"切到同一首"，用户以为没切歌）
    if (length <= 1) return current;
    let n = Math.floor(Math.random() * (length - 1));
    if (n >= current) n += 1;
    return n;
  }
  return (current + 1) % length;
}

export const useMusicPlayerStore = create<MusicPlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      currentIndex: -1,
      playbackState: 'idle',
      playMode: 'sequential',
      url: '',
      duration: 0,
      position: 0,
      lyrics: [],
      error: null,
      favorites: [],
      seekTarget: 0,

      setQueue: (tracks) => set({ queue: tracks, currentIndex: tracks.length > 0 ? 0 : -1 }),

      addToQueue: (track) => set((s) => {
        if (s.queue.find((t) => (t.musicId || t.id) === (track.musicId || track.id))) return s;
        return { queue: [...s.queue, track] };
      }),

      removeFromQueue: (id) => set((s) => {
        const removedIdx = s.queue.findIndex((t) => (t.musicId || t.id) === id);
        const newQueue = s.queue.filter((t) => (t.musicId || t.id) !== id);
        let newIdx = s.currentIndex;
        if (removedIdx >= 0 && removedIdx < s.currentIndex) newIdx = s.currentIndex - 1;
        else if (removedIdx === s.currentIndex) newIdx = newQueue.length > 0 ? Math.min(s.currentIndex, newQueue.length - 1) : -1;
        return { queue: newQueue, currentIndex: newIdx };
      }),

      clearQueue: () => set({ queue: [], currentIndex: -1 }),

      /**
       * 载入曲目到队列并置为 loading 态，但暂不写新 url —— url 由 MusicEngine 异步解析后
       * 通过 setUrl 单独写入。B2 修复：**保留旧 url**（不置空），Video 常驻下始终有合法 source，
       * 消除「url:'' → 新 url」空源翻转导致的偶发 onError/黑屏/误触发跳歌。
       * loading 态 paused=true，旧画面/旧音不发声，解析完成后 setUrl 切换。
       *
       * keepPosition=true（主页「继续播放」/ 记忆恢复）：保留当前 position 并把其转成
       * seekTarget，等 Video onLoad 就绪后 seek 回去 —— 否则 play() 会把进度清零，
       * 播放记忆形同虚设。
       */
      play: (track, queue, keepPosition = false) => set((s) => {
        const q = queue || s.queue;
        const idx = q.findIndex((t) => (t.musicId || t.id) === (track.musicId || track.id));
        const resumePos = keepPosition && idx === s.currentIndex && s.position > 0 ? s.position : 0;
        return {
          queue: q,
          currentIndex: idx >= 0 ? idx : 0,
          playbackState: 'loading',
          url: s.url,           // B2：保留旧 url（不置空），消除空 source 翻转
          duration: resumePos > 0 ? s.duration : 0,
          position: resumePos,
          lyrics: [],
          error: null,
          seekTarget: resumePos,
        };
      }),

      setUrl: (url) => set({ url }),

      setPlaybackState: (playbackState) => set({ playbackState }),

      setMode: (playMode) => set({ playMode }),

      setDuration: (duration) => set({ duration }),

      setPosition: (position) => set({ position }),

      setLyrics: (lyrics) => set({ lyrics }),

      setError: (error) => set({ error, playbackState: error ? 'error' : 'idle' }),

      setSeekTarget: (seekTarget) => set({ seekTarget }),

      /**
       * B7 收藏键归一：收藏统一存 `title|artist` 键（旧数据仍为 musicId，双兼容）——
       * 官方曲（数字 musicId）与 R2 曲（R2- 前缀）同一首歌共享同一收藏，换源不再"丢收藏"。
       */
      isFavorite: (id) => {
        const f = get().favorites;
        if (f.includes(id)) return true;
        const t = get().queue.find((x) => String(x.musicId || x.id) === String(id));
        if (t) {
          const k = `${String(t.title || '').trim()}|${String(t.artist || '').trim()}`.trim();
          if (k && k !== '|' && f.includes(k)) return true;
        }
        return false;
      },

      toggleFavorite: (id) => set((s) => {
        if (!id) return s;
        const t = s.queue.find((x) => String(x.musicId || x.id) === String(id));
        const k = t ? `${String(t.title || '').trim()}|${String(t.artist || '').trim()}`.trim() : '';
        const key = k && k !== '|' ? k : id;
        if (s.favorites.includes(id)) {
          return { favorites: s.favorites.filter((f) => f !== id) };
        }
        if (s.favorites.includes(key)) {
          return { favorites: s.favorites.filter((f) => f !== key) };
        }
        return { favorites: [...s.favorites, key] };
      }),

      next: () => {
        const s = get();
        if (s.queue.length === 0) return null;
        const idx = nextIndex(s.currentIndex, s.queue.length, s.playMode);
        set({ currentIndex: idx, duration: 0, position: 0, lyrics: [], error: null, seekTarget: 0 });
        return s.queue[idx] || null;
      },

      prev: () => {
        const s = get();
        if (s.queue.length === 0) return null;
        const idx = s.currentIndex <= 0 ? s.queue.length - 1 : s.currentIndex - 1;
        set({ currentIndex: idx, duration: 0, position: 0, lyrics: [], error: null, seekTarget: 0 });
        return s.queue[idx] || null;
      },
    }),
    {
      name: 'yaya_music_player_v2',
      storage: createJSONStorage(() => {
        const store = createThrottleStorage(AsyncStorage);
        throttleFlushRef = store.flushAll;
        return store;
      }),
      partialize: (s) => ({
        queue: s.queue,
        currentIndex: s.currentIndex,
        position: s.position,
        playMode: s.playMode,
        favorites: s.favorites,
        lyrics: s.lyrics,
        duration: s.duration,
      }),
      onRehydrateStorage: () => (state) => {
        if (state && state.currentIndex >= 0 && state.queue.length > 0) {
          // 续播：把持久化的 position 转成 seekTarget，等 Video onLoad 就绪后 seek 回去。
          // （此前 position 只写不读，重启后进度记忆形同虚设，音频永远从 0 开始）
          const pos = state.position || 0;
          useMusicPlayerStore.setState({ playbackState: 'paused', seekTarget: pos > 0 ? pos : 0 });
        }
      },
    },
  ),
);