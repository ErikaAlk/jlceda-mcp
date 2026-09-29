// 保真度最高的一条：**真实扩展产物 + 真实 WebSocket + 真实 broker**，
// 按用户报的顺序来 —— 先起「EDA」，Claude Code 后起。
//
// 前两层测试各自只验一半：extension.test.mjs 的 socket 是假的，
// broker.test.mjs 的 EDA 是假的。这条把两半接起来，唯一缺的只有 EDA 本体。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { createEdaRuntime, createEdaMock } from './eda-sandbox.mjs';
import { startBroker } from '../dist/broker.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, '..', 'jlc-bridge', 'dist', 'index.js');
const skip = existsSync(BUNDLE) ? false : '扩展还没打包，先跑 npm run build:ext';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 现取一个空闲端口。写死端口的话，本机只要有别的程序占着它，
 * 第 ① 步「EDA 先起、端口上没有任何人」就不成立，broker 也起不来（EADDRINUSE）。
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 用真 socket 实现 sys_WebSocket，但**照 EDA 的语义**来：
 * 连不上时什么回调都不给（node 的 ws 会 emit 'error'，这里故意吞掉）——
 * 这正是扩展必须靠超时自救的原因，不模拟准的话测了也白测。
 */
function realWebSocketApi(state) {
  const conns = new Map();
  return {
    register(id, url, onMessage, onConnected) {
      const existing = conns.get(id);
      if (existing && (existing.readyState === 0 || existing.readyState === 1)) {
        onConnected?.(); // EDA 复用已有连接时就是立刻回调（CONNECTING 也算）
        return;
      }
      if (existing) {
        try {
          existing.terminate();
        } catch {
          /* ignore */
        }
        conns.delete(id);
      }
      const ws = new WebSocket(url);
      conns.set(id, ws);
      state.registerCount += 1;
      ws.on('open', () => onConnected?.());
      ws.on('message', (raw) => onMessage?.({ data: raw.toString() }));
      ws.on('error', () => {
        /* EDA 不会把错误透给扩展，这里也不透 */
      });
      ws.on('close', () => {
        /* 同上：扩展收不到任何 close 通知 */
      });
    },
    send(id, data) {
      const ws = conns.get(id);
      if (!ws) throw new Error('错误：WebSocket 连接不存在！');
      if (ws.readyState !== 1) throw new Error('错误：WebSocket 数据发送失败！');
      ws.send(data);
    },
    close(id) {
      const ws = conns.get(id);
      if (ws) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        conns.delete(id);
      }
    },
    _dispose() {
      for (const ws of conns.values()) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      conns.clear();
    },
  };
}

test('先开 EDA、后开 Claude Code：真 socket 上也能自己连上并跑通命令', { skip }, async (t) => {
  const port = await freePort();
  const linkState = { registerCount: 0 };
  const ws = realWebSocketApi(linkState);

  const { eda, state, dispose } = createEdaMock({
    extraApi: {
      sys_WebSocket: ws,
      // 让 get_state 有东西可读，好证明命令真的端到端跑通了
      pcb_PrimitiveComponent: {
        getAll: async () => [
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
            getState_Pads: () => [],
          },
        ],
      },
      pcb_Net: { getAllNetsName: async () => ['GND'], getNetLength: async () => 1 },
    },
    config: { bridgePort: port },
  });

  let broker;
  t.after(async () => {
    ws._dispose();
    dispose();
    await broker?.close();
    delete globalThis.__JLC_BRIDGE_HUB_V2__;
  });

  // ① 「EDA」先起来，此时这个端口上没有任何人
  const runtime = createEdaRuntime(BUNDLE, eda);
  await runtime.call('activate', 'onStartupFinished');
  await sleep(4500);

  assert.equal(globalThis.__JLC_BRIDGE_HUB_V2__.phase !== 'online', true, '这会儿不该是已连接');
  assert.ok(linkState.registerCount >= 2, `应该在反复重试，实际只试了 ${linkState.registerCount} 次`);

  // ② Claude Code 起来了
  broker = await startBroker({ port });
  await sleep(3000);

  assert.equal(
    globalThis.__JLC_BRIDGE_HUB_V2__.phase,
    'online',
    '对端一出现，扩展就该自己连上（全程没有任何人工操作）',
  );
  assert.ok(broker.edaInfo(), 'broker 那边也应该看得到 EDA 接入了');

  // ③ 真发一条命令，验证整条链路是活的
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge`);
  await new Promise((r) => client.on('open', r));
  client.send(JSON.stringify({ v: 2, t: 'hello', role: 'mcp', name: 'test' }));

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('命令超时')), 5000);
    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'res' && msg.id === 'live-1') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    client.send(JSON.stringify({ v: 2, t: 'cmd', id: 'live-1', action: 'get_state', params: {} }));
  });

  assert.equal(reply.ok, true, `命令失败：${reply.error}`);
  assert.equal(reply.data.componentCount, 1);
  assert.equal(reply.data.components[0].designator, 'U1');
  client.close();
});
