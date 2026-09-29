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
/**
 * 发起连接后多久还没通就认定这次废了、推倒重来。
 *
 * 这是「先开 EDA、后开 Claude Code 能不能自动接上」的关键：`sys_WebSocket` 连不上时
 * 一个回调都不给，不设这个超时的话 phase 会永远停在 connecting，心跳再也不会重新
 * register，只能人去点「立即重连」。
 *
 * 取 1.8 秒是因为对端就在 127.0.0.1，正常握手是几十毫秒的事，1.8 秒已经是 20 倍余量；
 * 判早了的代价也只是多 register 一次（很便宜）。配合 2 秒的心跳 ⇒ 每 2 秒重试一次。
 */
const CONNECT_TIMEOUT_MS = 1_800;
/** 权限被拒之后不要每 2 秒重试一次刷屏，退避到这个间隔 */
const BLOCKED_RETRY_MS = 30_000;
/**
 * 连上之后，隔这么久没发过东西就主动 ping 一下。
 * 作用是**尽早发现对端已经没了**：Claude Code 退出时扩展这边收不到任何通知，
 * 只有往一个已关闭的 socket 上 send 才会抛错。没有它就得干等 RX_TIMEOUT_MS（11 秒）。
 */
const KEEPALIVE_MS = 4_000;

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

  // 重新导入扩展之后，hub 里的链路状态是上一版代码留下的：EDA 卸载旧扩展时已经关掉了它的连接，
  // phase 却还停在 online。发现构建标识变了就把连接推倒重来，由新代码重新 register。
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

  advance(hub);
}

/**
 * 把链路往前推一步。心跳每拍调一次，每个入口（激活 / 点菜单）也调一次。
 * **幂等**：已经连着时它什么也不做。
 *
 * 所有「该不该重连」的判断只在这里，别散到别处去 —— 上一版就是因为
 * 重连判断散在 tick 里、而 tick 对 connecting 状态没有出口，导致连不上时永远卡住。
 */
function advance(hub: BridgeHub): void {
  const now = Date.now();

  // ⓪ 先归一：'paused' 只是 hub.enabled 的投影，两者不许打架。
  //    少了这一步的话，enabled 一旦被别处改回 true，phase 会永远卡在 'paused'
  //    （switch 里没有它的分支，落到 default 直接返回）——
  //    表现就是菜单状态行写「已暂停」、动作项却是「暂停桥接」，自相矛盾且点不动。
  if (!hub.enabled) {
    hub.phase = 'paused';
    return;
  }
  if (hub.phase === 'paused') {
    hub.phase = 'offline'; // 已经恢复了，让下面的分支去重连
  }

  // ① 连着但太久没收到数据 ⇒ 判死
  if (hub.phase === 'online' && now - hub.lastRxAt > RX_TIMEOUT_MS) {
    hubLog(`${RX_TIMEOUT_MS}ms 没收到 broker 的心跳，判定断线`);
    hardReset(hub);
  }

  // ② 发起了但迟迟不通 ⇒ 这次废了，推倒重来（见 CONNECT_TIMEOUT_MS 的注释）
  if (hub.phase === 'connecting' && now - hub.connectStartedAt > CONNECT_TIMEOUT_MS) {
    hardReset(hub);
  }

  switch (hub.phase) {
    case 'idle':
    case 'offline':
      connect(hub);
      return;

    case 'blocked':
      // 人可能刚去把权限勾上了，隔一阵试一次
      if (now >= hub.blockedRetryAt) connect(hub);
      return;

    case 'connecting':
      // register 复用已有连接时会立刻回调 onConnected，握手可能还没完成，补发一次 hello
      onConnected();
      return;

    case 'online':
      // 主动 ping，好尽早发现对端已经没了（往关闭的 socket 上 send 会抛）
      if (now - hub.lastTxAt > KEEPALIVE_MS) {
        sendFrame({ v: PROTOCOL_VERSION, t: 'ping', ts: now });
      }
      return;

    default:
      return;
  }
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
  // 心跳在这里就停掉，别拖到下一拍 tick 里 —— 状态迁移要一次做完，
  // 中间那 2 秒里 hub 处在「已暂停但心跳还在跑」的中间态，很容易出怪事。
  clearInterval_(HEARTBEAT_ID);
  hub.heartbeatArmed = false;
  hubLog('用户暂停了桥接');
}

export function resume(): void {
  const hub = getHub();
  hub.enabled = true;
  hub.lastError = '';
  hub.blockedRetryAt = 0;
  armHeartbeat(); // 暂停时把心跳停掉了，恢复要重新装上
  connect(hub);
  hubLog('用户恢复了桥接');
}

function hardReset(hub: BridgeHub): void {
  wsClose(WS_ID);
  hub.phase = 'offline';
  hub.onlineSince = 0;
  hub.lastRxAt = 0;
  hub.connectStartedAt = 0;
}

function connect(hub: BridgeHub): void {
  hub.phase = 'connecting';
  hub.connectStartedAt = Date.now();
  const url = wsUrlFor(hub.port);
  try {
    wsRegister(WS_ID, url, onMessage, onConnected);
    // 注意：走到这里**不代表连上了**。对端不在时 WebSocket 构造照样成功，
    // 失败是异步的而且没有任何回调。真正的判据在 advance() 的超时那一支。
  } catch (err) {
    if (isPermissionError(err)) {
      hub.phase = 'blocked';
      hub.lastError = PERMISSION_HINT;
      hub.blockedRetryAt = Date.now() + BLOCKED_RETRY_MS;
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
 * 心跳 —— 整个自愈机制的发动机。它是唯一能让「先开 EDA、后开 Claude Code」
 * 自动接上的东西：每 2 秒把链路往前推一步，直到通为止，全程不需要人操作。
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

  advance(hub);
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
