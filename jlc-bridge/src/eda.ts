// 对 EDA 扩展 API 的一层薄封装。
//
// 只做三件事：把 `eda` 全局收敛成一个入口；把「这个 API 在这版 EDA 上有没有」的判断
// 集中在这里；把会抛异常的调用包成返回值，免得一个可选功能缺失就把整个命令炸掉。
//
// 沙箱里被 EDA 明确禁掉的东西（别去用，用了是静默 undefined 或直接抛）：
//   fetch / XMLHttpRequest / WebSocket / Worker / BroadcastChannel / localStorage /
//   indexedDB / document / window / eval / Function / alert
// 联外网只有 eda.sys_WebSocket 一条路，而且要「外部交互」权限。

export function edaApi(): any {
  try {
    // eda 由沙箱注入，直接引用；打包后在别的环境跑到这里会是 ReferenceError，所以兜一层
    return typeof eda !== 'undefined' ? (eda as any) : undefined;
  } catch {
    return undefined;
  }
}

/** 「外部交互」权限没开时，sys_WebSocket / sys_FileSystem 一律 throw，错误里带这句话。 */
export function isPermissionError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return text.includes('外部交互') || text.toLowerCase().includes('external interaction');
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ─── 弹窗 / 提示 ───

export function showDialog(content: string, title: string): void {
  const api = edaApi();
  try {
    api?.sys_Dialog?.showInformationMessage?.(content, title);
  } catch {
    try {
      console.log(`[${title}] ${content}`);
    } catch {
      /* ignore */
    }
  }
}

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

/** 非侵入式提示。做完一件小事就用它，别动不动弹模态框。 */
export function toast(message: string, kind: ToastKind = 'info', seconds = 3): void {
  const api = edaApi();
  try {
    if (api?.sys_Message?.showToastMessage) {
      api.sys_Message.showToastMessage(message, kind, seconds);
      return;
    }
    api?.sys_ToastMessage?.showMessage?.(message, kind, seconds);
  } catch {
    /* 提示失败不值得打断流程 */
  }
}

export function confirm(
  content: string,
  title: string,
  mainButton: string,
  cancelButton: string,
  onResult: (confirmed: boolean) => void,
): void {
  const api = edaApi();
  try {
    api?.sys_Dialog?.showConfirmationMessage?.(content, title, mainButton, cancelButton, onResult);
  } catch {
    onResult(false);
  }
}

export function promptText(
  before: string,
  after: string,
  title: string,
  value: string,
  onResult: (value: any) => void,
): void {
  const api = edaApi();
  try {
    api?.sys_Dialog?.showInputDialog?.(before, after, title, 'text', value, undefined, onResult);
  } catch {
    onResult(undefined);
  }
}

// ─── 配置存取（同步读，异步写） ───

export function readConfig<T>(key: string, fallback: T): T {
  try {
    const raw = edaApi()?.sys_Storage?.getExtensionUserConfig?.(key);
    return raw === undefined || raw === null ? fallback : (raw as T);
  } catch {
    return fallback;
  }
}

export function writeConfig(key: string, value: unknown): void {
  try {
    const result = edaApi()?.sys_Storage?.setExtensionUserConfig?.(key, value);
    // 返回的是 Promise，这里不需要等；吞掉 rejection 免得变成 unhandled
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* ignore */
  }
}

// ─── 定时器（按 ID 去重，重复 set 会替换旧的，正好适合「每次求值都调一遍」） ───

export function setInterval_(id: string, ms: number, fn: () => void): boolean {
  try {
    return Boolean(edaApi()?.sys_Timer?.setIntervalTimer?.(id, ms, fn));
  } catch {
    return false;
  }
}

export function clearInterval_(id: string): void {
  try {
    edaApi()?.sys_Timer?.clearIntervalTimer?.(id);
  } catch {
    /* ignore */
  }
}

export function delay(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    if (typeof setTimeout === 'function') {
      setTimeout(resolve, ms);
      return;
    }
    const id = `jlc_bridge_delay_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const timer = edaApi()?.sys_Timer;
    if (!timer?.setTimeoutTimer) {
      resolve();
      return;
    }
    timer.setTimeoutTimer(id, ms, () => {
      try {
        resolve();
      } finally {
        try {
          timer.clearTimeoutTimer?.(id);
        } catch {
          /* ignore */
        }
      }
    });
  });
}

// ─── WebSocket（唯一的对外通道） ───

export function wsRegister(
  id: string,
  url: string,
  onMessage: (ev: MessageEvent<any>) => void,
  onConnected: () => void,
): void {
  const api = edaApi();
  if (!api?.sys_WebSocket?.register) {
    throw new Error('这版嘉立创EDA 没有 sys_WebSocket 接口（需要 3.0 以上）');
  }
  api.sys_WebSocket.register(id, url, onMessage, onConnected);
}

export function wsSend(id: string, data: string): void {
  edaApi()?.sys_WebSocket?.send?.(id, data);
}

export function wsClose(id: string): void {
  try {
    edaApi()?.sys_WebSocket?.close?.(id, 1000, 'bridge closing');
  } catch {
    /* ignore */
  }
}

// ─── 环境信息 ───

export function edaVersion(): string {
  const api = edaApi();
  for (const getter of ['getEdaVersion', 'getVersion', 'getClientVersion']) {
    try {
      const value = api?.sys_Environment?.[getter]?.();
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {
      /* 试下一个 */
    }
  }
  return '';
}
