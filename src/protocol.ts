// 桥接协议（v2）—— 两端共用的唯一真源。
//
// 链路只有两段：
//   Claude Code ⇄ mcp-server[内嵌 broker] ⇄ 嘉立创EDA 的 jlc-bridge 扩展
//
// 旧版是三段（多一个要手动双击的 gateway.bat），中枢没人启动就整条链路死掉，
// 这是这个项目最主要的故障源。现在 broker 长在 mcp-server 里，Claude Code 一起就有。
//
// 改这个文件必须同步改扩展侧的 jlc-bridge/src/protocol.ts —— 那份是逐字拷贝，
// 因为扩展跑在 EDA 的沙箱里，没法 import 这个包。

/** broker 默认监听端口。可用环境变量 JLC_BRIDGE_PORT 覆盖，两端都认。 */
export const DEFAULT_PORT = 18800;

/** WebSocket 路径。历史遗留，别改，改了旧扩展就连不上。 */
export const WS_PATH = '/ws/bridge';

/** 协议版本。两端 hello 里带，对不上时 broker 会明确报出来而不是静默乱跑。 */
export const PROTOCOL_VERSION = 2;

/** broker 给 EDA 端发心跳的间隔。 */
export const PING_INTERVAL_MS = 3_000;

/** 超过这个时间没收到 EDA 端任何消息就判定链路已死并断开重连。 */
export const PEER_TIMEOUT_MS = 12_000;

export type Role = 'eda' | 'mcp';

export interface HelloMessage {
  v: number;
  t: 'hello';
  role: Role;
  name?: string;
  version?: string;
  /** EDA 端带上，方便排查版本相关的坑 */
  edaVersion?: string;
  pid?: number;
}

export interface CommandMessage {
  v: number;
  t: 'cmd';
  id: string;
  action: string;
  params: Record<string, unknown>;
}

export interface ResultMessage {
  v: number;
  t: 'res';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  ms?: number;
}

export interface PingMessage {
  v: number;
  t: 'ping';
  ts: number;
}

export interface PongMessage {
  v: number;
  t: 'pong';
  ts: number;
}

export interface EventMessage {
  v: number;
  t: 'evt';
  event: string;
  data?: Record<string, unknown>;
}

/** broker 主动推给 mcp 端的链路状态，连上/断开时各推一次。 */
export interface StateMessage {
  v: number;
  t: 'state';
  eda: EdaPeerInfo | null;
}

export interface EdaPeerInfo {
  name: string;
  version: string;
  edaVersion?: string;
  since: number;
}

export type BridgeMessage =
  | HelloMessage
  | CommandMessage
  | ResultMessage
  | PingMessage
  | PongMessage
  | EventMessage
  | StateMessage;

export function wsUrl(port: number = resolvePort()): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

export function resolvePort(): number {
  const explicit = Number(process.env.JLC_BRIDGE_PORT);
  if (Number.isFinite(explicit) && explicit > 0 && explicit < 65536) return Math.floor(explicit);

  // 兼容旧配置：v0.1 的 ~/.claude.json 里写的是完整 URL（GATEWAY_WS_URL），
  // 只认新变量的话，改过端口的人会被静默退回 18800 —— 又是一个不报错但结果是错的坑。
  const legacy = process.env.GATEWAY_WS_URL;
  if (legacy) {
    const port = Number(legacy.match(/:(\d+)/)?.[1]);
    if (Number.isFinite(port) && port > 0 && port < 65536) return Math.floor(port);
  }

  return DEFAULT_PORT;
}

/** 解析一帧。坏帧返回 undefined —— 调用方一律忽略，不要因为一帧坏了就断连接。 */
export function parseMessage(raw: string): BridgeMessage | undefined {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return undefined;
    return msg as BridgeMessage;
  } catch {
    return undefined;
  }
}
