// 复刻 嘉立创EDA 跑扩展的方式，用来在 Node 里测真实打包产物。
//
// 这不是「差不多的模拟」——下面的 with(sandbox) + Proxy + AsyncFunction 是从
// 安装目录 assets/pro-api/0.3.4.*/api.js 的 Tg() / xg() / Ta() 逐段抄出来的，
// 包括那条最要命的行为：
//
//     **每调用一次扩展里的函数，都会把整个 bundle 重新求值一遍。**
//
// 有了它，「点两次菜单才生效」「状态窗口卡 5 秒」这类问题在 Node 里就能复现和回归，
// 不用一遍遍去点 EDA 的界面。

import { readFileSync } from 'node:fs';

/** api.js 里的 eF：这些标识符即使 sandbox 上有也会被读成 undefined */
const BLOCKED = new Set([
  '__proto__',
  'eval',
  'Function',
  'globalThis',
  'top',
  'parent',
  'frames',
  'window',
  'opener',
]);

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/**
 * @param {string} bundlePath 打包后的 index.js
 * @param {object} edaMock 假的 eda 对象
 * @returns {{ call: (fn: string, arg?: string) => Promise<void>, evaluations: () => number }}
 */
export function createEdaRuntime(bundlePath, edaMock) {
  let evaluations = 0;

  // EDA 沙箱里被显式抹掉的浏览器能力。列在这里是为了让测试也踩到同样的限制——
  // 比如扩展代码里要是不小心用了 fetch / WebSocket / localStorage，测试就该炸。
  const sandbox = {
    document: undefined,
    indexedDB: undefined,
    localStorage: undefined,
    sessionStorage: undefined,
    location: undefined,
    navigator: undefined,
    self: undefined,
    window: undefined,
    eval: undefined,
    Function: undefined,
    fetch: () => {
      throw new Error('扩展内 fetch() 已被禁用');
    },
    alert: () => {
      throw new Error('扩展内 alert() 已被禁用');
    },
    WebSocket: undefined,
    XMLHttpRequest: undefined,
    BroadcastChannel: undefined,
    Worker: undefined,
    setTimeout: (...args) => setTimeout(...args),
    setInterval: (...args) => setInterval(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    clearInterval: (...args) => clearInterval(...args),
    console,
    crypto: globalThis.crypto,
    Blob: globalThis.Blob,
    btoa: globalThis.btoa,
    eda: edaMock,
  };

  const proxy = new Proxy(sandbox, {
    has: (target, key) => key in target,
    get(target, key, receiver) {
      if (key === Symbol.unscopables) return undefined;
      if (typeof key === 'string' && (key.startsWith('_') || BLOCKED.has(key))) return undefined;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) {
      if (typeof key === 'string' && key.startsWith('_')) return false;
      target[key] = value;
      return true;
    },
    ownKeys: (target) =>
      Object.keys(target).filter((k) => !k.startsWith('_') && !BLOCKED.has(k)),
  });

  async function call(fnName, arg) {
    evaluations += 1;
    // 每次都重新从磁盘读，和 EDA 一样（它每次从 IndexedDB 取 entry 文件）
    const source = readFileSync(bundlePath, 'utf8');
    const argExpr = arg === undefined ? 'undefined' : JSON.stringify(arg);
    const tail = `
/**/
if (typeof ${fnName} === 'function') {${fnName}(${argExpr});} else if (edaEsbuildExportName && typeof edaEsbuildExportName.${fnName} === 'function') {edaEsbuildExportName.${fnName}(${argExpr});}`;
    const body = `with (sandbox) {/**/\n${source}${tail}\n/**/}`;
    const fn = new AsyncFunction('sandbox', body);
    await fn(proxy);
  }

  return { call, evaluations: () => evaluations, sandbox };
}

/**
 * 一个够用的假 eda。记录所有被调用的东西，让测试可以断言
 * 「有没有注册菜单」「有没有装心跳」「弹窗里写了什么」。
 */
export function createEdaMock(options = {}) {
  const state = {
    config: { ...(options.config || {}) },
    menus: null,
    menuReplaceCount: 0,
    dialogs: [],
    toasts: [],
    intervals: new Map(),
    ws: {
      registered: [],
      sent: [],
      /** 设成 true 模拟「外部交互权限没开」 */
      denyPermission: Boolean(options.denyPermission),
      onMessage: null,
      onConnected: null,
      /** register 时是否立刻回调 onConnected（EDA 在复用已有连接时就是这样） */
      autoConnect: options.autoConnect !== false,
      /**
       * 对端在不在。false 时 register **不抛异常也不回调** —— 这正是
       * 「Claude Code 还没开」时 sys_WebSocket 的真实行为：WebSocket 构造照样成功，
       * 失败是异步的而且一个回调都不给。测「先开 EDA、后开 Claude Code」要靠它。
       */
      serverUp: options.serverUp !== false,
      /** 收到 hello 是否自动回一帧（模拟 broker 的行为）。默认开 */
      autoRespondHello: options.autoRespondHello !== false,
      closed: 0,
    },
  };

  const permissionError = () =>
    new Error('错误：未启用扩展和独立脚本的外部交互权限！');

  const eda = {
    sys_Storage: {
      getExtensionUserConfig: (key) => state.config[key],
      setExtensionUserConfig: async (key, value) => {
        state.config[key] = value;
        return true;
      },
    },
    sys_HeaderMenu: {
      replaceHeaderMenus: async (menus) => {
        state.menus = menus;
        state.menuReplaceCount += 1;
      },
    },
    sys_Dialog: {
      showInformationMessage: (content, title) => state.dialogs.push({ content, title }),
      showInputDialog: (before, after, title, type, value, other, cb) => {
        state.lastPrompt = { before, after, title, value };
        if (options.promptAnswer !== undefined) cb?.(options.promptAnswer);
      },
    },
    sys_Message: {
      showToastMessage: (message, kind) => state.toasts.push({ message, kind }),
    },
    sys_Timer: {
      setIntervalTimer: (id, ms, fn) => {
        // EDA 的语义：同 ID 重复注册会替换掉旧的
        const prev = state.intervals.get(id);
        if (prev) clearInterval(prev.handle);
        const handle = setInterval(fn, ms);
        handle.unref?.();
        state.intervals.set(id, { handle, ms, fn });
        return true;
      },
      clearIntervalTimer: (id) => {
        const prev = state.intervals.get(id);
        if (prev) clearInterval(prev.handle);
        state.intervals.delete(id);
        return true;
      },
      setTimeoutTimer: (id, ms, fn) => {
        setTimeout(fn, ms);
        return true;
      },
      clearTimeoutTimer: () => true,
    },
    sys_WebSocket: {
      register: (id, url, onMessage, onConnected) => {
        if (state.ws.denyPermission) throw permissionError();
        state.ws.registered.push({ id, url });
        state.ws.onMessage = onMessage;
        state.ws.onConnected = onConnected;
        // 对端不在：静默失败，什么回调都不给
        if (!state.ws.serverUp) return;
        if (state.ws.autoConnect) onConnected?.();
      },
      send: (id, data) => {
        if (state.ws.denyPermission) throw permissionError();
        if (!state.ws.serverUp) throw new Error('错误：WebSocket 数据发送失败！');
        state.ws.sent.push(data);
        // 照 broker 的约定：收到 hello 立刻回一帧，让扩展能马上判定「真的通了」。
        // 不模拟这一下的话，测试里的扩展会一直停在 connecting，和线上行为对不上。
        if (state.ws.autoRespondHello) {
          try {
            if (JSON.parse(data)?.t === 'hello') {
              state.ws.onMessage?.({
                data: JSON.stringify({ v: 2, t: 'ping', ts: Date.now() }),
              });
            }
          } catch {
            /* 不是 JSON 就算了 */
          }
        }
      },
      close: () => {
        state.ws.closed += 1;
        state.ws.onMessage = null;
      },
    },
    sys_Environment: {
      getEdaVersion: () => '3.2.166',
    },
    ...(options.extraApi || {}),
  };

  /**
   * 收摊。**每个用例跑完必须调**：扩展的心跳是个真的 setInterval，不清掉的话
   * 上一个用例的心跳会继续跑，而它 getHub() 拿到的是同一个 globalThis 上的 hub，
   * 于是去改下一个用例的状态 —— 表现是用例单跑过、一起跑就诡异地挂。
   */
  const dispose = () => {
    for (const { handle } of state.intervals.values()) clearInterval(handle);
    state.intervals.clear();
    state.ws.onMessage = null;
    state.ws.onConnected = null;
  };

  return { eda, state, dispose };
}
