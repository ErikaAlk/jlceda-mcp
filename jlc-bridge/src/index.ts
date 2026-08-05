// JLC MCP —— 让 Claude Code 通过 MCP 操作 嘉立创EDA 专业版的桥接扩展。
//
// 读这个文件之前先读 hub.ts 开头那段：**EDA 每次调用扩展都会把整个 bundle 重新求值一遍**，
// 这条约束决定了下面所有函数的写法（每个导出函数都先 boot() 一次，而不是指望
// activate 时初始化好的状态还在）。
//
// 导出的函数名要和 extension.json 里的 registerFn 对得上，改名字要两边一起改。

import { APP_NAME, APP_VERSION, readEnabled, readPort, saveEnabled, savePort } from './config';
import { edaApi, errText, promptText, showDialog, toast } from './eda';
import { getHub } from './hub';
import { ensureLink, pause, PERMISSION_HINT, reconnect, resume, setMenuRefresher } from './link';
import { refreshMenu } from './menu';
import { ACTIONS } from './registry';
import { getPCBState } from './commands/pcb-state';

/**
 * 每个入口都要先跑一遍。幂等。
 * 干三件事：把持久化配置读进 hub、确保链路在跑、把菜单画出来。
 */
function boot(): void {
  const hub = getHub(readPort());
  hub.port = readPort();
  // 存盘值只在 hub 刚建出来（= EDA 本次会话第一次跑到扩展）时读一次。
  // 每次都读的话会把用户刚点下的「暂停」冲掉 —— 见 hub.ts 里 enabled 字段的注释。
  if (!hub.enabledLoaded) {
    hub.enabled = readEnabled();
    hub.enabledLoaded = true;
  }
  setMenuRefresher(() => refreshMenu());
  ensureLink();
  refreshMenu(true);
}

// ─── EDA 生命周期 ───

/**
 * 启动激活。extension.json 里配的是 onStartupFinished。
 *
 * 旧版这里有个致命写法：只有当存盘开关为 true 时才去连，而那个开关默认是 false，
 * 于是「打开 EDA 不会自动开启」。现在默认就是开的，装完即用。
 */
export function activate(): void {
  try {
    boot();
  } catch (error) {
    console.error(`[${APP_NAME}] 激活失败`, error);
  }
}

// ─── 菜单项 ───

/** 状态。**必须秒开**：只读 hub 里的缓存，绝不在这里 await 任何网络动作。 */
export function showStatus(): void {
  boot();
  const hub = getHub();
  const api = edaApi();

  const uptime = hub.onlineSince ? formatDuration(Date.now() - hub.onlineSince) : '—';
  const lastRx = hub.lastRxAt ? `${formatDuration(Date.now() - hub.lastRxAt)}前` : '从未';

  const lines = [
    `状态：${phaseText(hub.phase)}`,
    `地址：ws://127.0.0.1:${hub.port}/ws/bridge`,
    `已连通：${uptime}`,
    `最近一次收到数据：${lastRx}`,
    `已执行命令：${hub.commandCount} 条${hub.lastAction ? `（最近：${hub.lastAction}）` : ''}`,
    `心跳定时器：${hub.heartbeatArmed ? '正常' : '没装上（链路不会自动重连）'}`,
    '',
    `扩展版本：v${APP_VERSION}`,
    `WebSocket 接口：${api?.sys_WebSocket?.register ? '可用' : '不可用'}`,
    `支持的动作：${ACTIONS.length} 个`,
  ];

  if (hub.lastError) lines.push('', '最近一次错误：', hub.lastError);

  if (hub.phase !== 'online' && hub.phase !== 'paused') {
    lines.push('', '——', '连不上时先看菜单里的「连不上怎么办」。');
  }

  showDialog(lines.join('\n'), `${APP_NAME} · 状态`);
}

export function reconnectNow(): void {
  boot();
  reconnect();
  refreshMenu(true);
  toast('正在重新连接…', 'info', 2);
}

export function togglePause(): void {
  boot();
  const hub = getHub();
  if (hub.enabled) {
    pause();
    saveEnabled(false);
    toast('桥接已暂停，Claude 暂时操作不了这块板', 'warn', 3);
  } else {
    saveEnabled(true);
    resume();
    toast('桥接已恢复', 'success', 2);
  }
  refreshMenu(true);
}

/** 自检：真的读一次当前 PCB，把结果摆出来。不碰网络，所以链路没通也能用来分辨问题出在哪一段。 */
export function runSelfTest(): void {
  boot();
  toast('正在读取当前 PCB…', 'info', 2);
  void (async () => {
    try {
      const state = await getPCBState();
      const preview = (state.components || [])
        .slice(0, 6)
        .map((c: any) => `  ${c.designator}  (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`)
        .join('\n');

      showDialog(
        [
          '读取成功 —— 扩展和 嘉立创EDA 之间没问题。',
          '',
          `元件：${state.componentCount} 个`,
          `网络：${state.netCount} 条`,
          `板框范围：(${state.boardBounds.minX.toFixed(1)}, ${state.boardBounds.minY.toFixed(1)}) ~ ` +
            `(${state.boardBounds.maxX.toFixed(1)}, ${state.boardBounds.maxY.toFixed(1)})`,
          preview ? `\n前几个元件：\n${preview}` : '',
          '',
          getHub().phase === 'online'
            ? '链路也是通的，Claude 现在就能操作。'
            : '注意：读板子没问题，但和 Claude Code 的链路还没连上（看菜单第一行）。',
        ].join('\n'),
        `${APP_NAME} · 自检`,
      );
    } catch (error) {
      showDialog(
        [
          '读取失败。',
          '',
          errText(error),
          '',
          '最常见的原因是当前标签页不是 PCB —— 先打开一个 PCB 再试。',
        ].join('\n'),
        `${APP_NAME} · 自检`,
      );
    }
  })();
}

export function changePort(): void {
  boot();
  const hub = getHub();
  promptText(
    '桥接使用的本机端口：',
    '改完会立刻按新端口重连。Claude Code 那边要设同样的 JLC_BRIDGE_PORT 环境变量。',
    `${APP_NAME} · 端口`,
    String(hub.port),
    (value) => {
      const port = Number(String(value ?? '').trim());
      if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
        if (value !== undefined) toast('端口不合法，没有改动', 'error', 3);
        return;
      }
      savePort(port);
      hub.port = port;
      reconnect();
      refreshMenu(true);
      toast(`端口已改成 ${port}，正在重连`, 'success', 3);
    },
  );
}

export function showLog(): void {
  boot();
  const hub = getHub();
  const recent = hub.logs.slice(-40);
  showDialog(
    recent.length ? recent.join('\n') : '（还没有日志）',
    `${APP_NAME} · 运行日志（最近 ${recent.length} 条）`,
  );
}

export function showHelp(): void {
  boot();
  const hub = getHub();
  const lines = [
    '按这个顺序查，一般第一步就能解决：',
    '',
    '1) Claude Code 开着吗？',
    '   桥接服务就跑在 Claude Code 的 MCP 进程里，Claude Code 没开就没人监听，',
    `   这里必然显示「未连接」。开着 Claude Code 时它会在 3 秒内自动连上。`,
    '',
    '2) 扩展的「外部交互」权限勾了吗？',
    '   高级 → 扩展 → 扩展管理器 → 找到 JLC MCP → 勾上「外部交互」。',
    '   没有这个权限，扩展连不出去，重试多少次都没用。',
    '',
    '3) 端口被别的程序占了？',
    `   当前用的是 ${hub.port}。换端口：菜单里的「连接端口…」，`,
    '   然后给 Claude Code 设一样的环境变量 JLC_BRIDGE_PORT。',
    '',
    '4) 还是不行？',
    '   点「查看运行日志」，把里面的内容发给 Claude 看。',
  ];
  if (hub.phase === 'blocked') lines.push('', '——', '当前诊断：', PERMISSION_HINT);
  showDialog(lines.join('\n'), `${APP_NAME} · 连不上怎么办`);
}

// ─── 小工具 ───

function phaseText(phase: string): string {
  switch (phase) {
    case 'online':
      return '已连接';
    case 'connecting':
      return '正在连接';
    case 'blocked':
      return '被权限挡住（需要「外部交互」）';
    case 'paused':
      return '已暂停（你自己关的）';
    default:
      return '未连接';
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}
