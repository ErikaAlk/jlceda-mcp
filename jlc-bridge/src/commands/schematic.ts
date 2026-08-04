// 原理图侧：读状态、导网表、跑 DRC。

import { edaApi } from '../eda';

export async function getSchematicState(): Promise<any> {
  const api = edaApi();
  if (!api?.sch_PrimitiveComponent?.getAll) {
    throw new Error('这版 嘉立创EDA 不支持读取原理图元件（或者当前打开的不是原理图）');
  }

  // 第二个参数 true = 跨所有图页
  const rows = await api.sch_PrimitiveComponent.getAll(undefined, true);
  const components = (Array.isArray(rows) ? rows : [])
    .map((r: any) => ({
      primitiveId: r?.getState_PrimitiveId?.() || '',
      designator: r?.getState_Designator?.() || '',
      name: r?.getState_Name?.() || r?.getState_DisplayName?.() || '',
      value: r?.getState_Value?.() || '',
      component: {
        libraryUuid: r?.getState_LibraryUuid?.() || r?.getState_ComponentLibraryUuid?.() || '',
        uuid: r?.getState_Uuid?.() || r?.getState_ComponentUuid?.() || '',
      },
    }))
    .filter((c: any) => c.primitiveId);

  let pins: any[] = [];
  if (api?.sch_PrimitivePin?.getAll) {
    try {
      const pinRows = await api.sch_PrimitivePin.getAll();
      pins = (Array.isArray(pinRows) ? pinRows : [])
        .map((p: any) => ({
          primitiveId: p?.getState_PrimitiveId?.() || '',
          pinNumber: p?.getState_PinNumber?.() || p?.getState_Number?.() || '',
          pinName: p?.getState_PinName?.() || p?.getState_Name?.() || '',
          net: p?.getState_Net?.() || p?.getState_NetName?.() || '',
          x: Number(p?.getState_X?.() ?? 0),
          y: Number(p?.getState_Y?.() ?? 0),
        }))
        .filter((p: any) => p.primitiveId);
    } catch {
      /* 引脚读不到不影响元件列表 */
    }
  }

  let wires: any[] = [];
  if (api?.sch_PrimitiveWire?.getAll) {
    try {
      const wireRows = await api.sch_PrimitiveWire.getAll();
      wires = (Array.isArray(wireRows) ? wireRows : [])
        .map((w: any) => ({
          primitiveId: w?.getState_PrimitiveId?.() || '',
          net: w?.getState_Net?.() || w?.getState_NetName?.() || '',
        }))
        .filter((w: any) => w.primitiveId);
    } catch {
      /* ignore */
    }
  }

  return {
    components,
    pins,
    wires,
    componentCount: components.length,
    pinCount: pins.length,
  };
}

export async function getNetlist(params: { type?: string }): Promise<any> {
  const api = edaApi();
  if (!api?.sch_Netlist?.getNetlist) throw new Error('这版 嘉立创EDA 不支持导出网表');
  const netlist = await api.sch_Netlist.getNetlist(params?.type);
  return { netlist: typeof netlist === 'string' ? netlist : JSON.stringify(netlist) };
}

export async function runSchDrc(params: { strict?: boolean }): Promise<any> {
  const api = edaApi();
  if (!api?.sch_Drc?.check) throw new Error('这版 嘉立创EDA 不支持原理图 DRC');
  const strict = params?.strict !== false;
  return { passed: Boolean(await api.sch_Drc.check(strict, false)) };
}
