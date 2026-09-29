// PCB 写操作：元件搬移、走线、过孔、禁布区、铺铜、差分对/等长组。
//
// 这里几个 create 用了「候选参数组合逐个试」的笨办法（keepout / pour）。
// 不是写着玩的：pcb_PrimitiveRegion.create / pcb_PrimitivePour.create 的签名在
// 不同 EDA 小版本之间变过，多边形对象的构造方式也有两套（createPolygon / 直接给数组），
// 试一遍是唯一能跨版本工作的做法。别「优化」成只试一种。

import { edaApi, delay } from '../eda';
import { primitiveBox } from './pcb-state';
import {
  getPrimitiveId,
  makeRectPolygonSource,
  makeRectPolygonSourceR,
  parsePrimitiveIds,
  getRectParams,
  toFinite,
} from './util';

// ─── 元件 ───

type ComponentMove = { x: number; y: number; rotation?: number };

async function findComponentRow(
  designator: string,
): Promise<{ id: string; row: IPCB_PrimitiveComponent }> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveComponent?.getAll) throw new Error('这版 嘉立创EDA 不支持查询元件');
  const rows: IPCB_PrimitiveComponent[] = await api.pcb_PrimitiveComponent.getAll();
  for (const row of rows) {
    if (row.getState_Designator() === designator) return { id: row.getState_PrimitiveId(), row };
  }
  throw new Error(`找不到元件：${designator}`);
}

/** setState_* 不检查参数：缺 x 时 EDA 什么都没改却回成功，角度不是数时元件的角度会被写成 NaN */
function readComponentMove(params: ComponentMove): ComponentMove {
  if (!Number.isFinite(params?.x) || !Number.isFinite(params?.y)) throw new Error('x/y 必须是数字');
  if (params.rotation !== undefined && !Number.isFinite(params.rotation)) {
    throw new Error('rotation 必须是数字');
  }
  return { x: params.x, y: params.y, rotation: params.rotation };
}

/**
 * 把元件挪到新位置，写回画布，返回写回后的角度。
 * 不调 pcb_PrimitiveComponent.modify：api.js 里它调 done() 时没有 await，
 * EDA 拒绝写入时 done() 抛的「对象参数不正确，无法应用到画布」没人接，调用方照样拿到成功。
 * 这里改完坐标直接 await 图元对象的 done()，发的是同一个 modify 请求，写入失败会抛到调用方。
 * done() 发的是对象的全部字段（层、坐标、角度、锁定、位号、BOM 标记和其它属性，不含封装和焊盘），
 * 所以写之前先 reset() 读回画布现状，免得拿查询时的旧值盖掉用户这段时间里改过的内容；
 * 元件已经被删掉时 reset() 直接抛错。锁定按 reset() 读回的状态判断，查询之后才锁上的元件也不动。
 */
async function writeComponentMove(
  designator: string,
  row: IPCB_PrimitiveComponent,
  move: ComponentMove,
): Promise<number> {
  // getAll 给的对象本来就是异步模式。同步模式下 reset() 和 setState_* 每改一个字段都会调一次 done()，同样不 await
  row.toAsync();
  await row.reset();
  if (row.getState_PrimitiveLock()) throw new Error(`元件被锁定：${designator}`);
  row.setState_X(move.x);
  row.setState_Y(move.y);
  if (move.rotation !== undefined) row.setState_Rotation(move.rotation);
  await row.done();
  return row.getState_Rotation();
}

export async function moveComponent(params: {
  designator: string;
  x: number;
  y: number;
  rotation?: number;
}): Promise<any> {
  const move = readComponentMove(params);
  const { row } = await findComponentRow(params.designator);
  const rotation = await writeComponentMove(params.designator, row, move);
  return { moved: params.designator, x: move.x, y: move.y, rotation };
}

/**
 * 搬迁元件：移动元件，并删掉直接连到它焊盘上的走线，避免留下一堆斜拉的残线。
 *
 * 焊盘图元 IPCB_PrimitivePad 没有位号和父元件 ID，这里用 getAllPinsByPrimitiveId() 直接拿元件的焊盘，
 * 给的是完整图元 ID，不含封装自带的过孔。
 * 哪些走线连着焊盘先交给 EDA 判断：getConnectedPrimitives() 走的是 EDA 的连接检查，只看同一网络，
 * 贴片焊盘只看同层、通孔焊盘各层都算，走线铜皮碰到焊盘铜皮就算，端点不在焊盘中心也算
 * （真机上通孔焊盘、大焊盘的走线端点常常离中心好几 mil）。
 * 其中只删端点落在焊盘外框（四边放宽半个线宽）里的直线和圆弧：从焊盘上横穿过去的同网络走线两头还连着别处，
 * 删了会把那条连接断掉。外框比铜皮大（圆形、旋转过的焊盘），横穿走线的拐点正好落在外框角上时仍会被删。
 * 过孔、填充区域不删。
 *
 * 先移动、后删：pcb.js 里移动元件只改元件自己的位置和属性，不碰走线，按移动前记下的 ID 照样删得到；
 * 移动失败时一条走线都还没删。
 */
export async function relocateComponent(params: {
  designator: string;
  x: number;
  y: number;
  rotation?: number;
}): Promise<any> {
  const move = readComponentMove(params);
  const api = edaApi();
  if (!api?.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId) {
    throw new Error('这版 嘉立创EDA 不支持查询元件焊盘，没法找出连到元件上的走线');
  }
  if (!api?.pcb_PrimitiveLine?.delete || !api?.pcb_PrimitiveArc?.delete) {
    throw new Error('这版 嘉立创EDA 不支持删除走线');
  }
  const { id: targetId, row: targetRow } = await findComponentRow(params.designator);
  if (targetRow.getState_PrimitiveLock()) throw new Error(`元件被锁定：${params.designator}`);

  // 元件一个焊盘都没有时 EDA 返回 undefined
  const pins: IPCB_PrimitiveComponentPad[] =
    (await api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(targetId)) ?? [];

  // 两个焊盘可能连着同一条线，按 ID 去重
  const lines = new Map<string, IPCB_PrimitiveLine>();
  const arcs = new Map<string, IPCB_PrimitiveArc>();
  for (const pin of pins) {
    // 类型包只公开了 false 这个重载；它比 true 只多给填充区域，下面按类型跳过
    const connected: Array<
      IPCB_PrimitiveLine | IPCB_PrimitiveArc | IPCB_PrimitiveVia | IPCB_PrimitivePolyline | IPCB_PrimitiveFill
    > = await pin.getConnectedPrimitives(false);
    // 外框放在连接查询之后取：连接检查会先刷新焊盘外框，元件刚被挪过时先取可能拿到旧位置
    const padBox = await primitiveBox('焊盘', pin.getState_PrimitiveId());
    // 端点离焊盘外框不到半个线宽，线头的圆帽就压在焊盘上
    const endsOnPad = (t: IPCB_PrimitiveLine | IPCB_PrimitiveArc) => {
      const margin = t.getState_LineWidth() / 2;
      const inside = (x: number, y: number) =>
        x >= padBox.minX - margin &&
        x <= padBox.maxX + margin &&
        y >= padBox.minY - margin &&
        y <= padBox.maxY + margin;
      return inside(t.getState_StartX(), t.getState_StartY()) || inside(t.getState_EndX(), t.getState_EndY());
    };
    for (const item of connected) {
      const type: string = item.getState_PrimitiveType();
      if (type === 'Line') {
        const line = item as IPCB_PrimitiveLine;
        if (endsOnPad(line)) lines.set(line.getState_PrimitiveId(), line);
      } else if (type === 'Arc') {
        const arc = item as IPCB_PrimitiveArc;
        if (endsOnPad(arc)) arcs.set(arc.getState_PrimitiveId(), arc);
      }
    }
  }

  const tracks = [...lines.values(), ...arcs.values()];
  const locked = tracks.filter((t) => t.getState_PrimitiveLock()).map((t) => t.getState_PrimitiveId());
  if (locked.length > 0) {
    throw new Error(
      `连到 ${params.designator} 焊盘上的走线被锁定：${locked.join('、')}。解锁之后再搬，这次没有删任何走线，元件也没动`,
    );
  }
  const rotation = await writeComponentMove(params.designator, targetRow, move);

  if (lines.size > 0) await api.pcb_PrimitiveLine.delete([...lines.keys()]);
  if (arcs.size > 0) await api.pcb_PrimitiveArc.delete([...arcs.keys()]);
  const deletedTracks = tracks.map((t) => t.getState_PrimitiveId());
  const uniqueNets = Array.from(
    new Set(pins.map((pin) => pin.getState_Net() ?? '').filter(Boolean)),
  );

  return {
    moved: params.designator,
    x: move.x,
    y: move.y,
    rotation,
    deletedTracks,
    deletedTrackCount: deletedTracks.length,
    netsToReroute: uniqueNets,
  };
}

export async function selectComponent(params: { designator: string }): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_SelectControl?.selectByDesignator) throw new Error('这版 嘉立创EDA 不支持按位号选中');
  await api.pcb_SelectControl.selectByDesignator(params.designator);
  return { selected: params.designator };
}

export async function deleteSelected(): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_SelectControl?.deleteSelected) throw new Error('这版 嘉立创EDA 不支持删除选中项');
  await api.pcb_SelectControl.deleteSelected();
  return { deleted: true };
}

export async function createPcbComponent(params: {
  component: { libraryUuid: string; uuid: string };
  layer: number;
  x: number;
  y: number;
  rotation?: number;
}): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveComponent?.create) throw new Error('这版 嘉立创EDA 不支持放置元件');
  const { component, layer, x, y, rotation } = params;
  if (!component?.libraryUuid || !component?.uuid) {
    throw new Error('需要 component.libraryUuid 和 component.uuid');
  }
  const result = await api.pcb_PrimitiveComponent.create(
    { libraryUuid: component.libraryUuid, uuid: component.uuid },
    layer,
    x,
    y,
    rotation ?? 0,
    false,
  );
  return {
    primitiveId: result?.getState_PrimitiveId?.() || result?.primitiveId || '',
    designator: result?.getState_Designator?.() || result?.designator || '',
  };
}

// ─── 走线 / 过孔 ───

export async function routeTrack(params: {
  net: string;
  points: Array<{ x: number; y: number }>;
  layer: number;
  width?: number;
}): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveLine?.create) throw new Error('这版 嘉立创EDA 不支持画走线');

  const points = Array.isArray(params?.points) ? params.points : [];
  if (points.length < 2) throw new Error('points 至少要两个点');

  const width = params.width ?? 10;
  const created: string[] = [];
  const failed: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < points.length - 1; i += 1) {
    const p1 = points[i];
    const p2 = points[i + 1];
    try {
      const line = await api.pcb_PrimitiveLine.create(
        params.net,
        params.layer,
        p1.x,
        p1.y,
        p2.x,
        p2.y,
        width,
        false,
      );
      created.push(getPrimitiveId(line));
    } catch (error) {
      // 旧版只往 console 打一句就算了，调用方看到 createdSegments 少了也不知道为什么。
      failed.push({ index: i, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    createdSegments: created.length,
    primitiveIds: created.filter(Boolean),
    failedSegments: failed,
  };
}

export async function deleteTracks(params: any): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveLine?.delete) throw new Error('这版 嘉立创EDA 不支持删除走线');
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveLine.delete(primitiveIds as any);
  return { deleted: Boolean(ok), primitiveIds: toArray(primitiveIds) };
}

/**
 * 建过孔。
 * holeDiameter 兼容 drill 这个名字 —— MCP 那边的 pcb_create_via 一直传 drill，
 * 而这边只认 holeDiameter，于是钻孔尺寸被静默丢掉、全部按默认 10mil 建。
 */
export async function createVia(params: {
  net: string;
  x: number;
  y: number;
  holeDiameter?: number;
  drill?: number;
  diameter?: number;
  viaType?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveVia?.create) throw new Error('这版 嘉立创EDA 不支持建过孔');

  const net = String(params?.net || '').trim();
  if (!net) throw new Error('需要 net');

  const x = toFinite(params?.x, NaN);
  const y = toFinite(params?.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要 x/y');

  const holeRaw = params?.holeDiameter ?? params?.drill;
  const holeDiameter = Math.max(1, toFinite(holeRaw, 10));
  const diameter = Math.max(holeDiameter + 1, toFinite(params?.diameter, 22));
  const viaType = Number.isFinite(Number(params?.viaType)) ? Number(params.viaType) : undefined;
  const primitiveLock = Boolean(params?.primitiveLock);

  const via = await api.pcb_PrimitiveVia.create(
    net,
    x,
    y,
    holeDiameter,
    diameter,
    viaType,
    undefined,
    undefined,
    primitiveLock,
  );
  return {
    primitiveId: getPrimitiveId(via),
    net,
    x,
    y,
    holeDiameter,
    diameter,
    viaType: viaType ?? null,
  };
}

export async function deleteVia(params: any): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveVia?.delete) throw new Error('这版 嘉立创EDA 不支持删除过孔');
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveVia.delete(primitiveIds as any);
  return { deleted: Boolean(ok), primitiveIds: toArray(primitiveIds) };
}

// ─── 禁布区 / 铺铜 ───

function buildRectPolygonCandidates(rect: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}): any[] {
  const api = edaApi();
  const sourceLine = makeRectPolygonSource(rect.x1, rect.y1, rect.x2, rect.y2);
  const sourceRect = makeRectPolygonSourceR(rect.x1, rect.y1, rect.x2, rect.y2);
  const list: any[] = [];
  const add = (item: any) => {
    if (item) list.push(item);
  };
  add(api?.pcb_MathPolygon?.createPolygon?.(sourceLine as any));
  add(api?.pcb_MathPolygon?.createPolygon?.(sourceRect as any));
  add(api?.pcb_MathPolygon?.createComplexPolygon?.(sourceLine as any));
  add(api?.pcb_MathPolygon?.createComplexPolygon?.(sourceRect as any));
  add(sourceLine as any);
  add(sourceRect as any);
  return list;
}

export async function createKeepoutRect(params: any): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveRegion?.create || !api?.pcb_MathPolygon?.createPolygon) {
    throw new Error('这版 嘉立创EDA 不支持建禁布区');
  }

  const rect = getRectParams(params);
  const requestedLayer = Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 12;
  const ruleTypes =
    Array.isArray(params?.ruleTypes) && params.ruleTypes.length > 0
      ? params.ruleTypes.map((i: any) => Number(i)).filter((i: number) => Number.isFinite(i))
      : [2, 3, 5, 6, 7];
  const regionName = String(params?.regionName || `KEEP_OUT_${Date.now()}`);
  const lineWidth = Math.max(0, toFinite(params?.lineWidth, 4));
  const primitiveLock = Boolean(params?.primitiveLock);

  const attempt = await tryCombinations(
    [
      Array.from(new Set([requestedLayer, 12, 1, 2])),
      buildRectPolygonCandidates(rect),
      [ruleTypes, [5], [2, 3, 5, 6, 7], undefined],
      [regionName, undefined],
      [lineWidth, undefined],
    ],
    ([layer, polygon, rt, rn, lw]) =>
      api.pcb_PrimitiveRegion.create(layer, polygon, rt, rn, lw, primitiveLock),
    '建禁布区失败',
  );

  const [usedLayer, , usedRuleTypes, usedName, usedLineWidth] = attempt.args;
  return {
    primitiveId: getPrimitiveId(attempt.value),
    layer: usedLayer,
    ruleTypes: Array.isArray(usedRuleTypes) ? usedRuleTypes : [],
    regionName: usedName || '',
    lineWidth: Number.isFinite(Number(usedLineWidth)) ? Number(usedLineWidth) : null,
    rect,
  };
}

export async function deleteRegion(params: any): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveRegion?.delete) throw new Error('这版 嘉立创EDA 不支持删除禁布区');
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveRegion.delete(primitiveIds as any);
  return { deleted: Boolean(ok), primitiveIds: toArray(primitiveIds) };
}

export async function createPourRect(params: any): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitivePour?.create || !api?.pcb_MathPolygon?.createPolygon) {
    throw new Error('这版 嘉立创EDA 不支持铺铜');
  }

  const net = String(params?.net || '').trim();
  if (!net) throw new Error('需要 net');
  const rect = getRectParams(params);
  const requestedLayer = Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 1;
  const fillMethod = String(params?.fillMethod || 'solid').trim().toLowerCase();
  const preserveSilos = Boolean(params?.preserveSilos);
  const pourName = String(params?.pourName || `POUR_${net}_${Date.now()}`);
  const pourPriority = Math.max(1, Math.floor(toFinite(params?.pourPriority, 1)));
  const lineWidth = Math.max(0, toFinite(params?.lineWidth, 8));
  const primitiveLock = Boolean(params?.primitiveLock);

  const attempt = await tryCombinations(
    [
      Array.from(new Set([requestedLayer, 1, 2])),
      buildRectPolygonCandidates(rect),
      Array.from(new Set([fillMethod, 'solid', undefined])),
      Array.from(new Set([preserveSilos, false, true])),
      [pourName, undefined],
      [pourPriority, undefined],
      [lineWidth, undefined],
    ],
    ([layer, polygon, fm, ps, pn, pp, lw]) =>
      api.pcb_PrimitivePour.create(net, layer, polygon, fm, ps, pn, pp, lw, primitiveLock),
    '铺铜失败',
  );

  const [usedLayer, , usedFill, usedPreserve, usedName, usedPriority, usedLineWidth] = attempt.args;
  return {
    primitiveId: getPrimitiveId(attempt.value),
    net,
    layer: usedLayer,
    fillMethod: usedFill || '',
    preserveSilos: Boolean(usedPreserve),
    pourName: usedName || '',
    pourPriority: Number.isFinite(Number(usedPriority)) ? Number(usedPriority) : null,
    lineWidth: Number.isFinite(Number(usedLineWidth)) ? Number(usedLineWidth) : null,
    rect,
  };
}

export async function deletePour(params: any): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitivePour?.delete) throw new Error('这版 嘉立创EDA 不支持删除铺铜');
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitivePour.delete(primitiveIds as any);
  return { deleted: Boolean(ok), primitiveIds: toArray(primitiveIds) };
}

// ─── 差分对 / 等长组 ───

export async function createDifferentialPair(params: any): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_Drc?.createDifferentialPair) throw new Error('这版 嘉立创EDA 不支持差分对');

  const name = String(params?.name || '').trim();
  // posNet/negNet 是 MCP 侧一直在用的名字；旧版这边只认 positiveNet/negativeNet，
  // 于是这个工具从来没成功过，每次都报「缺参数」。两套名字都收。
  const positiveNet = String(params?.positiveNet ?? params?.posNet ?? '').trim();
  const negativeNet = String(params?.negativeNet ?? params?.negNet ?? '').trim();
  if (!name || !positiveNet || !negativeNet) {
    throw new Error('需要 name / positiveNet(posNet) / negativeNet(negNet)');
  }
  const ok = await api.pcb_Drc.createDifferentialPair(name, positiveNet, negativeNet);
  return { created: Boolean(ok), name, positiveNet, negativeNet };
}

export async function deleteDifferentialPair(params: { name: string }): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_Drc?.deleteDifferentialPair) throw new Error('这版 嘉立创EDA 不支持差分对');
  const name = String(params?.name || '').trim();
  if (!name) throw new Error('需要 name');
  return { deleted: Boolean(await api.pcb_Drc.deleteDifferentialPair(name)), name };
}

export async function listDifferentialPairs(): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_Drc?.getAllDifferentialPairs) throw new Error('这版 嘉立创EDA 不支持差分对');
  const rows = await api.pcb_Drc.getAllDifferentialPairs();
  const pairs = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    name: String(row?.name || ''),
    positiveNet: String(row?.positiveNet || ''),
    negativeNet: String(row?.negativeNet || ''),
  }));
  return { totalPairs: pairs.length, pairs };
}

export async function createEqualLengthGroup(params: any): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_Drc?.createEqualLengthNetGroup) throw new Error('这版 嘉立创EDA 不支持等长组');
  const name = String(params?.name || '').trim();
  const nets = Array.isArray(params?.nets)
    ? params.nets.map((i: any) => String(i || '').trim()).filter(Boolean)
    : [];
  if (!name || nets.length === 0) throw new Error('需要 name 和 nets');
  const color = params?.color || { r: 255, g: 128, b: 0, alpha: 1 };
  return {
    created: Boolean(await api.pcb_Drc.createEqualLengthNetGroup(name, nets, color)),
    name,
    nets,
    color,
  };
}

export async function deleteEqualLengthGroup(params: { name: string }): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_Drc?.deleteEqualLengthNetGroup) throw new Error('这版 嘉立创EDA 不支持等长组');
  const name = String(params?.name || '').trim();
  if (!name) throw new Error('需要 name');
  return { deleted: Boolean(await api.pcb_Drc.deleteEqualLengthNetGroup(name)), name };
}

export async function listEqualLengthGroups(): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_Drc?.getAllEqualLengthNetGroups) throw new Error('这版 嘉立创EDA 不支持等长组');
  const rows = await api.pcb_Drc.getAllEqualLengthNetGroups();
  const groups = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    name: String(row?.name || ''),
    nets: Array.isArray(row?.nets) ? row.nets : [],
    color: row?.color || null,
  }));
  return { totalGroups: groups.length, groups };
}

// ─── 文档 ───

export async function getBoardInfo(): Promise<any> {
  const api = edaApi();
  if (!api?.dmt_Board?.getCurrentBoardInfo) {
    throw new Error('这版 嘉立创EDA 不支持读取工程信息');
  }
  const info = await api.dmt_Board.getCurrentBoardInfo();

  // EDA 实际给的是 info.schematic.uuid，不是 info.sch.uuid ——
  // 真机上一调就发现 schematicUuid 是空串，而 sch_* 那几个工具和
  // 「切到原理图」全靠它。又一个不报错但结果是错的字段名。
  const pages = Array.isArray(info?.schematic?.page) ? info.schematic.page : [];

  return {
    name: String(info?.name || info?.title || ''),
    schematicUuid: String(
      info?.schematicUuid || info?.schUuid || info?.schematic?.uuid || info?.sch?.uuid || '',
    ),
    pcbUuid: String(info?.pcbUuid || info?.pcb?.uuid || ''),
    projectUuid: String(info?.parentProjectUuid || info?.projectUuid || ''),
    /** 原理图分页。open_document 要的是**页的 uuid**，不是原理图本身的 */
    schematicPages: pages.map((p: any) => ({
      uuid: String(p?.uuid || ''),
      name: String(p?.name || ''),
    })),
    raw: info ?? null,
  };
}

export async function openDocument(params: { uuid: string }): Promise<any> {
  const api = edaApi();
  if (!api?.dmt_EditorControl?.openDocument) throw new Error('这版 嘉立创EDA 不支持切换文档');
  const uuid = String(params?.uuid || '').trim();
  if (!uuid) throw new Error('需要 uuid');
  await api.dmt_EditorControl.openDocument(uuid);
  await delay(500); // 等文档加载，后面紧接着读数据的场景很常见
  return { opened: uuid };
}

// ─── 内部 ───

function toArray(ids: string | string[]): string[] {
  return Array.isArray(ids) ? ids : [ids];
}

/**
 * 笛卡尔积逐个试，第一个不抛异常且返回真值的组合胜出。
 * 全试完还不行就把最后一次的异常抛出去 —— 别静默返回 null，那样上层完全不知道发生了什么。
 */
async function tryCombinations(
  candidateLists: any[][],
  invoke: (args: any[]) => Promise<any>,
  failMessage: string,
): Promise<{ value: any; args: any[] }> {
  let lastError: unknown = null;
  const total = candidateLists.reduce((acc, list) => acc * Math.max(1, list.length), 1);

  for (let index = 0; index < total; index += 1) {
    const args: any[] = [];
    let rest = index;
    for (const list of candidateLists) {
      const size = Math.max(1, list.length);
      args.push(list[rest % size]);
      rest = Math.floor(rest / size);
    }
    try {
      const value = await invoke(args);
      if (value) return { value, args };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${failMessage}：${detail}`);
  }
  throw new Error(`${failMessage}：所有参数组合都被 嘉立创EDA 拒绝了`);
}
