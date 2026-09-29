// 丝印：查询、冲突检测、单个移动、自动避让。

import { edaApi } from '../eda';
import {
  boxInside,
  boxIntersects,
  createBoxFromCenter,
  isVerticalAngle,
  round3,
  toFinite,
  type Box,
} from './util';
import { getBoardBoundingBox, getSelectedPrimitiveIdSet } from './pcb-state';

/** EDA 的层 ID：3 顶层丝印，4 底层丝印 */
const SILKSCREEN_LAYERS = new Set<number>([3, 4]);

/**
 * 丝印上的字来自两种图元，挪位置时写回各自的图元对象：
 * - 文本 IPCB_PrimitiveString：直接放在板上的文字。pcb_PrimitiveString.getAll() 只给这种（pcb.js 里按 !getParent() 过滤了）。
 * - 属性 IPCB_PrimitiveAttribute：挂在元件上的文字，位号、值都是这种，由 pcb_PrimitiveAttribute.getAll() 给出。
 */
type SilkPrimitive =
  | { kind: 'string'; row: IPCB_PrimitiveString }
  | { kind: 'attribute'; row: IPCB_PrimitiveAttribute };

/** 丝印图元，属性多带所属元件的位号 */
type SilkRow =
  | { kind: 'string'; row: IPCB_PrimitiveString }
  | { kind: 'attribute'; row: IPCB_PrimitiveAttribute; designator: string };

type SilkMove = { x: number; y: number; rotation?: number };

/**
 * 图元外框（画布坐标，mil）。
 * 丝印和避让目标都用 EDA 自己算的外框：异形焊盘、旋转、文字字形都已经算进去了。
 * 取不到就报错，免得拿一个猜出来的框去判冲突、挪丝印。
 */
async function primitiveBox(kind: string, primitiveId: string): Promise<Box> {
  const api = edaApi();
  if (!api?.pcb_Primitive?.getPrimitivesBBox) {
    throw new Error('这版 嘉立创EDA 没有 pcb_Primitive.getPrimitivesBBox，算不出丝印和焊盘的外框');
  }
  const box: Box | undefined = await api.pcb_Primitive.getPrimitivesBBox([primitiveId]);
  if (!box) throw new Error(`${kind} ${primitiveId} 取不到外框`);
  return box;
}

/** 属性在画布上有没有字。EDA 自己挪属性文字前也是这么判断的（pcb.js 的 modifyAttrPosition） */
function attributeShowsText(row: IPCB_PrimitiveAttribute): boolean {
  return (
    (row.getState_KeyVisible() && Boolean(row.getState_Key())) ||
    (row.getState_ValueVisible() && Boolean(row.getState_Value()))
  );
}

/** 属性在画布上显示的字，和 pcb.js 的 getText() 一致：Key、Value 都显示时是「Key:Value」 */
function attributeText(row: IPCB_PrimitiveAttribute): string {
  const key = row.getState_Key();
  const value = row.getState_Value();
  if (row.getState_KeyVisible()) return row.getState_ValueVisible() ? `${key}:${value}` : key;
  return value;
}

/** 顶层、底层丝印上的文本，加上丝印层上显示出字来的元件属性（位号等） */
async function collectSilkscreenRows(): Promise<SilkRow[]> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveString?.getAll) throw new Error('这版 嘉立创EDA 不支持文本查询');
  if (!api?.pcb_PrimitiveAttribute?.getAll) throw new Error('这版 嘉立创EDA 不支持元件属性查询，读不到位号');
  if (!api?.pcb_PrimitiveComponent?.getAll) {
    throw new Error('这版 嘉立创EDA 不支持元件查询，查不出属性属于哪个元件');
  }

  const rows: SilkRow[] = [];
  const strings: IPCB_PrimitiveString[] = await api.pcb_PrimitiveString.getAll();
  for (const row of strings) {
    if (SILKSCREEN_LAYERS.has(row.getState_Layer())) rows.push({ kind: 'string', row });
  }

  const components: IPCB_PrimitiveComponent[] = await api.pcb_PrimitiveComponent.getAll();
  const designators = new Map<string, string | undefined>();
  for (const component of components) {
    designators.set(component.getState_PrimitiveId(), component.getState_Designator());
  }
  // 列表里是全部元件的全部属性，多数是隐藏的（Key、Value 都不显示），
  // 隐藏属性可能没有摆放位置，这时 pcb.js 把位置记成原点
  const attributes: IPCB_PrimitiveAttribute[] = await api.pcb_PrimitiveAttribute.getAll();
  for (const row of attributes) {
    if (!SILKSCREEN_LAYERS.has(row.getState_Layer()) || !attributeShowsText(row)) continue;
    const primitiveId = row.getState_PrimitiveId();
    const parentId = row.getState_ParentPrimitiveId();
    // pcb.js 里这两个接口遍历的是同一批元件，对不上说明 EDA 的数据变了
    if (!designators.has(parentId)) {
      throw new Error(`属性 ${primitiveId} 的父图元 ${parentId} 不在元件列表里`);
    }
    const designator = designators.get(parentId);
    if (designator === undefined) {
      throw new Error(`元件 ${parentId} 没有位号，认不出丝印上的 ${row.getState_Key()} 属性 ${primitiveId} 属于谁`);
    }
    rows.push({ kind: 'attribute', row, designator });
  }
  return rows;
}

/** 文本和属性各自的字段，属性多带 Key、Value 和所属元件；label 用在报错里 */
function ownFields(silk: SilkRow): { label: string; fields: Record<string, unknown> } {
  if (silk.kind === 'string') {
    const { row } = silk;
    return {
      label: '丝印',
      fields: { kind: 'string', text: row.getState_Text(), x: row.getState_X(), y: row.getState_Y() },
    };
  }

  const { row, designator } = silk;
  const key = row.getState_Key();
  const x = row.getState_X();
  const y = row.getState_Y();
  // api-types 里属性坐标的类型是 number | null。pcb.js 只会把隐藏的属性标成没有摆放位置（positionIsNull），
  // 显示着的属性拿到 null 说明 EDA 的数据格式变了
  if (x === null || y === null) {
    throw new Error(`元件 ${designator} 的 ${key} 属性 ${row.getState_PrimitiveId()} 显示在丝印上，却没有坐标`);
  }
  return {
    label: `元件 ${designator} 的 ${key} 属性`,
    fields: {
      kind: 'attribute',
      text: attributeText(row),
      key,
      value: row.getState_Value(),
      parentPrimitiveId: row.getState_ParentPrimitiveId(),
      designator,
      x,
      y,
    },
  };
}

async function buildSilkscreenItem(silk: SilkRow, selectedSet: Set<string>): Promise<any> {
  const { row } = silk;
  const primitiveId = row.getState_PrimitiveId();
  const { label, fields } = ownFields(silk);
  const bbox = await primitiveBox(label, primitiveId);
  return {
    primitiveId,
    ...fields,
    rotation: row.getState_Rotation(),
    fontSize: row.getState_FontSize(),
    layer: row.getState_Layer(),
    locked: row.getState_PrimitiveLock(),
    selected: selectedSet.has(primitiveId),
    bbox,
    width: bbox.maxX - bbox.minX,
    height: bbox.maxY - bbox.minY,
  };
}

type Obstacle = { primitiveId: string; net: string; box: Box };

async function toObstacle(kind: string, row: IPCB_PrimitivePad | IPCB_PrimitiveVia): Promise<Obstacle> {
  const primitiveId = row.getState_PrimitiveId();
  return { primitiveId, net: row.getState_Net() ?? '', box: await primitiveBox(kind, primitiveId) };
}

async function collectAllObstacles(): Promise<{ pads: Obstacle[]; vias: Obstacle[] }> {
  const api = edaApi();
  if (!api?.pcb_PrimitivePad?.getAll || !api?.pcb_PrimitiveVia?.getAll) {
    throw new Error('这版 嘉立创EDA 不支持焊盘或过孔查询，没法判断丝印压没压到它们');
  }
  const padRows: IPCB_PrimitivePad[] = await api.pcb_PrimitivePad.getAll();
  const viaRows: IPCB_PrimitiveVia[] = await api.pcb_PrimitiveVia.getAll();
  const pads: Obstacle[] = [];
  for (const row of padRows) pads.push(await toObstacle('焊盘', row));
  const vias: Obstacle[] = [];
  for (const row of viaRows) vias.push(await toObstacle('过孔', row));
  return { pads, vias };
}

async function detectConflicts(silkscreens: any[]): Promise<{
  perSilk: Map<string, any[]>;
  stats: { totalConflicts: number; byType: Record<string, number> };
  boardBox?: Box;
}> {
  const { pads, vias } = await collectAllObstacles();
  const boardBox = await getBoardBoundingBox();
  const perSilk = new Map<string, any[]>();
  const byType: Record<string, number> = {};
  let totalConflicts = 0;

  const push = (silkId: string, conflict: any) => {
    if (!perSilk.has(silkId)) perSilk.set(silkId, []);
    perSilk.get(silkId)!.push(conflict);
    const key = String(conflict.type || 'unknown');
    byType[key] = (byType[key] || 0) + 1;
    totalConflicts += 1;
  };

  for (const silk of silkscreens) {
    const silkBox: Box | undefined = silk?.bbox;
    const silkId = String(silk?.primitiveId || '');
    if (!silkBox || !silkId) continue;

    if (boardBox && !boxInside(silkBox, boardBox, 0)) {
      push(silkId, { type: 'out_of_board', targetId: 'BOARD', description: '丝印超出板框' });
    }
    for (const pad of pads) {
      if (boxIntersects(silkBox, pad.box, 0.5)) {
        push(silkId, {
          type: 'overlap_pad',
          targetId: pad.primitiveId,
          net: pad.net || '',
          description: '丝印压在焊盘上',
        });
      }
    }
    for (const via of vias) {
      if (boxIntersects(silkBox, via.box, 0.5)) {
        push(silkId, {
          type: 'overlap_via',
          targetId: via.primitiveId,
          net: via.net || '',
          description: '丝印压在过孔上',
        });
      }
    }
  }

  for (let i = 0; i < silkscreens.length; i += 1) {
    const a = silkscreens[i];
    if (!a?.bbox || !a?.primitiveId) continue;
    for (let j = i + 1; j < silkscreens.length; j += 1) {
      const b = silkscreens[j];
      if (!b?.bbox || !b?.primitiveId) continue;
      if (!boxIntersects(a.bbox, b.bbox, 0.5)) continue;
      push(a.primitiveId, {
        type: 'overlap_silkscreen',
        targetId: b.primitiveId,
        description: '两条丝印互相重叠',
      });
      push(b.primitiveId, {
        type: 'overlap_silkscreen',
        targetId: a.primitiveId,
        description: '两条丝印互相重叠',
      });
    }
  }

  return { perSilk, stats: { totalConflicts, byType }, boardBox: boardBox || undefined };
}

type SilkQuery = { includeConflicts?: boolean; onlyConflicted?: boolean; limit?: number };

/** 查丝印，连同每条丝印的图元对象一起给出（自动避让要拿它写回画布） */
async function readSilkscreens(params?: SilkQuery): Promise<{ result: any; rowsById: Map<string, SilkRow> }> {
  const rows = await collectSilkscreenRows();
  const selectedSet = await getSelectedPrimitiveIdSet();
  const limit = Math.max(1, Math.floor(toFinite(params?.limit, 20000)));

  const silkscreens: any[] = [];
  const rowsById = new Map<string, SilkRow>();
  for (const row of rows) {
    const item = await buildSilkscreenItem(row, selectedSet);
    silkscreens.push(item);
    rowsById.set(item.primitiveId, row);
    if (silkscreens.length >= limit) break;
  }

  if (!params?.includeConflicts && !params?.onlyConflicted) {
    const result = {
      totalSilkscreens: silkscreens.length,
      returnedSilkscreens: silkscreens.length,
      silkscreens,
    };
    return { result, rowsById };
  }

  const conflictResult = await detectConflicts(silkscreens);
  const onlyConflicted = Boolean(params?.onlyConflicted);
  const output = [];
  for (const item of silkscreens) {
    const conflicts = conflictResult.perSilk.get(item.primitiveId) || [];
    const next = { ...item, hasConflict: conflicts.length > 0, conflicts, conflictCount: conflicts.length };
    if (!onlyConflicted || next.hasConflict) output.push(next);
  }

  const result = {
    totalSilkscreens: silkscreens.length,
    returnedSilkscreens: output.length,
    conflictSummary: conflictResult.stats,
    boardBox: conflictResult.boardBox || null,
    silkscreens: output,
  };
  return { result, rowsById };
}

export async function getSilkscreens(params?: SilkQuery): Promise<any> {
  return (await readSilkscreens(params)).result;
}

/**
 * 把丝印图元挪到新位置，写回画布。
 * 不调 pcb_PrimitiveString.modify / pcb_PrimitiveAttribute.modify：api.js 里这两个方法调 done() 时没有 await，
 * EDA 拒绝写入时 done() 抛的「对象参数不正确，无法应用到画布」没人接，调用方照样拿到成功。
 * 这里改完坐标直接 await 图元对象的 done()，发的是同一个 modify 请求，写入失败会抛到调用方。
 * done() 发的是对象的全部字段，所以写之前先 reset() 读回画布现状，免得拿查询时的旧值
 * 盖掉用户这段时间里改过的内容（比如位号）；图元已经被删掉时 reset() 直接抛错。
 */
async function writeMove(row: IPCB_PrimitiveString | IPCB_PrimitiveAttribute, move: SilkMove): Promise<void> {
  // getAll 给的对象本来就是异步模式；同步模式下 setState_* 会自己调 done()，同样不 await
  row.toAsync();
  await row.reset();
  row.setState_X(move.x);
  row.setState_Y(move.y);
  if (move.rotation !== undefined) row.setState_Rotation(move.rotation);
  await row.done();
}

/**
 * 按图元 ID 找丝印图元，文本和元件属性都找。
 * 不用 pcb_PrimitiveAttribute.get()：api.js 里它按单个 ID 查不到时返回空数组（类型声明写的是 undefined）。
 */
async function findSilkPrimitive(primitiveId: string): Promise<SilkPrimitive> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveString?.getAll || !api?.pcb_PrimitiveAttribute?.getAll) {
    throw new Error('这版 嘉立创EDA 不支持文本或元件属性查询，找不到要挪的丝印');
  }
  const attributes: IPCB_PrimitiveAttribute[] = await api.pcb_PrimitiveAttribute.getAll();
  const attribute = attributes.find((row) => row.getState_PrimitiveId() === primitiveId);
  if (attribute) return { kind: 'attribute', row: attribute };
  const strings: IPCB_PrimitiveString[] = await api.pcb_PrimitiveString.getAll();
  const text = strings.find((row) => row.getState_PrimitiveId() === primitiveId);
  if (text) return { kind: 'string', row: text };
  throw new Error(`找不到图元 ${primitiveId}：它既不是文本，也不是元件属性`);
}

/** 挪一条丝印。primitiveId 可以是文本，也可以是元件属性（位号等） */
export async function moveSilkscreen(params: {
  primitiveId: string;
  x: number;
  y: number;
  rotation?: number;
}): Promise<any> {
  if (!params?.primitiveId) throw new Error('需要 primitiveId');
  if (!Number.isFinite(Number(params?.x)) || !Number.isFinite(Number(params?.y))) {
    throw new Error('x/y 必须是数字');
  }
  if (params.rotation !== undefined && !Number.isFinite(Number(params.rotation))) {
    throw new Error('rotation 必须是数字');
  }

  const primitiveId = String(params.primitiveId);
  const move: SilkMove = { x: Number(params.x), y: Number(params.y) };
  if (params.rotation !== undefined) move.rotation = Number(params.rotation);

  const { kind, row } = await findSilkPrimitive(primitiveId);
  await writeMove(row, move);
  return { primitiveId, kind, ...move };
}

/** 自动避让结果里认图元用的字段，属性多给所属元件的位号 */
function describeItem(item: any): Record<string, unknown> {
  const base = { primitiveId: item.primitiveId, kind: item.kind, text: item.text };
  return item.kind === 'attribute' ? { ...base, designator: item.designator } : base;
}

function translatedBox(item: any, x: number, y: number, rotation: number): Box {
  const w = Math.max(1, toFinite(item?.width, 10));
  const h = Math.max(1, toFinite(item?.height, 10));
  const vertical = isVerticalAngle(rotation);
  return createBoxFromCenter(x, y, vertical ? h : w, vertical ? w : h);
}

/**
 * 自动挪丝印避让。
 *
 * 注意：旧版这里调了一个从来没定义过的 round3()，所以这个命令一被调用就是
 * ReferenceError —— 也就是说 pcb_auto_silkscreen 这个工具从来没成功跑过。
 * round3 现在在 util.ts 里。
 */
export async function autoSilkscreen(params?: {
  maxMoves?: number;
  step?: number;
  maxRadius?: number;
  tryAngles?: number[];
  onlyConflicted?: boolean;
}): Promise<any> {
  const maxMoves = Math.max(1, Math.floor(toFinite(params?.maxMoves, 80)));
  const step = Math.max(2, toFinite(params?.step, 12));
  const maxRadius = Math.max(step, toFinite(params?.maxRadius, 96));
  const angleCandidates =
    Array.isArray(params?.tryAngles) && params!.tryAngles!.length > 0
      ? params!.tryAngles!.map((a) => toFinite(a, 0))
      : [0, 90, 180, -90];

  const { result: silkResult, rowsById } = await readSilkscreens({
    includeConflicts: true,
    onlyConflicted: Boolean(params?.onlyConflicted),
  });
  const items: any[] = Array.isArray(silkResult?.silkscreens) ? silkResult.silkscreens : [];
  if (items.length === 0) return { total: 0, moved: 0, improved: 0, skipped: 0, details: [] };

  const { pads, vias } = await collectAllObstacles();
  const boardBox = (await getBoardBoundingBox()) || undefined;

  const fixedBoxes = new Map<string, Box>();
  for (const item of items) {
    if (item?.primitiveId && item?.bbox) fixedBoxes.set(String(item.primitiveId), item.bbox as Box);
  }

  const score = (selfId: string, candidate: Box): number => {
    let total = 0;
    for (const pad of pads) if (boxIntersects(candidate, pad.box, 0.5)) total += 20;
    for (const via of vias) if (boxIntersects(candidate, via.box, 0.5)) total += 18;
    for (const [otherId, otherBox] of fixedBoxes.entries()) {
      if (otherId === selfId) continue;
      if (boxIntersects(candidate, otherBox, 0.5)) total += 12;
    }
    if (boardBox && !boxInside(candidate, boardBox, 0)) total += 50;
    return total;
  };

  const sorted = [...items].sort(
    (a, b) => Number(b?.conflictCount || 0) - Number(a?.conflictCount || 0),
  );
  const details: any[] = [];
  let moved = 0;
  let skipped = 0;

  const directions = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [0, 0],
  ];

  for (const item of sorted) {
    if (moved >= maxMoves) break;
    const primitiveId = String(item?.primitiveId || '');
    if (!primitiveId || item?.locked) {
      skipped += 1;
      continue;
    }

    const ox = toFinite(item.x, 0);
    const oy = toFinite(item.y, 0);
    const orot = toFinite(item.rotation, 0);
    const originalScore = score(primitiveId, translatedBox(item, ox, oy, orot));

    let best = { x: ox, y: oy, rotation: orot, score: originalScore, distance: 0 };
    const angles = Array.from(new Set([orot, ...angleCandidates]));

    search: for (let radius = 0; radius <= maxRadius; radius += step) {
      for (const [dx, dy] of directions) {
        const x = round3(ox + dx * radius);
        const y = round3(oy + dy * radius);
        for (const rotation of angles) {
          const candidateScore = score(primitiveId, translatedBox(item, x, y, rotation));
          const distance = Math.hypot(x - ox, y - oy);
          if (candidateScore < best.score || (candidateScore === best.score && distance < best.distance)) {
            best = { x, y, rotation, score: candidateScore, distance };
          }
          if (best.score === 0 && best.distance <= step) break search;
        }
      }
    }

    if (best.score < originalScore) {
      const silk = rowsById.get(primitiveId);
      if (!silk) throw new Error(`丝印 ${primitiveId} 在查询结果里却没有对应的图元对象`);
      await writeMove(silk.row, { x: best.x, y: best.y, rotation: best.rotation });
      moved += 1;
      fixedBoxes.set(primitiveId, translatedBox(item, best.x, best.y, best.rotation));
      details.push({
        ...describeItem(item),
        from: { x: ox, y: oy, rotation: orot, score: originalScore },
        to: { x: best.x, y: best.y, rotation: best.rotation, score: best.score },
      });
    } else {
      skipped += 1;
      details.push({
        ...describeItem(item),
        from: { x: ox, y: oy, rotation: orot, score: originalScore },
        skipped: true,
      });
    }
  }

  return { total: sorted.length, moved, improved: moved, skipped, details };
}
