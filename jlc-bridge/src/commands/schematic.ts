// 原理图侧：读状态、导网表、跑 DRC。
//
// ⚠ 这一整个文件的前提：**原理图的 API 只在「当前打开的文档是原理图页」时才工作。**
// 当前是 PCB 页的话，sch_Drc.check() 直接被 EDA 挡回来（错误里写着 doctype(3) not support，
// 3 就是 PCB），sch_PrimitiveComponent.getAll() 也读不到东西。
// 所以下面每个入口都先 ensureSchematicActive()。

import { edaApi, delay, errText } from '../eda';
import { readFirstNumberValue, readFirstStringValue } from './util';

/** EDMT_EditorDocumentType.SCHEMATIC_PAGE */
const DOCTYPE_SCHEMATIC_PAGE = 1;

/**
 * ESCH_PrimitiveComponentType.COMPONENT。
 *
 * **不传这个参数的后果**：getAll 会把网络标识(netflag)、网络端口(netport)、
 * 网络标签(netlabel)、图纸(sheet) 全都当成「器件」返回。真机上量过：
 * 311 条里只有 164 条是真元件，其余全是没有位号的标识类图元 ——
 * 表现就是「元件字段全是空的」。
 */
const COMPONENT_TYPE_PART = 'part';

async function currentDocumentType(): Promise<number | undefined> {
  try {
    const info = await edaApi()?.dmt_SelectControl?.getCurrentDocumentInfo?.();
    const raw = Number(info?.documentType);
    return Number.isFinite(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 保证当前打开的是原理图页；不是就切过去。
 *
 * 故意选择「自动切」而不是「报错让人去切」：调用方是 AI，让它为了读个网表
 * 先自己想起来要调 open_document，多半会卡在一句看不懂的 doctype(3) 上。
 * 切了会在返回值里说明（switchedToSchematic），不是偷偷摸摸干的。
 */
async function ensureSchematicActive(): Promise<{ switched: boolean; pageUuid: string }> {
  const api = edaApi();
  if ((await currentDocumentType()) === DOCTYPE_SCHEMATIC_PAGE) {
    return { switched: false, pageUuid: '' };
  }

  if (!api?.dmt_EditorControl?.openDocument || !api?.dmt_Board?.getCurrentBoardInfo) {
    throw new Error('当前打开的不是原理图页，而这版 嘉立创EDA 也不支持自动切换文档。请先手动打开原理图。');
  }

  let pageUuid = '';
  try {
    const info = await api.dmt_Board.getCurrentBoardInfo();
    const pages = info?.schematic?.page;
    if (Array.isArray(pages) && pages.length > 0) pageUuid = String(pages[0]?.uuid || '');
  } catch (error) {
    throw new Error(`当前不是原理图页，尝试查找原理图时失败：${errText(error)}`);
  }

  if (!pageUuid) {
    throw new Error('当前打开的不是原理图页，而且这个工程里没找到原理图。先在 EDA 里打开原理图再试。');
  }

  await api.dmt_EditorControl.openDocument(pageUuid);
  await delay(600); // 等文档真的加载完，紧接着就要读它
  return { switched: true, pageUuid };
}

/** 元件上的自定义属性（值/精度/耐压这些）都在 otherProperty 里，EDA 没有 getState_Value() */
function readOtherProperty(row: any): Record<string, string> {
  try {
    const raw = row?.getState_OtherProperty?.();
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null || v === '') continue;
      out[String(k)] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** 从自定义属性里挑出「值」。不同库里这一栏叫法不一样，都收 */
function pickValue(props: Record<string, string>): string {
  for (const key of ['Value', 'value', '值', 'VALUE']) {
    if (props[key]) return props[key];
  }
  return '';
}

function readLibRef(row: any, getter: string): { libraryUuid: string; uuid: string; name: string } | undefined {
  try {
    const ref = row?.[getter]?.();
    if (!ref || typeof ref !== 'object') return undefined;
    const uuid = String((ref as any).uuid || '');
    if (!uuid) return undefined;
    return {
      libraryUuid: String((ref as any).libraryUuid || ''),
      uuid,
      name: String((ref as any).name || ''),
    };
  } catch {
    return undefined;
  }
}

export async function getSchematicState(params?: {
  designators?: string[];
  includeProperties?: boolean;
  limit?: number;
}): Promise<any> {
  const api = edaApi();
  if (!api?.sch_PrimitiveComponent?.getAll) {
    throw new Error('这版 嘉立创EDA 不支持读取原理图元件');
  }

  const { switched, pageUuid } = await ensureSchematicActive();

  // 第一个参数一定要给 'part'，否则会混进一堆没有位号的标识类图元（见常量注释）
  const rows = await api.sch_PrimitiveComponent.getAll(COMPONENT_TYPE_PART, true);

  const wanted = new Set(
    (Array.isArray(params?.designators) ? params!.designators! : [])
      .map((d) => String(d || '').trim().toUpperCase())
      .filter(Boolean),
  );
  const includeProperties = params?.includeProperties !== false;
  const limitRaw = Number(params?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 5000;

  const components: any[] = [];
  let skippedWithoutDesignator = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) continue;

    const designator = readFirstStringValue(row, ['getState_Designator']);
    if (!designator) {
      skippedWithoutDesignator += 1;
      continue;
    }
    if (wanted.size > 0 && !wanted.has(designator.toUpperCase())) continue;

    const props = includeProperties ? readOtherProperty(row) : {};
    const item: any = {
      primitiveId,
      designator,
      name: readFirstStringValue(row, ['getState_Name']),
      value: pickValue(props),
      x: readFirstNumberValue(row, ['getState_X']),
      y: readFirstNumberValue(row, ['getState_Y']),
      rotation: readFirstNumberValue(row, ['getState_Rotation']),
    };

    const device = readLibRef(row, 'getState_Component');
    if (device) item.component = device;
    const footprint = readLibRef(row, 'getState_Footprint');
    if (footprint) item.footprint = footprint;

    const mpn = readFirstStringValue(row, ['getState_ManufacturerId']);
    if (mpn) item.manufacturerId = mpn;
    const manufacturer = readFirstStringValue(row, ['getState_Manufacturer']);
    if (manufacturer) item.manufacturer = manufacturer;
    const supplierId = readFirstStringValue(row, ['getState_SupplierId']);
    if (supplierId) item.supplierId = supplierId;
    const uniqueId = readFirstStringValue(row, ['getState_UniqueId']);
    if (uniqueId) item.uniqueId = uniqueId;

    if (includeProperties && Object.keys(props).length > 0) item.properties = props;

    components.push(item);
    if (components.length >= limit) break;
  }

  // 网络走 sch_Net。原来读 sch_PrimitivePin.getAll()，那个拿的是**符号编辑器里的引脚**，
  // 在原理图页上恒为空 —— 真机上量到 0 条，所以「读不出网络」。
  const nets: any[] = [];
  if (api?.sch_Net?.getAllNets) {
    try {
      const netRows = await api.sch_Net.getAllNets();
      for (const n of Array.isArray(netRows) ? netRows : []) {
        const name = String(n?.net || '').trim();
        if (!name) continue;
        const wires = Array.isArray(n?.wires) ? n.wires : [];
        nets.push({
          name,
          wireCount: wires.length,
          pages: Array.from(new Set(wires.map((w: any) => String(w?.pageName || '')).filter(Boolean))),
        });
      }
    } catch {
      /* 下面还有兜底 */
    }
  }
  if (nets.length === 0 && api?.sch_Net?.getAllNetsName) {
    try {
      const names = await api.sch_Net.getAllNetsName();
      for (const name of Array.isArray(names) ? names : []) {
        const text = String(name || '').trim();
        if (text) nets.push({ name: text });
      }
    } catch {
      /* ignore */
    }
  }

  return {
    componentCount: components.length,
    netCount: nets.length,
    components,
    nets,
    /** getAll 里那些没有位号的标识类图元（网络标识/端口/标签）被丢掉了多少条 */
    skippedNonPartSymbols: skippedWithoutDesignator,
    switchedToSchematic: switched || undefined,
    schematicPageUuid: pageUuid || undefined,
  };
}

export async function getNetlist(params: { type?: string }): Promise<any> {
  const api = edaApi();
  if (!api?.sch_Netlist?.getNetlist) throw new Error('这版 嘉立创EDA 不支持导出网表');
  const { switched } = await ensureSchematicActive();
  const netlist = await api.sch_Netlist.getNetlist(params?.type);
  return {
    netlist: typeof netlist === 'string' ? netlist : JSON.stringify(netlist),
    switchedToSchematic: switched || undefined,
  };
}

export async function runSchDrc(params: { strict?: boolean }): Promise<any> {
  const api = edaApi();
  if (!api?.sch_Drc?.check) throw new Error('这版 嘉立创EDA 不支持原理图 DRC');

  // 不先切过去的话，EDA 会回一句 "doctype(3) not support"（3 = PCB），
  // 光看那句话完全猜不到是「当前标签页不对」。
  const { switched } = await ensureSchematicActive();

  const strict = params?.strict !== false;
  try {
    const verbose = await api.sch_Drc.check(strict, false, true);
    if (Array.isArray(verbose)) {
      return {
        passed: verbose.length === 0,
        totalCount: verbose.length,
        issues: verbose,
        switchedToSchematic: switched || undefined,
      };
    }
    return { passed: Boolean(verbose), switchedToSchematic: switched || undefined };
  } catch {
    // 详细模式不被支持时退回布尔模式
    const ok = await api.sch_Drc.check(strict, false, false);
    return { passed: Boolean(ok), switchedToSchematic: switched || undefined };
  }
}
