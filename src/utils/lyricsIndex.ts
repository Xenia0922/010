import { LyricsMatcher, LyricEntry } from './lyricsMatcher';
import { normalizeSong, normalizeArtist, normalizeGroup } from './normalize';
import { fetchWithTimeout } from './network';
import AsyncStorage from '@react-native-async-storage/async-storage';

// B5：歌词索引落盘缓存（24h TTL）——冷启动不再每次重拉 lyrics-index.json，弱网下歌词功能稳定
const INDEX_CACHE_KEY = 'yaya_lyrics_index_v1';
const INDEX_CACHE_TTL = 24 * 60 * 60 * 1000;

interface RawIndexEntry {
  path: string;
  group: string;
  folder: string;
  file: string;
  songTitle: string;
}

export function buildLyricEntries(raw: RawIndexEntry[]): LyricEntry[] {
  const dedup = new Map<string, LyricEntry>();
  for (const item of raw) {
    if (!item.songTitle || !item.path) continue;
    const id = `${item.group}-${item.songTitle}`;
    if (dedup.has(id)) continue;
    const ns = normalizeSong(item.songTitle);
    const na = normalizeArtist(item.group);
    const ng = normalizeGroup(item.group);
    dedup.set(id, {
      id,
      songName: item.songTitle,
      artist: item.group,
      group: item.group,
      filePath: item.path,
      normalized: {
        song: { strict: ns.strict, medium: ns.medium, loose: ns.loose },
        artist: { strict: na.strict, medium: na.medium, loose: na.loose },
        group: { strict: ng.strict, medium: ng.medium, loose: ng.loose },
      },
    });
  }
  return [...dedup.values()];
}

let cachedMatcher: { entries: LyricEntry[]; matcher: any } | null = null;

export async function getLyricsMatcher() {
  if (cachedMatcher) return cachedMatcher;

  // 1) 落盘缓存优先（24h TTL）
  try {
    const raw = await AsyncStorage.getItem(INDEX_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.t && Date.now() - parsed.t < INDEX_CACHE_TTL && Array.isArray(parsed.index)) {
        const entries = buildLyricEntries(parsed.index);
        if (entries.length) {
          cachedMatcher = { entries, matcher: new LyricsMatcher(entries) };
          return cachedMatcher;
        }
      }
    }
  } catch {
    /* ignore cache errors */
  }

  // 2) 网络拉取 + 写缓存
  const resp = await fetchWithTimeout('https://yaya-data.pages.dev/lyrics-index.json', {}, 10000);
  const raw: RawIndexEntry[] = await resp.json();
  const entries = buildLyricEntries(raw);
  const matcher = new LyricsMatcher(entries);
  cachedMatcher = { entries, matcher };
  try {
    await AsyncStorage.setItem(INDEX_CACHE_KEY, JSON.stringify({ t: Date.now(), index: raw }));
  } catch {
    /* ignore cache errors */
  }
  return cachedMatcher;
}
