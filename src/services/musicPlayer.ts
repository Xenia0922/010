import { useMusicPlayerStore, Track, LyricLine } from '../store/musicPlayerStore';
import { usePlayerStore } from '../player/store/playerStore';
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

// 歌词缓存写盘串行化：并发拉取（快切歌/后台预取）若各自 read-modify-write 整表重写，
// 后写者基于旧表覆盖会丢条目。所有写入走单链排队、每次读最新表；命中缓存不触发写盘。
let _lyricWriteChain: Promise<void> = Promise.resolve();
function saveLyricCache(cacheKey: string, text: string): void {
  _lyricWriteChain = _lyricWriteChain.then(async () => {
    try {
      const cache = await readLyricCache();
      cache[cacheKey] = { t: Date.now(), text };
      const keys = Object.keys(cache);
      if (keys.length > 200) {
        const oldest = keys
          .map((k) => ({ k, t: cache[k].t }))
          .sort((a, b) => a.t - b.t)
          .slice(0, keys.length - 200)
          .map((x) => x.k);
        oldest.forEach((k) => delete cache[k]);
      }
      await AsyncStorage.setItem(LYRICS_CACHE_KEY, JSON.stringify(cache));
    } catch { /* 写失败静默：本次未入缓存，下次重拉 */ }
  });
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
const PLAY_UA = 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)';
const PLAY_REFERER = 'https://h5.48.cn/';

function trackKey(track: Track): string {
  return String((track as any).musicId || (track as any).id || `${track.title}|${track.artist || ''}`);
}

export const MusicEngine = {
  get state() { return useMusicPlayerStore.getState(); },
  _urlResolver: null as TrackUrlResolver | null,
  // 播放请求序号：快速连点 play/resume 时递增，仅最新请求的 URL 解析结果可写回 store，
  // 防止慢响应（旧曲目解析晚于新曲目）覆盖当前播放曲目导致「播错歌」。
  _playSeq: 0,
  // 预热地址缓存：trackKey → 已解析 URL（预加载下一首/起播提速，AWS 冷边首连慢）。
  // Map 保插入序，超上限丢最旧 —— 长会话/大歌单防无限增长（URL 是长串，几百首≈数百 KB）
  _warmUrls: new Map<string, string>(),
  _warmUrlsMax: 40,
  // 连续自动跳过深度：整队 URL 失效时 playTrack catch 自动 next() 逐首扫，计数封顶防失败级联无限连跳
  _autoSkipDepth: 0,
  // 切歌节流：Exo 事件（ended/cmd next/prev）有 App 全局 + 页面双监听器时防连切两首
  _skipTs: 0,

  /** 对 URL 发一次极小 Range 请求，提前打通 AWS/CDN 边缘与 TLS（后续 Exo 拉流更快、少卡起播） */
  async _warmUrl(url: string): Promise<void> {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      try {
        await fetch(url, {
          headers: { Range: 'bytes=0-4095', 'User-Agent': PLAY_UA, Referer: PLAY_REFERER },
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // 预热失败不影响播放（静默）
    }
  },

  /** 预加载下一首：后台解析 URL + Range 预热 + 缓存，切歌时零等待起播 */
  _prewarmNextTrack(): void {
    const st = useMusicPlayerStore.getState();
    const q = st.queue || [];
    if (q.length < 2) return;
    let n = -1;
    if (st.playMode === 'single') return; // 单曲循环重复同一 URL，无预热意义
    if (st.playMode === 'random') {
      if (q.length > 1) {
        n = Math.floor(Math.random() * q.length);
        if (n === st.currentIndex) n = (n + 1) % q.length;
      }
    } else {
      n = (st.currentIndex + 1) % q.length;
    }
    if (n < 0 || n === st.currentIndex) return;
    const nextTrack = q[n];
    if (!nextTrack || this._warmUrls.has(trackKey(nextTrack))) return;
    this._initDefaultResolver();
    this._waitForResolver().then((resolver) => {
      if (!resolver) return;
      resolver(nextTrack).then((url) => {
        if (!url || !/^https?:/i.test(url)) return;
        this._cacheWarmUrl(trackKey(nextTrack), url);
        this._warmUrl(url);
      }).catch(() => {});
    });
  },

  /** 写预热缓存并裁剪超限项（Map 插入序 = 最旧优先删） */
  _cacheWarmUrl(key: string, url: string): void {
    this._warmUrls.set(key, url);
    while (this._warmUrls.size > this._warmUrlsMax) {
      const oldest = this._warmUrls.keys().next();
      if (!oldest.done) this._warmUrls.delete(oldest.value);
      else break;
    }
  },

  /**
   * 取单曲"可立即播放"的 url（预热缓存 → 解析器，成功后入预热缓存）——
   * 专供系统卡 skip hints 预推：前台播放确立时调用；后台冻结 JS 时原生即可本地切歌。
   */
  async resolvePlayUrl(track: Track): Promise<string | null> {
    if (!track) return null;
    const key = trackKey(track);
    const hit = this._warmUrls.get(key);
    if (hit) return hit;
    this._initDefaultResolver();
    const resolver = this._urlResolver;
    if (!resolver) return null;
    try {
      const url = await resolver(track);
      if (url && /^https?:/i.test(url) && isPlayableHost(url)) {
        this._cacheWarmUrl(key, url);
        return url;
      }
    } catch {}
    return null;
  },

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
      url: useMusicPlayerStore.getState().url, // 保留旧 url（B2 同模式防空源翻转）
      duration: 0,
      position: 0,
      lyrics: [],
      error: null,
    });
    this._initDefaultResolver();
    const seq = this._playSeq; // 预解析期间若用户发起播放/切歌（_playSeq++），丢弃过期回写
    this._waitForResolver().then(resolver => {
      if (resolver) {
        resolver(track).then(resolved => {
          if (resolved && seq === this._playSeq) useMusicPlayerStore.setState({ url: resolved });
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
    // 播放互斥：后播者胜 —— 音乐开播时，若直播/录播/视频播放器在放则先停掉
    try {
      const ps = usePlayerStore.getState();
      if (ps.source && ps.state !== 'idle') ps.close();
    } catch {}
    const seq = ++this._playSeq;
    const store = useMusicPlayerStore.getState();
    store.play(track, queue);
    this._fetchLyrics(track);
    this._initDefaultResolver();
    const resolver = await this._waitForResolver();
    if (seq !== this._playSeq) return; // 等待期间用户已发起更新的播放请求
    if (!resolver) { store.setError('解析器未就绪'); return; }
    try {
      // 已预热的曲目（切歌路径）直接取缓存地址，跳过解析网络往返
      const warmed = this._warmUrls.get(trackKey(track));
      const url = warmed || await resolver(track);
      if (seq !== this._playSeq) return; // 解析期间用户已切换曲目，丢弃旧响应
      if (!url) throw new Error('no url');
      if (!isPlayableHost(url)) throw new Error('不支持的播放源');
      if (!/^https?:\/\//i.test(url)) throw new Error('非法播放地址');
      store.setUrl(url);
      store.setPlaybackState('playing');
      this._autoSkipDepth = 0; // 播放成功：复位自动跳过计数（下次失败可再启一轮封顶扫描）
      // 后台预解析 + Range 预热下一首：切歌/下一首起播不再等 AWS 冷连接
      this._prewarmNextTrack();
    } catch (e: any) {
      if (seq !== this._playSeq) return;
      store.setError(e?.message || 'play failed');
      // 无效的歌曲自动跳到下一首；但 single 模式/仅一首时 next() 会绕回同曲
      // （nextIndex 返回 current），造成无限重试，必须停在 error 态由用户手动处理。
      // _autoSkipDepth 封顶（≤队列长度）：整队 URL 全失效时最多完整扫一遍即停，防失败级联无限连跳。
      const st = useMusicPlayerStore.getState();
      if (st.queue.length > 1 && st.playMode !== 'single') {
        if (this._autoSkipDepth < st.queue.length) {
          this._autoSkipDepth += 1;
          try { await this.next(); } catch {}
        } else {
          this._autoSkipDepth = 0; // 本队列已扫完一轮仍全失效：复位待命，避免自动跳过永久锁死
        }
      }
    }
  },

  /**
   * 恢复播放（主页「继续播放」/ 记忆恢复统一入口）：
   * 保留当前 position 转成 seekTarget（Video onLoad 后就绪续播），重新解析 URL 并播放。
   * 与 playTrack 的区别：playTrack 永远从 0 开始，resume 从记忆位置继续。
   */
  async resume() {
    // 播放互斥：后播者胜 —— resume 同样停掉 playerStore 上的直播/录播/视频
    try {
      const ps = usePlayerStore.getState();
      if (ps.source && ps.state !== 'idle') ps.close();
    } catch {}
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
      const warmed = this._warmUrls.get(trackKey(track));
      const url = warmed || await resolver(track);
      if (seq !== this._playSeq) return null; // 解析期间用户已切换，丢弃旧响应
      if (!url) throw new Error('no url');
      if (!isPlayableHost(url)) throw new Error('不支持的播放源');
      if (!/^https?:\/\//i.test(url)) throw new Error('非法播放地址');
      store.setUrl(url);
      store.setPlaybackState('playing');
      this._prewarmNextTrack();
      return track;
    } catch (e: any) {
      store.setError(e?.message || '恢复播放失败');
      return null;
    }
  },

  /** Next track, fetch URL and play（250ms 引擎级节流：多 Exo 监听器/连点防连切） */
  async next() {
    const now = Date.now();
    if (now - this._skipTs < 250) return null;
    this._skipTs = now;
    const nextTrack = useMusicPlayerStore.getState().next();
    if (!nextTrack) return null;
    await this.playTrack(nextTrack);
    return nextTrack;
  },

  /** Previous track */
  async prev() {
    const now = Date.now();
    if (now - this._skipTs < 250) return null;
    this._skipTs = now;
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
        if (!resolver) { useMusicPlayerStore.getState().setError('解析器未就绪'); return; }
        try {
          const url = await resolver(t);
          if (!url || !isPlayableHost(url) || !/^https?:\/\//i.test(url)) {
            console.warn('[MusicEngine] resume url invalid');
            return;
          }
          // 异步解析期间可能已切歌 / 已被并发路径（playTrack/loadQueueAt 预解析）写回 url：
          // 一律用最新 state 判断（不用闭包旧快照 s —— 跨 await 用过期值的 TOCTOU），
          // 只有仍是同一曲才允许写回，避免把旧曲地址盖到新曲上。
          const cur = useMusicPlayerStore.getState();
          if (cur.url && /^https?:\/\//i.test(cur.url) && isPlayableHost(cur.url)) {
            if (cur.playbackState !== 'playing') cur.setPlaybackState('playing'); // 有地址即起播
            return;
          }
          const curTrack = cur.queue[cur.currentIndex];
          const sameTrack = curTrack && String(curTrack.musicId || curTrack.id) === String(t.musicId || t.id);
          if (!sameTrack) return; // 期间已切歌：丢弃过期解析结果
          cur.setUrl(url);
          cur.setPlaybackState('playing');
          if (!cur.lyrics || cur.lyrics.length === 0) this._fetchLyrics(t);
        } catch (e: any) {
          useMusicPlayerStore.getState().setError(e?.message || '播放恢复失败');
        }
      });
      return;
    }
    // URL 非法/空 → 禁止状态翻转
    if (!s.url || !/^https?:\/\//i.test(s.url) || !isPlayableHost(s.url)) {
      console.warn('[MusicEngine] togglePause blocked: invalid url', s.url);
      return;
    }
    // 加载/解析中（切歌/起播）不接受切换：store 马上会进入 playing，防误翻转为 paused/playing
    if (s.playbackState === 'loading') return;
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
    // 竞态防护：抓当前播放序号；歌词解析/网络多跳期间若用户切了歌（_playSeq 变化），
    // 旧歌歌词不得写回（此前快切歌可能把上一首歌词落到新歌上）
    const seq = this._playSeq;
    const commit = (lines: any[]) => {
      if (seq !== this._playSeq) return;
      useMusicPlayerStore.getState().setLyrics(lines);
    };
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
        coreGroupCandidates.push(g); // 保持 group 不变，仅标题换核心版
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
              commit(parseLrc(hit.text));
              return;
            }
            const lrcResp = await fetchWithTimeout(url, {}, 10000);
            const raw = await lrcResp.text();
            commit(parseLrc(raw));
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
          commit(parseLrc(hit.text));
          return;
        }
        const lrcResp = await fetchWithTimeout(url, {}, 10000);
        if (!lrcResp.ok) { console.warn('[lyrics] fetch', lrcResp.status, title); return; } // 404/错误页不落缓存
        const raw = await lrcResp.text();
        commit(parseLrc(raw));
        saveLyricCache(cacheKey, raw);
      } else {
        console.warn('[lyrics] no match for', title, 'group=', rawGroup);
      }
    } catch (e) {
      console.warn('[lyrics] fetch failed', title, e);
    }
  },
};