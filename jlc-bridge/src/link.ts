// 和 broker 之间的链路。
//
// 设计前提见 hub.ts：每次菜单点击都会重新求值整个 bundle，所以这里的每个入口
// **都必须是幂等的**——`ensureLink()` 可以被调一百次，已经连上时它什么也不做。
//
// EDA 的 sys_WebSocket 有两个坑，写在这里免得下次又踩：
//
//   1. 它只有 onMessage / onConnected 两个回调，**没有 onclose、没有 onerror**。
//      对端死掉时扩展这边毫无感知。所以判活只能靠「最近一次收到数据的时间」，
//      broker 每 3 秒 ping 一次就是为了喂这个判据。
//
//   2. register() 遇到同 ID 且 readyState 是 CONNECTING 或 OPEN 的连接时，会
//      **立刻同步调用 onConnected 然后返回**——注意 CONNECTING 也算。所以
//      「onConnected 被调了」不等于「连上了」。真正的判据是收到过对端的数据，
//      所以 phase 从 connecting 翻到 online 是在收到第一帧的时候，不是在 onConnected 里。

import {
  PROTOCOL_VERSION,
  wsUrlFor,
  type CommandFrame,
} from './protocol';
import {
  errText,
  isPermissionError,
  setInterval_,
  clearInterval_,
  wsClose,
  wsRegister,
  wsSend,
  edaVersion,
} from './eda';
import { getHub, hubLog, type BridgeHub } from './hub';
import { execute } from './registry';
import { APP_NAME, APP_VERSION, CODE_BUILD } from './config';

/** sys_WebSocket 的连接 ID。固定值，靠它做跨求值的去重。 */
const WS_ID = 'jlc_bridge_link';
/** sys_Timer 的心跳 ID。同 ID 重复注册会替换旧的，正好。 */
const HEARTBEAT_ID = 'jlc_bridge_heartbeat';

const HEARTBEAT_MS = 2_000;
/** 超过这么久没收到 broker 的任何数据（它每 3 秒 ping 一次）就判死重连 */
const RX_TIMEOUT_MS = 11_000;
/** 权限被拒之后不要每 2 秒重试一次刷屏，退避到这个间隔 */
const BLOCKED_RETRY_MS = 30_000;

let lastBlockedAttempt = 0;

export const PERMISSION_HINT =
  '扩展的「外部交互」权限没开。\n' +
  '打开方式：顶部菜单 高级 → 扩展 → 扩展管理器 → 找到 JLC MCP → 勾上「外部交互」。\n' +
  '这个权限是 嘉立创EDA 用来管控扩展联网的，没有它扩展连不出去，重试多少次都没用。';

/**
 * 确保链路在跑。可以随便调——已经连着时立即返回。
 * 每次扩展被求值（激活 / 点菜单）都会走一遍这里，这就是「自动连上」的实现。
 */
export function ensureLink(): void {
  const hub = getHub();

  // 装过新版扩展之后，还活着的是上一版代码的 onMessage 闭包。
  // 发现代码版本变了就把连接推倒重来，让新代码接管消息处理。
  if (hub.codeBuild && hub.codeBuild !== CODE_BUILD) {
    hubLog(`检测到扩展代码已更新（${hub.codeBuild} → ${CODE_BUILD}），重建连接`);
    hardReset(hub);
  }
  hub.codeBuild = CODE_BUILD;

  armHeartbeat();

  if (!hub.enabled) {
    hub.phase = 'paused';
    return;
  }

  if (hub.phase === 'online' || hub.phase === 'connecting') return;

  if (hub.phase === 'blocked' && Date.now() - lastBlockedAttempt < BLOCKED_RETRY_MS) return;

  connect(hub);
}

/** 用户点「重新连接」时用：先彻底放掉再连，不吃 register 的复用分支。 */
export function reconnect(): void {
  const hub = getHub();
  hardReset(hub);
  hub.enabled = true;
  connect(hub);
}

export function pause(): void {
  const hub = getHub();
  hub.enabled = false;
  hardReset(hub);
  hub.phase = 'paused';
  hubLog('用户暂停了桥接');
}

export function resume(): void {
  const hub = getHub();
  hub.enabled = true;
  hub.lastError = '';
  connect(hub);
  hubLog('用户恢复了桥接');
}

function hardReset(hub: BridgeHub): void {
  wsClose(WS_ID);
  hub.phase = 'offline';
  hub.onlineSince = 0;
  hub.lastRxAt = 0;
}

function connect(hub: BridgeHub): void {
  hub.phase = 'connecting';
  const url = wsUrlFor(hub.port);
  try {
    wsRegister(WS_ID, url, onMessage, onConnected);
    hubLog(`已发起连接 ${url}`);
  } catch (err) {
    if (isPermissionError(err)) {
      hub.phase = 'blocked';
      hub.lastError = PERMISSION_HINT;
      lastBlockedAttempt = Date.now();
      hubLog('连接被拒：外部交互权限未开启');
      return;
    }
    hub.phase = 'offline';
    hub.lastError = errText(err);
    hubLog(`连接失败：${hub.lastError}`);
  }
}

function onConnected(): void {
  // 注意：CONNECTING 状态下这个回调也会被调（见文件头第 2 条），
  // 所以这里只发 hello，不敢直接判定 online。发不出去说明还没握上，下一拍心跳再试。
  const hub = getHub();
  const sent = sendFrame({
    v: PROTOCOL_VERSION,
    t: 'hello',
    role: 'eda',
    name: APP_NAME,
    version: APP_VERSION,
    edaVersion: edaVersion(),
  });
  if (sent) hubLog('已发出 hello，等待 broker 应答');
}

function onMessage(ev: MessageEvent<any>): void {
  const hub = getHub();
  hub.lastRxAt = Date.now();

  // 收到对端数据 = 链路真的通了。这是唯一可信的判据。
  if (hub.phase !== 'online') {
    hub.phase = 'online';
    hub.onlineSince = Date.now();
    hub.lastError = '';
    hubLog('链路已连通');
  }

  const raw = typeof ev?.data === 'string' ? ev.data : '';
  if (!raw) return;

  let frame: any;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }

  if (frame?.t === 'ping') {
    sendFrame({ v: PROTOCOL_VERSION, t: 'pong', ts: Date.now() });
    return;
  }

  if (frame?.t === 'cmd') {
    void runCommand(frame as CommandFrame);
  }
}

async function runCommand(frame: CommandFrame): Promise<void> {
  const hub = getHub();
  const started = Date.now();
  hub.commandCount += 1;
  hub.lastAction = frame.action;
  hub.lastActionAt = started;

  try {
    const data = await execute(frame.action, frame.params || {});
    sendFrame({
      v: PROTOCOL_VERSION,
      t: 'res',
      id: frame.id,
      ok: true,
      data,
      ms: Date.now() - started,
    });
  } catch (err) {
    const message = errText(err);
    hubLog(`命令 ${frame.action} 失败：${message}`);
    sendFrame({
      v: PROTOCOL_VERSION,
      t: 'res',
      id: frame.id,
      ok: false,
      error: message,
      ms: Date.now() - started,
    });
  }
}

function sendFrame(frame: unknown): boolean {
  const hub = getHub();
  try {
    wsSend(WS_ID, JSON.stringify(frame));
    hub.lastTxAt = Date.now();
    return true;
  } catch (err) {
    if (isPermissionError(err)) {
      hub.phase = 'blocked';
      hub.lastError = PERMISSION_HINT;
      return false;
    }
    // 最常见的是「还没握上手就发」——不是错误，下一拍再试
    if (hub.phase === 'online') {
      hub.phase = 'offline';
      hub.lastError = errText(err);
      hubLog(`发送失败，判定链路已断：${hub.lastError}`);
    }
    return false;
  }
}

/**
 * 心跳。它同时干三件事，是整个自愈机制的发动机：
 *   ① 没连上就去连（这样 Claude Code 后起动也能自动接上）
 *   ② 连上了但太久没收到数据就判死重连（sys_WebSocket 不给 close 回调，只能这么判）
 *   ③ 状态变了就刷新菜单上的状态行
 */
function armHeartbeat(): void {
  const ok = setInterval_(HEARTBEAT_ID, HEARTBEAT_MS, tick);
  const hub = getHub();
  hub.heartbeatArmed = ok;
  if (!ok) hubLog('警告：sys_Timer 装不上心跳定时器，链路将不会自动重连');
}

function tick(): void {
  const hub = getHub();

  if (!hub.enabled) {
    hub.phase = 'paused';
    clearInterval_(HEARTBEAT_ID);
    hub.heartbeatArmed = false;
    refreshMenuIfChanged();
    return;
  }

  const now = Date.now();
  if (hub.phase === 'online' && now - hub.lastRxAt > RX_TIMEOUT_MS) {
    hubLog(`${RX_TIMEOUT_MS}ms 没收到 broker 的心跳，判定断线`);
    hardReset(hub);
  }

  if (hub.phase === 'offline' || hub.phase === 'idle') {
    connect(hub);
  } else if (hub.phase === 'blocked' && now - lastBlockedAttempt >= BLOCKED_RETRY_MS) {
    // 用户可能刚去把权限勾上了，隔一会儿试一次
    connect(hub);
  } else if (hub.phase === 'connecting') {
    // register 的复用分支会立刻回调 onConnected，握手可能还没完成，再推一次 hello
    onConnected();
  }

  refreshMenuIfChanged();
}

/** 由 index.ts 注入，避免 link ↔ menu 循环依赖 */
let menuRefresher: (() => void) | undefined;

export function setMenuRefresher(fn: () => void): void {
  menuRefresher = fn;
}

function refreshMenuIfChanged(): void {
  try {
    menuRefresher?.();
  } catch {
    /* 菜单刷不动不该影响链路 */
  }
}
