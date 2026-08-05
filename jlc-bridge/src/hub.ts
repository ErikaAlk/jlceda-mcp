// ⚠ 这个文件是整个扩展能不能正常工作的前提，改之前先把下面这段读完。
//
// 嘉立创EDA 运行扩展的方式（从安装目录 assets/pro-api/*/api.js 的 Ta() 逆出来的）：
// **每一次调用——启动激活、每一次点菜单——都会把整个 bundle 重新读出来、重新 eval 一遍，
// 然后才调那个函数。** 也就是说：
//
//     模块级的 let / 全局变量，在两次菜单点击之间不保留。
//
// 旧版代码是按「模块常驻」写的（`let bridgeEnabled = false` 之类），于是：
//   · 点「状态」时 bridgeEnabled 永远是 false，而存盘的开关是 true，
//     于是它去跑一遍 startPolling → 卡在 5 秒的 WebSocket 超时上 → 「状态窗口要等很久」；
//   · 点第一下 Enable/Disable 时同样读到 (false || 存盘true) = true，
//     判定「当前是开着的」于是执行关闭；点第二下才真的打开
//     ——用户报的「必须点两次」就是这么来的，不是玄学。
//
// 能跨越重新求值活下来的只有三样东西：
//   ① EDA 自己按 ID 托管的资源：sys_Timer 的定时器、sys_WebSocket 的连接、sys_Storage 的配置；
//   ② globalThis 上挂的东西（沙箱没有拦 globalThis，实测可读可写）；
//   ③ 已经跑起来的闭包（比如第一次求值时注册的 WebSocket onMessage 回调）。
//
// 所以所有跨调用的状态一律挂在 globalThis 的这个 hub 上，任何一次求值都能读到同一份。

import { PROTOCOL_VERSION } from './protocol';

/** 挂在 globalThis 上的键。带版本号，将来协议大改时不会和老版本的残留打架。 */
const HUB_KEY = '__JLC_BRIDGE_HUB_V2__';

export type LinkPhase =
  | 'idle' // 从没连过
  | 'connecting' // 已发起，还没握上
  | 'online' // 通了
  | 'offline' // 断了，正在退避重连
  | 'blocked' // 被 EDA 的权限挡住了，重试没用，得人去勾选项
  | 'paused'; // 用户主动暂停

export interface BridgeHub {
  /** 协议版本，用来发现「globalThis 上还挂着上一版扩展的 hub」 */
  readonly v: number;
  phase: LinkPhase;
  /** 用户希望桥接开着吗。这是内存里的镜像，真值存在 sys_Storage 里 */
  enabled: boolean;
  port: number;
  /** 最近一次收到对端任何数据的时间戳，判活用 */
  lastRxAt: number;
  lastTxAt: number;
  onlineSince: number;
  /**
   * 本次 connect 是什么时候发起的。
   *
   * `sys_WebSocket` 连不上时**什么回调都不给**（没有 error、没有 close，onConnected 也不会来），
   * 所以「这次连接是不是已经废了」只能靠这个时间戳超时判定。
   * 没有它的话 phase 会永远卡在 connecting，心跳再也不会重新 register —— 表现就是
   * 「先开 EDA 后开 Claude Code，必须手动点一次重连」。
   */
  connectStartedAt: number;
  /** 权限被拒后下一次可以重试的时间点。放 hub 里而不是模块变量，否则重新求值就丢 */
  blockedRetryAt: number;
  /** 最近一次失败的人话原因，直接摆在菜单和状态窗口里 */
  lastError: string;
  /** 处理过多少条命令，看得出「到底有没有在干活」 */
  commandCount: number;
  lastAction: string;
  lastActionAt: number;
  /** 菜单上一次渲染出来的状态行文字，只有变了才去调 replaceHeaderMenus */
  menuSignature: string;
  /**
   * 当前活着的那份代码的构建标识。
   * 装了新版扩展之后，旧的 WebSocket onMessage 闭包还挂在 EDA 那边，
   * 靠这个字段发现「跑着的是上一版代码」并把连接推倒重来。
   */
  codeBuild: string;
  /** 已经装过心跳定时器了吗（防止每次求值都重复装，虽然 sys_Timer 自己也按 ID 去重） */
  heartbeatArmed: boolean;
  /** 最近若干条日志，环形缓冲。EDA 里看不到 console，这是唯一的现场 */
  logs: string[];
}

function createHub(port: number): BridgeHub {
  return {
    v: PROTOCOL_VERSION,
    phase: 'idle',
    enabled: true,
    port,
    lastRxAt: 0,
    lastTxAt: 0,
    onlineSince: 0,
    connectStartedAt: 0,
    blockedRetryAt: 0,
    lastError: '',
    commandCount: 0,
    lastAction: '',
    lastActionAt: 0,
    menuSignature: '',
    codeBuild: '',
    heartbeatArmed: false,
    logs: [],
  };
}

/**
 * 拿到全局唯一的 hub。第一次调用时创建。
 *
 * 沙箱里 globalThis 是可达的：EDA 的 with(sandbox) 代理只在 `key in sandbox` 时才接管，
 * 而 sandbox 对象上没有 globalThis 这个键，所以标识符会一路解析到真正的全局对象。
 * 万一哪天 EDA 把它也堵上，退回模块级变量——那时行为退化成旧版（每次调用状态重置），
 * 但不会抛异常把整个扩展打死。
 */
export function getHub(defaultPort = 18800): BridgeHub {
  const g = globalScope();
  if (!g) {
    fallbackHub = fallbackHub ?? createHub(defaultPort);
    return fallbackHub;
  }
  const existing = (g as any)[HUB_KEY];
  if (existing && existing.v === PROTOCOL_VERSION) return existing as BridgeHub;

  const fresh = createHub(defaultPort);
  (g as any)[HUB_KEY] = fresh;
  return fresh;
}

let fallbackHub: BridgeHub | undefined;

function globalScope(): object | undefined {
  try {
    if (typeof globalThis === 'object' && globalThis) return globalThis;
  } catch {
    /* 被沙箱堵了 */
  }
  return undefined;
}

const MAX_LOGS = 200;

export function hubLog(message: string): void {
  const hub = getHub();
  const stamp = new Date().toISOString().slice(11, 23);
  hub.logs.push(`${stamp} ${message}`);
  if (hub.logs.length > MAX_LOGS) hub.logs.splice(0, hub.logs.length - MAX_LOGS);
  try {
    console.log(`[JLC MCP] ${message}`);
  } catch {
    /* ignore */
  }
}

/** hub 是否认为链路当前可用 */
export function isOnline(hub: BridgeHub): boolean {
  return hub.phase === 'online';
}
