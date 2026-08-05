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

  const reply = await runCommand(runtime, state, 'get_netlist', {}, 3000);
  assert.equal(reply.ok, true, reply.error);
  assert.match(reply.data.netlist, /netlist JLCEDA/);
  assert.equal(deprecatedCalled, false, '绝不能退回去调那个会卡死的废弃接口');
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
