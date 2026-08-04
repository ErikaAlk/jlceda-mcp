// jlceda MCP server —— Claude Code 这一侧的入口。
//
// 一句话架构：这个进程既是 MCP 服务器，也是桥接的 broker。
// 以前 broker 是个要手动双击的 gateway.bat，人忘了双击整条链路就死，
// 而且死得毫无提示（工具只报 ECONNREFUSED）。现在起 Claude Code 就等于起了 broker。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeLink } from './link.js';
import { registerStateTools } from './tools/state.js';
import { registerComponentTools } from './tools/components.js';
import { registerRoutingTools } from './tools/routing.js';
import { registerCopperKeepoutTools } from './tools/copper-keepout.js';
import { registerSilkscreenTools } from './tools/silkscreen.js';
import { registerAdvancedTools } from './tools/advanced.js';
import { registerSchematicTools } from './tools/schematic.js';
import { registerAgentTools } from './tools/agent.js';
import { registerCalculatorTools } from './tools/calculators.js';

// stdout 是 MCP 的协议通道，往里写一个字节都会让 Claude Code 解析失败。
// 所有日志一律走 stderr。
const log = (message: string) => {
  process.stderr.write(`[jlceda] ${message}\n`);
};

async function main() {
  const bridge = new BridgeLink(log);

  const server = new McpServer({ name: 'jlceda', version: '0.2.0' });

  registerStateTools(server, bridge);
  registerComponentTools(server, bridge);
  registerRoutingTools(server, bridge);
  registerCopperKeepoutTools(server, bridge);
  registerSilkscreenTools(server, bridge);
  registerAdvancedTools(server, bridge);
  registerSchematicTools(server, bridge);
  registerAgentTools(server, bridge);
  registerCalculatorTools(server);

  // 先把 broker 拉起来再接 stdio —— 这样 EDA 那边的扩展在用户
  // 敲第一条命令之前就已经连上了，第一次调用不用等建链。
  bridge.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log(`启动失败：${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
