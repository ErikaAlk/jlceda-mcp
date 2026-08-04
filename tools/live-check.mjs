// 真机自检：对着**真正开着的 嘉立创EDA** 跑一遍，验证整条链路。
//
//   node tools/live-check.mjs            跑一次
//   node tools/live-check.mjs --watch    每 5 秒跑一次，直到通过（改完扩展在这儿盯着最省事）
//
// 单元测试证明的是「代码逻辑对」，这个证明的是「装到 EDA 里之后真的能用」。
// 两者都要有：沙箱测试骗不了自己，但也发现不了「扩展没装上」「权限没勾」这类问题。

import { startBroker } from '../dist/broker.js';
import { BridgeLink } from '../dist/link.js';
import { resolvePort } from '../dist/protocol.js';

const watch = process.argv.includes('--watch');
const port = resolvePort();
const quiet = process.argv.includes('--quiet');

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

async function ensureBroker() {
  try {
    const handle = await startBroker({ port, log: quiet ? () => {} : (m) => console.log(`  · ${m}`) });
    return { handle, owned: true };
  } catch (err) {
    if (err?.code === 'EADDRINUSE') return { handle: null, owned: false };
    throw err;
  }
}

async function runOnce() {
  const checks = [];
  const record = (name, passed, detail) => {
    checks.push({ name, passed, detail });
    (passed ? ok : bad)(`${name}${detail ? ` —— ${detail}` : ''}`);
  };

  const { handle, owned } = await ensureBroker();
  const link = new BridgeLink(() => {});

  try {
    record(
      'broker 就位',
      true,
      owned ? `本进程监听 ${port}` : `复用别的进程在 ${port} 上的 broker`,
    );

    // 1) 扩展有没有连进来
    const pong = await link.command('ping');
    record('嘉立创EDA 扩展已连通', Boolean(pong?.message === 'pong'), `扩展 v${pong?.bridgeVersion}`);

    // 2) 能不能真的读到板子（证明扩展和 EDA 之间也是通的，不只是网络通）
    const state = await link.command('get_state');
    const componentCount = Number(state?.componentCount ?? 0);
    record(
      '能读到当前 PCB',
      componentCount > 0,
      componentCount > 0
        ? `${componentCount} 个元件 / ${state.netCount} 条网络`
        : '读到 0 个元件 —— EDA 里打开一个 PCB 再试',
    );

    // 3) 能力探测：这台 EDA 到底支持哪些写操作
    const features = await link.command('get_feature_support');
    record('能力探测正常', Boolean(features?.bridgeVersion), `丝印修改=${features?.silkscreen?.modify}`);

    // 4) 错误路径也要是人话，不能是 undefined
    let errorText = '';
    try {
      await link.command('no_such_action_at_all');
    } catch (err) {
      errorText = err.message;
    }
    record('未知命令报的是人话', /no_such_action_at_all/.test(errorText), errorText.slice(0, 60));
  } catch (err) {
    record('链路检查', false, err.message.split('\n')[0]);
  } finally {
    await link.close();
    if (handle) await handle.close();
  }

  const failed = checks.filter((c) => !c.passed);
  return { checks, failed };
}

async function main() {
  let round = 0;
  for (;;) {
    round += 1;
    console.log(`\n=== 真机自检 #${round} ${new Date().toLocaleTimeString()} ===`);
    const { checks, failed } = await runOnce();

    if (failed.length === 0) {
      console.log(`\n全部通过（${checks.length} 项）。整条链路是通的。`);
      process.exit(0);
    }

    console.log(`\n${failed.length}/${checks.length} 项没过。`);
    if (!watch) process.exit(1);
    console.log('5 秒后重试（Ctrl+C 退出）…');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch((err) => {
  console.error('自检本身崩了：', err);
  process.exit(2);
});
