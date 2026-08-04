// mcp-server 这一侧的链路。取代旧的 bridge-client.ts。
//
// 和旧版的三个区别：
//  1. 会自己去当 broker（抢 18800）。抢不到说明别的 Claude Code 会话已经在当了，
//     那就退化成纯客户端；对方退出后再把端口抢回来。旧版指望用户手动双击 gateway.bat，
//     没人双击 = 整条链路死掉，这次故障就是这么来的。
//  2. connect() 有单飞行去重。旧版每条并发命令都各自 new 一个 WebSocket。
//  3. 连不上时报的是「怎么修」，不是 ECONNREFUSED。

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { startBroker, type BrokerHandle } from './broker.js';
import {
  PROTOCOL_VERSION,
  parseMessage,
  resolvePort,
  wsUrl,
  type EdaPeerInfo,
} from './protocol.js';

const COMMAND_TIMEOUT_MS = 60_000;
const RECONNECT_DELAY_MS = 1_500;
/** 当 broker 的那个会话退出后，多久尝试一次接管 */
const ELECTION_RETRY_MS = 5_000;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
}

export interface LinkStatus {
  brokerRole: 'owner' | 'client';
  port: number;
  socketConnected: boolean;
  eda: EdaPeerInfo | null;
  pendingCommands: number;
}

export class BridgeLink {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private broker: BrokerHandle | null = null;
  private edaInfo: EdaPeerInfo | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private electionTimer: NodeJS.Timeout | null = null;
  private readonly port = resolvePort();

  constructor(private readonly log: (msg: string) => void = () => {}) {}

  /** 后台开始建链。不 await —— MCP 工具第一次被调用时会自然等它。 */
  start(): void {
    void this.ensureConnected().catch(() => {
      /* 连不上就连不上，命令真发出去时会带着人话报错 */
    });
  }

  status(): LinkStatus {
    return {
      brokerRole: this.broker ? 'owner' : 'client',
      port: this.port,
      socketConnected: this.ws?.readyState === WebSocket.OPEN,
      eda: this.edaInfo,
      pendingCommands: this.pending.size,
    };
  }

  async command(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureConnected();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(describeDeadLink(this.port));
    }

    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `命令 '${action}' 等了 ${COMMAND_TIMEOUT_MS / 1000} 秒没有结果。` +
              `EDA 那边可能正卡在一个大操作上，或者扩展中途断开了。`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, action });
      try {
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'cmd', id, action, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.electionTimer) clearInterval(this.electionTimer);
    this.ws?.close();
    this.ws = null;
    await this.broker?.close();
    this.broker = null;
  }

  // ─── 内部 ───

  private ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (this.closed) throw new Error('link 已关闭');
    await this.electBroker();
    await this.openSocket();
  }

  /**
   * 竞选 broker：抢得到端口就自己当，抢不到就当客户端。
   * EADDRINUSE 是正常分支，不是错误。
   */
  private async electBroker(): Promise<void> {
    if (this.broker) return;
    try {
      this.broker = await startBroker({ port: this.port, log: this.log });
      this.log('本进程当选 broker');
      if (this.electionTimer) {
        clearInterval(this.electionTimer);
        this.electionTimer = null;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
      this.log(`端口 ${this.port} 已有 broker，本进程走客户端模式`);
      this.scheduleElection();
    }
  }

  /** 当 broker 的那个进程退出后，端口会空出来，定期回来接管。 */
  private scheduleElection(): void {
    if (this.electionTimer || this.closed) return;
    this.electionTimer = setInterval(() => {
      if (this.closed || this.broker) return;
      void this.electBroker().catch(() => {
        /* 还占着就继续等 */
      });
    }, ELECTION_RETRY_MS);
    this.electionTimer.unref?.();
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(this.port));
      let settled = false;

      ws.on('open', () => {
        settled = true;
        this.ws = ws;
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            t: 'hello',
            role: 'mcp',
            name: 'jlceda-mcp',
            pid: process.pid,
          }),
        );
        resolve();
      });

      ws.on('message', (raw: Buffer | string) => this.handleMessage(raw.toString()));

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(describeDeadLink(this.port, err.message)));
        }
      });

      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        this.edaInfo = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`命令 '${p.action}' 执行途中与 broker 的连接断开了。`));
          this.pending.delete(id);
        }
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch(() => this.scheduleReconnect());
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  private handleMessage(raw: string): void {
    const msg = parseMessage(raw);
    if (!msg) return;

    if (msg.t === 'state') {
      this.edaInfo = msg.eda;
      return;
    }

    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || `命令 '${p.action}' 失败，但 EDA 没说原因。`));
    }
  }
}

function describeDeadLink(port: number, detail?: string): string {
  return [
    `连不上桥接服务（127.0.0.1:${port}）。`,
    detail ? `底层错误：${detail}` : '',
    '正常情况下 broker 就跑在这个 mcp-server 里，不需要单独启动任何东西。',
    `如果这里报连不上，多半是别的程序占了 ${port} 端口 —— 换个端口：设环境变量 JLC_BRIDGE_PORT。`,
  ]
    .filter(Boolean)
    .join('\n');
}
