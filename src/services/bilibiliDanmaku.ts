/**
 * bilibiliDanmaku · B站直播弹幕（WebSocket 直连弹幕服务器）
 *  - getDanmuInfo 取 token + host_list → wss 连接
 *  - 认证包 protover=0：服务器以未压缩 JSON 下发（免 pako/免 brotli）
 *  - 30s 心跳保活；断线 5s 自动重连
 *  - 仅解析 DANMU_MSG 文本，回调给上层渲染
 */
import bilibiliApi from '../api/bilibili';
import pako from 'pako';

interface DanmuHost {
  host: string;
  port: number;
  wss_port: number;
}

interface DanmuInfo {
  token: string;
  host_list: DanmuHost[];
}

export interface BiliDanmakuHandlers {
  onMessage: (text: string) => void;
  onStatus?: (connected: boolean) => void;
}

function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if ((b & 0xe0) === 0xc0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63));
      i += 2;
    } else if ((b & 0xf0) === 0xe0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63));
      i += 3;
    } else if (i + 3 < bytes.length) {
      const cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      out += String.fromCodePoint(cp);
      i += 4;
    } else {
      i += 1;
    }
  }
  return out;
}

/** 组包：16 字节头 + JSON 体（大端序） */
function encodePacket(op: number, body: string): ArrayBuffer {
  const bodyBytes = utf8Encode(body);
  const buf = new ArrayBuffer(16 + bodyBytes.length);
  const dv = new DataView(buf);
  dv.setUint32(0, 16 + bodyBytes.length); // 包长
  dv.setUint16(4, 16);                    // 头长
  dv.setUint16(6, 1);                     // 协议版本
  dv.setUint16(8, op);                    // 操作码
  dv.setUint32(12, 1);                    // 序号
  new Uint8Array(buf, 16).set(bodyBytes);
  return buf;
}

/** 从 ArrayBuffer / string 中解出所有 op=5 的弹幕文本（支持协议 0 JSON 与协议 2 zlib 压缩） */
function extractDanmaku(data: any): string[] {
  const texts: string[] = [];
  const parseBody = (body: string) => {
    try {
      const obj = JSON.parse(body);
      if (obj?.cmd === 'DANMU_MSG' && Array.isArray(obj.info) && obj.info[1]) texts.push(String(obj.info[1]));
    } catch {
      /* ignore 单条坏包 */
    }
  };
  if (typeof data === 'string') {
    parseBody(data);
    return texts;
  }
  const buf: ArrayBuffer = data instanceof ArrayBuffer ? data : data?.buffer ? (data as any).buffer : null;
  if (!buf || buf.byteLength < 16) return texts;
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  let offset = 0;
  while (offset + 16 <= buf.byteLength) {
    const len = dv.getUint32(offset);
    if (len < 16 || offset + len > buf.byteLength) break;
    const ver = dv.getUint16(offset + 6);
    const op = dv.getUint16(offset + 8);
    const payload = bytes.subarray(offset + 16, offset + len);
    if (op === 5) {
      if (ver === 0) {
        parseBody(utf8Decode(payload));
      } else if (ver === 2) {
        // zlib 压缩：解压后可能是多条 op=5 报文，递归解析
        try {
          const inflated = pako.inflate(payload);
          texts.push(...extractDanmaku(inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength)));
        } catch {
          /* 解压失败忽略 */
        }
      }
    }
    offset += len;
  }
  return texts;
}

export class BilibiliDanmaku {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private roomId = '';
  private handlers: BiliDanmakuHandlers | null = null;
  private closed = true;
  private targets: { url: string; token: string }[] = [];

  connect(roomId: string, handlers: BiliDanmakuHandlers): void {
    this.disconnect();
    this.roomId = String(roomId);
    this.handlers = handlers;
    this.closed = false;
    this.fetchTargets()
      .then((targets) => {
        if (this.closed || !targets.length) return;
        this.targets = targets;
        this.openSocket(targets[0].url, targets[0].token, 0);
      })
      .catch(() => this.scheduleReconnect());
  }

  /** 取弹幕服务器列表：新接口失败自动回退旧接口（bilibiliApi 已封装），并展开多端口候选 */
  private async fetchTargets(): Promise<{ url: string; token: string }[]> {
    const info: DanmuInfo = await bilibiliApi.getDanmuInfo(this.roomId);
    const token = info?.token || '';
    const out: { url: string; token: string }[] = [];
    const seen = new Set<string>();
    const hosts = (info?.host_list || []).filter((h) => h && h.host);
    for (const h of hosts) {
      const ports = [Number(h.wss_port) || 443];
      if (!ports.includes(443)) ports.push(443);
      if (!ports.includes(2245)) ports.push(2245);
      for (const port of ports) {
        const url = `wss://${h.host}:${port}/sub`;
        if (!seen.has(url)) { seen.add(url); out.push({ url, token }); }
      }
    }
    return out;
  }

  private openSocket(url: string, token: string, attempt: number): void {
    if (this.closed) return;
    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        if (this.closed) { ws.close(); return; }
        const auth = JSON.stringify({
          uid: 0,
          roomid: Number(this.roomId),
          protover: 0,
          platform: 'web',
          type: 2,
          key: token,
        });
        ws.send(encodePacket(7, auth));
        this.handlers?.onStatus?.(true);
        this.startHeartbeat();
      };
      ws.onmessage = (event: any) => {
        try {
          for (const text of extractDanmaku(event.data)) this.handlers?.onMessage(text);
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.stopHeartbeat();
        // 当前目标失败 → 换下一个目标；全部失败 → 稍后重连
        const next = attempt + 1;
        if (!this.closed && next < this.targets.length) {
          this.openSocket(this.targets[next].url, this.targets[next].token, next);
        } else {
          this.scheduleReconnect();
        }
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(encodePacket(2, '{}')); // 心跳包需合法 JSON 文本（原传 [object Object] 会被 B站忽略/断连）
        }
      } catch {
        /* ignore */
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.fetchTargets()
        .then((targets) => {
          if (this.closed || !targets.length) return;
          this.targets = targets;
          this.openSocket(targets[0].url, targets[0].token, 0);
        })
        .catch(() => this.scheduleReconnect());
    }, 5000);
  }

  disconnect(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.handlers = null;
  }
}

export default BilibiliDanmaku;
