// 单独跑一个常驻 broker：`npm run broker`
//
// 平时不需要它 —— broker 已经内嵌在 mcp-server 里，起 Claude Code 就有。
// 它存在只为两种场景：
//   ① 排障时想看链路上到底在跑什么（这里的日志是全的）；
//   ② 想让 嘉立创EDA 的连接在 Claude Code 重启期间也保持不断。

import { startBroker } from './broker.js';
import { resolvePort } from './protocol.js';

const port = resolvePort();
const stamp = () => new Date().toISOString().slice(11, 19);

startBroker({ port, log: (m) => console.log(`[broker ${stamp()}] ${m}`) })
  .then(() => {
    console.log(`[broker ${stamp()}] 就绪。保持这个窗口开着，Ctrl+C 退出。`);
  })
  .catch((err: NodeJS.ErrnoException) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[broker] 端口 ${port} 已经被占用了 —— 多半是某个 Claude Code 会话已经在当 broker，` +
          `这种情况下不需要再单独起一个。`,
      );
      process.exit(1);
    }
    console.error('[broker] 启动失败：', err);
    process.exit(1);
  });
