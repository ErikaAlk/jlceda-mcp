// 扩展本体的回归测试。跑的是 jlc-bridge/dist/index.js 这个真实打包产物，
// 装进 tests/eda-sandbox.mjs 复刻出来的 EDA 沙箱里。
//
// 这里每一条断言都对应用户报过的一个症状，别随手删。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createEdaRuntime, createEdaMock } from './eda-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, '..', 'jlc-bridge', 'dist', 'index.js');

const skip = existsSync(BUNDLE)
  ? false
  : '扩展还没打包，先跑 npm run build:ext';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每个用例创建的假 EDA，afterEach 里统一收摊（心跳是真的 setInterval，见 dispose 的注释） */
const live = [];

function boot(options) {
  const { eda, state, dispose } = createEdaMock(options);
  live.push(dispose);
  return { runtime: createEdaRuntime(BUNDLE, eda), state };
}

test('激活后立刻自己连出去，不需要人去点任何开关', { skip }, async () => {
  const { runtime, state } = boot();
  await runtime.call('activate', 'onStartupFinished');

  assert.equal(state.ws.registered.length, 1, '应该注册了一个 WebSocket');
  assert.match(state.ws.registered[0].url, /^ws:\/\/127\.0\.0\.1:18800\/ws\/bridge$/);
  assert.ok(state.intervals.size >= 1, '应该装了心跳定时器');
  assert.ok(state.menus, '应该注册了菜单');
});

test('装完默认就是开的 —— 存储里没有任何配置也一样', { skip }, async () => {
  const { runtime, state } = boot({ config: {} });
  await runtime.call('activate', 'onStartupFinished');
  assert.equal(state.ws.registered.length, 1);
});

test('状态窗口必须秒开，绝不能卡在建链上', { skip }, async () => {
  // 这条钉的是用户报的「点击状态之后要等很久才出现窗口」。
  // 根因是旧版 showStatus 会去跑一遍 startPolling，里面有个 5 秒的 WebSocket 超时。
  const { runtime, state } = boot({ autoConnect: false });
  const started = Date.now();
  await runtime.call('showStatus');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `状态窗口用了 ${elapsed}ms，太慢了`);
  assert.equal(state.dialogs.length, 1);
  assert.match(state.dialogs[0].title, /状态/);
});

test('暂停/恢复各只需要点一次', { skip }, async () => {
  // 钉「必须手动点一次 enable/disable 之后再点一次才能正常打开」。
  // 旧版之所以要点两次：每次点击都是全新求值，内存里的 bridgeEnabled 恒为 false，
  // 而存盘值是 true，于是第一下被判成「关闭」。
  const { runtime, state } = boot();
  await runtime.call('activate', 'onStartupFinished');

  await runtime.call('togglePause');
  assert.equal(state.config.bridgeEnabled, false, '点一次就应该暂停');

  await runtime.call('togglePause');
  assert.equal(state.config.bridgeEnabled, true, '再点一次就应该恢复');
});

test('跨调用的状态活在 globalThis 上，不会被重新求值抹掉', { skip }, async () => {
  const { runtime } = boot();
  await runtime.call('activate', 'onStartupFinished');

  const hub = globalThis.__JLC_BRIDGE_HUB_V2__;
  assert.ok(hub, 'hub 应该挂在 globalThis 上');
  hub.commandCount = 42;

  await runtime.call('showStatus'); // 又一次完整重新求值
  assert.equal(
    globalThis.__JLC_BRIDGE_HUB_V2__.commandCount,
    42,
    '重新求值之后状态必须还在',
  );
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('外部交互权限没开时，说的是人话而不是干等', { skip }, async () => {
  const { runtime, state } = boot({ denyPermission: true });
  await runtime.call('activate', 'onStartupFinished');
  await runtime.call('showStatus');

  const text = state.dialogs.at(-1).content;
  assert.match(text, /外部交互/);
  assert.match(text, /扩展管理器/);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('菜单第一行就是状态灯，连上之后标题会变', { skip }, async () => {
  const { runtime, state } = boot({ autoConnect: false });
  await runtime.call('activate', 'onStartupFinished');

  const firstItem = () => state.menus.pcb[0].menuItems[0].title;
  assert.match(firstItem(), /未连接|正在连接/);

  // 模拟 broker 发来一帧 —— 收到数据才算真的连上
  state.ws.onConnected?.();
  state.ws.onMessage?.({ data: JSON.stringify({ v: 2, t: 'ping', ts: Date.now() }) });
  await sleep(20);
  await runtime.call('showStatus'); // 任何一次调用都会重画菜单

  assert.match(firstItem(), /已连接/);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('收到 cmd 会执行并把 res 发回去', { skip }, async () => {
  const components = [
    {
      getState_PrimitiveId: () => 'p1',
      getState_Designator: () => 'U1',
      getState_Name: () => 'MCU',
      getState_X: () => 100,
      getState_Y: () => 200,
      getState_Rotation: () => 0,
      getState_Width: () => 10,
      getState_Height: () => 10,
      getState_Layer: () => 1,
      getState_PrimitiveLock: () => false,
      getState_Pads: () => [{ net: 'GND' }],
    },
  ];
  const { runtime, state } = boot({
    extraApi: {
      pcb_PrimitiveComponent: { getAll: async () => components },
      pcb_Net: { getAllNetsName: async () => ['GND', 'VCC'], getNetLength: async () => 1 },
    },
  });

  await runtime.call('activate', 'onStartupFinished');
  state.ws.sent.length = 0;

  state.ws.onMessage({
    data: JSON.stringify({ v: 2, t: 'cmd', id: 'c1', action: 'get_state', params: {} }),
  });
  await sleep(60);

  const reply = state.ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === 'res');
  assert.ok(reply, '应该回了一帧 res');
  assert.equal(reply.id, 'c1');
  assert.equal(reply.ok, true);
  assert.equal(reply.data.componentCount, 1);
  assert.equal(reply.data.components[0].designator, 'U1');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('不认识的动作会把支持的动作列表一起报出来', { skip }, async () => {
  const { runtime, state } = boot();
  await runtime.call('activate', 'onStartupFinished');
  state.ws.sent.length = 0;

  state.ws.onMessage({
    data: JSON.stringify({ v: 2, t: 'cmd', id: 'c2', action: 'no_such_action', params: {} }),
  });
  await sleep(40);

  const reply = state.ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === 'res');
  assert.equal(reply.ok, false);
  assert.match(reply.error, /no_such_action/);
  assert.match(reply.error, /get_state/, '错误里应该列出可用动作');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('收到 ping 会回 pong（broker 靠这个判活）', { skip }, async () => {
  const { runtime, state } = boot();
  await runtime.call('activate', 'onStartupFinished');
  state.ws.sent.length = 0;

  state.ws.onMessage({ data: JSON.stringify({ v: 2, t: 'ping', ts: 1 }) });
  await sleep(20);

  const pong = state.ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === 'pong');
  assert.ok(pong, '应该回了 pong');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('先开 EDA、后开 Claude Code —— 必须自己连上，不许要人点重连', { skip }, async () => {
  // 用户报的：「如果 Claude Code 没启动、先启动嘉立创，还是得手动重连一次」。
  //
  // 根因：sys_WebSocket 连不上时**一个回调都不给**（没有 error、没有 close，
  // onConnected 也不来），所以 phase 会一直停在 connecting；而心跳当时对
  // connecting 状态只会补发一次 hello，永远不会重新 register ⇒ 卡死。
  // 现在 connecting 有超时，超了就推倒重来。
  const { runtime, state } = boot({ serverUp: false });
  await runtime.call('activate', 'onStartupFinished');

  const hub = globalThis.__JLC_BRIDGE_HUB_V2__;
  assert.equal(hub.phase, 'connecting', '发起了但还没通');
  assert.equal(state.ws.registered.length, 1);

  const tick = [...state.intervals.values()][0]?.fn;
  assert.ok(tick, '心跳定时器应该装上了');

  // 心跳跑几拍：对端一直不在，应该反复重试而不是卡住
  for (let i = 0; i < 3; i++) {
    hub.connectStartedAt -= 5000; // 把「已经等了很久」快进出来，不用真等
    tick();
  }
  assert.ok(
    state.ws.registered.length >= 3,
    `对端不在时应该持续重试，实际只 register 了 ${state.ws.registered.length} 次`,
  );

  // Claude Code 起来了
  state.ws.serverUp = true;
  hub.connectStartedAt -= 5000;
  tick();

  // 这一拍应该已经连上了，全程没有任何人工操作
  assert.equal(hub.phase, 'online', '对端一出现就该自动连上');
  const hello = state.ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === 'hello');
  assert.ok(hello, '应该发出了 hello');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('同一个场景，用真实计时器再验一遍（不快进时间）', { skip }, async () => {
  // 上面那条把时间快进了，验的是状态机。这条不动时间，验的是
  // 心跳周期(2s) 和连接超时(1.8s) 这组参数真的能收敛 —— 参数配错的话
  // （比如超时 > 心跳周期）状态机再对也永远重试不起来。
  const { runtime, state } = boot({ serverUp: false });
  await runtime.call('activate', 'onStartupFinished');

  await sleep(4500); // 对端一直不在，心跳应该一直在重试
  const triesWhileDown = state.ws.registered.length;
  assert.ok(triesWhileDown >= 2, `4.5 秒里只重试了 ${triesWhileDown} 次，太慢`);

  state.ws.serverUp = true; // Claude Code 起来了
  await sleep(3000);

  assert.equal(
    globalThis.__JLC_BRIDGE_HUB_V2__.phase,
    'online',
    '对端出现后 3 秒内应该自己连上',
  );
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('对端消失后靠主动 ping 尽快发现，而不是干等 11 秒', { skip }, async () => {
  const { runtime, state } = boot();
  await runtime.call('activate', 'onStartupFinished');
  state.ws.onMessage({ data: JSON.stringify({ v: 2, t: 'ping', ts: Date.now() }) });
  await sleep(20);

  const hub = globalThis.__JLC_BRIDGE_HUB_V2__;
  assert.equal(hub.phase, 'online');

  // Claude Code 退出：socket 关了，但扩展这边收不到任何通知
  state.ws.serverUp = false;
  const tick = [...state.intervals.values()][0].fn;
  hub.lastTxAt -= 10_000; // 让保活 ping 到点
  tick();

  assert.notEqual(hub.phase, 'online', 'send 抛错就该立刻判定断线，不用等 RX 超时');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('自检读不到 PCB 时要说清楚是没打开 PCB', { skip }, async () => {
  const { runtime, state } = boot({
    extraApi: {
      pcb_PrimitiveComponent: {
        getAll: async () => {
          throw new Error('no document');
        },
      },
    },
  });
  await runtime.call('runSelfTest');
  await sleep(60);

  const dialog = state.dialogs.at(-1);
  assert.ok(dialog, '应该弹了结果窗口');
  assert.match(dialog.content, /PCB/);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test.afterEach(() => {
  while (live.length) live.pop()();
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});
