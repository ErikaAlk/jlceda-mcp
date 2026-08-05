// 顶部菜单。
//
// 旧菜单三项：Enable/Disable Bridge、Status、Test Command。三个问题：
//   · 「Enable/Disable」是一个开关塞进一个菜单项，点下去会发生什么全看不见的内部状态，
//     用户只能靠点两下试出来（而那恰恰是旧版唯一能连上的办法，见 hub.ts）；
//   · 想知道通没通，唯一入口是「Status」，而它当时要卡 5 秒才弹窗；
//   · 中英文混排。
//
// 现在的做法：**把状态做成菜单的第一行，标题本身就是状态灯**。
// 鼠标划过去就看见通没通，不用点、不用等、不用弹窗。链路状态一变，心跳会顺手
// 把这一行的标题改掉（replaceHeaderMenus），所以它是活的。
//
// 动作项一律写成「点下去会发生什么」，不写成开关名词：
//   「暂停桥接」而不是「Enable/Disable」。

import { APP_NAME, APP_VERSION } from './config';
import { edaApi } from './eda';
import { getHub, type LinkPhase } from './hub';

const TOP_ID = 'jlcMcpBridge';

/** 一级菜单标题。用「JLC MCP」而不是「JLC Bridge」——用户就是这么叫它的。 */
const TOP_TITLE = 'JLC MCP';

interface MenuItem {
  id: string;
  title: string;
  registerFn?: string;
}

function statusTitle(phase: LinkPhase, port: number): string {
  switch (phase) {
    case 'online':
      return '● 已连接 · Claude 可以操作这块板';
    case 'connecting':
      return '◌ 正在连接…';
    case 'blocked':
      return '⚠ 缺少「外部交互」权限 · 点这里看怎么开';
    case 'offline':
    case 'idle':
    default:
      return `○ 未连接 · Claude Code 开着吗（端口 ${port}）`;
  }
}

/** 菜单出现在哪些编辑器里。全放，这样在开始页也能看到状态。 */
const SURFACES = ['home', 'blank', 'schematic', 'symbol', 'pcb', 'footprint', 'panel'] as const;

function buildMenuItems(): Array<MenuItem | null> {
  const hub = getHub();

  // ⚠ 状态行和动作项**必须从同一个变量推**。
  // 栽过：状态行读 hub.phase、动作项读 hub.enabled，两者一旦不同步就出现
  // 「状态行写着『已暂停』、下面却摆着『暂停桥接』」这种自相矛盾的菜单。
  // 现在只认 paused 这一个量，物理上不可能打架。
  const paused = !hub.enabled;

  // 三段，段与段之间用 null 画分隔线（EDA 的约定）：
  //   ① 状态灯　② 改变链路的动作　③ 排障
  const actions: MenuItem[] = paused
    ? [{ id: 'pause', title: '恢复桥接', registerFn: 'togglePause' }]
    : [
        { id: 'reconnect', title: '立即重连', registerFn: 'reconnectNow' },
        { id: 'pause', title: '暂停桥接', registerFn: 'togglePause' },
      ];

  return [
    {
      id: 'status',
      title: paused ? '⏸ 已暂停 · 点下面「恢复桥接」' : statusTitle(hub.phase, hub.port),
      registerFn: 'showStatus',
    },
    null,
    ...actions,
    { id: 'port', title: `连接端口…（当前 ${hub.port}）`, registerFn: 'changePort' },
    null,
    { id: 'selftest', title: '自检：读一次当前 PCB', registerFn: 'runSelfTest' },
    { id: 'log', title: '查看运行日志', registerFn: 'showLog' },
    { id: 'help', title: '连不上怎么办', registerFn: 'showHelp' },
  ];
}

function buildMenus(): Record<string, unknown> {
  const top = { id: TOP_ID, title: TOP_TITLE, menuItems: buildMenuItems() };
  const menus: Record<string, unknown> = {};
  for (const surface of SURFACES) menus[surface] = [top];
  return menus;
}

/**
 * 刷新菜单。只在状态行真的变了才调 replaceHeaderMenus——
 * 那个接口等于 remove + insert，2 秒一次地无脑重建会让菜单闪。
 */
export function refreshMenu(force = false): void {
  const hub = getHub();
  const signature = `${hub.phase}|${hub.enabled}|${hub.port}`;
  if (!force && signature === hub.menuSignature) return;
  hub.menuSignature = signature;

  try {
    const result = edaApi()?.sys_HeaderMenu?.replaceHeaderMenus?.(buildMenus());
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* 菜单刷新失败不该影响桥接本身 */
  }
}

export function menuHeader(): string {
  return `${APP_NAME} v${APP_VERSION}`;
}
