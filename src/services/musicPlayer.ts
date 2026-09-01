import { useMusicPlayerStore, Track, LyricLine } from '../store/musicPlayerStore';
import { normalizeUrl } from '../utils/data';
import { parseLrc } from '../utils/lyrics';
import { getLyricsMatcher } from '../utils/lyricsIndex';
import { fetchWithTimeout } from '../utils/network';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LYRICS_BASE_URL = 'https://yaya-data.pages.dev/lyrics';
// 单首歌词磁盘缓存：同一首歌反复播放不再重复拉取（7 天 TTL）
const LYRICS_CACHE_KEY = 'yaya_lyric_cache_v1';
const LYRICS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

async function readLyricCache(): Promise<Record<string, { t: number; text: string }>> {
  try {
    const raw = await AsyncStorage.getItem(LYRICS_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 48 官方域名白名单 —— 纯函数、无副作用、可安全静态导入 */
export function isPlayableHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.48.cn') || host === 'snh48.com' || host === 'www.snh48.com') return true;
    // R2 音乐库子域（music.gnz.hk）：正常媒体 CDN（audio/mpeg、image/jpeg 200），
    // 仅放行子域而非整个 gnz.hk（gnz.hk 主域曾对移动端回 403 HTML 挑战页导致 ExoPlayer 崩溃）
    return host === 'music.gnz.hk';
  } catch {
    return false;
  }
}

export function mediaUrl(path: string): string {
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return path.startsWith('/') ? `https://mp4.48.cn${path}` : normalizeUrl(path);
}

type TrackUrlResolver = (track: Track) => Promise<string | null>;

/**
 * MusicEngine —— 纯状态编排器。
 *
 * 不再持有 Video ref、不再做 seek、不再拦截 onProgress。
 * Video 的 seek / progress / duration 由 MusicLibraryScreen 上的 <Video> 独立管理。
 */
export const MusicEngine = {
  get state() { return useMusicPlayerStore.getState(); },
  _urlResolver: null as TrackUrlResolver | null,
  // 播放请求序号：快速连点 play/resume 时递增，仅最新请求的 URL 解析结果可写回 store，
  // 防止慢响应（旧曲目解析晚于新曲目）覆盖当前播放曲目导致「播错歌」。
  _playSeq: 0,

  setUrlResolver(resolver: TrackUrlResolver) {
    this._urlResolver = resolver;
  },

  /** 等待解析器就绪（最多等待 3 秒） */
  async _waitForResolver(timeoutMs = 3000): Promise<TrackUrlResolver | null> {
    if (this._urlResolver) return this._urlResolver;
    let waited = 0;
    while (!this._urlResolver && waited < timeoutMs) {
      await new Promise(r => setTimeout(r, 50));
      waited += 50;
    }
    return this._urlResolver;
  },

  /** Set queue and play from index 0 */
  loadQueue(tracks: Track[]) {
    const store = useMusicPlayerStore.getState();
    store.setQueue(tracks);
    if (tracks.length > 0) store.play(tracks[0], tracks);
  },

  /**
   * 默认 URL 解析器：直接用 track.mp3 / path 字段。
   * 页面挂载后可通过 setUrlResolver() 覆盖为更优实现（如含 officialMediaApi 回退）。
   * 不使用 dynamic import（消除与 MusicLibraryScreen 的循环引用）。
   */
  _initDefaultResolver() {
    if (this._urlResolver) return;
    this._urlResolver = async (track: Track) => {
      // 1. 优先用 track.mp3（官方源直接可播放）
      if (track?.mp3 && /^https?:/i.test(String(track.mp3))) {
        const u = String(track.mp3);
        if (isPlayableHost(u)) return u;
      }
      // 2. 兜底：track 自带的各种 path 字段
      const fb = String(
        (track as any).filePath ||
        (track as any).musicPath ||
        (track as any).playStreamPath ||
        (track as any).audioPath ||
        (track as any).url ||
        ''
      );
      if (fb && /^https?:/i.test(fb)) {
        if (isPlayableHost(fb)) return fb;
      }
      // 3. 通过 mediaUrl 规范化
      const normalized = mediaUrl(fb);
      if (normalized) {
        if (isPlayableHost(normalized)) return normalized;
      }
      return null;
    };
  },

  /**
   * 载入队列并定位到指定曲目，但不自动播放。
   * 预解析 URL + 歌词，等用户按播放键时已就绪。
   */
  loadQueueAt(track: Track, queue?: Track[]) {
    const store = useMusicPlayerStore.getState();
    const q = queue || store.queue;
    const idx = q.findIndex((t) => (t.musicId || t.id) === (track.musicId || track.id));
    store.setQueue(q);
    useMusicPlayerStore.setState({
      currentIndex: idx >= 0 ? idx : 0,
      playbackState: 'paused',
      url: '',
      duration: 0,
      position: 0,
      lyrics: [],
      error: null,
    });
    this._initDefaultResolver();
    this._waitForResolver().then(resolver => {
      if (resolver) {
        resolver(track).then(resolved => {
          if (resolved) useMusicPlayerStore.setState({ url: resolved });
        }).catch(() => {});
      }
    });
    this._fetchLyrics(track);
  },

  /**
   * 核心播放：解析 URL → setUrl + setPlaybackState('playing')。
   * 不再持有/操作 Video ref，不放 seek 锁。
   */
  async playTrack(track: Track, queue?: Track[]) {
    const seq = ++this._playSeq;
    const store = useMusicPlayerStore.getState();
    store.play(track, queue);
    this._fetchLyrics(track);
    this._initDefaultResolver();
    const resolver = await this._waitForResolver();
    if (seq !== this._playSeq) return; // 等待期间用户已发起更新的播放请求
    if (!resolver) { store.setError('解析器未就绪'); return; }
    try {
      const url = await resolver(track);
      if (seq !== this._playSeq) return; // 解析期间用户已切换曲目，丢弃旧响应
      if (!url) throw new Error('no url');
      if (!isPlayableHost(url)) throw new Error('不支持的播放源');
      if (!/^https?:\/\//i.test(url)) throw new Error('非法播放地址');
      store.setUrl(url);
      store.setPlaybackState('playing');
    } catch (e: any) {
      if (seq !== this._playSeq) return;
      store.setError(e?.message || 'play failed');
      // 无效的歌曲自动跳到下一首；但 single 模式/仅一首时 next() 会绕回同曲
      // （nextIndex 返回 current），造成无限重试，必须停在 error 态由用户手动处理
      const st = useMusicPlayerStore.getState();
      if (st.queue.length > 1 && st.playMode !== 'single') this.next();
    }
  },

  /**
   * 恢复播放（主页「继续播放」/ 记忆恢复统一入口）：
   * 保留当前 position 转成 seekTarget（Video onLoad 后就绪续播），重新解析 URL 并播放。
   * 与 playTrack 的区别：playTrack 永远从 0 开始，resume 从记忆位置继续。
   */
  async resume() {
    const seq = ++this._playSeq;
    const store = useMusicPlayerStore.getState();
    const track = store.queue[store.currentIndex];
    if (!track) return null;
    store.play(track, store.queue, true);
    this._fetchLyrics(track);
    this._initDefaultResolver();
    const resolver = await this._waitForResolver();
    if (seq !== this._playSeq) return null; // 已有更新的播放请求
    if (!resolver) { store.setError('解析器未就绪'); return null; }
    try {
      const url = await resolver(track);
      if (seq !== this._playSeq) return null; // 解析期间用户已切换，丢弃旧响应
      if (!url) throw new Error('no url');
      if (!isPlayableHost(url)) throw new Error('不支持的播放源');
      if (!/^https?:\/\//i.test(url)) throw new Error('非法播放地址');
      store.setUrl(url);
      store.setPlaybackState('playing');
      return track;
    } catch (e: any) {
      store.setError(e?.message || '恢复播放失败');
      return null;
    }
  },

  /** Next track, fetch URL and play */
  async next() {
    const nextTrack = useMusicPlayerStore.getState().next();
    if (!nextTrack) return null;
    await this.playTrack(nextTrack);
    return nextTrack;
  },

  /** Previous track */
  async prev() {
    const prevTrack = useMusicPlayerStore.getState().prev();
    if (!prevTrack) return null;
    await this.playTrack(prevTrack);
    return prevTrack;
  },

  /** 跳到播放列表指定下标 */
  async playAt(index: number) {
    const s = useMusicPlayerStore.getState();
    if (index < 0 || index >= s.queue.length) return null;
    const t = s.queue[index];
    if (!t) return null;
    useMusicPlayerStore.setState({ currentIndex: index });
    await this.playTrack(t, s.queue);
    return t;
  },

  /** 从播放列表移除歌曲；移除当前播放曲时自动续播下一首（或停止） */
  async removeFromQueue(id: string) {
    const s = useMusicPlayerStore.getState();
    const idx = s.queue.findIndex((t) => String(t.musicId || t.id) === String(id));
    if (idx < 0) return;
    const wasCurrent = idx === s.currentIndex;
    useMusicPlayerStore.getState().removeFromQueue(id);
    const after = useMusicPlayerStore.getState();
    if (!wasCurrent) return;
    // 当前曲被移除：续播原位置的下一首（removeFromQueue 已把 currentIndex 指向它）
    const nextTrack = after.queue[after.currentIndex];
    if (nextTrack && after.queue.length > 0) {
      await this.playTrack(nextTrack, after.queue);
    } else {
      useMusicPlayerStore.setState({ url: '', playbackState: 'idle', position: 0, duration: 0, lyrics: [] });
    }
  },

  /**
   * 暂停/播放切换。
   * - URL 为空（记忆恢复后首次）→ 重新解析地址再播放
   * - URL 非法 → 静默拒绝（防止 Video source 异常）
   * - 正常 → 翻转 playbackState
   * 不再调用 resume() → playTrack 重建 Video；resume 改为内联轻量解析路径。
   */
  togglePause() {
    const s = useMusicPlayerStore.getState();
    // 记忆恢复后首次播放：url 为空，需要先重新解析地址
    if (!s.url && s.queue[s.currentIndex]) {
      const t = s.queue[s.currentIndex];
      this._initDefaultResolver();
      this._waitForResolver().then(async (resolver) => {
        if (!resolver) { s.setError('解析器未就绪'); return; }
        try {
          const url = await resolver(t);
          if (!url || !isPlayableHost(url) || !/^https?:\/\//i.test(url)) {
            console.warn('[MusicEngine] resume url invalid');
            return;
          }
          s.setUrl(url);
          s.setPlaybackState('playing');
          if (!s.lyrics || s.lyrics.length === 0) this._fetchLyrics(t);
        } catch (e: any) {
          s.setError(e?.message || '播放恢复失败');
        }
      });
      return;
    }
    // URL 非法/空 → 禁止状态翻转
    if (!s.url || !/^https?:\/\//i.test(s.url) || !isPlayableHost(s.url)) {
      console.warn('[MusicEngine] togglePause blocked: invalid url', s.url);
      return;
    }
    const willPlay = s.playbackState !== 'playing';
    s.setPlaybackState(willPlay ? 'playing' : 'paused');
    if (willPlay && s.queue[s.currentIndex] && (!s.lyrics || s.lyrics.length === 0)) {
      this._fetchLyrics(s.queue[s.currentIndex]);
    }
  },

  cycleMode() {
    const s = useMusicPlayerStore.getState();
    const next = s.playMode === 'sequential' ? 'random' : s.playMode === 'random' ? 'single' : 'sequential';
    s.setMode(next);
  },

  // --- Lyrics ---
  async _fetchLyrics(track: Track) {
    const title = String(track.title || '').trim();
    if (!title) return;
    // 优先用真实团体/艺人名（groupLabel/artist），成员名（joinMemberNames）次之；
    // 多团体名（如「SNH48、BEJ48」）拆分后逐个尝试——拼接串归一化后匹配不到 LRC，
    // 会落到纯歌名模糊匹配而错配其他版本的歌词（用户反馈「歌词对不上」的根因）。
    const rawGroup = String(
      (track as any).groupLabel || (track as any).artist || (track as any).subTitle || (track as any).joinMemberNames || ''
    ).trim();
    const candidates: string[] = [];
    const parts = rawGroup.split(/[、,，/·+&;；\s]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) candidates.push(...parts);
    if (rawGroup) candidates.push(rawGroup);
    candidates.push(''); // 纯标题兜底（Tier 6 模糊匹配）
    // R2 公演曲标题常带副标题后缀（如「Starlight (星光)」「蒲公英的脚印 (过渡公演)」），
    // 歌词索引只收核心标题（Starlight / 蒲公英的脚印）——增加「去括号核心标题」候选，
    // 让 medium/loose 匹配能命中（此前整串归一化不匹配 → R2 曲目大量「暂无歌词」）。
    const coreTitle = title.replace(/[（(].*?[)）]/g, '').trim();
    if (coreTitle && coreTitle !== title) {
      const coreGroupCandidates: string[] = [];
      for (const g of candidates) {
        if (!g) continue;
        coreGroupCandidates.push(g);
        coreGroupCandidates.push(`${coreTitle}`.length ? g : g); // 保持 group 不变，仅标题换核心版
      }
      try {
        const { matcher } = await getLyricsMatcher();
        for (const g of coreGroupCandidates) {
          const r = matcher.match({ song: coreTitle, group: g });
          if (r) {
            const url = `${LYRICS_BASE_URL}/${encodeURI(r.entry.filePath)}`;
            const cacheKey = `lyric:${r.entry.filePath}`;
            const cache = await readLyricCache();
            const hit = cache[cacheKey];
            if (hit && Date.now() - hit.t < LYRICS_CACHE_TTL) {
              useMusicPlayerStore.getState().setLyrics(parseLrc(hit.text));
              return;
            }
            const lrcResp = await fetchWithTimeout(url, {}, 10000);
            const raw = await lrcResp.text();
            useMusicPlayerStore.getState().setLyrics(parseLrc(raw));
            cache[cacheKey] = { t: Date.now(), text: raw };
            const keys = Object.keys(cache);
            if (keys.length > 200) {
              const oldest = keys
                .map((k) => ({ k, t: cache[k].t }))
                .sort((a, b) => a.t - b.t)
                .slice(0, keys.length - 200)
                .map((x) => x.k);
              oldest.forEach((k) => delete cache[k]);
            }
            AsyncStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(cache)).catch(() => {});
            return;
          }
        }
      } catch {
        /* 核心标题匹配失败则走下面的常规流程 */
      }
    }
    try {
      const { matcher } = await getLyricsMatcher();
      let best: ReturnType<typeof matcher.match> = null;
      for (const g of candidates) {
        const r = matcher.match(g ? { song: title, group: g } : { song: title });
        if (r && (!best || r.tier < best.tier || (r.tier === best.tier && r.score > best.score))) best = r;
      }
      if (best) {
        const url = `${LYRICS_BASE_URL}/${encodeURI(best.entry.filePath)}`;
        const cacheKey = `lyric:${best.entry.filePath}`;
        const cache = await readLyricCache();
        const hit = cache[cacheKey];
        if (hit && Date.now() - hit.t < LYRICS_CACHE_TTL) {
          useMusicPlayerStore.getState().setLyrics(parseLrc(hit.text));
          return;
        }
        const lrcResp = await fetchWithTimeout(url, {}, 10000);
        const raw = await lrcResp.text();
        useMusicPlayerStore.getState().setLyrics(parseLrc(raw));
        // 落盘（整表重写有界：最多保留 200 首，超出丢最旧）
        cache[cacheKey] = { t: Date.now(), text: raw };
        const keys = Object.keys(cache);
        if (keys.length > 200) {
          const oldest = keys
            .map((k) => ({ k, t: cache[k].t }))
            .sort((a, b) => a.t - b.t)
            .slice(0, keys.length - 200)
            .map((x) => x.k);
          oldest.forEach((k) => delete cache[k]);
        }
        AsyncStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(cache)).catch(() => {});
      } else {
        console.warn('[lyrics] no match for', title, 'group=', rawGroup);
      }
    } catch (e) {
      console.warn('[lyrics] fetch failed', title, e);
    }
  },
};