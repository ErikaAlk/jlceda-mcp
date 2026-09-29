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
- **连不上时同样一个回调都不给**：对端不在时 `new WebSocket(...)` 照样构造成功，
  失败是异步的，`onConnected` 永远不来。所以 `connecting` **必须有超时**
  （`CONNECT_TIMEOUT_MS`），超了就 `hardReset` 重来。
  少了这条，phase 会永远停在 `connecting`、心跳再也不会重新 `register`——
  表现就是用户报的「先开 EDA、后开 Claude Code，必须手动点一次重连」。
  所有重连判断集中在 `advance()` 一处，别再散出去。
- **连上之后扩展要主动 ping**（`KEEPALIVE_MS`）。往一个已关闭的 socket 上 `send` 会抛，
  这是对端消失时唯一能快速察觉的信号；没有它就得干等 11 秒的接收超时。
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

### 图元 getter 以 `api-types.d.ts` 为准，焊盘 ID 是「元件 ID + 后缀」

EDA 安装目录 `resources/app/assets/pro-api/<版本>/api-types.d.ts` 写清了每个图元类有哪些 `getState_*`，
读之前先对一遍。按猜的方法名读不会报错，只会静默拿到空值：线宽、元件宽高、焊盘位号都栽在这上面。
图元对象标成类型包里的 `IPCB_*` 类型（见 `pcb-state.ts` 的焊盘部分），不存在的 getter 过不了类型检查。

焊盘图元没有位号和父元件 ID。只要某一个元件的焊盘时，用 `pcb_PrimitiveComponent.getAllPinsByPrimitiveId(元件 ID)`，
它给的是完整图元 ID 和画布坐标（mil），不含封装自带的过孔；元件没有焊盘、或者按这个 ID 找不到元件时返回 `undefined`。
要知道哪些走线连着某个焊盘，用器件焊盘的 `getConnectedPrimitives()`（见 `relocateComponent()`）：`pcb.js` 里走的是 EDA 的连接检查，
只看同一网络（`checkTrackPad` 里 `whetherCheckNet` 默认开着），贴片焊盘只看同层、通孔焊盘各层都算，铜皮碰到就算，
走线端点不在焊盘中心也算。真机上通孔焊盘、大焊盘的走线端点常常离中心 5 到几十 mil，别按坐标去凑。
从焊盘上横穿过去、两头连着别处的同网络走线它也会返回，要删线时得自己按端点再筛一遍。
它的参数 `onlyCentreConnection` 只在 `api.js` 里决定要不要带上填充区域，根本没传给 `pcb.js`；类型包 0.1.175 只公开了 `false` 那个重载。
要给全板焊盘找所属元件时，拿元件的 `getState_Pads()` 反查。那里的 `primitiveId` 是去掉元件 ID 的后缀
（`pro-pcb/<版本>/js/pcb.js` 序列化元件时写的是 `pad.globalIndex.replace(component.globalIndex, '')`），
焊盘的完整 ID 要拼成「元件 ID + 后缀」，列表里还混着封装自带的过孔。实现见 `mapPadOwners()`。

丝印上的字有两种图元。`pcb_PrimitiveString.getAll()` 只给不挂在元件上的文本（`pcb.js` 里按 `!getParent()` 过滤了），
文本图元没有父图元 ID 的 getter。位号、值这些挂在元件上的字是属性图元 `IPCB_PrimitiveAttribute`，
从 `pcb_PrimitiveAttribute.getAll()` 取。
这个列表里是全部元件的全部属性，多数是隐藏的（Key、Value 都不显示），隐藏属性可能没有摆放位置，这时坐标给的是原点，
所以只收丝印层（3、4）上显示出字的属性，判断条件照 `pcb.js` 的 `modifyAttrPosition`（见 `silkscreen.ts`）。
`pcb_PrimitiveAttribute.get(单个 ID)` 查不到时返回空数组（类型声明写的是 `undefined`），按 ID 分辨文本和属性要到两个 `getAll()` 里找。

`api.js` 里 14 个 PCB 图元类（文本、属性、元件、导线、过孔等）的 `modify()` 调 `done()` 时没有 await：
EDA 拒绝写入时 `done()` 抛的「对象参数不正确，无法应用到画布」没人接，`modify()` 照样返回图元对象。
要让写入失败报出来，取到图元对象后先 `toAsync()`、再 `reset()` 读回画布现状，`setState_*` 之后 await 它的 `done()`
（见 `silkscreen.ts` 的 `writeMove()`、`pcb-edit.ts` 的 `writeComponentMove()`）。`done()` 发的是对象的全部字段，不先 `reset()` 就会拿取对象时的旧值覆盖画布。
`toAsync()` 要放在 `reset()` 前面：同步模式下 `reset()` 里每个 `setState_*` 都会调一次不 await 的 `done()`。
类型包 0.1.175 里文本、属性两类图元没有 `reset()` / `done()`（元件、导线等有），这两类的声明照 EDA 安装目录的 `api-types.d.ts` 补在 `jlc-bridge/src/eda-beta.d.ts`。

元件的 `reset()` 读回的对象和 `getAll()` 给的不一样：`otherProperty` 是完整的 `attrsMap`（`getAll()` 去掉了位号、名称、BOM 标记等 8 个标准键），
BOM 标记按 `!!attrsMap['Add into BOM']` 算，值是 `"no"` 也读成 `true`。写回时 `pcb.js` 的 `component-modify` 先按 BOM 标记把属性改成 `"yes"`，
再按 `otherProperty` 用 `modifyATTRMap` 改回 `"no"`，画布上的 BOM 标记不变。改回这一步有个前提：元件上没有键为「Add into BOM」的属性图元。
有的话走的是属性文字的 value setter，它看到文字上的值没变就直接返回，`attrsMap` 会停在 `"yes"`。
本机两个真实工程里三块 PCB 的元件都没有这个属性图元：BOM 标记在器件上（`"yes"`），元件记录里只存改过的值（见过 `"no"`）。
`done()` 不发封装和焊盘。

元件 `get(单个 ID)` 查不到时返回 `undefined`；`reset()` 遇到已被删掉的元件时读空记录，抛 TypeError。

运行中的 EDA 加载的是哪一版 `pcb.js` / `api.js`，看 `assets/pro-versions/<版本>/editor.ini`。

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

**跑测试**：`npm test`（63 项）。每条断言都对应一个踩过的坑，别随手删。
