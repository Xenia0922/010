import * as FileSystem from 'expo-file-system/legacy';

/**
 * 封面下载落盘 → file:// 本地路径（给系统媒体服务/通知用）。
 * 背景（2026-09 实测）：OPPO/ColorOS 对「Java 侧直接联网拉封面 / dataURI」兼容差，
 * RN 侧 downloadAsync（自带与音乐库同源网络栈）→ file:// → 服务 decodeFile 是唯一稳定路径。
 * MusicLibraryScreen（Exo 原生播放 art）与 App.tsx（旧自管通知）共用。
 */
const coverDataCache = new Map<string, string>();
let coverDirReady: Promise<boolean> | null = null;

function ensureCoverDir(): Promise<boolean> {
  if (!coverDirReady) {
    coverDirReady = (async () => {
      try {
        const dir = `${FileSystem.cacheDirectory || ''}cover/`;
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return coverDirReady;
}

function coverFileFor(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  const ext = /\.png([?#]|$)/i.test(url) ? 'png' : 'jpg';
  return `${FileSystem.cacheDirectory || ''}cover/notif_${h.toString(36)}.${ext}`;
}

/** 返回可直读的封面路径（file:// 或 data:）；http(s) 下载到本地；失败降级回原 URL */
export async function fetchCoverToFile(coverUrl: string): Promise<string> {
  if (!coverUrl) return '';
  if (coverUrl.startsWith('file://') || coverUrl.startsWith('data:')) return coverUrl;
  const hit = coverDataCache.get(coverUrl);
  if (hit) return hit;
  try {
    await ensureCoverDir();
    const local = coverFileFor(coverUrl);
    const res: any = await Promise.race([
      FileSystem.downloadAsync(coverUrl, local),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cover timeout')), 7000)),
    ]);
    if (res && (res.status === 200 || res.status === undefined)) {
      coverDataCache.set(coverUrl, local);
      return local;
    }
  } catch {
    // 下载失败：降级原 URL（原生侧仍有单流网络回退）
  }
  return coverUrl;
}

/** 补全相对路径 → https://source.48.cn/... 并把任意 resize 缩略升级为 500x500（原图在该站 404） */
export function normalizeCoverUrl(raw: string): string {
  let cover = String(raw || '').trim();
  if (!cover) return '';
  if (!/^https?:\/\//i.test(cover)) {
    cover = `https://source.48.cn${cover.startsWith('/') ? cover : '/' + cover}`;
  }
  if (/resize_\d+x\d+/i.test(cover)) {
    cover = cover.replace(/resize_\d+x\d+/i, 'resize_500x500');
  }
  return cover;
}
