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

function boot(options) {
  const { eda, state } = createEdaMock(options);
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
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});
