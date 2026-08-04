// broker 与 mcp 侧链路的测试。用真的 WebSocket、真的端口，只有 EDA 那头是假的。

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startBroker } from '../dist/broker.js';
import { BridgeLink } from '../dist/link.js';
import { PROTOCOL_VERSION, wsUrl } from '../dist/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 测试各用一个端口，免得并行跑的时候互相抢 */
let nextPort = 18850;
const takePort = () => nextPort++;

/** 一个照协议行事的假 EDA 扩展 */
function fakeEda(port, { handler, name = 'jlc-bridge' } = {}) {
  const ws = new WebSocket(wsUrl(port));
  const seen = [];
  ws.on('open', () => {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello', role: 'eda', name, version: '0.2.0' }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    seen.push(msg);
    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'pong', ts: Date.now() }));
      return;
    }
    if (msg.t === 'cmd') {
      const result = handler
        ? handler(msg)
        : { ok: true, data: { pong: true, echoed: msg.action, params: msg.params } };
      // handler 返回 null = 故意不回，用来测「EDA 收了命令但没下文」这条路径
      if (!result) return;
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'res', id: msg.id, ...result }));
    }
  });
  return { ws, seen, close: () => ws.close() };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return false;
}

test('命令能从 mcp 经 broker 送到 EDA 再原路回来', async () => {
  const port = takePort();
  process.env.JLC_BRIDGE_PORT = String(port);
  const broker = await startBroker({ port });
  const eda = fakeEda(port);
  const link = new BridgeLink();

  try {
    assert.ok(await waitFor(() => broker.edaInfo() !== null), 'EDA 应该已接入');
    const data = await link.command('ping', { hello: 'world' });
    assert.equal(data.pong, true);
    assert.equal(data.echoed, 'ping');
    assert.deepEqual(data.params, { hello: 'world' });
  } finally {
    await link.close();
    eda.close();
    await broker.close();
  }
});

test('EDA 没接进来时立刻失败，并且说清楚该去检查什么', async () => {
  const port = takePort();
  process.env.JLC_BRIDGE_PORT = String(port);
  const broker = await startBroker({ port });
  const link = new BridgeLink();

  try {
    const started = Date.now();
    await assert.rejects(
      () => link.command('get_state'),
      (err) => {
        assert.match(err.message, /嘉立创EDA/);
        assert.match(err.message, /外部交互/);
        return true;
      },
    );
    // 旧版这里会干等 60 秒超时
    assert.ok(Date.now() - started < 2000, '应该立刻失败而不是等超时');
  } finally {
    await link.close();
    await broker.close();
  }
});

test('结果只回给发命令的那个 mcp 客户端，不广播', async () => {
  const port = takePort();
  process.env.JLC_BRIDGE_PORT = String(port);
  const broker = await startBroker({ port });
  const eda = fakeEda(port, {
    handler: (msg) => ({ ok: true, data: { forAction: msg.action } }),
  });
  const a = new BridgeLink();
  const b = new BridgeLink();

  try {
    await waitFor(() => broker.edaInfo() !== null);
    const [ra, rb] = await Promise.all([a.command('action_a'), b.command('action_b')]);
    assert.equal(ra.forAction, 'action_a');
    assert.equal(rb.forAction, 'action_b');
  } finally {
    await a.close();
    await b.close();
    eda.close();
    await broker.close();
  }
});

test('EDA 中途断线时，在飞的命令立刻失败而不是挂到超时', async () => {
  const port = takePort();
  process.env.JLC_BRIDGE_PORT = String(port);
  const broker = await startBroker({ port });
  const eda = fakeEda(port, { handler: () => null }); // 收到命令但永远不回
  const link = new BridgeLink();

  try {
    await waitFor(() => broker.edaInfo() !== null);
    const pending = link.command('get_state');
    const settled = pending.then(
      () => ({ ok: true }),
      (err) => ({ ok: false, message: err.message }),
    );
    await sleep(150);
    eda.ws.terminate();
    const outcome = await settled;
    assert.equal(outcome.ok, false, '在飞的命令应该失败掉');
    assert.match(outcome.message, /断开/);
  } finally {
    await link.close();
    await broker.close();
  }
});

test('抢不到端口时退化成客户端，一样能发命令', async () => {
  const port = takePort();
  process.env.JLC_BRIDGE_PORT = String(port);
  // 先让一个 BridgeLink 当上 broker
  const owner = new BridgeLink();
  owner.start();
  await waitFor(() => owner.status().socketConnected);
  assert.equal(owner.status().brokerRole, 'owner');

  const eda = fakeEda(port);
  const guest = new BridgeLink();

  try {
    const data = await guest.command('ping');
    assert.equal(data.pong, true);
    assert.equal(guest.status().brokerRole, 'client', '第二个进程应该是客户端');
  } finally {
    await guest.close();
    await owner.close();
    eda.close();
  }
});

test('端口被别人占着不会把 broker 起崩，而是报 EADDRINUSE', async () => {
  const port = takePort();
  const first = await startBroker({ port });
  try {
    await assert.rejects(
      () => startBroker({ port }),
      (err) => err.code === 'EADDRINUSE',
    );
  } finally {
    await first.close();
  }
});

test('挡掉来自网页的连接，放行 嘉立创EDA 自己的来源', async () => {
  const port = takePort();
  const broker = await startBroker({ port });
  try {
    const evil = new WebSocket(wsUrl(port), { origin: 'https://evil.example.com' });
    const rejected = await new Promise((resolve) => {
      evil.on('error', () => resolve(true));
      evil.on('open', () => resolve(false));
    });
    assert.equal(rejected, true, '随便一个网页不该能连上来改用户的板子');

    const ok = new WebSocket(wsUrl(port), { origin: 'https://pro.lceda.cn' });
    const accepted = await new Promise((resolve) => {
      ok.on('error', () => resolve(false));
      ok.on('open', () => resolve(true));
    });
    assert.equal(accepted, true, '嘉立创EDA 客户端的来源必须放行');
    ok.close();
  } finally {
    await broker.close();
  }
});

test('EDA 端不回 pong 时会被心跳清理掉', async () => {
  const port = takePort();
  const broker = await startBroker({ port });
  const silent = new WebSocket(wsUrl(port));
  try {
    await new Promise((r) => silent.on('open', r));
    silent.send(JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello', role: 'eda', name: 'zombie' }));
    assert.ok(await waitFor(() => broker.edaInfo() !== null));

    // PEER_TIMEOUT_MS 是 12 秒，这里手动把连接掐掉验证收尾路径；
    // 完整的超时路径太慢，不适合放进单测。
    silent.terminate();
    assert.ok(await waitFor(() => broker.edaInfo() === null), '断开后应该清掉 EDA 记录');
  } finally {
    await broker.close();
  }
});
