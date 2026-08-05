// broker —— 撮合 mcp-server 和 嘉立创EDA 扩展的中枢。
//
// 为什么内嵌在 mcp-server 里：
//   旧版把它做成一个要手动双击的 gateway.bat。人不双击（或者重启电脑之后忘了），
//   18800 上就没人监听，扩展连不上、MCP 也连不上，表现是「整个 MCP 坏了」。
//   实测用户这次报障时 18800 上确实一个监听都没有。
//
// 一台机器只需要一个 broker，谁先起来谁当。抢不到端口的那个退化成纯客户端
// （见 link.ts 的竞选逻辑），所以开几个 Claude Code 会话都不会打架。

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import {
  PING_INTERVAL_MS,
  PEER_TIMEOUT_MS,
  PROTOCOL_VERSION,
  WS_PATH,
  parseMessage,
  type EdaPeerInfo,
} from './protocol.js';

export interface BrokerOptions {
  port: number;
  /** 日志出口。mcp-server 内嵌时必须走 stderr —— stdout 是 MCP 的协议通道，写进去会污染。 */
  log?: (message: string) => void;
  /**
   * 允许接入的网页来源。EDA 扩展跑在渲染进程里，会带 Origin 头。
   * 默认只放行非 http(s) 的来源（file://、null 等）以及这里显式列出的，
   * 免得随便一个网页都能连上来改用户的 PCB。
   */
  allowedOrigins?: string[];
}

interface Peer {
  ws: WebSocket;
  role: 'eda' | 'mcp' | 'unknown';
  info?: EdaPeerInfo;
  lastSeen: number;
}

export interface BrokerHandle {
  port: number;
  close(): Promise<void>;
  /** 当前是否有 EDA 扩展接入 */
  edaInfo(): EdaPeerInfo | null;
}

/**
 * 嘉立创EDA 客户端的渲染进程实际是从 pro.lceda.cn 载入的（离线包则是 app:// 或 file://），
 * 所以它带的 Origin 是个 https 来源，不放进白名单会被下面的网页拦截规则误伤。
 * 这几个是从安装目录的 app.js 里查出来的，不是猜的。
 */
const EDA_ORIGINS = [
  'https://pro.lceda.cn',
  'https://lceda.cn',
  'https://pro.easyeda.com',
  'https://easyeda.com',
];

const DEFAULT_ALLOWED_ORIGINS = [
  ...EDA_ORIGINS,
  ...(process.env.JLC_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

/**
 * 起一个 broker。端口被占用时 reject（错误码 EADDRINUSE），调用方据此判断
 * 「已经有人在当 broker 了」并退化成客户端。
 */
export function startBroker(options: BrokerOptions): Promise<BrokerHandle> {
  const log = options.log ?? (() => {});
  const allowedOrigins = new Set([...(options.allowedOrigins ?? []), ...DEFAULT_ALLOWED_ORIGINS]);

  return new Promise<BrokerHandle>((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: options.port,
      path: WS_PATH,
      verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) => {
        const ok = isOriginAllowed(origin, allowedOrigins);
        if (!ok) {
          log(
            `拒绝了一个来自网页的连接：origin=${origin}。` +
              `如果这其实是嘉立创EDA，把它加进环境变量 JLC_ALLOWED_ORIGINS 即可。` +
              `(url=${req.url})`,
          );
        }
        return ok;
      },
    });

    const peers = new Set<Peer>();
    /** 命令 id → 发起命令的 mcp 端。结果只回给发起者，不广播。 */
    const pending = new Map<string, Peer>();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let settled = false;

    const edaPeers = () => [...peers].filter((p) => p.role === 'eda');
    const mcpPeers = () => [...peers].filter((p) => p.role === 'mcp');

    const send = (peer: Peer, payload: unknown) => {
      if (peer.ws.readyState !== WebSocket.OPEN) return;
      try {
        peer.ws.send(JSON.stringify(payload));
      } catch {
        /* 对端正在断开，忽略 */
      }
    };

    const broadcastState = () => {
      const eda = edaPeers()[0]?.info ?? null;
      for (const peer of mcpPeers()) {
        send(peer, { v: PROTOCOL_VERSION, t: 'state', eda });
      }
    };

    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      log(`broker 出错：${err.message}`);
    });

    wss.on('listening', () => {
      settled = true;
      log(`broker 已监听 127.0.0.1:${options.port}${WS_PATH}`);

      heartbeat = setInterval(() => {
        const now = Date.now();
        for (const peer of peers) {
          // 只对 EDA 端做存活探测。EDA 的 sys_WebSocket 没有 close/error 回调，
          // 半死连接只能靠这个心跳发现；mcp 端是 node，socket 断了立刻有 close 事件。
          if (peer.role !== 'eda') continue;
          if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
            log(`EDA 端 ${peer.info?.name ?? '?'} 超过 ${PEER_TIMEOUT_MS}ms 没有响应，断开。`);
            try {
              peer.ws.terminate();
            } catch {
              /* ignore */
            }
            continue;
          }
          send(peer, { v: PROTOCOL_VERSION, t: 'ping', ts: now });
        }
      }, PING_INTERVAL_MS);
      // 心跳不该拖住进程退出
      heartbeat.unref?.();

      resolve({
        port: options.port,
        edaInfo: () => edaPeers()[0]?.info ?? null,
        close: () =>
          new Promise<void>((done) => {
            if (heartbeat) clearInterval(heartbeat);
            for (const peer of peers) {
              try {
                peer.ws.close(1001, 'broker shutting down');
              } catch {
                /* ignore */
              }
            }
            wss.close(() => done());
          }),
      });
    });

    wss.on('connection', (ws: WebSocket) => {
      const peer: Peer = { ws, role: 'unknown', lastSeen: Date.now() };
      peers.add(peer);

      ws.on('message', (raw: Buffer | string) => {
        peer.lastSeen = Date.now();
        const msg = parseMessage(raw.toString());
        if (!msg) return;

        switch (msg.t) {
          case 'hello': {
            peer.role = msg.role === 'eda' ? 'eda' : 'mcp';
            if (peer.role === 'eda') {
              peer.info = {
                name: String(msg.name ?? 'jlc-bridge'),
                version: String(msg.version ?? '?'),
                edaVersion: msg.edaVersion ? String(msg.edaVersion) : undefined,
                since: Date.now(),
              };
              log(`✓ 嘉立创EDA 扩展接入：${peer.info.name} v${peer.info.version}`);
              // 立刻回一帧。扩展那边判「真的连上了」的依据是**收到过对端数据**
              // （sys_WebSocket 不给 open/close 回调，只能这么判），不马上回的话
              // 它要等到下一次心跳 ping 才翻成「已连接」，白白慢 3 秒。
              send(peer, { v: PROTOCOL_VERSION, t: 'ping', ts: Date.now() });
              if (msg.v !== PROTOCOL_VERSION) {
                log(
                  `⚠ 扩展的协议版本是 v${msg.v}，broker 是 v${PROTOCOL_VERSION}。` +
                    `八成是扩展没更新，去 EDA 里重装一次 .eext。`,
                );
              }
            } else {
              log(`✓ mcp-server 接入（pid=${msg.pid ?? '?'}）`);
            }
            broadcastState();
            return;
          }

          case 'cmd': {
            peer.role = 'mcp';
            const eda = edaPeers()[0];
            if (!eda) {
              send(peer, {
                v: PROTOCOL_VERSION,
                t: 'res',
                id: msg.id,
                ok: false,
                error:
                  '嘉立创EDA 没有接进来。请确认：① EDA 已打开；' +
                  '② 顶部菜单「JLC MCP」第一行显示的是「已连接」；' +
                  '③ 扩展的「外部交互」权限已勾上（扩展管理器里）。',
              });
              return;
            }
            pending.set(msg.id, peer);
            send(eda, { v: PROTOCOL_VERSION, t: 'cmd', id: msg.id, action: msg.action, params: msg.params ?? {} });
            return;
          }

          case 'res': {
            const origin = pending.get(msg.id);
            pending.delete(msg.id);
            if (origin) send(origin, msg);
            return;
          }

          case 'evt': {
            for (const p of mcpPeers()) send(p, msg);
            return;
          }

          case 'pong':
            return;

          case 'ping':
            send(peer, { v: PROTOCOL_VERSION, t: 'pong', ts: Date.now() });
            return;

          default:
            return;
        }
      });

      ws.on('close', () => {
        peers.delete(peer);
        if (peer.role === 'eda') {
          log(`嘉立创EDA 扩展断开（${peer.info?.name ?? '?'}）`);
          // 这个 EDA 端上还没回结果的命令，立刻失败掉，别让 mcp 端干等到超时。
          for (const [id, origin] of pending) {
            send(origin, {
              v: PROTOCOL_VERSION,
              t: 'res',
              id,
              ok: false,
              error: '命令执行途中 嘉立创EDA 断开了连接。',
            });
            pending.delete(id);
          }
          broadcastState();
        } else if (peer.role === 'mcp') {
          for (const [id, origin] of pending) {
            if (origin === peer) pending.delete(id);
          }
        }
      });

      ws.on('error', () => {
        /* close 事件里统一收尾 */
      });
    });
  });
}

function isOriginAllowed(origin: string | undefined, allowlist: Set<string>): boolean {
  // node 的 ws 客户端不带 Origin —— mcp-server 走这条路。
  if (!origin) return true;
  if (allowlist.has(origin)) return true;
  // 网页（http/https）默认挡掉：任意站点都能连本机 WebSocket，不挡的话
  // 一个恶意页面就能改用户的板子。EDA 客户端是 Electron，来源不是 http(s)。
  return !/^https?:\/\//i.test(origin);
}
