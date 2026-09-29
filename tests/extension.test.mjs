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

/** 扩展跨调用的状态都挂在 globalThis 上（见 hub.ts） */
const getHubState = () => globalThis.__JLC_BRIDGE_HUB_V2__;

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

/** 从当前菜单里取出状态行标题和「暂停/恢复」那一项的标题 */
function menuTexts(state) {
  const items = state.menus.pcb[0].menuItems.filter(Boolean);
  return {
    status: items[0].title,
    toggle: items.find((i) => i.id === 'pause').title,
  };
}

test('暂停之后，状态行和动作项不许自相矛盾', { skip }, async () => {
  // 用户截图里的样子：状态行写「⏸ 已暂停」，下面的动作项却是「暂停桥接」。
  // 根因是这两处读了两个不同的变量（phase / enabled），而 boot() 每次都用存盘值
  // 覆盖 enabled，把刚点下的暂停冲掉了。
  const { runtime, state } = boot();
  await runtime.call('activate', 'onStartupFinished');

  await runtime.call('togglePause');
  let m = menuTexts(state);
  assert.match(m.status, /已暂停/);
  assert.match(m.toggle, /恢复桥接/, '暂停之后动作项必须是「恢复桥接」');

  // 再点几个别的菜单项 —— 每一次都是一次完整的重新求值
  await runtime.call('showStatus');
  await runtime.call('runSelfTest');
  await sleep(40);

  m = menuTexts(state);
  assert.match(m.status, /已暂停/, '点了别的菜单项之后还应该是暂停态');
  assert.match(m.toggle, /恢复桥接/, '动作项不能变回「暂停桥接」');
  assert.equal(getHubState().phase, 'paused');

  // 就算状态不知怎么被弄拧了（phase 说暂停、enabled 说开着），
  // 菜单也不能画出自相矛盾的两行——这是用户截图里那一幕。
  getHubState().enabled = true;
  await runtime.call('showStatus');
  m = menuTexts(state);
  const statusSaysPaused = /已暂停/.test(m.status);
  const toggleSaysResume = /恢复桥接/.test(m.toggle);
  assert.equal(
    statusSaysPaused,
    toggleSaysResume,
    `状态行和动作项打架了：「${m.status}」配「${m.toggle}」`,
  );
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('存盘失败时也不能把用户刚点下的暂停冲掉', { skip }, async () => {
  // sys_Storage 的写是异步的、还可能悄悄失败。扩展这边一旦拿读回来的旧值
  // 去盖内存里的选择，用户点的「暂停」就白点了。
  const { runtime, state } = boot();
  await runtime.call('activate', 'onStartupFinished');

  state.configWritesFail = true; // 从现在起所有存盘都静默失败
  await runtime.call('togglePause');
  await runtime.call('showStatus'); // 又一次完整重新求值

  const m = menuTexts(state);
  assert.match(m.toggle, /恢复桥接/, '存盘失败也不该让暂停失效');
  assert.equal(getHubState().enabled, false);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('恢复之后 phase 要真的离开 paused，而不是卡在那儿', { skip }, async () => {
  const { runtime, state } = boot();
  await runtime.call('activate', 'onStartupFinished');
  await runtime.call('togglePause');
  assert.equal(getHubState().phase, 'paused');

  await runtime.call('togglePause'); // 恢复
  const hub = getHubState();
  assert.notEqual(hub.phase, 'paused', '恢复之后不能还停在 paused');
  assert.equal(hub.enabled, true);
  assert.ok(hub.heartbeatArmed, '恢复之后心跳要重新装上，否则再也不会自动重连');
  assert.match(menuTexts(state).toggle, /暂停桥接/);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
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
      getState_Layer: () => 1,
      getState_PrimitiveLock: () => false,
      getState_Pads: () => [{ net: 'GND' }],
    },
  ];
  const { runtime, state } = boot({
    extraApi: {
      pcb_PrimitiveComponent: { getAll: async () => components },
      pcb_Primitive: {
        getPrimitivesBBox: async () => ({ minX: 95, minY: 195, maxX: 105, maxY: 205 }),
      },
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

test('get_board_info 要认得 EDA 真实返回的字段名', { skip }, async () => {
  // fixture 是真机上 dmt_Board.getCurrentBoardInfo() 的实际返回，一字未改。
  // 原来的代码找的是 info.sch.uuid，而 EDA 给的是 info.schematic.uuid ——
  // schematicUuid 一直是空串，sch_* 和「切到原理图」全都没法用。
  const realBoardInfo = {
    name: 'Board1',
    uuid: '525eb0a5c052ea4c',
    zIndex: 1,
    parentProjectUuid: '8b10bedd9d484f77b020434d405b4bb6',
    pcb: {
      itemType: 'PCB',
      uuid: '107fb73b165b4a108c2b96469149f2e5',
      name: 'PCB1',
      parentProjectUuid: '8b10bedd9d484f77b020434d405b4bb6',
      parentBoardName: 'Board1',
    },
    schematic: {
      itemType: 'Schematic',
      uuid: '379928e1f83c4e3e8a3e416e63fde89d',
      name: 'schematic1',
      parentProjectUuid: '8b10bedd9d484f77b020434d405b4bb6',
      page: [
        { itemType: 'Schematic Page', uuid: 'b28c873246764dd38100759bb9639a7e', name: 'p1' },
        { itemType: 'Schematic Page', uuid: '19b4712d50cb48e5bf14ad0240a29bc1', name: 'p2' },
      ],
    },
  };

  const { runtime, state } = boot({
    extraApi: { dmt_Board: { getCurrentBoardInfo: async () => realBoardInfo } },
  });
  await runtime.call('activate', 'onStartupFinished');
  state.ws.sent.length = 0;

  state.ws.onMessage({
    data: JSON.stringify({ v: 2, t: 'cmd', id: 'b1', action: 'get_board_info', params: {} }),
  });
  await sleep(60);

  const reply = state.ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === 'res');
  assert.equal(reply.ok, true);
  assert.equal(reply.data.schematicUuid, '379928e1f83c4e3e8a3e416e63fde89d');
  assert.equal(reply.data.pcbUuid, '107fb73b165b4a108c2b96469149f2e5');
  assert.equal(reply.data.projectUuid, '8b10bedd9d484f77b020434d405b4bb6');
  assert.deepEqual(
    reply.data.schematicPages.map((p) => p.name),
    ['p1', 'p2'],
  );
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('导线线宽读 getState_LineWidth，导线图元没有 getState_Width', { skip }, async () => {
  // 照 EDA 安装目录 pro-api 的 api-types.d.ts 里 IPCB_PrimitiveLine 的 getter 逐个造，
  // 线宽只有 getState_LineWidth()。原来读的是不存在的 getState_Width()，
  // pcb_get_tracks 和 pcb_get_net_primitives 返回的每条导线 width 都是 0。
  const line = {
    getState_PrimitiveType: () => 'Line',
    getState_PrimitiveId: () => 't1',
    getState_Net: () => 'GND',
    getState_Layer: () => 1,
    getState_StartX: () => 0,
    getState_StartY: () => 0,
    getState_EndX: () => 100,
    getState_EndY: () => 0,
    getState_LineWidth: () => 12,
    getState_PrimitiveLock: () => false,
  };
  const { runtime, state } = boot({
    extraApi: { pcb_PrimitiveLine: { getAll: async () => [line] } },
  });
  await runtime.call('activate', 'onStartupFinished');

  const tracks = await runCommand(runtime, state, 'get_tracks');
  assert.equal(tracks.ok, true, tracks.error);
  assert.equal(tracks.data.tracks[0].width, 12, 'get_tracks 的线宽');

  const netPrims = await runCommand(runtime, state, 'get_net_primitives', { net: 'GND' });
  assert.equal(netPrims.ok, true, netPrims.error);
  assert.equal(netPrims.data.tracks[0].width, 12, 'get_net_primitives 的线宽');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('元件宽高取自 getPrimitivesBBox，器件图元没有 getState_Width/Height', { skip }, async () => {
  // 照 EDA 安装目录 pro-api 的 api-types.d.ts 里 IPCB_PrimitiveComponent 的 getter 逐个造，
  // 里面没有任何尺寸 getter。原来读的是不存在的 getState_Width()/getState_Height()，
  // pcb_get_state 返回的每个元件 width/height 都是 0，boardBounds 只剩元件中心点围成的框。
  const component = (id, designator, x, y) => ({
    getState_PrimitiveType: () => 'Component',
    getState_PrimitiveId: () => id,
    getState_Component: () => ({ libraryUuid: 'lib1', uuid: 'dev1' }),
    getState_Footprint: () => ({ libraryUuid: 'lib1', uuid: 'fp1' }),
    getState_Layer: () => 1,
    getState_X: () => x,
    getState_Y: () => y,
    getState_Rotation: () => 0,
    getState_PrimitiveLock: () => false,
    getState_AddIntoBom: () => true,
    getState_Model3D: () => undefined,
    getState_Designator: () => designator,
    getState_Pads: () => [{ primitiveId: `${id}-1`, net: 'GND', padNumber: '1' }],
    getState_Name: () => designator,
    getState_UniqueId: () => undefined,
    getState_Manufacturer: () => undefined,
    getState_ManufacturerId: () => undefined,
    getState_Supplier: () => undefined,
    getState_SupplierId: () => undefined,
    getState_OtherProperty: () => ({}),
  });
  // 外框故意不以元件原点为中心：封装原点不一定在外框正中，
  // 板框范围得按外框本身算，不能拿「中心点 ± 宽高一半」去凑。
  const boxes = {
    u1: { minX: 80, minY: 170, maxX: 140, maxY: 210 },
    r1: { minX: 295, minY: 390, maxX: 305, maxY: 420 },
  };
  const { runtime, state } = boot({
    extraApi: {
      pcb_PrimitiveComponent: {
        getAll: async () => [component('u1', 'U1', 100, 200), component('r1', 'R1', 300, 400)],
      },
      pcb_Primitive: { getPrimitivesBBox: bboxLookup(boxes) },
    },
  });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_state');
  assert.equal(reply.ok, true, reply.error);
  const [u1, r1] = reply.data.components;
  assert.equal(u1.width, 60, 'U1 的宽');
  assert.equal(u1.height, 40, 'U1 的高');
  assert.equal(r1.width, 10, 'R1 的宽');
  assert.equal(r1.height, 30, 'R1 的高');
  assert.deepEqual(reply.data.boardBounds, { minX: 80, minY: 170, maxX: 305, maxY: 420 });
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

// ─── 焊盘 ───
//
// 焊盘和元件都照 EDA 安装目录 pro-api 的 api-types.d.ts 逐个 getter 造，一个不多。
// 焊盘图元 IPCB_PrimitivePad 没有位号、父元件 ID、孔径、直径、形状这些 getter，
// 原来读的全是不存在的方法：真机上 39 个焊盘的 designator / parentPrimitiveId / shape 全是空串，
// 按位号过滤一条都命中不了。
//
// ID 照真机量到的样子造：焊盘的图元 ID 是「元件 ID + 后缀」，
// 元件 getState_Pads() 里给的只有后缀（EDA 的 pcb.js 序列化元件时把元件 ID 从焊盘 ID 里 replace 掉了）。

function pcbPad({ id, padNumber, net, x, y, layer = 1, pad, hole = null }) {
  return {
    getState_PrimitiveType: () => 'Pad',
    getState_PrimitiveId: () => id,
    getState_Layer: () => layer,
    getState_PadNumber: () => padNumber,
    getState_X: () => x,
    getState_Y: () => y,
    getState_Rotation: () => 0,
    getState_Pad: () => pad,
    getState_Net: () => net,
    getState_Hole: () => hole,
    getState_HoleOffsetX: () => 0,
    getState_HoleOffsetY: () => 0,
    getState_HoleRotation: () => 0,
    getState_Metallization: () => hole !== null,
    getState_PadType: () => 0,
    getState_SpecialPad: () => undefined,
    getState_SolderMaskAndPasteMaskExpansion: () => null,
    getState_HeatWelding: () => null,
    getState_PrimitiveLock: () => false,
  };
}

function pcbComponent({ id, designator, x, y, pads }) {
  return {
    getState_PrimitiveType: () => 'Component',
    getState_PrimitiveId: () => id,
    getState_Component: () => ({ libraryUuid: 'lib1', uuid: 'dev1' }),
    getState_Footprint: () => ({ libraryUuid: 'lib1', uuid: 'fp1' }),
    getState_Layer: () => 1,
    getState_X: () => x,
    getState_Y: () => y,
    getState_Rotation: () => 0,
    getState_PrimitiveLock: () => false,
    getState_AddIntoBom: () => true,
    getState_Model3D: () => undefined,
    getState_Designator: () => designator,
    getState_Pads: () => pads,
    getState_Name: () => designator,
    getState_UniqueId: () => undefined,
    getState_Manufacturer: () => undefined,
    getState_ManufacturerId: () => undefined,
    getState_Supplier: () => undefined,
    getState_SupplierId: () => undefined,
    getState_OtherProperty: () => ({}),
  };
}

/** fullPadIds：让 getState_Pads() 给完整 ID，模拟 EDA 改了 ID 规则 */
function padBoardMock({ fullPadIds = false } = {}) {
  const R1 = '240bc228c1ee3a49';
  const LED1 = '77c7fafe2c6e66e1';
  const H1 = '52930e4c1065e082';
  const ref = (componentId, suffix, net, padNumber) => ({
    primitiveId: fullPadIds ? componentId + suffix : suffix,
    net,
    padNumber,
  });
  const smd = ['RECT', 31.5, 35.4, 0];

  const components = [
    pcbComponent({
      id: R1,
      designator: 'R1',
      x: 440,
      y: 410,
      pads: [ref(R1, 'e7', '$1N15', '1'), ref(R1, 'e8', '$1N16', '2')],
    }),
    pcbComponent({
      id: LED1,
      designator: 'LED1',
      x: 410,
      y: 305,
      pads: [ref(LED1, 'e21', '$1N16', '1'), ref(LED1, 'e22', 'GND', '2')],
    }),
    pcbComponent({
      id: H1,
      designator: 'H1',
      x: 305,
      y: 80,
      pads: [
        ref(H1, 'e15', '+5V', '1'),
        ref(H1, 'e16', 'PA0', '2'),
        // 封装自带的过孔也列在这里（pcb.js 把过孔和焊盘推进同一个数组，编号就是 ID），它不是焊盘
        ref(H1, 'e30', 'GND', 'e30'),
      ],
    }),
  ];

  const pads = [
    pcbPad({ id: `${R1}e7`, padNumber: '1', net: '$1N15', x: 440, y: 439.7, pad: smd }),
    pcbPad({ id: `${R1}e8`, padNumber: '2', net: '$1N16', x: 440, y: 380.3, pad: smd }),
    pcbPad({ id: `${LED1}e21`, padNumber: '1', net: '$1N16', x: 439.5, y: 305, pad: smd }),
    pcbPad({ id: `${LED1}e22`, padNumber: '2', net: 'GND', x: 380.5, y: 305, pad: smd }),
    pcbPad({
      id: `${H1}e15`,
      padNumber: '1',
      net: '+5V',
      x: 55,
      y: 80,
      layer: 12,
      pad: ['RECT', 60, 60, 0],
      hole: ['ROUND', 40],
    }),
    pcbPad({
      id: `${H1}e16`,
      padNumber: '2',
      net: 'PA0',
      x: 155,
      y: 80,
      layer: 12,
      pad: ['ELLIPSE', 60, 60],
      hole: ['ROUND', 40],
    }),
    // 直接放在板上、不属于任何元件的焊盘
    pcbPad({
      id: 'a1b2c3d4e5f60718',
      padNumber: '1',
      net: '',
      x: 600,
      y: 600,
      layer: 12,
      pad: ['OVAL', 80, 120],
      hole: ['SLOT', 40, 80],
    }),
  ];

  return {
    api: {
      pcb_PrimitiveComponent: { getAll: async () => components },
      pcb_PrimitivePad: { getAll: async () => pads },
    },
  };
}

test('焊盘的位号、所属元件、外形、孔径都从真实 getter 读出来', { skip }, async () => {
  const m = padBoardMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const r1 = await runCommand(runtime, state, 'get_pads', { designator: 'r1' });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.data.returnedPads, 2, '按位号过滤要命中 R1 的两个焊盘，位号不分大小写');
  for (const pad of r1.data.pads) {
    assert.equal(pad.designator, 'R1');
    assert.equal(pad.parentPrimitiveId, '240bc228c1ee3a49');
  }
  assert.deepEqual(
    r1.data.pads.map((p) => p.padNumber),
    ['1', '2'],
  );
  assert.equal(r1.data.pads[0].shape, 'RECT');
  assert.equal(r1.data.pads[0].width, 31.5);
  assert.equal(r1.data.pads[0].height, 35.4);
  assert.equal(r1.data.pads[0].hole, null, '贴片焊盘没有孔');

  const h1 = await runCommand(runtime, state, 'get_pads', { designator: 'H1' });
  assert.equal(h1.data.returnedPads, 2, '封装自带的过孔不算焊盘');
  assert.equal(h1.data.pads[1].shape, 'ELLIPSE');
  assert.deepEqual(h1.data.pads[1].hole, { shape: 'ROUND', diameter: 40 });

  const all = await runCommand(runtime, state, 'get_pads');
  assert.equal(all.data.returnedPads, 7);
  const free = all.data.pads.find((p) => p.primitiveId === 'a1b2c3d4e5f60718');
  assert.equal(free.designator, '', '不属于任何元件的焊盘没有位号');
  assert.equal(free.parentPrimitiveId, '');
  assert.deepEqual(free.hole, { shape: 'SLOT', diameter: 40, length: 80 });

  const net = await runCommand(runtime, state, 'get_net_primitives', { net: '$1N16' });
  assert.equal(net.ok, true, net.error);
  assert.deepEqual(
    net.data.pads.map((p) => `${p.designator}.${p.padNumber}`).sort(),
    ['LED1.1', 'R1.2'],
  );
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('元件的焊盘 ID 拼不出任何焊盘时直接报错，不许退回位号全空', { skip }, async () => {
  // 哪天 EDA 把 getState_Pads() 改成给完整 ID，「元件 ID + 后缀」就一个焊盘都拼不出来。
  // 这时要当场报出来，不能又变回「位号全是空串、按位号过滤一条不中」却不报错。
  const m = padBoardMock({ fullPadIds: true });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_pads', { designator: 'R1' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /对不上/);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

/** 照 api.js 的实现：传进来的图元对象先换成 ID；一个图元回它自己的外框，多个回合并外框，一个都没有回 undefined */
function bboxLookup(boxes) {
  return async (items) => {
    const hit = items
      .map((item) => boxes[typeof item === 'string' ? item : item.getState_PrimitiveId()])
      .filter(Boolean);
    if (hit.length === 0) return undefined;
    return {
      minX: Math.min(...hit.map((b) => b.minX)),
      minY: Math.min(...hit.map((b) => b.minY)),
      maxX: Math.max(...hit.map((b) => b.maxX)),
      maxY: Math.max(...hit.map((b) => b.maxY)),
    };
  };
}

// ─── 搬迁元件 ───
//
// 器件焊盘、导线、圆弧、过孔、填充区域都照 api-types.d.ts 逐个 getter 造。原来的 relocateComponent 在
// pcb_PrimitivePad.getAll() 的焊盘上读 getState_Designator / getState_ParentPrimitiveId 这类不存在的 getter
// 去认「哪些焊盘是这个元件的」，一个都认不出来，pcb_relocate_component 的自动断线从来没删过任何走线。
//
// 哪些图元连着焊盘由 EDA 的 getConnectedPrimitives() 判断，夹具里 connectedOf 就是它的回答：
// 照 pcb.js 的连接检查，只含同一网络、层对得上、铜皮碰到焊盘的图元。
// 真机上通孔焊盘、大焊盘的走线端点常常离焊盘中心好几 mil，所以夹具里的走线端点故意不放在焊盘中心。

/** IPCB_PrimitiveComponentPad：焊盘图元的全部 getter，外加父器件 ID 和 getConnectedPrimitives() */
function pcbComponentPad(parentId, options, connected) {
  return {
    ...pcbPad(options),
    getState_PrimitiveType: () => 'ComponentPad',
    getState_ParentComponentPrimitiveId: () => parentId,
    // 照 api.js：参数为 true 时不带填充区域，别的照给
    getConnectedPrimitives: async (onlyCentreConnection) =>
      connected.filter((item) => !onlyCentreConnection || item.getState_PrimitiveType() !== 'Fill'),
  };
}

function pcbLine({ id, net, from = [0, 0], to = [0, 0], layer = 1, locked = false }) {
  return {
    getState_PrimitiveType: () => 'Line',
    getState_PrimitiveId: () => id,
    getState_Net: () => net,
    getState_Layer: () => layer,
    getState_StartX: () => from[0],
    getState_StartY: () => from[1],
    getState_EndX: () => to[0],
    getState_EndY: () => to[1],
    getState_LineWidth: () => 10,
    getState_PrimitiveLock: () => locked,
  };
}

function pcbArc({ id, net, from, to, layer = 1, locked = false }) {
  return {
    getState_PrimitiveType: () => 'Arc',
    getState_PrimitiveId: () => id,
    getState_Net: () => net,
    getState_Layer: () => layer,
    getState_StartX: () => from[0],
    getState_StartY: () => from[1],
    getState_EndX: () => to[0],
    getState_EndY: () => to[1],
    getState_ArcAngle: () => 90,
    getState_LineWidth: () => 10,
    getState_InteractiveMode: () => 1,
    getState_PrimitiveLock: () => locked,
  };
}

function pcbFill({ id, net, layer = 1 }) {
  return {
    getState_PrimitiveType: () => 'Fill',
    getState_PrimitiveId: () => id,
    getState_Net: () => net,
    getState_Layer: () => layer,
    getState_ComplexPolygon: () => undefined,
    getState_FillMode: () => undefined,
    getState_LineWidth: () => 0,
    getState_PrimitiveLock: () => false,
  };
}

/** modifyFails：移动元件时照 api.js 抛错（pcb.js 的 component-modify 返回 null 时就是这样） */
function relocateBoardMock({ modifyFails = false } = {}) {
  const R1 = '240bc228c1ee3a49';
  const H1 = '52930e4c1065e082';
  const U2 = '6b1f0c2d9e8a7f35';
  const MK1 = '0d4e2f9a1b3c5e77';
  const smd = ['RECT', 31.5, 35.4, 0];
  const tht = { layer: 12, pad: ['RECT', 60, 60, 0], hole: ['ROUND', 40] };

  // R1 的两个焊盘外框：x 424.25~455.75，1 号 y 422~457.4，2 号 y 362.6~398
  const line = (id, net, extra) => pcbLine({ id, net, ...extra });
  const t1 = line('t1', '$1N16', { from: [440, 381.9], to: [439.5, 305] });
  const t2 = line('t2', '$1N15', { from: [440, 500], to: [440, 452.5] }); // 端点在焊盘里，离中心 12.8 mil
  // 线宽 10，端点在焊盘外框外 3.6 mil：线头的圆帽压在焊盘上（真机上就有这样连着的线）
  const w1 = line('w1', '$1N15', { from: [440, 461], to: [440, 520] });
  // 同一网络的线从焊盘上横穿过去，两头连着别处
  const p1 = line('p1', '$1N15', { from: [400, 440], to: [500, 440] });
  const b1 = line('b1', '+5V', { from: [55, 75], to: [255, 75] }); // H1.1 和 H1.3 共用
  const t8 = line('t8', '+5V', { from: [0, 80], to: [52, 80], layer: 2 });
  const q1 = line('q1', 'PA0', { from: [155, 75], to: [155, 20] });
  const k1 = line('k1', 'SDA', { from: [700, 500], to: [760, 500], locked: true });
  const u1 = line('u1', 'SCL', { from: [700, 560], to: [760, 560] });

  const padsOf = {
    [R1]: [
      { id: `${R1}e7`, padNumber: '1', net: '$1N15', x: 440, y: 439.7, pad: smd },
      { id: `${R1}e8`, padNumber: '2', net: '$1N16', x: 440, y: 380.3, pad: smd },
    ],
    [H1]: [
      { id: `${H1}e15`, padNumber: '1', net: '+5V', x: 55, y: 80, ...tht },
      { id: `${H1}e16`, padNumber: '2', net: 'PA0', x: 155, y: 80, ...tht },
      { id: `${H1}e17`, padNumber: '3', net: '+5V', x: 255, y: 80, ...tht },
    ],
    [U2]: [
      { id: `${U2}e3`, padNumber: '3', net: 'SDA', x: 700, y: 500, pad: smd },
      { id: `${U2}e4`, padNumber: '4', net: 'SCL', x: 700, y: 560, pad: smd },
    ],
    [MK1]: [],
  };
  const connectedOf = {
    [`${R1}e7`]: [
      t2,
      w1,
      p1,
      pcbArc({ id: 'a1', net: '$1N15', from: [450, 455], to: [480, 485] }),
      pcbVia({ id: 'v1', net: '$1N15', x: 440, y: 439.7, diameter: 24 }),
    ],
    [`${R1}e8`]: [t1, pcbFill({ id: 'f1', net: '$1N16' })],
    [`${H1}e15`]: [b1, t8],
    [`${H1}e16`]: [q1],
    [`${H1}e17`]: [b1],
    [`${U2}e3`]: [k1],
    [`${U2}e4`]: [u1, pcbArc({ id: 'ka', net: 'SCL', from: [700, 560], to: [720, 590], locked: true })],
  };
  // 焊盘外框：外形都没有旋转，按宽高围出来
  const padBoxes = Object.fromEntries(
    Object.values(padsOf)
      .flat()
      .map((p) => [
        p.id,
        { minX: p.x - p.pad[1] / 2, minY: p.y - p.pad[2] / 2, maxX: p.x + p.pad[1] / 2, maxY: p.y + p.pad[2] / 2 },
      ]),
  );
  // getState_Pads() 里的焊盘 ID 只有后缀
  const refs = (componentId) =>
    padsOf[componentId].map((p) => ({
      primitiveId: p.id.slice(componentId.length),
      net: p.net,
      padNumber: p.padNumber,
    }));
  const components = [
    pcbComponent({ id: R1, designator: 'R1', x: 440, y: 410, pads: refs(R1) }),
    pcbComponent({ id: H1, designator: 'H1', x: 155, y: 80, pads: refs(H1) }),
    pcbComponent({ id: U2, designator: 'U2', x: 700, y: 510, pads: refs(U2) }),
    pcbComponent({ id: MK1, designator: 'MK1', x: 800, y: 800, pads: refs(MK1) }),
  ];
  const allLines = [t1, t2, w1, p1, b1, t8, q1, k1, u1];

  const deleted = { lines: [], arcs: [] };
  const modified = [];
  const api = {
    pcb_Primitive: { getPrimitivesBBox: bboxLookup(padBoxes) },
    pcb_PrimitiveComponent: {
      getAll: async () => components,
      // 照 api.js：一个焊盘都没有时返回 undefined
      getAllPinsByPrimitiveId: async (id) =>
        padsOf[id].length === 0
          ? undefined
          : padsOf[id].map((p) => pcbComponentPad(id, p, connectedOf[p.id] ?? [])),
      modify: async (id, property) => {
        if (modifyFails) throw new Error('错误：对象参数不正确，无法应用到画布。');
        modified.push({ id, property });
        return components.find((c) => c.getState_PrimitiveId() === id);
      },
    },
    // 全板焊盘和按网络查走线也给上：原来的代码就是在这里面按不存在的 getter 找元件的焊盘
    pcb_PrimitivePad: { getAll: async () => Object.values(padsOf).flat().map(pcbPad) },
    pcb_PrimitiveLine: {
      getAll: async (net) => allLines.filter((l) => net === undefined || l.getState_Net() === net),
      delete: async (ids) => {
        deleted.lines.push(...[ids].flat());
        return true;
      },
    },
    pcb_PrimitiveArc: {
      getAll: async () => [],
      delete: async (ids) => {
        deleted.arcs.push(...[ids].flat());
        return true;
      },
    },
  };
  return { api, deleted, modified, ids: { R1, H1, U2, MK1 } };
}

test('搬迁元件时删掉端点连在它焊盘上的走线和圆弧，横穿焊盘的线、过孔、填充不动', { skip }, async () => {
  const m = relocateBoardMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'relocate_component', {
    designator: 'R1',
    x: 600,
    y: 410,
  });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual([...reply.data.deletedTracks].sort(), ['a1', 't1', 't2', 'w1']);
  assert.deepEqual(m.deleted.lines.sort(), ['t1', 't2', 'w1'], 'EDA 那边真的删了这几条线，横穿焊盘的 p1 不删');
  assert.deepEqual(m.deleted.arcs, ['a1'], '圆弧走线也是走线');
  assert.deepEqual(reply.data.netsToReroute, ['$1N15', '$1N16']);
  assert.deepEqual(m.modified, [{ id: m.ids.R1, property: { x: 600, y: 410, rotation: 0 } }]);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('通孔元件：两个焊盘共用的线只删一次，没有焊盘的元件照常搬', { skip }, async () => {
  const m = relocateBoardMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const h1 = await runCommand(runtime, state, 'relocate_component', { designator: 'H1', x: 155, y: 150 });
  assert.equal(h1.ok, true, h1.error);
  assert.deepEqual(m.deleted.lines.sort(), ['b1', 'q1', 't8']);
  assert.deepEqual(h1.data.netsToReroute, ['+5V', 'PA0']);

  // 没有焊盘的元件照常搬
  const mk1 = await runCommand(runtime, state, 'relocate_component', { designator: 'MK1', x: 900, y: 900 });
  assert.equal(mk1.ok, true, mk1.error);
  assert.deepEqual(mk1.data.deletedTracks, []);
  assert.deepEqual(m.modified.map((mv) => mv.id), [m.ids.H1, m.ids.MK1]);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('连到焊盘上的直线或圆弧被锁定时直接报错，一条都不删，元件也不动', { skip }, async () => {
  const m = relocateBoardMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'relocate_component', { designator: 'U2', x: 700, y: 600 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /锁定：k1、ka。/, '锁定的直线和圆弧都要点名');
  assert.deepEqual(m.deleted.lines, [], '没锁的 u1 也不能先删掉');
  assert.deepEqual(m.deleted.arcs, []);
  assert.deepEqual(m.modified, []);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('移动元件失败时一条走线都不删', { skip }, async () => {
  const m = relocateBoardMock({ modifyFails: true });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'relocate_component', { designator: 'R1', x: 600, y: 410 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /对象参数不正确/);
  assert.deepEqual(m.deleted.lines, []);
  assert.deepEqual(m.deleted.arcs, []);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

// ─── 丝印 ───
//
// 文本、属性、焊盘、过孔照 api-types.d.ts 逐个 getter 造。文本图元 IPCB_PrimitiveString 没有
// getState_Content / getState_CenterX / getState_ParentPrimitiveId；焊盘图元没有 getState_Diameter /
// getState_PadDiameter。原来焊盘取不到外框时拿这两个不存在的 getter 算避让框，读空之后按 10 mil 见方去判冲突。
//
// 元件位号、值这些挂在元件上的文字是属性图元 IPCB_PrimitiveAttribute。pcb_PrimitiveString.getAll() 不给它们
// （pcb.js 里按 !getParent() 过滤了），原来只读文本，真机上一块摆满元件的板查出来 0 条丝印，位号从来没被挪过。
//
// 写回也照 api.js 造：getAll 每次都照画布现状造一批新对象，对象处在异步模式；
// setState_* 只改对象上的值（同步模式下会顺手调 done()，不 await），reset() 从画布重新读一遍，
// done() 才把对象的全部字段发给 EDA，EDA 拒绝时抛「对象参数不正确，无法应用到画布」。
// pcb_PrimitiveString.modify / pcb_PrimitiveAttribute.modify 调 done() 时没有 await，EDA 拒绝写入也照样返回对象。

/**
 * 照画布上的一条记录造图元对象，方法都是 api-types.d.ts 里有的。
 * fields 是记录的一份拷贝，getter 读它；reset() 从画布重新拷一份，done() 交给 write() 后把整份拷贝写回画布。
 */
function primitiveObject(record, getters, write) {
  const fields = { ...record };
  let async = true;
  const obj = {};
  const set = (key) => (value) => {
    fields[key] = value;
    if (!async) obj.done();
    return obj;
  };
  return Object.assign(obj, getters(fields), {
    setState_X: set('x'),
    setState_Y: set('y'),
    setState_Rotation: set('rotation'),
    isAsync: () => async,
    toAsync: () => ((async = true), obj),
    reset: async () => (Object.assign(fields, record), obj),
    done: async () => {
      await write(obj);
      Object.assign(record, fields);
      return obj;
    },
  });
}

/** 照 api.js 的 modify：改完字段调 done() 却不 await，直接把对象返回 */
function edaModify(row, property) {
  row.isAsync() || row.toAsync();
  if (property.x !== undefined) row.setState_X(property.x);
  if (property.y !== undefined) row.setState_Y(property.y);
  if (property.rotation !== undefined) row.setState_Rotation(property.rotation);
  row.done();
  return row;
}

/** IPCB_PrimitiveString。record：{ id, text, x, y, rotation, layer } */
function pcbString(record, write) {
  return primitiveObject(
    record,
    (f) => ({
      getState_PrimitiveType: () => 'String',
      getState_PrimitiveId: () => f.id,
      getState_Layer: () => f.layer,
      getState_X: () => f.x,
      getState_Y: () => f.y,
      getState_Text: () => f.text,
      getState_FontFamily: () => 'default',
      getState_FontSize: () => 16,
      getState_LineWidth: () => 2,
      getState_AlignMode: () => 5,
      getState_Rotation: () => f.rotation,
      getState_Reverse: () => false,
      getState_Expansion: () => 0,
      getState_Mirror: () => false,
      getState_PrimitiveLock: () => false,
    }),
    write,
  );
}

function pcbVia({ id, net, x, y, diameter }) {
  return {
    getState_PrimitiveType: () => 'Via',
    getState_PrimitiveId: () => id,
    getState_Net: () => net,
    getState_X: () => x,
    getState_Y: () => y,
    getState_HoleDiameter: () => diameter / 2,
    getState_Diameter: () => diameter,
    getState_ViaType: () => 0,
    getState_DesignRuleBlindViaName: () => null,
    getState_SolderMaskExpansion: () => null,
    getState_PrimitiveLock: () => false,
  };
}

/**
 * IPCB_PrimitiveAttribute 的全部 getter 加写回用的方法。坐标单位 mil（api.js 里是画布坐标 × 10）。
 * record：{ id, parentId, key, value, keyVisible, valueVisible, x, y, rotation, layer }
 */
function pcbAttribute(record, write) {
  return primitiveObject(
    record,
    (f) => ({
      getState_PrimitiveType: () => 'Attribute',
      getState_PrimitiveId: () => f.id,
      getState_ParentPrimitiveId: () => f.parentId,
      getState_Layer: () => f.layer,
      getState_X: () => f.x,
      getState_Y: () => f.y,
      getState_Key: () => f.key,
      getState_Value: () => f.value,
      getState_KeyVisible: () => f.keyVisible,
      getState_ValueVisible: () => f.valueVisible,
      getState_FontFamily: () => 'default',
      getState_FontSize: () => 12,
      getState_LineWidth: () => 2,
      getState_AlignMode: () => 5,
      getState_Rotation: () => f.rotation,
      getState_Reverse: () => false,
      getState_Expansion: () => 0,
      getState_Mirror: () => false,
      getState_PrimitiveLock: () => false,
    }),
    write,
  );
}

// EDA 给每个元件挂一整串属性（Designator、Value、Footprint……），多数是隐藏的。
// 隐藏的属性可能没有摆放位置，这时 pcb.js 把位置记成原点，api.js 给出来的坐标是 (0, 0)。
// 这里不该收进来的属性都不给外框，误收进来时测试会因为「取不到外框」失败
// （真机上隐藏属性的外框是退化成一个点的框，不会报错）。
const SILK_ATTRIBUTES = [
  // R1 的位号，压在 pad1 上
  { id: 'a1', parentId: 'c1', key: 'Designator', value: 'R1', valueVisible: true, x: 440, y: 290, layer: 3 },
  { id: 'a2', parentId: 'c1', key: 'Value', value: '10k', valueVisible: false, x: 0, y: 0, layer: 3 },
  { id: 'a3', parentId: 'c1', key: 'Footprint', value: 'R0603', valueVisible: false, x: 0, y: 0, layer: 3 },
  // C1 的位号在底层丝印，周围空着，转了 180°
  { id: 'a4', parentId: 'c2', key: 'Designator', value: 'C1', valueVisible: true, x: 700, y: 700, rotation: 180, layer: 4 },
  // 显示着，但在顶层装配层（9），不是丝印
  { id: 'a5', parentId: 'c2', key: 'Value', value: '100nF', valueVisible: true, x: 700, y: 720, layer: 9 },
  // 勾了显示但值是空的，画布上一个字都没有
  { id: 'a6', parentId: 'c2', key: 'Manufacturer Part', value: '', valueVisible: true, x: 700, y: 740, layer: 4 },
  // Key 和 Value 都显示
  { id: 'a7', parentId: 'c1', key: 'Tolerance', value: '1%', keyVisible: true, valueVisible: true, x: 600, y: 500, layer: 3 },
];

/**
 * withoutBox：让 getPrimitivesBBox 对这个图元给 undefined；nanBox：给一个带 NaN 的外框；
 * onlyCopperText：板上只有铜皮层上的那条文字；
 * attributes：元件挂着的属性（画布记录，缺的 keyVisible、rotation 按隐藏和 0° 补）；
 * rejectWrite：EDA 拒绝写回这个图元；
 * userEdit(canvas)：用户在 EDA 里改画布，第一次查焊盘时执行一次（这时丝印已经查完）
 */
function silkBoardMock({
  withoutBox,
  nanBox,
  onlyCopperText = false,
  attributes = [],
  rejectWrite,
  userEdit,
} = {}) {
  const boxes = {
    outline: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    // 80×50 的大焊盘，中心 (440, 305)
    pad1: { minX: 400, minY: 280, maxX: 480, maxY: 330 },
    via1: { minX: 188, minY: 188, maxX: 212, maxY: 212 },
    // 压住焊盘右上角，离焊盘中心远，10 mil 见方的框碰不到它
    s1: { minX: 462, minY: 326, maxX: 486, maxY: 342 },
    s2: { minX: 190, minY: 210, maxX: 210, maxY: 220 },
    s3: { minX: 430, minY: 300, maxX: 450, maxY: 310 },
    a1: { minX: 430, minY: 284, maxX: 450, maxY: 296 },
    a4: { minX: 690, minY: 695, maxX: 710, maxY: 705 },
    a7: { minX: 570, minY: 495, maxX: 630, maxY: 505 },
  };
  delete boxes[withoutBox];
  if (nanBox) boxes[nanBox] = { ...boxes[nanBox], minX: NaN };

  // EDA 收到的写回。done() 发出去的是整个对象，这里记下坐标和角度
  const writes = [];
  const write = async (obj) => {
    const id = obj.getState_PrimitiveId();
    // api.js 的 done()：EDA 的 modify 请求回了假值就抛这句
    if (id === rejectWrite) throw new Error('错误：对象参数不正确，无法应用到画布。');
    writes.push({
      id,
      type: obj.getState_PrimitiveType(),
      x: obj.getState_X(),
      y: obj.getState_Y(),
      rotation: obj.getState_Rotation(),
    });
  };

  // 画布：每个图元一条记录。getAll 每次都照它造新对象，done() 把对象写回它
  const allStrings = [
    { id: 's1', text: 'R1', x: 474, y: 334, rotation: 0, layer: 3 },
    { id: 's2', text: 'GND', x: 200, y: 215, rotation: 0, layer: 4 },
    // 顶层铜皮上的文字，不是丝印
    { id: 's3', text: 'NOTE', x: 440, y: 305, rotation: 0, layer: 1 },
  ];
  const canvas = {
    strings: onlyCopperText ? allStrings.slice(2) : allStrings,
    attributes: attributes.map((spec) => ({ keyVisible: false, rotation: 0, ...spec })),
  };
  const components = [
    pcbComponent({ id: 'c1', designator: 'R1', x: 440, y: 305, pads: [] }),
    pcbComponent({ id: 'c2', designator: 'C1', x: 700, y: 720, pads: [] }),
    // 没有位号的元件
    pcbComponent({ id: 'c3', designator: undefined, x: 50, y: 50, pads: [] }),
  ];
  let pendingEdit = userEdit;
  return {
    writes,
    canvas,
    api: {
      pcb_Primitive: { getPrimitivesBBox: bboxLookup(boxes) },
      pcb_PrimitiveString: {
        getAll: async (layer) =>
          canvas.strings.filter((r) => layer === undefined || r.layer === layer).map((r) => pcbString(r, write)),
        modify: async (id, property) => {
          const record = canvas.strings.find((r) => r.id === id);
          // api.js 按 ID 取不到文本时返回 undefined
          if (!record) return undefined;
          return edaModify(pcbString(record, write), property);
        },
      },
      pcb_PrimitiveAttribute: {
        // 照 api.js：摊平全部元件的属性，再按父图元、层、锁定过滤
        getAll: async (parentPrimitiveId, layer, primitiveLock) =>
          canvas.attributes
            .map((r) => pcbAttribute(r, write))
            .filter(
              (a) =>
                (parentPrimitiveId === undefined || a.getState_ParentPrimitiveId() === parentPrimitiveId) &&
                (layer === undefined || a.getState_Layer() === layer) &&
                (primitiveLock === undefined || a.getState_PrimitiveLock() === primitiveLock),
            ),
        modify: async (id, property) => {
          const record = canvas.attributes.find((r) => r.id === id);
          // api.js 按 ID 取不到属性时拿到的是空数组，接着调 isAsync() 就抛了
          if (!record) throw new TypeError('t.isAsync is not a function');
          return edaModify(pcbAttribute(record, write), property);
        },
      },
      pcb_PrimitiveComponent: { getAll: async () => components },
      pcb_PrimitivePad: {
        getAll: async () => {
          pendingEdit?.(canvas);
          pendingEdit = undefined;
          return [pcbPad({ id: 'pad1', padNumber: '1', net: '$1N16', x: 440, y: 305, pad: ['RECT', 80, 50, 0] })];
        },
      },
      pcb_PrimitiveVia: {
        getAll: async () => [pcbVia({ id: 'via1', net: 'GND', x: 200, y: 200, diameter: 24 })],
      },
      // 板框：getBoardBoundingBox 按层 11 取线
      pcb_PrimitiveLine: {
        getAll: async (net, layer) =>
          layer === 11 ? [pcbLine({ id: 'outline', net: '', from: [0, 0], to: [1000, 0] })] : [],
      },
    },
  };
}

test('丝印冲突按真实 getter 和 EDA 外框判定，只收丝印层上的文本', { skip }, async () => {
  const m = silkBoardMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_silkscreens', { includeConflicts: true });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(
    reply.data.silkscreens.map((s) => s.primitiveId),
    ['s1', 's2'],
    '铜皮层上的文字不算丝印',
  );
  const [s1, s2] = reply.data.silkscreens;
  assert.equal(s1.text, 'R1');
  assert.equal(s1.x, 474);
  assert.equal(s1.y, 334);
  assert.equal(s1.layer, 3);
  assert.deepEqual(s1.bbox, { minX: 462, minY: 326, maxX: 486, maxY: 342 });
  assert.equal('parentPrimitiveId' in s1, false, '文本图元没有父图元，不该给一个恒为空的字段');
  assert.deepEqual(
    s1.conflicts.map((c) => `${c.type}:${c.targetId}:${c.net}`),
    ['overlap_pad:pad1:$1N16'],
  );
  assert.deepEqual(
    s2.conflicts.map((c) => `${c.type}:${c.targetId}:${c.net}`),
    ['overlap_via:via1:GND'],
  );

  const auto = await runCommand(runtime, state, 'auto_silkscreen');
  assert.equal(auto.ok, true, auto.error);
  assert.deepEqual(m.writes.map((w) => w.id).sort(), ['s1', 's2']);
  for (const d of auto.data.details) assert.equal(d.to.score, 0, `${d.primitiveId} 挪完还压着东西`);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('焊盘或过孔取不到外框时直接报错，不许拿猜的框去判丝印冲突', { skip }, async () => {
  // NaN 外框在 boxIntersects 里所有比较都不成立，会被当成和什么都冲突
  for (const [options, expected] of [
    [{ withoutBox: 'pad1' }, '焊盘 pad1 取不到外框'],
    [{ withoutBox: 'via1' }, '过孔 via1 取不到外框'],
    [{ nanBox: 'pad1' }, '焊盘 pad1 取不到外框'],
  ]) {
    const m = silkBoardMock(options);
    const { runtime, state } = boot({ extraApi: m.api });
    await runtime.call('activate', 'onStartupFinished');

    const reply = await runCommand(runtime, state, 'get_silkscreens', { includeConflicts: true });
    assert.equal(reply.ok, false, `${JSON.stringify(options)} 时不该判出一份冲突结果`);
    assert.match(reply.error, new RegExp(expected));
    delete globalThis.__JLC_BRIDGE_HUB_V2__;
  }
});

test('丝印层上没有文本时就是 0 条，不拿别的层的文本充数', { skip }, async () => {
  // 原来顶层、底层丝印读不到文本时，会把所有层的文本都当成丝印返回。
  // 这时也没有东西要判冲突，不该去取焊盘外框：pad1 故意取不到外框，取了就会报错。
  const m = silkBoardMock({ onlyCopperText: true, withoutBox: 'pad1' });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_silkscreens', { includeConflicts: true });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(reply.data.silkscreens, []);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('位号这类元件属性也算丝印，带上所属元件，自动避让时写回属性图元', { skip }, async () => {
  const m = silkBoardMock({ attributes: SILK_ATTRIBUTES });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_silkscreens', { includeConflicts: true });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(
    reply.data.silkscreens.map((s) => s.primitiveId),
    ['s1', 's2', 'a1', 'a4', 'a7'],
    '隐藏的、不在丝印层的、显示出来没有字的属性都不算丝印',
  );
  const byId = Object.fromEntries(reply.data.silkscreens.map((s) => [s.primitiveId, s]));
  assert.equal(byId.s1.kind, 'string');
  assert.equal('parentPrimitiveId' in byId.s1, false, '文本图元没有父图元');

  const a1 = byId.a1;
  assert.equal(a1.kind, 'attribute');
  assert.equal(a1.text, 'R1');
  assert.equal(a1.key, 'Designator');
  assert.equal(a1.parentPrimitiveId, 'c1');
  assert.equal(a1.designator, 'R1');
  assert.equal(a1.x, 440);
  assert.equal(a1.y, 290);
  assert.equal(a1.layer, 3);
  assert.deepEqual(a1.bbox, { minX: 430, minY: 284, maxX: 450, maxY: 296 });
  assert.deepEqual(
    a1.conflicts.map((c) => `${c.type}:${c.targetId}:${c.net}`),
    ['overlap_pad:pad1:$1N16'],
  );
  assert.equal(byId.a4.designator, 'C1');
  assert.equal(byId.a4.layer, 4);
  assert.deepEqual(byId.a4.conflicts, []);
  assert.equal(byId.a7.text, 'Tolerance:1%', 'Key 和 Value 都显示时画布上是「Key:Value」');

  const auto = await runCommand(runtime, state, 'auto_silkscreen');
  assert.equal(auto.ok, true, auto.error);
  assert.deepEqual(
    m.writes.filter((w) => w.type === 'Attribute').map((w) => w.id),
    ['a1'],
    '压着焊盘的位号要挪，写回的是属性图元',
  );
  assert.deepEqual(
    m.writes.filter((w) => w.type === 'String').map((w) => w.id).sort(),
    ['s1', 's2'],
  );
  const a1Detail = auto.data.details.find((d) => d.primitiveId === 'a1');
  assert.equal(a1Detail.designator, 'R1');
  assert.equal(a1Detail.to.score, 0, 'a1 挪完还压着东西');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('pcb_move_silkscreen 按 primitiveId 分辨属性和文本，写回对应的图元', { skip }, async () => {
  const m = silkBoardMock({ attributes: SILK_ATTRIBUTES });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const attr = await runCommand(runtime, state, 'move_silkscreen', { primitiveId: 'a1', x: 440, y: 250, rotation: 90 });
  assert.equal(attr.ok, true, attr.error);
  assert.equal(attr.data.kind, 'attribute');
  assert.deepEqual(m.writes, [{ id: 'a1', type: 'Attribute', x: 440, y: 250, rotation: 90 }]);

  const keep = await runCommand(runtime, state, 'move_silkscreen', { primitiveId: 'a4', x: 720, y: 700 });
  assert.equal(keep.ok, true, keep.error);
  assert.deepEqual(m.writes[1], { id: 'a4', type: 'Attribute', x: 720, y: 700, rotation: 180 }, '没传角度就不动角度');

  const str = await runCommand(runtime, state, 'move_silkscreen', { primitiveId: 's1', x: 500, y: 400 });
  assert.equal(str.ok, true, str.error);
  assert.equal(str.data.kind, 'string');
  assert.deepEqual(m.writes[2], { id: 's1', type: 'String', x: 500, y: 400, rotation: 0 });

  const missing = await runCommand(runtime, state, 'move_silkscreen', { primitiveId: 'nope', x: 0, y: 0 });
  assert.equal(missing.ok, false, '找不到的图元不许报成功');
  assert.match(missing.error, /nope/);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('丝印层上的属性取不到外框时直接报错并写出位号', { skip }, async () => {
  const m = silkBoardMock({ attributes: SILK_ATTRIBUTES, withoutBox: 'a1' });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_silkscreens');
  assert.equal(reply.ok, false, '位号没有外框时不该给出一份丝印列表');
  assert.match(reply.error, /R1/);
  assert.match(reply.error, /a1 取不到外框/);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('EDA 拒绝写回丝印时，挪动和自动避让都要报错，不许报成功', { skip }, async () => {
  // pcb_PrimitiveAttribute.modify 调 done() 不 await：EDA 拒绝写入时它照样返回对象，
  // 原来的代码因此把没挪成的位号报成挪好了。
  for (const [action, params] of [
    ['move_silkscreen', { primitiveId: 'a1', x: 440, y: 250 }],
    ['auto_silkscreen', {}],
  ]) {
    const m = silkBoardMock({ attributes: SILK_ATTRIBUTES, rejectWrite: 'a1' });
    const { runtime, state } = boot({ extraApi: m.api });
    await runtime.call('activate', 'onStartupFinished');

    const reply = await runCommand(runtime, state, action, params);
    assert.equal(reply.ok, false, `${action}：EDA 没写进去却报了成功`);
    assert.match(reply.error, /无法应用到画布/);
    delete globalThis.__JLC_BRIDGE_HUB_V2__;
  }
});

test('自动避让写回前重新读画布，不把用户刚改的位号写回旧值', { skip }, async () => {
  // done() 发的是对象的全部字段。自动避让先查丝印，再查冲突、取外框、逐个打分，最后才写回；
  // 用查询时的旧对象写回，会把用户在这段时间里改过的位号（R1 → R9）写回 R1。
  const m = silkBoardMock({
    attributes: SILK_ATTRIBUTES,
    userEdit: (canvas) => {
      canvas.attributes.find((r) => r.id === 'a1').value = 'R9';
    },
  });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const auto = await runCommand(runtime, state, 'auto_silkscreen');
  assert.equal(auto.ok, true, auto.error);
  assert.ok(
    m.writes.some((w) => w.id === 'a1'),
    'a1 压着焊盘，应该被挪过',
  );
  assert.equal(m.canvas.attributes.find((r) => r.id === 'a1').value, 'R9', '用户改过的位号被旧对象写回去了');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('丝印层上的属性认不出所属元件、元件没有位号、显示着却没有坐标时直接报错', { skip }, async () => {
  for (const [extra, pattern] of [
    [{ id: 'a8', parentId: 'ghost', key: 'Designator', value: 'X9', valueVisible: true, x: 100, y: 100, layer: 3 }, /ghost 不在元件列表里/],
    [{ id: 'a9', parentId: 'c3', key: 'Value', value: '4.7k', valueVisible: true, x: 60, y: 60, layer: 3 }, /c3 没有位号/],
    [{ id: 'a10', parentId: 'c1', key: 'Comment', value: 'DNP', valueVisible: true, x: null, y: null, layer: 3 }, /没有坐标/],
  ]) {
    const m = silkBoardMock({ attributes: [...SILK_ATTRIBUTES, extra] });
    const { runtime, state } = boot({ extraApi: m.api });
    await runtime.call('activate', 'onStartupFinished');

    const reply = await runCommand(runtime, state, 'get_silkscreens');
    assert.equal(reply.ok, false, `${extra.id} 的数据对不上，不该给出一份丝印列表`);
    assert.match(reply.error, pattern);
    delete globalThis.__JLC_BRIDGE_HUB_V2__;
  }
});

// ─── 原理图 ───
//
// 下面这组的 fixture 全部照真机量到的形状造：真实原理图上 sch_PrimitiveComponent.getAll()
// 不加类型参数会返回 311 条，其中只有 164 条是真元件，其余是网络标识/端口/标签这类没有位号的东西。

function schematicMock(options = {}) {
  const calls = { getAll: [], opened: [] };
  const parts = [
    {
      getState_PrimitiveId: () => 'e10',
      getState_Designator: () => 'R15',
      getState_Name: () => '电阻',
      getState_X: () => 100,
      getState_Y: () => 200,
      getState_Rotation: () => 0,
      getState_OtherProperty: () => ({ Value: '100K', 封装: 'R0603' }),
      getState_Component: () => ({ libraryUuid: 'lib1', uuid: 'dev1', name: '100K' }),
      getState_Footprint: () => ({ libraryUuid: 'lib1', uuid: 'fp1', name: 'R0603' }),
      getState_ManufacturerId: () => 'RC0603FR-07100KL',
    },
    // 没有位号的标识类图元：不加类型参数时 getAll 会把这些也返回
    { getState_PrimitiveId: () => 'e11', getState_Designator: () => '' },
    { getState_PrimitiveId: () => 'e12', getState_Designator: () => undefined },
  ];

  // 当前打开的文档。openDocument 会真的改它 —— 扩展切完页之后要轮询等加载完，
  // mock 不跟着变的话会一直等下去。
  const current = { documentType: options.docType ?? 1, uuid: 'page1' };

  return {
    calls,
    current,
    api: {
      dmt_SelectControl: {
        getCurrentDocumentInfo: async () => ({ ...current }),
      },
      dmt_Board: {
        getCurrentBoardInfo: async () => ({
          schematic: { uuid: 'sch1', page: [{ uuid: 'page1', name: 'p1' }] },
        }),
      },
      dmt_EditorControl: {
        openDocument: async (uuid) => {
          calls.opened.push(uuid);
          current.documentType = 1;
          current.uuid = uuid;
        },
      },
      sch_PrimitiveComponent: {
        getAll: async (type, allPages) => {
          calls.getAll.push({ type, allPages });
          return parts;
        },
      },
      sch_Net: {
        getAllNets: async () => [
          { net: 'GND', wires: [{ pageName: 'p1' }, { pageName: 'p2' }] },
          { net: '+5V', wires: [{ pageName: 'p1' }] },
        ],
      },
      sch_Drc: { check: async () => [] },
      // 原理图页上恒为空 —— 真机量到 0 条，原来就是读它才「读不出网络」
      sch_PrimitivePin: { getAll: async () => [] },
    },
  };
}

async function runCommand(runtime, state, action, params = {}, waitMs = 80) {
  state.ws.sent.length = 0;
  state.ws.onMessage({ data: JSON.stringify({ v: 2, t: 'cmd', id: 'q', action, params }) });
  // 切文档那条路里有 600ms 的加载等待，等太短会拿到 undefined
  const deadline = Date.now() + waitMs;
  let reply;
  do {
    await sleep(40);
    reply = state.ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === 'res');
  } while (!reply && Date.now() < deadline);
  return reply;
}

test('原理图元件：只取真元件，位号/值/库引用都读得出来', { skip }, async () => {
  const m = schematicMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_schematic_state');
  assert.equal(reply.ok, true, reply.error);

  // 不传 'part' 的话会混进一堆没有位号的标识图元 —— 真机上 311 里只有 164 条是真元件
  assert.deepEqual(m.calls.getAll[0], { type: 'part', allPages: true });

  assert.equal(reply.data.componentCount, 1);
  assert.equal(reply.data.skippedNonPartSymbols, 2);

  const r15 = reply.data.components[0];
  assert.equal(r15.designator, 'R15');
  assert.equal(r15.value, '100K', 'EDA 没有 getState_Value()，值在 otherProperty 里');
  assert.equal(r15.component.uuid, 'dev1', '库引用要从 getState_Component() 取');
  assert.equal(r15.footprint.uuid, 'fp1');
  assert.equal(r15.manufacturerId, 'RC0603FR-07100KL');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('原理图网络走 sch_Net，不走恒为空的引脚接口', { skip }, async () => {
  const m = schematicMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_schematic_state');
  assert.equal(reply.data.netCount, 2);
  assert.deepEqual(
    reply.data.nets.map((n) => n.name),
    ['GND', '+5V'],
  );
  assert.deepEqual(reply.data.nets[0].pages, ['p1', 'p2']);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('当前是 PCB 页时自动切到原理图，而不是回一句 doctype(3)', { skip }, async () => {
  // EDMT_EditorDocumentType.PCB = 3。原理图的 API 在 PCB 页上会被 EDA 直接挡回来，
  // 错误写着 "doctype(3) not support"，光看这句完全猜不到是标签页不对。
  const m = schematicMock({ docType: 3 });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_schematic_state', {}, 2000);
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(m.calls.opened, ['page1'], '应该先切到原理图第一页');
  assert.equal(reply.data.switchedToSchematic, true, '切了要说出来，不能偷偷切');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('原理图 DRC 也会先切过去', { skip }, async () => {
  const m = schematicMock({ docType: 3 });
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'run_sch_drc', {}, 2000);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.data.passed, true);
  assert.deepEqual(m.calls.opened, ['page1']);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('切页之后要等文档加载完再读，不能定长 sleep', { skip }, async () => {
  // 真机上栽过：切完页只等 600ms 就读，getAll 只返回 49 个元件；
  // 等加载完再读是 164 个。少掉的那些不报错，就是静悄悄地没有。
  const m = schematicMock({ docType: 3 });
  let ready = false;
  const full = [
    {
      getState_PrimitiveId: () => 'e1',
      getState_Designator: () => 'U1',
      getState_OtherProperty: () => ({}),
    },
    {
      getState_PrimitiveId: () => 'e2',
      getState_Designator: () => 'U2',
      getState_OtherProperty: () => ({}),
    },
    {
      getState_PrimitiveId: () => 'e3',
      getState_Designator: () => 'U3',
      getState_OtherProperty: () => ({}),
    },
  ];
  // 刚切过去时只能读到一部分，过一会儿才全
  m.api.sch_PrimitiveComponent.getAll = async (type, allPages) => {
    m.calls.getAll.push({ type, allPages });
    return ready ? full : full.slice(0, 1);
  };
  setTimeout(() => {
    ready = true;
  }, 400);

  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_schematic_state', {}, 5000);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.data.componentCount, 3, '应该等到加载完再读，而不是拿半截数据');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('sch_Net 为空时，网络从网络标签/导线兜底取', { skip }, async () => {
  // EDA 3.2.166 上 sch_Net.getAllNets() 实测返回空数组（接口标着 @alpha）。
  const m = schematicMock();
  m.api.sch_Net = { getAllNets: async () => [] }; // 官方接口给不出东西
  const netSymbols = {
    netlabel: [{ getState_Net: () => 'VMCU-3.3V' }, { getState_Net: () => 'GND' }],
    netflag: [{ getState_Net: () => 'GND' }],
    netport: [],
  };
  const origGetAll = m.api.sch_PrimitiveComponent.getAll;
  m.api.sch_PrimitiveComponent.getAll = async (type, allPages) => {
    if (netSymbols[type]) return netSymbols[type];
    return origGetAll(type, allPages);
  };

  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_schematic_state');
  assert.equal(reply.data.netSource, 'netLabels');
  assert.equal(reply.data.netScope, 'allPages', '网络标识类图元能跨图页拿');
  assert.deepEqual(
    reply.data.nets.map((n) => n.name).sort(),
    ['GND', 'VMCU-3.3V'],
  );
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('网表走 getNetlistFile，不碰已废弃且会卡死的 getNetlist', { skip }, async () => {
  const m = schematicMock();
  let deprecatedCalled = false;
  m.api.sch_Netlist = {
    getNetlist: async () => {
      deprecatedCalled = true;
      return new Promise(() => {}); // 真机行为：永远不返回
    },
  };
  m.api.sch_ManufactureData = {
    getNetlistFile: async (name, type) => ({ text: async () => `(netlist ${type})` }),
  };

  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_netlist', { raw: true }, 3000);
  assert.equal(reply.ok, true, reply.error);
  assert.match(reply.data.netlist, /netlist JLCEDA/);
  assert.equal(deprecatedCalled, false, '绝不能退回去调那个会卡死的废弃接口');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('网表默认只给概览，不把 35 万字符原文丢回来', { skip }, async () => {
  // 真机上整份网表 356687 字符，直接返回会把调用方的上下文撑爆。
  const m = schematicMock();
  const netlistJson = JSON.stringify({
    version: '2.0.0',
    components: {
      gge1: {
        props: { Designator: 'U1' },
        pinInfoMap: {
          1: { number: '1', name: 'VBAT', net: '' },
          2: { number: '2', name: 'PC13', net: 'PC13' },
          3: { number: '3', name: 'VSS', net: 'GND' },
        },
      },
      gge2: {
        props: { Designator: 'C1' },
        pinInfoMap: {
          1: { number: '1', name: '', net: 'GND' },
          2: { number: '2', name: '', net: '+5V' },
        },
      },
    },
  });
  m.api.sch_ManufactureData = {
    getNetlistFile: async () => ({ text: async () => netlistJson }),
  };
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  // 默认：概览，不带原文
  const overview = await runCommand(runtime, state, 'get_netlist', {}, 3000);
  assert.equal(overview.data.format, 'json');
  assert.equal(overview.data.componentCount, 2);
  assert.equal(overview.data.netCount, 3);
  assert.equal(overview.data.netlist, undefined, '默认不该带原文');
  assert.deepEqual(overview.data.nets[0], { name: 'GND', pinCount: 2 }, '按引脚数从多到少');

  // 点名要某个网络：把引脚清单摊开
  const gnd = await runCommand(runtime, state, 'get_netlist', { nets: ['gnd'] }, 3000);
  assert.equal(gnd.data.nets.length, 1);
  assert.deepEqual(
    gnd.data.nets[0].pins.map((p) => `${p.designator}.${p.pin}`).sort(),
    ['C1.1', 'U1.3'],
  );

  // 点名要某个元件：给它每个引脚接到哪儿
  const u1 = await runCommand(runtime, state, 'get_netlist', { designators: ['U1'] }, 3000);
  assert.equal(u1.data.components.length, 1);
  assert.equal(u1.data.components[0].pins.length, 3);
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('includeProperties:false 时 value 仍然要有', { skip }, async () => {
  // 值藏在 otherProperty 里（EDA 没有 getState_Value()），
  // 不能因为「不要属性表」就把值也一起吞掉 —— 真机上就是这么全空的。
  const m = schematicMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const reply = await runCommand(runtime, state, 'get_schematic_state', {
    includeProperties: false,
  });
  assert.equal(reply.data.components[0].value, '100K');
  assert.equal(reply.data.components[0].properties, undefined, '属性表本身不该带回来');
  assert.equal(reply.data.totalComponents, 1, '过滤前的总数也要报');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('EDA 的接口卡死时，扩展自己超时并说清是哪个动作', { skip }, async () => {
  // 不加这道闸的话，一条卡死的命令会把整条链路占满 60 秒，别的命令也发不动。
  const { runtime, state } = boot({
    extraApi: { pcb_PrimitiveComponent: { getAll: () => new Promise(() => {}) } },
  });
  await runtime.call('activate', 'onStartupFinished');

  const hub = getHubState();
  assert.ok(hub, 'hub 应该在');
  // 45 秒的真超时不适合放进单测，这里只钉住「有这道闸、且报的是动作名」
  const src = (await import('node:fs')).readFileSync(BUNDLE, 'utf8');
  assert.match(src, /45e3|45_?000/, '注册表里应该有命令级超时（esbuild 会把 45_000 压成 45e3）');
  assert.match(src, /\\u8FD8\\u6CA1\\u8FD4\\u56DE|还没返回/, '超时消息要点名是哪个动作');
  delete globalThis.__JLC_BRIDGE_HUB_V2__;
});

test('按位号过滤原理图元件', { skip }, async () => {
  const m = schematicMock();
  const { runtime, state } = boot({ extraApi: m.api });
  await runtime.call('activate', 'onStartupFinished');

  const hit = await runCommand(runtime, state, 'get_schematic_state', { designators: ['r15'] });
  assert.equal(hit.data.componentCount, 1, '位号过滤要忽略大小写');

  const miss = await runCommand(runtime, state, 'get_schematic_state', { designators: ['U99'] });
  assert.equal(miss.data.componentCount, 0);
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
