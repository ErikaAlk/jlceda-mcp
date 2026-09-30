# jlceda-mcp

把 嘉立创EDA 专业版接到 Claude Code：读 PCB / 原理图、移元件、走线、打过孔、铺铜、
跑 DRC、排丝印，全都可以让 AI 直接做。

```
Claude Code ⇄ mcp-server（内含 broker） ⇄ 嘉立创EDA 的 JLC MCP 扩展
```

只有两段，不需要额外启动任何东西：起 Claude Code 就等于起了桥接服务。

---

## 快速开始

### 1. 装扩展（只做一次）

嘉立创EDA → 顶部菜单 **高级 → 扩展管理器 → 导入**，选：

```
jlc-bridge/build/jlc-bridge.eext
```

装完在「配置」里确认 **允许外部交互** 是勾上的（默认就是勾上的）。
没有这个权限扩展连不出去，重试多少次都没用。

### 2. 配 Claude Code（只做一次）

用户级 `~/.claude.json` 里加：

```json
{
  "mcpServers": {
    "jlceda": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Users/你的用户名/Documents/jlcmcp/dist/index.js"]
    }
  }
}
```

改完 **重启 Claude Code** 才生效。

### 3. 用

打开 EDA，打开一个 PCB，看顶部菜单 **JLC MCP** 第一行：

| 显示 | 意思 |
|---|---|
| ● 已连接 · Claude 可以操作这块板 | 好了，直接让 Claude 干活 |
| ○ 未连接 · Claude Code 开着吗 | Claude Code 没开，或它的 MCP 进程没起来 |
| ⚠ 缺少「外部交互」权限 | 去扩展管理器把那个勾勾上 |
| ⏸ 已暂停 | 你自己按的暂停，点「恢复桥接」 |

**状态就写在菜单标题上，不用点开任何窗口。** 连上一般在 3 秒内自动完成。

---

## 它能做什么

38 个工具，Claude 直接调用：

| 组 | 工具 |
|---|---|
| 读状态 | `pcb_get_state` `pcb_get_pads` `pcb_get_tracks` `pcb_get_net_primitives` `pcb_get_board_info` `pcb_get_silkscreens` `pcb_screenshot` |
| 元件 | `pcb_move_component` `pcb_relocate_component`（自动断线）`pcb_batch_move` `pcb_select_component` `pcb_create_component` `pcb_delete_selected` |
| 布线 | `pcb_route_track` `pcb_create_via` `pcb_delete_tracks` `pcb_delete_via` |
| 铜箔 | `pcb_create_copper_pour` `pcb_create_keepout` `pcb_delete_pour` `pcb_delete_keepout` |
| 规则 | `pcb_create_diff_pair` `pcb_create_equal_length` + 各自的 list / delete |
| 丝印 | `pcb_move_silkscreen` `pcb_auto_silkscreen`（自动避让焊盘 / 过孔 / 其它丝印） |
| 检查 | `pcb_run_drc` `sch_run_drc` |
| 原理图 | `sch_get_state`（元件+网络，可按位号过滤）`sch_get_netlist`（连接关系，可按网络/位号点查）`pcb_open_document` |
| 计算 | `calc_impedance`（含反算线宽）`calc_trace_width`（IPC-2221） |
| 诊断 | `pcb_ping` `pcb_get_feature_support` `bridge_status` |

`bridge_status` **不需要 EDA 在线也能回答**，专门用来分辨「是 EDA 没连上」还是「命令本身失败」。

另有 `pcb_agent`（黑箱自动模式），需要额外的 `ANTHROPIC_API_KEY`，默认不注册。

---

## 出问题时

菜单里有四个自查入口，从上往下用：

1. 状态：秒开，显示连了多久、收发了多少、最近的错误是什么
2. 自检：读一次当前 PCB，不碰网络。它成功而链路没通 ⇒ 问题在 Claude Code 那侧
3. 查看运行日志：扩展自己的日志，连不上时把它发给 Claude 看
4. 连不上怎么办：按顺序列出四种常见原因

命令行侧：

```bash
npm run live                # 对着真开着的 EDA 跑一遍完整链路自检
npm run live -- --watch     # 每 5 秒重试直到通过（边改边看最省事）
```

### 常见情况

| 现象 | 原因 |
|---|---|
| 菜单显示「未连接」 | Claude Code 没开。桥接服务就跑在它的 MCP 进程里 |
| 菜单显示「缺少外部交互权限」 | 扩展管理器 → 配置 → 勾「允许外部交互」 |
| 端口被占 | 菜单「连接端口…」改一个，同时给 Claude Code 设 `JLC_BRIDGE_PORT` |
| 工具报「嘉立创EDA 没有接进来」 | EDA 没开、没装扩展，或菜单第一行不是「已连接」 |
| 扩展管理器里点「导入 / 卸载」毫无反应 | EDA 这个会话的扩展管理子系统卡住了（导入旧包也一样没反应、工程自动备份也在报失败）。重启 嘉立创EDA 即可 |

---

## 开发

```bash
npm run build         # 编 mcp-server（TypeScript → dist/）
npm run build:ext     # 类型检查 + 打包扩展 → jlc-bridge/build/*.eext
npm run build:all     # 两个一起
npm test              # 43 项自动化测试
npm run check         # build + test
npm run broker        # 单独跑一个常驻 broker（平时不需要，排障时看得清楚）
```

测试分四层，一层比一层接近真机：

- `tests/extension.test.mjs`：把**真实打包产物**装进一个复刻的 EDA 沙箱里跑
  （`tests/eda-sandbox.mjs` 照着 EDA 安装目录里 `api.js` 的 `Tg` / `xg` / `Ta` 逐段抄的，
  包括「每次调用都重新求值整个 bundle」这条最要命的行为）。
  用户报过的每个症状都在这里有一条断言钉着。
- `tests/broker.test.mjs`：真端口、真 WebSocket，只有 EDA 那头是假的。
  覆盖转发、竞选、断线、网页来源拦截。
- `tests/reconnect-live.test.mjs`：把上面两半接起来，**真实扩展产物 + 真 socket + 真 broker**，
  按「先开 EDA、后开 Claude Code」的顺序跑通一条真命令。唯一缺的只有 EDA 本体。
- `tests/server.test.mjs`：真起 `dist/index.js` 走 stdio，验证构建产物能被 Claude Code 加载。

改了协议要**同时**改 `src/protocol.ts` 和 `jlc-bridge/src/protocol.ts`（两份逐字对齐）。

架构细节、EDA 沙箱的坑、不许破坏的不变量 → 见 [CLAUDE.md](CLAUDE.md)。

---

## 更新记录

### 未发布

**2026-09-29** `pcb_get_tracks` 和 `pcb_get_net_primitives` 返回的每条导线 `width` 都是 0。
扩展读的是 `getState_Width()`，EDA 的导线图元 `IPCB_PrimitiveLine` 没有这个方法，
线宽要从 `getState_LineWidth()` 读（对照 EDA 安装目录 `pro-api` 下的 `api-types.d.ts` 核实）。
改的是扩展，要在 EDA 里重新导入 `jlc-bridge/build/jlc-bridge.eext` 才生效。
顺带把 `tests/reconnect-live.test.mjs` 的端口改成运行时现取：原来写死 18931，
本机有别的程序占着这个端口时 broker 起不来，「EDA 先起、端口上没有任何人」这一步的前提也不成立。

**2026-08-25** 只动 README。标题从 `# jlceda-mcp —— 让 Claude Code 直接操作 嘉立创EDA 专业版`
收成 `# jlceda-mcp`，正下方那段本来就把这件事说清楚了。正文里的破折号
22 → 0，几处列表项开头的加粗标签去掉。内容一条没删，没有出新版本。

### v0.2.0（2026-08-04）

整个重构了一遍。用户报的三个问题各有各的根因：

**① 「点状态要等很久」**
`showStatus` 里会顺手跑一遍建链，卡在 5 秒的 WebSocket 超时上。
现在状态只读内存里的缓存，秒开；而且状态直接写在菜单标题上，多数时候不用点开。

**② 「连不上 WebSocket」**
根因不在扩展，旧架构是三段，中间那个 gateway 是要**手动双击 .bat** 才启动的。
排查时 18800 端口上一个监听都没有。现在 broker 内嵌进 mcp-server，起 Claude Code 就有；
多个 Claude Code 会话会自动竞选，谁先起来谁当 broker。
（顺带确认了：扩展的「允许外部交互」权限一直是勾着的，不是权限问题。）

**③ 「必须点两下 Enable/Disable 才能用」**
这条最有意思：**EDA 每次调用扩展函数（包括每次点菜单）都会把整个 bundle 重新读出来、
重新 eval 一遍**，模块级变量在两次点击之间根本不保留。旧代码是按「模块常驻」写的，
于是内存里的开关恒为 false、存盘的开关是 true，第一下被判成「关闭」，第二下才真的打开。
现在所有跨调用的状态挂在 `globalThis` 上，连接用幂等的 `ensureLink()`，
装完即用，不需要点任何开关。

顺带修掉的哑 bug（都是「不报错但结果是错的」那种）：

- `pcb_auto_silkscreen` 调了一个从来没定义过的 `round3()`，一调用就 ReferenceError，
  也就是说这个工具从来没成功跑过
- `pcb_create_via` 发 `drill`、扩展只认 `holeDiameter`，钻孔尺寸被静默丢掉，
  所有过孔都按默认 10 mil 建出来
- `pcb_create_diff_pair` 发 `posNet/negNet`、扩展只认 `positiveNet/negativeNet`，
  每次都报「缺参数」
- `pcb_get_pads` 的 `designator` 参数被静默忽略，查谁都返回全部焊盘
- `pcb_screenshot` 读 `data.image`、扩展给的是 `data.imageDataUrl`，从来没返回过图片
- `pcb_get_silkscreens` 从不传 `includeConflicts`，扩展里那套冲突检测等于永远关着
- `pcb_get_board_info` 找的是 `info.sch.uuid`，而 EDA 给的是 `info.schematic.uuid`，
  `schematicUuid` 一直返回空串，`sch_*` 那几个工具和「切到原理图」都没法用
  （这条是接上真机之后第一次调用才发现的）
- 原理图那一整块基本是废的（真机上量出来的）：
  `sch_PrimitiveComponent.getAll()` 不传器件类型，会把网络标识/端口/标签也当成元件返回，
  实测 311 条里只有 164 条有位号，所以看着像「元件字段全是空的」；
  `value` 读的是不存在的 `getState_Value()`（真值在 `getState_OtherProperty()` 里）；
  库引用读的是不存在的 `getState_LibraryUuid()`（真接口是 `getState_Component()`）；
  网络读的是 `sch_PrimitivePin.getAll()`，那个拿的是**符号编辑器里的引脚**，
  在原理图页上恒为 0 条，网络得走 `sch_Net.getAllNets()`
- **原理图的 API 只在「当前打开的是原理图页」时才工作**。在 PCB 页上调 `sch_run_drc`，
  EDA 回一句 `doctype(3) not support`（3 = PCB），光看这句猜不到是标签页不对。
  现在 `sch_*` 三个命令都会先自动切过去，并在返回值里说明切过（`switchedToSchematic`）
- 切完页**不能定长 sleep 就去读**：真机上等 600ms 读到 49 个元件，等加载完是 164 个，
  少掉的那些不报错、就是静悄悄地没有。现在轮询到「元件数连续几拍不再变」才读
- `sch_Netlist.getNetlist()` 官方已标 `@deprecated`，而且**调下去永远不返回**
  （整条链路被它占满 60 秒）。改用官方指定的 `sch_ManufactureData.getNetlistFile()`
- 扩展侧加了 45 秒的命令级超时：EDA 的接口真的会卡死，没这道闸的话一条命令能把链路占满，
  而且报出来的错还不知道是哪个动作
- 网络名三条路依次兜底：`sch_Net`（这版 EDA 上实测为空）→ 网络标签/标识/端口（可跨图页）
  → 当前页导线；返回里带 `netSource` / `netScope`，别让人以为拿到的都是全工程的
- `sch_get_netlist` 默认只给概览：整份网表在真实板子上是 **35 万字符**，原样返回等于没法用。
  现在默认给「有哪些网络、各挂几个引脚」，要细节就传 `nets` / `designators` 点查，
  `raw:true` 才给原文。网表里有完整的引脚→网络映射，这是拿连接关系最靠谱的一条路
- `includeProperties:false` 时 `value` 也要有：值藏在 `otherProperty` 里，
  不能因为「不要属性表」把值一起吞掉
- 文件轮询那条「备用传输」其实一直是死的：它用 `sys_File.mkdir` 建目录，
  而这个 API 在 EDA 3.x 根本不存在，目录建不出来 ⇒ 所有读写静默失败。已删掉

其它变化：

- 菜单重做：状态灯 + 写清楚结果的动作项（「暂停桥接」而不是「Enable/Disable」），全中文
- 扩展从 2765 行单文件拆成 12 个模块；120 行的 switch 换成动作表，
  不认识的动作会把支持的动作列表一起报出来
- broker 挡掉来自网页的连接（任意站点都能连本机 WebSocket，不挡就是个洞），
  嘉立创EDA 自己的来源在白名单里
- 命令结果只回给发起的那个客户端，不再广播
- EDA 断线时在飞的命令立刻失败，不再干等 60 秒超时
- 加了 42 项自动化测试，其中扩展那组是把真实产物装进复刻的 EDA 沙箱里跑的
- 旧配置里的 `GATEWAY_WS_URL` 仍然认（只取里面的端口），换新版不用改 `~/.claude.json`
- **先开 EDA、后开 Claude Code 也会自己连上**：`sys_WebSocket` 连不上时一个回调都不给，
  没有连接超时的话状态会永远停在「正在连接」、心跳再也不会重新 register，
  表现就是「必须手动点一次重连」。现在 1.8 秒没通就推倒重来，每 2 秒重试一次；
  broker 收到 hello 也会立刻回一帧，不用等它下一次心跳
- 对端消失（Claude Code 退出）时改由扩展主动 ping 探活，2 秒左右就发现，
  不再干等 11 秒的接收超时
- 菜单不再自相矛盾：状态行和「暂停/恢复」那一项以前分别读 `phase` 和 `enabled`，
  两者一旦不同步就出现「状态行写着已暂停、下面却摆着『暂停桥接』」。现在同源推导。
  根因是 `boot()` 每次都用存盘值覆盖内存里的开关，而 `sys_Storage` 的写是异步的、
  失败还被吞掉，存盘一失败，用户刚点下的暂停就被读回来的旧值冲掉了

### v0.1.x

原作者 [hyl64](https://github.com/hyl64/jlcmcp) 的版本。

---

## 关于作者

当前维护：Claude (Opus 5)。

原始版本由 hyl64 以 Apache-2.0 发布；MCP 工具的划分、
PCB 图元读写那套 `getState_*` 的兼容写法来自那一版，保留致谢。
原仓库看起来已不再维护（缺失的 gateway 中枢一直没有补进去，
`README` 里的链路第三段在仓库里根本不存在）。

许可证 Apache-2.0，见 [LICENSE](LICENSE)。
