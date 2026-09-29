// PCB 只读查询：整板状态、焊盘、走线、网络图元、板框、截图、能力探测。

import { edaApi, delay } from '../eda';
import { APP_VERSION } from '../config';
import {
  encodeBase64FromArrayBuffer,
  firstBox,
  normalizeNetArray,
  readFirstStringValue,
  toFinite,
  type Box,
} from './util';

export async function getPCBState(): Promise<any> {
  const api = edaApi();

  const components: any[] = [];
  const boxes: Box[] = [];
  if (api?.pcb_PrimitiveComponent?.getAll) {
    const rows = await api.pcb_PrimitiveComponent.getAll();
    if (Array.isArray(rows)) {
      if (!api?.pcb_Primitive?.getPrimitivesBBox) {
        throw new Error('这版 嘉立创EDA 没有 pcb_Primitive.getPrimitivesBBox，读不出元件尺寸');
      }
      for (const row of rows) {
        const primitiveId = row?.getState_PrimitiveId?.() || '';
        const designator = row?.getState_Designator?.() || '';
        if (!primitiveId || !designator) continue;

        // IPCB_PrimitiveComponent 没有尺寸 getter，宽高只能取图元外框（画布坐标系，mil）
        const bbox: Box | undefined = await api.pcb_Primitive.getPrimitivesBBox([primitiveId]);
        if (!bbox) throw new Error(`元件 ${designator} 取不到外框`);
        boxes.push(bbox);

        components.push({
          primitiveId,
          designator,
          name: row?.getState_Name?.() || '',
          x: Number(row?.getState_X?.() ?? 0),
          y: Number(row?.getState_Y?.() ?? 0),
          rotation: Number(row?.getState_Rotation?.() ?? 0),
          width: bbox.maxX - bbox.minX,
          height: bbox.maxY - bbox.minY,
          layer: String(row?.getState_Layer?.() ?? ''),
          locked: Boolean(row?.getState_PrimitiveLock?.()),
          padNets: normalizeNetArray(row?.getState_Pads?.()),
        });
      }
    }
  }

  // 封装原点不一定在外框正中，板框范围直接按外框算
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }

  const nets: any[] = [];
  if (api?.pcb_Net?.getAllNetsName) {
    const names = await api.pcb_Net.getAllNetsName();
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name !== 'string' || !name.trim()) continue;
        const netName = name.trim();
        let length: number | undefined;
        try {
          length = await api.pcb_Net.getNetLength(netName);
        } catch {
          /* 取不到长度不影响其它字段 */
        }
        nets.push({ name: netName, length });
      }
    }
  }

  return {
    components,
    nets,
    boardBounds: {
      minX: minX === Number.POSITIVE_INFINITY ? 0 : minX,
      minY: minY === Number.POSITIVE_INFINITY ? 0 : minY,
      maxX: maxX === Number.NEGATIVE_INFINITY ? 100 : maxX,
      maxY: maxY === Number.NEGATIVE_INFINITY ? 100 : maxY,
    },
    componentCount: components.length,
    netCount: nets.length,
  };
}

/**
 * 图元外框（画布坐标，mil），取的是 EDA 自己算的外框：异形焊盘、旋转、文字字形都已经算进去了。
 * 取不到就报错，免得拿一个猜出来的框去判冲突、挪丝印、认走线。
 */
export async function primitiveBox(kind: string, primitiveId: string): Promise<Box> {
  const api = edaApi();
  if (!api?.pcb_Primitive?.getPrimitivesBBox) {
    throw new Error('这版 嘉立创EDA 没有 pcb_Primitive.getPrimitivesBBox，取不到图元外框');
  }
  const box: Box | undefined = await api.pcb_Primitive.getPrimitivesBBox([primitiveId]);
  if (!box || ![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite)) {
    throw new Error(`${kind} ${primitiveId} 取不到外框：${JSON.stringify(box)}`);
  }
  return box;
}

export async function getBBoxOfPrimitive(primitive: any): Promise<Box | undefined> {
  try {
    const bbox = await edaApi()?.pcb_Primitive?.getPrimitivesBBox?.([primitive]);
    if (!bbox) return undefined;
    return {
      minX: toFinite((bbox as any).minX, NaN),
      minY: toFinite((bbox as any).minY, NaN),
      maxX: toFinite((bbox as any).maxX, NaN),
      maxY: toFinite((bbox as any).maxY, NaN),
    };
  } catch {
    return undefined;
  }
}

export async function getBoardBoundingBox(): Promise<Box | undefined> {
  const api = edaApi();
  const layerCandidates = [api?.EPCB_LayerId?.BOARD_OUTLINE, 11].filter((item) =>
    Number.isFinite(Number(item)),
  );

  let merged: Box | undefined;
  for (const layer of layerCandidates) {
    try {
      const lines = await api?.pcb_PrimitiveLine?.getAll?.(undefined, Number(layer));
      const arcs = await api?.pcb_PrimitiveArc?.getAll?.(undefined, Number(layer));
      const polys = await api?.pcb_PrimitivePolyline?.getAll?.(undefined, Number(layer));
      const rows = [
        ...(Array.isArray(lines) ? lines : []),
        ...(Array.isArray(arcs) ? arcs : []),
        ...(Array.isArray(polys) ? polys : []),
      ];
      for (const row of rows) {
        const box = await getBBoxOfPrimitive(row);
        if (!box) continue;
        if (!merged) {
          merged = { ...box };
          continue;
        }
        merged.minX = Math.min(merged.minX, box.minX);
        merged.minY = Math.min(merged.minY, box.minY);
        merged.maxX = Math.max(merged.maxX, box.maxX);
        merged.maxY = Math.max(merged.maxY, box.maxY);
      }
      if (merged) return merged;
    } catch {
      /* 换下一个候选层 */
    }
  }

  try {
    const state = await getPCBState();
    if (state?.boardBounds) {
      return {
        minX: toFinite(state.boardBounds.minX, 0),
        minY: toFinite(state.boardBounds.minY, 0),
        maxX: toFinite(state.boardBounds.maxX, 100),
        maxY: toFinite(state.boardBounds.maxY, 100),
      };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export async function getSelectedPrimitiveIdSet(): Promise<Set<string>> {
  const result = new Set<string>();
  try {
    const ids = await edaApi()?.pcb_SelectControl?.getAllSelectedPrimitives_PrimitiveId?.();
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'string' && id.trim()) result.add(id.trim());
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

type PadOwner = { primitiveId: string; designator: string };

/**
 * 焊盘图元 ID → 所属元件。
 *
 * 焊盘图元 IPCB_PrimitivePad 没有位号、也没有父元件 ID 的 getter，只能从元件那头反查：
 * 元件的 getState_Pads() 列出它名下的焊盘，但那里的 primitiveId 只是后缀。
 * EDA 的 pcb.js 序列化元件时写的是 pad.globalIndex.replace(component.globalIndex, '')，
 * 焊盘的完整图元 ID 是「元件 ID + 后缀」（真机上 39 个焊盘全是这样）。
 * 这个列表里还混着封装自带的过孔，拼出来不在 padIds 里的就是它们。
 */
async function mapPadOwners(padIds: Set<string>): Promise<Map<string, PadOwner>> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveComponent?.getAll) {
    throw new Error('这版 嘉立创EDA 不支持元件查询，查不出焊盘属于哪个元件');
  }

  const rows: IPCB_PrimitiveComponent[] = await api.pcb_PrimitiveComponent.getAll();
  const owners = new Map<string, PadOwner>();
  let listed = 0;
  for (const row of rows) {
    const primitiveId = row.getState_PrimitiveId();
    const designator = row.getState_Designator() || '';
    for (const ref of row.getState_Pads() || []) {
      listed++;
      const padId = primitiveId + ref.primitiveId;
      if (padIds.has(padId)) owners.set(padId, { primitiveId, designator });
    }
  }
  if (listed > 0 && owners.size === 0) {
    throw new Error(
      `元件的 getState_Pads() 一共列了 ${listed} 项，按「元件 ID + 焊盘 ID」拼出来一个焊盘都对不上，EDA 的焊盘 ID 规则可能变了`,
    );
  }
  return owners;
}

/** getState_Pad() 的外形数组摊成字段，尺寸单位 mil */
function padShapeFields(primitiveId: string, pad: any[] | undefined): Record<string, unknown> {
  if (!pad) throw new Error(`焊盘 ${primitiveId} 读不出外形，getState_Pad() 返回 undefined`);
  const [shape] = pad;
  switch (shape) {
    case 'ELLIPSE':
    case 'OVAL':
      return { shape, width: pad[1], height: pad[2] };
    case 'RECT':
      // 第 4 项是 EDA 属性面板里的「Corner Radius Ratio」，百分数，不是 mil
      return { shape, width: pad[1], height: pad[2], cornerRadiusRatio: pad[3] };
    case 'NGON':
      return { shape, diameter: pad[1], sides: pad[2] };
    case 'POLYGON':
      return { shape, polygon: pad[1] };
  }
  throw new Error(`焊盘 ${primitiveId} 的外形认不出：${JSON.stringify(pad)}`);
}

/** getState_Hole()：null 表示没有孔（贴片焊盘），尺寸单位 mil */
function padHole(primitiveId: string, hole: any[] | null): Record<string, unknown> | null {
  if (hole === null) return null;
  const [shape] = hole;
  if (shape === 'ROUND') return { shape, diameter: hole[1] };
  if (shape === 'SLOT') return { shape, diameter: hole[1], length: hole[2] };
  throw new Error(`焊盘 ${primitiveId} 的孔认不出：${JSON.stringify(hole)}`);
}

function readPad(row: IPCB_PrimitivePad, owners: Map<string, PadOwner>): any {
  const primitiveId = row.getState_PrimitiveId();
  const owner = owners.get(primitiveId);
  return {
    primitiveId,
    padNumber: row.getState_PadNumber(),
    designator: owner?.designator ?? '',
    parentPrimitiveId: owner?.primitiveId ?? '',
    net: row.getState_Net() || '',
    x: row.getState_X(),
    y: row.getState_Y(),
    rotation: row.getState_Rotation(),
    layer: row.getState_Layer(),
    locked: row.getState_PrimitiveLock(),
    ...padShapeFields(primitiveId, row.getState_Pad()),
    hole: padHole(primitiveId, row.getState_Hole()),
  };
}

/**
 * 查焊盘。
 *
 * 支持两种过滤：nets（网络名，逗号分隔或数组）和 designator（位号，不分大小写）。
 * designator 这条是补的 —— MCP 那边的 pcb_get_pads 一直传的是 designator，
 * 而这边只认 nets，于是这个参数被静默丢掉，查谁都返回全部焊盘。
 * 位号和所属元件由 mapPadOwners() 从元件那头反查。
 */
export async function getPads(params?: {
  nets?: string[] | string;
  designator?: string;
  limit?: number;
  includeBBox?: boolean;
}): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitivePad?.getAll) throw new Error('这版 嘉立创EDA 不支持焊盘查询');

  const rows: IPCB_PrimitivePad[] = await api.pcb_PrimitivePad.getAll();
  const owners = await mapPadOwners(new Set(rows.map((row) => row.getState_PrimitiveId())));
  const limitRaw = Number(params?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10000;
  const includeBBox = Boolean(params?.includeBBox);

  const netsInput = Array.isArray(params?.nets)
    ? params?.nets
    : typeof params?.nets === 'string'
      ? params.nets.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
  const netFilter = new Set<string>(
    netsInput.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean),
  );
  const designatorFilter = String(params?.designator || '').trim().toUpperCase();

  const pads: any[] = [];
  for (const row of rows) {
    const pad = readPad(row, owners);
    if (netFilter.size > 0 && !netFilter.has(pad.net.toUpperCase())) continue;
    if (designatorFilter && pad.designator.toUpperCase() !== designatorFilter) continue;

    if (includeBBox) {
      const bbox = await getBBoxOfPrimitive(row);
      if (bbox) pad.bbox = bbox;
    }

    pads.push(pad);
    if (pads.length >= limit) break;
  }

  const netStats = new Map<string, number>();
  for (const item of pads) {
    const key = String(item.net || '').trim();
    if (!key) continue;
    netStats.set(key, (netStats.get(key) || 0) + 1);
  }

  return {
    totalPads: rows.length,
    returnedPads: pads.length,
    nets: Array.from(netStats.entries())
      .map(([name, padCount]) => ({ name, padCount }))
      .sort((a, b) => b.padCount - a.padCount),
    pads,
  };
}

export async function getTracks(params: { net?: string; layer?: number }): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitiveLine?.getAll) throw new Error('这版 嘉立创EDA 不支持走线查询');

  const rows = await api.pcb_PrimitiveLine.getAll(params?.net, params?.layer);
  const tracks = (Array.isArray(rows) ? rows : [])
    .map((r: any) => ({
      primitiveId: r?.getState_PrimitiveId?.() || '',
      net: r?.getState_Net?.() || '',
      layer: r?.getState_Layer?.() ?? '',
      startX: Number(r?.getState_StartX?.() ?? 0),
      startY: Number(r?.getState_StartY?.() ?? 0),
      endX: Number(r?.getState_EndX?.() ?? 0),
      endY: Number(r?.getState_EndY?.() ?? 0),
      width: Number(r?.getState_LineWidth?.() ?? 0),
    }))
    .filter((t: any) => t.primitiveId);
  return { tracks, count: tracks.length };
}

export async function getNetPrimitives(params: { net: string }): Promise<any> {
  const api = edaApi();
  const net = String(params?.net || '').trim();
  if (!net) throw new Error('需要 net');

  const result: { net: string; tracks: any[]; vias: any[]; pads: any[] } = {
    net,
    tracks: [],
    vias: [],
    pads: [],
  };

  if (api?.pcb_PrimitiveLine?.getAll) {
    const rows = await api.pcb_PrimitiveLine.getAll(net);
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = r?.getState_PrimitiveId?.();
      if (!id) continue;
      result.tracks.push({
        primitiveId: id,
        startX: Number(r?.getState_StartX?.() ?? 0),
        startY: Number(r?.getState_StartY?.() ?? 0),
        endX: Number(r?.getState_EndX?.() ?? 0),
        endY: Number(r?.getState_EndY?.() ?? 0),
        layer: r?.getState_Layer?.() ?? '',
        width: Number(r?.getState_LineWidth?.() ?? 0),
      });
    }
  }

  if (api?.pcb_PrimitiveVia?.getAll) {
    try {
      const rows = await api.pcb_PrimitiveVia.getAll();
      for (const r of Array.isArray(rows) ? rows : []) {
        if ((r?.getState_Net?.() || '') !== net) continue;
        const id = r?.getState_PrimitiveId?.();
        if (!id) continue;
        result.vias.push({
          primitiveId: id,
          x: Number(r?.getState_X?.() ?? 0),
          y: Number(r?.getState_Y?.() ?? 0),
        });
      }
    } catch {
      /* ignore */
    }
  }

  if (api?.pcb_PrimitivePad?.getAll) {
    const rows: IPCB_PrimitivePad[] = await api.pcb_PrimitivePad.getAll();
    // 反查要拿全板的焊盘，只拿这个网络的会让 mapPadOwners 的「一个都对不上」误报
    const owners = await mapPadOwners(new Set(rows.map((r) => r.getState_PrimitiveId())));
    for (const r of rows) {
      if ((r.getState_Net() || '') !== net) continue;
      const primitiveId = r.getState_PrimitiveId();
      result.pads.push({
        primitiveId,
        x: r.getState_X(),
        y: r.getState_Y(),
        designator: owners.get(primitiveId)?.designator ?? '',
        padNumber: r.getState_PadNumber(),
      });
    }
  }

  return result;
}

// ─── DRC ───

export async function runDRC(): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_Drc?.check && !api?.pcb_Drc?.runDrc) {
    throw new Error('这版 嘉立创EDA 不支持 DRC');
  }

  let passed: boolean | undefined;
  let issues: any[] = [];

  if (api?.pcb_Drc?.check) {
    try {
      const verbose = await api.pcb_Drc.check(true, false, true);
      if (Array.isArray(verbose)) {
        issues = verbose;
        passed = verbose.length === 0;
      } else if (typeof verbose === 'boolean') {
        passed = verbose;
      }
    } catch {
      try {
        const quick = await api.pcb_Drc.check(true, false, false);
        if (typeof quick === 'boolean') passed = quick;
      } catch {
        /* ignore */
      }
    }
  }

  if (issues.length === 0 && api?.pcb_Drc?.runDrc) {
    try {
      const raw = await api.pcb_Drc.runDrc();
      if (Array.isArray(raw)) {
        issues = raw;
        if (passed === undefined) passed = raw.length === 0;
      }
    } catch {
      /* ignore */
    }
  }

  const normalized = issues.map((item: any, index: number) => {
    const rule = String(item?.rule || item?.type || item?.name || '').trim();
    const message = String(item?.message || item?.description || '').trim();
    const refs = Array.isArray(item?.primitiveIds)
      ? item.primitiveIds.map((id: any) => String(id || '')).filter(Boolean)
      : [];
    const text = `${rule} ${message}`.toLowerCase();
    let severity = 'unknown';
    if (/error|错误|违规/.test(text)) severity = 'error';
    else if (/warning|警告/.test(text)) severity = 'warning';
    else if (/info|提示/.test(text)) severity = 'info';
    return { index: index + 1, severity, rule, message, primitiveIds: refs, raw: item };
  });

  if (passed === undefined) passed = normalized.length === 0;

  return {
    passed: Boolean(passed),
    totalCount: normalized.length,
    summary: {
      errors: normalized.filter((i) => i.severity === 'error').length,
      warnings: normalized.filter((i) => i.severity === 'warning').length,
      infos: normalized.filter((i) => i.severity === 'info').length,
      unknown: normalized.filter((i) => i.severity === 'unknown').length,
    },
    issues: normalized,
  };
}

// ─── 截图 ───

async function blobToBase64(blob: Blob): Promise<{ base64: string; mimeType: string }> {
  const mimeType = blob?.type || 'image/png';
  const buffer = await blob.arrayBuffer();
  return { base64: encodeBase64FromArrayBuffer(buffer), mimeType };
}

function readTabIdFromDocumentInfo(info: any): string | undefined {
  if (!info) return undefined;
  if (typeof info?.tabId === 'string' && info.tabId.trim()) return info.tabId.trim();
  const tabId = readFirstStringValue(info, ['getState_TabId']);
  return tabId || undefined;
}

async function resolveCaptureTabId(): Promise<string | undefined> {
  const api = edaApi();
  try {
    const currentDoc = await api?.dmt_SelectControl?.getCurrentDocumentInfo?.();
    const tabId = readTabIdFromDocumentInfo(currentDoc);
    if (tabId) return tabId;
  } catch {
    /* ignore */
  }
  try {
    const boardInfo = await api?.dmt_Board?.getCurrentBoardInfo?.();
    const pcbUuid = String(boardInfo?.pcb?.uuid || '').trim();
    if (!pcbUuid) return undefined;
    try {
      const openedTabId = await api?.dmt_EditorControl?.openDocument?.(pcbUuid);
      if (typeof openedTabId === 'string' && openedTabId.trim()) return openedTabId.trim();
    } catch {
      /* ignore */
    }
    return pcbUuid;
  } catch {
    return undefined;
  }
}

/**
 * 截图。返回 { base64, mimeType }，**不返回 data: URL**。
 * MCP 那边要把它塞进 image content block，需要的是纯 base64；
 * 旧版返回 imageDataUrl 而 MCP 侧读的是 data.image，字段名对不上，
 * 结果截图工具从来没真的返回过图片，只返回一坨 JSON 文本。
 */
export async function takeScreenshot(): Promise<any> {
  const api = edaApi();

  if (api?.dmt_EditorControl?.getCurrentRenderedAreaImage) {
    const tabId = await resolveCaptureTabId();
    if (tabId && api?.dmt_EditorControl?.activateDocument) {
      try {
        await api.dmt_EditorControl.activateDocument(tabId);
      } catch {
        /* ignore */
      }
    }
    if (api?.dmt_EditorControl?.zoomToAllPrimitives) {
      try {
        await api.dmt_EditorControl.zoomToAllPrimitives(tabId);
      } catch {
        /* ignore */
      }
    }
    await delay(120);

    for (const args of [[tabId], []]) {
      try {
        const blob: Blob | undefined = await api.dmt_EditorControl.getCurrentRenderedAreaImage(
          ...(args as any),
        );
        if (blob?.arrayBuffer) return { ...(await blobToBase64(blob)), source: 'renderedArea' };
      } catch {
        /* 试下一种调用方式 */
      }
    }
  }

  for (const attempt of [
    () => api?.pcb_Document?.exportImage?.('png'),
    () => api?.sys_Canvas?.toDataURL?.('image/png'),
  ]) {
    try {
      const dataUrl = await attempt();
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        const comma = dataUrl.indexOf(',');
        return {
          base64: dataUrl.slice(comma + 1),
          mimeType: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png',
          source: 'export',
        };
      }
    } catch {
      /* 试下一种 */
    }
  }

  throw new Error('这版 嘉立创EDA 没有可用的截图接口');
}

// ─── 能力探测 ───

export async function getFeatureSupport(): Promise<any> {
  const api = edaApi();
  return {
    bridgeVersion: APP_VERSION,
    screenshot: {
      renderedAreaImage: Boolean(api?.dmt_EditorControl?.getCurrentRenderedAreaImage),
      exportImage: Boolean(api?.pcb_Document?.exportImage),
    },
    // 丝印包括文本和元件属性（位号等）。查询还要靠元件列表认属性的归属、靠 getPrimitivesBBox 取外框；
    // 挪动是取到图元对象后 await 它的 done()（见 silkscreen.ts 的 writeMove），有两个 getAll 就够
    silkscreen: {
      query: Boolean(
        api?.pcb_PrimitiveString?.getAll &&
          api?.pcb_PrimitiveAttribute?.getAll &&
          api?.pcb_PrimitiveComponent?.getAll &&
          api?.pcb_Primitive?.getPrimitivesBBox,
      ),
      modify: Boolean(api?.pcb_PrimitiveString?.getAll && api?.pcb_PrimitiveAttribute?.getAll),
    },
    via: {
      create: Boolean(api?.pcb_PrimitiveVia?.create),
      delete: Boolean(api?.pcb_PrimitiveVia?.delete),
    },
    keepout: {
      create: Boolean(api?.pcb_PrimitiveRegion?.create && api?.pcb_MathPolygon?.createPolygon),
      delete: Boolean(api?.pcb_PrimitiveRegion?.delete),
    },
    pour: {
      create: Boolean(api?.pcb_PrimitivePour?.create && api?.pcb_MathPolygon?.createPolygon),
      delete: Boolean(api?.pcb_PrimitivePour?.delete),
    },
    routingRules: {
      differentialPair: Boolean(api?.pcb_Drc?.createDifferentialPair),
      equalLengthGroup: Boolean(api?.pcb_Drc?.createEqualLengthNetGroup),
      drcCheck: Boolean(api?.pcb_Drc?.check || api?.pcb_Drc?.runDrc),
    },
    schematic: {
      getBoardInfo: Boolean(api?.dmt_Board?.getCurrentBoardInfo),
      openDocument: Boolean(api?.dmt_EditorControl?.openDocument),
      getComponents: Boolean(api?.sch_PrimitiveComponent?.getAll),
      getNetlist: Boolean(api?.sch_Netlist?.getNetlist),
      schDrc: Boolean(api?.sch_Drc?.check),
      createPcbComponent: Boolean(api?.pcb_PrimitiveComponent?.create),
    },
  };
}

export function firstFiniteBox(...boxes: Array<Box | undefined>): Box | undefined {
  return firstBox(boxes);
}
