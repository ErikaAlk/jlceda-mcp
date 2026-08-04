// 命令实现共用的小工具。
//
// EDA 的图元对象是一堆 getState_XXX() 方法，不同版本、不同图元类型的方法名不一样，
// 所以下面这几个 readFirst* 是「按一串候选名依次试，谁先给出有效值就用谁」。
// 别改成直接取属性——那样在某些图元上会静默拿到 undefined。

export type Box = { minX: number; minY: number; maxX: number; maxY: number };

export function toFinite(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** 坐标保留三位小数。旧版漏写了这个函数，导致 auto_silkscreen 一调用就 ReferenceError。 */
export function round3(value: number): number {
  return Math.round(toFinite(value, 0) * 1000) / 1000;
}

export function readFirstStringValue(target: any, getterNames: string[]): string {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      const raw = getter.call(target);
      if (raw === undefined || raw === null) continue;
      const text = String(raw).trim();
      if (text) return text;
    } catch {
      /* 试下一个 */
    }
  }
  return '';
}

export function readFirstNumberValue(target: any, getterNames: string[]): number | undefined {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      const value = Number(getter.call(target));
      if (Number.isFinite(value)) return value;
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

export function readFirstBooleanValue(target: any, getterNames: string[]): boolean | undefined {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      return Boolean(getter.call(target));
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

export function normalizeAngle(angle: number): number {
  let value = toFinite(angle, 0);
  while (value <= -180) value += 360;
  while (value > 180) value -= 360;
  return value;
}

export function isVerticalAngle(angle: number): boolean {
  const a = Math.abs(normalizeAngle(angle));
  return Math.abs(a - 90) <= 20;
}

export function createBoxFromCenter(x: number, y: number, width: number, height: number): Box {
  const halfW = Math.max(0, toFinite(width, 0) / 2);
  const halfH = Math.max(0, toFinite(height, 0) / 2);
  return { minX: x - halfW, minY: y - halfH, maxX: x + halfW, maxY: y + halfH };
}

export function estimateStringBox(
  x: number,
  y: number,
  text: string,
  fontSize: number,
  rotation: number,
): Box {
  const content = String(text || '');
  const size = Math.max(1, toFinite(fontSize, 10));
  const estimatedWidth = Math.max(size * Math.max(content.length, 1) * 0.6, size * 0.8);
  const estimatedHeight = Math.max(size, 1);
  const width = isVerticalAngle(rotation) ? estimatedHeight : estimatedWidth;
  const height = isVerticalAngle(rotation) ? estimatedWidth : estimatedHeight;
  return createBoxFromCenter(x, y, width, height);
}

export function boxIntersects(a: Box, b: Box, tolerance = 0): boolean {
  const t = Math.max(0, toFinite(tolerance, 0));
  if (a.maxX < b.minX - t) return false;
  if (a.minX > b.maxX + t) return false;
  if (a.maxY < b.minY - t) return false;
  if (a.minY > b.maxY + t) return false;
  return true;
}

export function boxInside(inner: Box, outer: Box, margin = 0): boolean {
  const m = Math.max(0, toFinite(margin, 0));
  return (
    inner.minX >= outer.minX - m &&
    inner.minY >= outer.minY - m &&
    inner.maxX <= outer.maxX + m &&
    inner.maxY <= outer.maxY + m
  );
}

export function firstBox(boxes: Array<Box | undefined>): Box | undefined {
  for (const box of boxes) {
    if (!box) continue;
    const ok =
      Number.isFinite(box.minX) &&
      Number.isFinite(box.minY) &&
      Number.isFinite(box.maxX) &&
      Number.isFinite(box.maxY);
    if (ok) return box;
  }
  return undefined;
}

export function getPrimitiveId(primitive: any): string {
  return readFirstStringValue(primitive, ['getState_PrimitiveId']);
}

/**
 * 统一解析「要操作哪些图元」。
 * 三种写法都收：primitiveIds 数组 / primitiveId 单个 / id 单个。
 */
export function parsePrimitiveIds(params: any): string | string[] {
  if (Array.isArray(params?.primitiveIds)) {
    const ids = params.primitiveIds.map((item: any) => String(item ?? '').trim()).filter(Boolean);
    if (ids.length === 0) throw new Error('primitiveIds 不能是空数组');
    return ids;
  }
  for (const key of ['primitiveId', 'id']) {
    if (params?.[key] !== undefined) {
      const id = String(params[key] ?? '').trim();
      if (!id) throw new Error(`${key} 不能为空`);
      return id;
    }
  }
  throw new Error('需要 primitiveId 或 primitiveIds');
}

export function getRectParams(params: any): { x1: number; y1: number; x2: number; y2: number } {
  const x1 = toFinite(params?.x1, NaN);
  const y1 = toFinite(params?.y1, NaN);
  const x2 = toFinite(params?.x2, NaN);
  const y2 = toFinite(params?.y2, NaN);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    throw new Error('需要 x1/y1/x2/y2 四个坐标');
  }
  return { x1, y1, x2, y2 };
}

export function normalizeNetArray(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const net = item.trim();
      if (net) dedup.add(net);
      continue;
    }
    if (item && typeof item === 'object') {
      const netRaw = (item as any).net;
      if (typeof netRaw === 'string') {
        const net = netRaw.trim();
        if (net) dedup.add(net);
      }
    }
  }
  return Array.from(dedup);
}

export function makeRectPolygonSource(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Array<number | string> {
  const minX = Math.min(toFinite(x1), toFinite(x2));
  const maxX = Math.max(toFinite(x1), toFinite(x2));
  const minY = Math.min(toFinite(y1), toFinite(y2));
  const maxY = Math.max(toFinite(y1), toFinite(y2));
  return [minX, minY, 'L', maxX, minY, maxX, maxY, minX, maxY];
}

export function makeRectPolygonSourceR(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Array<number | string> {
  const minX = Math.min(toFinite(x1), toFinite(x2));
  const maxX = Math.max(toFinite(x1), toFinite(x2));
  const minY = Math.min(toFinite(y1), toFinite(y2));
  const maxY = Math.max(toFinite(y1), toFinite(y2));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return ['R', minX, minY, width, height, 0, 0];
}

export function encodeBase64FromArrayBuffer(buffer: ArrayBuffer): string {
  const maybeBuffer = (globalThis as any)?.Buffer;
  if (maybeBuffer?.from) return maybeBuffer.from(buffer).toString('base64');
  if (typeof btoa !== 'function') throw new Error('这个环境没有 base64 编码能力');

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
