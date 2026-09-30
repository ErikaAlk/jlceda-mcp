// PCB 只读查询：整板状态、焊盘、走线、网络图元、板框、截图、能力探测。

import { edaApi, delay } from '../eda';
import { APP_VERSION } from '../config';
import {
  encodeBase64FromArrayBuffer,
  firstBox,
  normalizeNetArray,
  readFirstBooleanValue,
  readFirstNumberValue,
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

/**
 * 查焊盘。
 *
 * 支持两种过滤：nets（网络名，逗号分隔或数组）和 designator（位号）。
 * designator 这条是补的 —— MCP 那边的 pcb_get_pads 一直传的是 designator，
 * 而这边只认 nets，于是这个参数被静默丢掉，查谁都返回全部焊盘。
 */
export async function getPads(params?: {
  nets?: string[] | string;
  designator?: string;
  limit?: number;
  includeBBox?: boolean;
}): Promise<any> {
  const api = edaApi();
  if (!api?.pcb_PrimitivePad?.getAll) throw new Error('这版 嘉立创EDA 不支持焊盘查询');

  const rows = await api.pcb_PrimitivePad.getAll();
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
  for (const row of rows || []) {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) continue;

    const net = readFirstStringValue(row, ['getState_Net', 'getState_NetName']);
    if (netFilter.size > 0 && (!net || !netFilter.has(net.toUpperCase()))) continue;

    const designator = readFirstStringValue(row, ['getState_Designator']);
    if (designatorFilter && designator.toUpperCase() !== designatorFilter) continue;

    const x = readFirstNumberValue(row, ['getState_X', 'getState_CenterX', 'getState_PosX']);
    const y = readFirstNumberValue(row, ['getState_Y', 'getState_CenterY', 'getState_PosY']);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    const layerRaw = readFirstNumberValue(row, ['getState_Layer']);

    const pad: any = {
      primitiveId,
      net: net || '',
      x,
      y,
      layer:
        layerRaw !== undefined
          ? Number(layerRaw)
          : String(readFirstStringValue(row, ['getState_Layer']) || ''),
      parentPrimitiveId: readFirstStringValue(row, [
        'getState_ParentPrimitiveId',
        'getState_BelongPrimitiveId',
        'getState_ComponentPrimitiveId',
      ]),
      designator,
      locked: Boolean(readFirstBooleanValue(row, ['getState_PrimitiveLock'])),
      holeDiameter: readFirstNumberValue(row, ['getState_HoleDiameter', 'getState_DrillDiameter']),
      diameter: readFirstNumberValue(row, ['getState_Diameter', 'getState_PadDiameter']),
      shape: readFirstStringValue(row, ['getState_Shape', 'getState_PadShape']),
    };

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
    totalPads: Array.isArray(rows) ? rows.length : 0,
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
    try {
      const rows = await api.pcb_PrimitivePad.getAll();
      for (const r of Array.isArray(rows) ? rows : []) {
        const padNet = r?.getState_Net?.() || r?.getState_NetName?.() || '';
        if (padNet !== net) continue;
        const id = r?.getState_PrimitiveId?.();
        if (!id) continue;
        result.pads.push({
          primitiveId: id,
          x: Number(r?.getState_X?.() ?? r?.getState_CenterX?.() ?? 0),
          y: Number(r?.getState_Y?.() ?? r?.getState_CenterY?.() ?? 0),
          designator: r?.getState_Designator?.() || '',
        });
      }
    } catch {
      /* ignore */
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
    silkscreen: {
      query: Boolean(api?.pcb_PrimitiveString?.getAll),
      modify: Boolean(api?.pcb_PrimitiveString?.modify),
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
