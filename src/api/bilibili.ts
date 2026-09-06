import { NativeModules, Platform } from 'react-native';
import { useSettingsStore } from '../store';
import { requestJson } from '../utils/network';

const BILIBILI_WEB_API = 'https://api.bilibili.com';
const BILIBILI_LIVE_API = 'https://api.live.bilibili.com';

function getCookie(): string {
  return useSettingsStore.getState().settings.bilibiliCookie || '';
}

function biliHeaders(cookie = getCookie(), referer = 'https://live.bilibili.com/'): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    Referer: referer,
  };
  if (referer.includes('live.bilibili.com')) headers.Origin = 'https://live.bilibili.com';
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function assertBiliOk(res: any, fallback: string) {
  if (res?.code === 0) return res;
  if (res?.code === -412 || /request was banned/i.test(String(res?.message || ''))) {
    throw new Error('B站接口请求被拦截，请登录 B站账号或稍后再试');
  }
  throw new Error(res?.message || res?.msg || fallback);
}

function candidateScore(item: any): number {
  let score = 0;
  const format = String(item.formatName || '').toLowerCase();
  const protocol = String(item.protocolName || '').toLowerCase();
  const codec = String(item.codecName || '').toLowerCase();

  // 优先级：① 可播放性（HLS fmp4/ts 远优先于 http-flv，ExoPlayer 播不了 flv）
  //          ② 画质（qn 越高越好，默认即最高可用画质）
  //          ③ 同画质下编码 tie-break：AVC 略优于 HEVC
  // 这样默认拿到「能播的最高画质」；若某线路播放失败，上层静默换到下一条。
  if (format === 'fmp4' || format === 'ts' || protocol.includes('hls')) score += 100000;
  score += Number(item.currentQn || 0) * 2;
  if (codec === 'avc') score += 1;
  return score;
}

function liveCandidates(playInfo: any): any[] {
  const playurl = playInfo?.data?.playurl_info?.playurl;
  const candidates: any[] = [];

  for (const stream of playurl?.stream || []) {
    for (const format of stream.format || []) {
      for (const codec of format.codec || []) {
        const baseUrl = String(codec.base_url || '').trim();
        if (!baseUrl) continue;
        for (const info of codec.url_info || []) {
          const host = String(info.host || '').trim();
          if (!host) continue;
          candidates.push({
            url: `${host}${baseUrl}${String(info.extra || '').trim()}`,
            host,
            protocolName: String(stream.protocol_name || '').trim(),
            formatName: String(format.format_name || '').trim(),
            codecName: String(codec.codec_name || '').trim(),
            currentQn: Number(codec.current_qn || 0),
          });
        }
      }
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((item) => item.url && !seen.has(item.url) && seen.add(item.url))
    .sort((a, b) => candidateScore(b) - candidateScore(a));
}

export interface BiliQuality {
  qn: number;
  label: string;
}

/** 画质选项：优先用接口的 g_qn_desc 文案，缺失时按候选 currentQn 兜底；按 qn 降序 */
function buildQualities(playInfo: any, candidates: any[]): BiliQuality[] {
  const descList = playInfo?.data?.playurl_info?.playurl?.g_qn_desc || [];
  const labelByQn = new Map<number, string>();
  for (const q of descList) {
    if (q && Number(q.qn) > 0) labelByQn.set(Number(q.qn), String(q.desc || `qn${q.qn}`));
  }
  const qns = new Set<number>();
  for (const c of candidates) {
    if (Number(c.currentQn) > 0) {
      qns.add(Number(c.currentQn));
      if (!labelByQn.has(Number(c.currentQn))) labelByQn.set(Number(c.currentQn), `qn${c.currentQn}`);
    }
  }
  return [...qns]
    .sort((a, b) => b - a)
    .map((qn) => ({ qn, label: labelByQn.get(qn) || '原画' }));
}

export const bilibiliApi = {
  headers(roomId?: string) {
    return biliHeaders(getCookie(), roomId ? `https://live.bilibili.com/${roomId}` : 'https://live.bilibili.com/');
  },

  async checkLoginStatus(cookie?: string) {
    const res = await requestJson<any>(`${BILIBILI_WEB_API}/x/web-interface/nav`, {
      headers: biliHeaders(cookie, 'https://www.bilibili.com/'),
    });
    return assertBiliOk(res, 'B站登录状态检查失败');
  },

  async generateQrCode() {
    const res = await requestJson<any>('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      headers: biliHeaders('', 'https://passport.bilibili.com/'),
    });
    return assertBiliOk(res, 'B站二维码获取失败');
  },

  async pollQrCode(qrcodeKey: string) {
    const res = await requestJson<any>(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
      { headers: biliHeaders('', 'https://passport.bilibili.com/') },
    );
    return assertBiliOk(res, 'B站扫码状态获取失败');
  },

  /** B站 2024+ 新协议：扫码确认后 poll 只回 ticket 型 crossDomain url（如
   *  https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=xxx&gourl=...），
   *  cookie 由访问该 url 时服务端 Set-Cookie 响应头下发。RN fetch 自动跟随 302 拿不到该头，
   *  走原生 BiliLoginModule（followRedirects=false 停在首包读 Set-Cookie）。返回 "k=v; k=v" 串。 */
  async exchangeTicket(crossDomainUrl: string) {
    const M: any = (NativeModules as any)?.BiliLoginModule;
    if (Platform.OS !== 'android' || !M?.fetchTicket) {
      throw new Error('当前环境不支持 B站 ticket 换 cookie（需 Android 原生模块）');
    }
    const raw = await M.fetchTicket(String(crossDomainUrl));
    return String(raw || '');
  },

  async getRoomInit(roomId: string) {
    const res = await requestJson<any>(
      `${BILIBILI_LIVE_API}/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
      { headers: biliHeaders(getCookie(), `https://live.bilibili.com/${roomId}`) },
    );
    return assertBiliOk(res, 'B站房间信息获取失败');
  },

  /** 房间详情：标题 + 封面（公演直播行展示用） */
  async getRoomInfo(roomId: string) {
    const res = await requestJson<any>(
      `${BILIBILI_LIVE_API}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`,
      { headers: biliHeaders(getCookie(), `https://live.bilibili.com/${roomId}`) },
    );
    return assertBiliOk(res, 'B站房间详情获取失败').data || {};
  },

  async getRoomPlayInfo(roomId: string) {
    const query = new URLSearchParams({
      room_id: String(roomId),
      protocol: '0,1',
      format: '0,1,2',
      codec: '0,1',
      // 最高画质：qn=10000(原画) + fourk=1 允许 4K/杜比流 + fnval 覆盖 HLS/TS/FMP4/杜比/4K
      qn: '10000',
      fourk: '1',
      fnval: '4048',
      platform: 'web',
      ptype: '8',
    });
    const res = await requestJson<any>(
      `${BILIBILI_LIVE_API}/xlive/web-room/v2/index/getRoomPlayInfo?${query.toString()}`,
      { headers: biliHeaders(getCookie(), `https://live.bilibili.com/${roomId}`) },
    );
    return assertBiliOk(res, 'B站直播流获取失败');
  },

  async getDanmuInfo(roomId: string) {
    // 新版接口风控严（未登录/部分网络返回 -352），失败时回退旧版 getConf（两者都返回 token + host 列表）
    try {
      const res = await requestJson<any>(
        `${BILIBILI_LIVE_API}/xlive/web-room/v1/index/getDanmuInfo?id=${encodeURIComponent(roomId)}&type=0`,
        { headers: biliHeaders(getCookie(), `https://live.bilibili.com/${roomId}`) },
      );
      return assertBiliOk(res, 'B站弹幕信息获取失败').data || {};
    } catch {
      const conf = await requestJson<any>(
        `${BILIBILI_LIVE_API}/room/v1/Danmu/getConf?room_id=${encodeURIComponent(roomId)}&platform=pc&player=web`,
        { headers: biliHeaders(getCookie(), `https://live.bilibili.com/${roomId}`) },
      );
      const data = assertBiliOk(conf, 'B站弹幕配置获取失败').data || {};
      const hosts = (data.host_server_list || data.server_list || [])
        .map((h: any) => ({ host: h.host, wss_port: Number(h.wss_port) || 443 }))
        .filter((h: any) => h.host);
      return {
        token: data.token || '',
        host_list: hosts.length ? hosts : [{ host: data.host || 'broadcastlv.chat.bilibili.com', wss_port: 443 }],
      };
    }
  },

  async resolveLive(roomId: string) {
    const init = await this.getRoomInit(roomId);
    const realRoomId = String(init.data?.room_id || roomId);
    if (Number(init.data?.live_status) !== 1) throw new Error('该直播间当前未开播');

    const playInfo = await this.getRoomPlayInfo(realRoomId);
    const candidates = liveCandidates(playInfo);
    if (!candidates.length) throw new Error('未找到可用的直播播放地址');

    return {
      realRoomId,
      streamUrl: candidates[0].url,
      streamCandidates: candidates,
      qualities: buildQualities(playInfo, candidates),
      title: playInfo.data?.room_info?.title || `B站直播 ${realRoomId}`,
    };
  },

  async resolveLiveUrl(roomId: string): Promise<string | null> {
    const info = await this.resolveLive(roomId);
    return info.streamUrl || null;
  },
};

export default bilibiliApi;
