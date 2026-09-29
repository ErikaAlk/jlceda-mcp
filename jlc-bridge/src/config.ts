import * as extensionConfig from '../extension.json';
import { DEFAULT_PORT } from './protocol';
import { readConfig, writeConfig } from './eda';

export const APP_NAME = String((extensionConfig as any).displayName || 'JLC MCP');
export const APP_VERSION = String((extensionConfig as any).version || '0.0.0');

/** 构建时由 build/compile.js 注入：打包产物的 SHA-256 前 12 位 */
declare const __CODE_HASH__: string;

/**
 * 这份代码的构建标识：版本号+代码哈希。改了代码，版本号不动它也会变；源码不变时重新构建，它不变。
 * 用途见 link.ts：重新导入扩展之后，globalThis 上的 hub 还是上一版代码留下的，
 * 靠它发现这件事并推倒重连。
 */
export const CODE_BUILD = `${APP_VERSION}+${__CODE_HASH__}`;

export const HEADER_MENUS = (extensionConfig as any).headerMenus;

const PORT_KEY = 'bridgePort';
const ENABLED_KEY = 'bridgeEnabled';

export function readPort(): number {
  const raw = Number(readConfig(PORT_KEY, DEFAULT_PORT));
  return Number.isFinite(raw) && raw > 0 && raw < 65536 ? Math.floor(raw) : DEFAULT_PORT;
}

export function savePort(port: number): void {
  writeConfig(PORT_KEY, port);
}

/**
 * 桥接开关的持久值。
 *
 * 默认 true —— 这是和旧版最大的行为差别：旧版默认关，要人去点一次 Enable，
 * 而那个菜单项的文字又看不出当前是开是关，于是「装完不知道要点、点了不知道点没点」。
 * 现在装完即用，不想要的人再去点「暂停」。
 */
export function readEnabled(): boolean {
  const raw = readConfig<any>(ENABLED_KEY, true);
  if (raw === false || raw === 'false' || raw === 0) return false;
  return true;
}

export function saveEnabled(enabled: boolean): void {
  writeConfig(ENABLED_KEY, enabled);
}
