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
import { getBoardBoundingBox, getSelectedPrimitiveIdSet, primitiveBox } from './pcb-state';

/** EDA 的层 ID：3 顶层丝印，4 底层丝印 */
const SILKSCREEN_LAYERS = new Set<number>([3, 4]);

/** 顶层、底层丝印上的文本。pcb_PrimitiveString 只给不挂在元件上的文本，元件位号不在里面。 */
async function collectSilkscreenRows(): Promise<IPCB_PrimitiveString[]> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveString?.getAll) throw new Error('这版 嘉立创EDA 不支持文本查询');
  const rows: IPCB_PrimitiveString[] = await api.pcb_PrimitiveString.getAll();
  return rows.filter((row) => SILKSCREEN_LAYERS.has(row.getState_Layer()));
}

async function buildSilkscreenItem(row: IPCB_PrimitiveString, selectedSet: Set<string>): Promise<any> {
  const primitiveId = row.getState_PrimitiveId();
  const bbox = await primitiveBox('丝印', primitiveId);
  return {
    primitiveId,
    text: row.getState_Text(),
    x: row.getState_X(),
    y: row.getState_Y(),
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
  const { pads, vias } =
    silkscreens.length > 0 ? await collectAllObstacles() : { pads: [], vias: [] };
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

export async function getSilkscreens(params?: {
  includeConflicts?: boolean;
  onlyConflicted?: boolean;
  limit?: number;
}): Promise<any> {
  const rows = await collectSilkscreenRows();
  const selectedSet = await getSelectedPrimitiveIdSet();
  const limit = Math.max(1, Math.floor(toFinite(params?.limit, 20000)));

  const silkscreens: any[] = [];
  for (const row of rows) {
    silkscreens.push(await buildSilkscreenItem(row, selectedSet));
    if (silkscreens.length >= limit) break;
  }

  if (!params?.includeConflicts && !params?.onlyConflicted) {
    return {
      totalSilkscreens: silkscreens.length,
      returnedSilkscreens: silkscreens.length,
      silkscreens,
    };
  }

  const conflictResult = await detectConflicts(silkscreens);
  const onlyConflicted = Boolean(params?.onlyConflicted);
  const output = [];
  for (const item of silkscreens) {
    const conflicts = conflictResult.perSilk.get(item.primitiveId) || [];
    const next = { ...item, hasConflict: conflicts.length > 0, conflicts, conflictCount: conflicts.length };
    if (!onlyConflicted || next.hasConflict) output.push(next);
  }

  return {
    totalSilkscreens: silkscreens.length,
    returnedSilkscreens: output.length,
    conflictSummary: conflictResult.stats,
    boardBox: conflictResult.boardBox || null,
    silkscreens: output,
  };
}

export async function moveSilkscreen(params: {
  primitiveId: string;
  x: number;
  y: number;
  rotation?: number;
}): Promise<any> {
  const api = edaApi();
  if (!params?.primitiveId) throw new Error('需要 primitiveId');
  if (!Number.isFinite(Number(params?.x)) || !Number.isFinite(Number(params?.y))) {
    throw new Error('x/y 必须是数字');
  }
  if (!api?.pcb_PrimitiveString?.modify) throw new Error('这版 嘉立创EDA 不支持修改丝印');

  const property: any = { x: Number(params.x), y: Number(params.y) };
  if (params.rotation !== undefined) property.rotation = Number(params.rotation);

  await api.pcb_PrimitiveString.modify(String(params.primitiveId), property);
  return { primitiveId: String(params.primitiveId), ...property };
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
  const api = edaApi();
  if (!api?.pcb_PrimitiveString?.modify) throw new Error('这版 嘉立创EDA 不支持修改丝印');

  const maxMoves = Math.max(1, Math.floor(toFinite(params?.maxMoves, 80)));
  const step = Math.max(2, toFinite(params?.step, 12));
  const maxRadius = Math.max(step, toFinite(params?.maxRadius, 96));
  const angleCandidates =
    Array.isArray(params?.tryAngles) && params!.tryAngles!.length > 0
      ? params!.tryAngles!.map((a) => toFinite(a, 0))
      : [0, 90, 180, -90];

  const silkResult = await getSilkscreens({
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
      await api.pcb_PrimitiveString.modify(primitiveId, {
        x: best.x,
        y: best.y,
        rotation: best.rotation,
      });
      moved += 1;
      fixedBoxes.set(primitiveId, translatedBox(item, best.x, best.y, best.rotation));
      details.push({
        primitiveId,
        text: item.text,
        from: { x: ox, y: oy, rotation: orot, score: originalScore },
        to: { x: best.x, y: best.y, rotation: best.rotation, score: best.score },
      });
    } else {
      skipped += 1;
      details.push({
        primitiveId,
        text: item.text,
        from: { x: ox, y: oy, rotation: orot, score: originalScore },
        skipped: true,
      });
    }
  }

  return { total: sorted.length, moved, improved: moved, skipped, details };
}
