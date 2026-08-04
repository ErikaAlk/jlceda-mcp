# CLAUDE.md — jlceda-mcp

新会话进来先读这份，再读 [README.md](README.md)（那份是给人看的用法）。
这份是给 agent 看的：**架构、不许破坏的不变量、会浪费你半小时的坑**。

## 两个组件

| 目录 | 是什么 | 跑在哪 |
|---|---|---|
| `src/` | MCP server + 内嵌 broker | Claude Code 起的 node 进程 |
| `jlc-bridge/` | 嘉立创EDA 扩展 | EDA 渲染进程的沙箱里 |

```
Claude Code ⇄(stdio) mcp-server ⇄(ws://127.0.0.1:18800/ws/bridge) JLC MCP 扩展 ⇄ EDA
                       └─ broker 就长在这里
```

---

## ⚠ 不变量 1：EDA 每次调用扩展都会把整个 bundle 重新求值一遍

这是这个项目最反直觉的一条，**旧版三个 bug 里有两个是它造成的**。

从 EDA 安装目录 `assets/pro-api/*/api.js` 的 `Ta()` 逆出来的事实：
菜单点击走 `extensionApi.callFunctionInExtension` → `Ta(uuid, fnName)`，而 `Ta` 会

1. **重新从 IndexedDB 读出 entry 文件的源码**
2. 在末尾拼一段 `if (typeof fnName === 'function') { fnName(...) } else if (edaEsbuildExportName...)`
3. 包进 `with (sandbox) { ... }`，用 `AsyncFunction` **整个重新 eval**

也就是说：

> **模块级的 `let` / 闭包变量，在两次菜单点击之间不保留。**
> 启动激活、点「状态」、点「暂停」——每一次都是一个全新的模块实例。

能跨越重新求值活下来的只有三样：

- EDA 按 ID 托管的资源：`sys_Timer` 的定时器、`sys_WebSocket` 的连接、`sys_Storage` 的配置
- `globalThis` 上挂的东西（沙箱没拦 `globalThis`，实测可读可写）
- 已经跑起来的闭包（第一次求值时注册的 `onMessage` 回调会一直用那一版代码）

所以：**所有跨调用的状态一律挂在 `hub.ts` 的 `globalThis.__JLC_BRIDGE_HUB_V2__` 上**，
每个导出函数第一件事都是 `boot()`（幂等）。别写 `let connected = false` 这种。

装了新版扩展之后，还活着的 `onMessage` 闭包是**上一版代码**的。
`link.ts` 靠 `hub.codeBuild !== CODE_BUILD` 发现这件事并推倒重连，让新代码接管。别删。

## ⚠ 不变量 2：`sys_WebSocket` 没有 close / error 回调

`register(id, url, onMessage, onConnected)` 就这四个参数。对端死了扩展毫无感知。

推论：

- **判活只能靠「最近一次收到数据的时间」**（`hub.lastRxAt`）。broker 每 3 秒 ping 一次
  就是为了喂这个判据；扩展收到 ping 回 pong。超过 `RX_TIMEOUT_MS` 没动静就判死重连。
- `register()` 遇到同 ID 且 readyState 是 **CONNECTING 或 OPEN** 的连接时，会
  **立刻同步调用 `onConnected` 然后返回**——注意 CONNECTING 也算。
  所以「`onConnected` 被调了」≠「连上了」。phase 从 `connecting` 翻到 `online`
  必须发生在**收到第一帧**的时候，不能在 `onConnected` 里。
- 反过来，这个复用语义让 `ensureLink()` 天然幂等：已经连着时再调就是个空操作。
  这正是「每次点菜单都调一遍」能成立的原因。

## ⚠ 不变量 3：沙箱里没有 fetch / WebSocket / XHR / localStorage

`xg()` 里把这些全设成了 `undefined`：

```
document indexedDB localStorage sessionStorage location navigator self window
eval Function fetch alert WebSocket XMLHttpRequest BroadcastChannel Worker …
```

**联外网只有 `eda.sys_WebSocket` 一条路**，而且要「允许外部交互」权限
（没有权限时 `register` / `send` / `close` 一律 `throw`，错误里带「外部交互」四个字，
`eda.ts` 的 `isPermissionError()` 就是认这个）。

旧版留了一条「原生 WebSocket 兜底」，那条路在 EDA 3.x 上永远走不通，已删。

`setTimeout` / `setInterval` 是有的（被代理到 `window.*`），但**心跳要用
`sys_Timer.setIntervalTimer` 并固定 ID** —— 同 ID 重复注册会替换旧的，
正好抵消「每次求值都装一次」。

## ⚠ 不变量 4：两份 protocol.ts 必须逐字一致

`src/protocol.ts`（服务端）和 `jlc-bridge/src/protocol.ts`（扩展）是同一份协议抄了两遍——
扩展跑在沙箱里，没法 import 服务端的包。改一边必须改另一边。
`PROTOCOL_VERSION` 对不上时 broker 会在日志里明说，不会静默乱跑。

## ⚠ 不变量 5：`extension.json` 的 `onChangeAllowExternalInteractions` 只能填 `"on"` / `"off"`

它不是函数名。EDA 的加载代码是
`_.extensionActivationEventListOnChangeAllowExternalInteractions[值].push(uuid)`，
而那个对象只有 `{on: [], off: []}` 两个键。填别的（比如 `"activate"`）会
**在扩展加载时抛 TypeError，整个扩展装不上**。

其余激活事件（`onStartupFinished` / `onEditorPcb` / …）只判真假，填什么都行，
实际调用的固定是 `activate('事件名')`。

## ⚠ 不变量 6：stdout 是 MCP 的协议通道

`src/` 里任何日志都必须走 stderr。往 stdout 写一个字节，Claude Code 那边就解析失败。
`BridgeLink` 的 log 回调、broker 的 log 都是这么接的。

---

## 环境坑

### 用 UI 自动化点 EDA 时：截图坐标和鼠标坐标不是一套

这台机器左屏 2560×1440 @100%，右屏物理 3200×2000 / 逻辑 2000×1250 @160%。

- `Graphics.CopyFromScreen` 拿到的是**物理像素**（截图上量到的就是这个）
- `SetCursorPos` 吃的是**逻辑像素**（DPI 不感知的进程会被系统虚拟化）

混着用会点到别的东西上（栽过：本来要点「高级」，结果点到通知铃铛，弹出了浏览器）。
换算：`logical_x = 2560 + (physical_x - 2560) / 1.6`，`logical_y = physical_y / 1.6`。
验证办法：`SetCursorPos` 之后用另一个 DPI 感知的工具读回光标位置对一下。

### EDA 菜单栏会溢出

窗口不够宽时扩展菜单会被收进菜单栏最右边那个 `˅` 里，
所以「顶部菜单没看到 JLC MCP」不一定是扩展没装。

### EDA 扩展管理器可能整个卡住

2026-08-04 遇到过：扩展管理器的**导入和卸载都毫无反应**——
导入新包没反应，导入**已知能装的旧包**也没反应，卸载点了「确认」也没反应
（`取消` 有反应，说明点击本身是到位的），同时工程「自动备份失败」。
这是 EDA 那个会话的持久化子系统卡住了，不是包的问题。**重启 EDA 即可。**

判断办法：看 `%LOCALAPPDATA%\LCEDA-Pro\cache.x64.3\IndexedDB\https_pro.lceda.cn_0.indexeddb.blob\1\00\`
里那几个文件的时间戳——真的装进去了这些文件会更新。

### 想看扩展里发生了什么

EDA 不给 console。三条路：

1. 菜单「查看运行日志」——`hub.logs` 环形缓冲，最近 200 条
2. `npm test` 的 `tests/extension.test.mjs`——把真实产物装进复刻的沙箱跑，能打断点
3. `npm run live`——对着真 EDA 跑完整链路

---

## 常见任务

**改了扩展**：`npm run build:ext` → 在 EDA 里重新导入 `.eext`（同 UUID 会覆盖）→
`npm run live` 验证。菜单第一行的状态灯会自己变。

**改了 MCP server**：`npm run build` → **重启 Claude Code**（MCP 进程不会热重载）。

**加一个新命令**：
`jlc-bridge/src/commands/` 里写实现 → `registry.ts` 里加一行 →
`src/tools/` 里加对应的 MCP 工具。**两边的参数名要对齐**——
旧版栽过四次「参数名对不上，静默丢参数」，见 README 更新记录。

**改协议**：两份 `protocol.ts` 一起改，`PROTOCOL_VERSION` 加一。

**跑测试**：`npm test`（23 项）。每条断言都对应一个踩过的坑，别随手删。
