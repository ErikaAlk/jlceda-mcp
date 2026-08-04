// 把 dist/index.js 当真正的 MCP server 拉起来，走 stdio 问它话。
//
// 单元测试覆盖不到这一层：它验的是「构建产物能被 Claude Code 正常加载」。
// 其中「stdout 必须是干净的 JSON-RPC」那条最重要——往 stdout 写一个字节，
// Claude Code 那边就解析失败，而且报的错和真正的原因八竿子打不着。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, 'dist', 'index.js');
const skip = existsSync(entry) ? false : '还没构建，先跑 npm run build';

/** 起一个 server，问完话就杀掉 */
async function ask(env = {}) {
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // 用一个没人占的端口，免得和真在跑的 broker 打架
    env: { ...process.env, JLC_BRIDGE_PORT: '18921', ...env },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  await new Promise((r) => setTimeout(r, 2500));
  child.kill();

  const rawLines = stdout.split('\n').filter(Boolean);
  const parsed = [];
  for (const line of rawLines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      /* 留给下面的断言去发现 */
    }
  }
  return { rawLines, parsed, stderr };
}

test('stdout 必须是干净的 JSON-RPC，一个字节的杂音都不能有', { skip }, async () => {
  const { rawLines, parsed } = await ask();
  assert.equal(
    parsed.length,
    rawLines.length,
    `stdout 里有 ${rawLines.length - parsed.length} 行不是 JSON —— 日志一律走 stderr`,
  );
});

test('能握手并列出全部工具', { skip }, async () => {
  const { parsed } = await ask();
  const init = parsed.find((m) => m.id === 0);
  assert.equal(init?.result?.serverInfo?.name, 'jlceda');

  const tools = parsed.find((m) => m.id === 1)?.result?.tools ?? [];
  assert.ok(tools.length >= 38, `只列出了 ${tools.length} 个工具`);

  const names = new Set(tools.map((t) => t.name));
  for (const must of ['pcb_ping', 'pcb_get_state', 'bridge_status', 'calc_impedance']) {
    assert.ok(names.has(must), `缺少工具 ${must}`);
  }
});

test('启动时自己就把 broker 拉起来了（不需要额外启动任何东西）', { skip }, async () => {
  const { stderr } = await ask();
  assert.match(stderr, /broker 已监听/);
  assert.match(stderr, /当选 broker/);
});

test('旧配置里的 GATEWAY_WS_URL 端口仍然认', { skip }, async () => {
  // v0.1 的 ~/.claude.json 写的是完整 URL。只认新变量的话，
  // 改过端口的人会被静默退回 18800 —— 又一个不报错但结果是错的坑。
  const { stderr } = await ask({
    JLC_BRIDGE_PORT: '',
    GATEWAY_WS_URL: 'ws://127.0.0.1:18922/ws/bridge',
  });
  assert.match(stderr, /18922/);
});
