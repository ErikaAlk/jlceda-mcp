// 桥接协议（v2）—— 和 mcp-server 侧的 src/protocol.ts 是同一份，逐字对齐。
//
// 为什么要抄两份：扩展跑在 嘉立创EDA 的沙箱里，被 esbuild 打成一个自包含的 IIFE，
// 没法 import 服务端那个包。改一边必须改另一边，两边的 PROTOCOL_VERSION 对不上时
// broker 会在日志里明说，不会静默乱跑。

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 18800;
export const WS_PATH = '/ws/bridge';

export interface CommandFrame {
  v: number;
  t: 'cmd';
  id: string;
  action: string;
  params: Record<string, any>;
}

export interface ResultFrame {
  v: number;
  t: 'res';
  id: string;
  ok: boolean;
  data?: any;
  error?: string;
  ms?: number;
}

export type AnyFrame =
  | CommandFrame
  | ResultFrame
  | { v: number; t: 'hello'; role: 'eda'; name: string; version: string; edaVersion?: string }
  | { v: number; t: 'ping'; ts: number }
  | { v: number; t: 'pong'; ts: number }
  | { v: number; t: 'evt'; event: string; data?: Record<string, any> };

export function wsUrlFor(port: number): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}
