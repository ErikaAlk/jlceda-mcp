// action 名 → 处理函数。
//
// 旧版是一个 120 行的 switch，加一条命令要动三处（switch、类型、文档），
// 而且拼错 action 名只会得到 `unknown action: xxx` 这一句，看不出有哪些能用。
// 现在是一张表：未知动作会把「你可以用哪些」一起报出来。
//
// 这张表也是 MCP 侧工具与扩展之间的契约。改名字要两边一起改，
// 相关的坑（drill vs holeDiameter、posNet vs positiveNet）见 commands/pcb-edit.ts。

import { APP_VERSION } from './config';
import { getHub } from './hub';
import {
  getFeatureSupport,
  getNetPrimitives,
  getPCBState,
  getPads,
  getTracks,
  runDRC,
  takeScreenshot,
} from './commands/pcb-state';
import {
  createDifferentialPair,
  createEqualLengthGroup,
  createKeepoutRect,
  createPcbComponent,
  createPourRect,
  createVia,
  deleteDifferentialPair,
  deleteEqualLengthGroup,
  deletePour,
  deleteRegion,
  deleteSelected,
  deleteTracks,
  deleteVia,
  getBoardInfo,
  listDifferentialPairs,
  listEqualLengthGroups,
  moveComponent,
  openDocument,
  relocateComponent,
  routeTrack,
  selectComponent,
} from './commands/pcb-edit';
import { autoSilkscreen, getSilkscreens, moveSilkscreen } from './commands/silkscreen';
import { getNetlist, getSchematicState, runSchDrc } from './commands/schematic';

type Handler = (params: Record<string, any>) => Promise<any> | any;

const HANDLERS: Record<string, Handler> = {
  // 链路自检
  ping: () => {
    const hub = getHub();
    return {
      message: 'pong',
      timestamp: Date.now(),
      bridgeVersion: APP_VERSION,
      commandsHandled: hub.commandCount,
      onlineSinceMs: hub.onlineSince ? Date.now() - hub.onlineSince : 0,
    };
  },

  // PCB 读
  get_state: () => getPCBState(),
  get_feature_support: () => getFeatureSupport(),
  get_pads: (p) => getPads(p),
  get_tracks: (p) => getTracks(p),
  get_net_primitives: (p) => getNetPrimitives(p as any),
  get_board_info: () => getBoardInfo(),
  run_drc: () => runDRC(),
  screenshot: () => takeScreenshot(),

  // PCB 写
  move_component: (p) => moveComponent(p as any),
  relocate_component: (p) => relocateComponent(p as any),
  select_component: (p) => selectComponent(p as any),
  delete_selected: () => deleteSelected(),
  create_pcb_component: (p) => createPcbComponent(p as any),
  route_track: (p) => routeTrack(p as any),
  delete_tracks: (p) => deleteTracks(p),
  create_via: (p) => createVia(p as any),
  delete_via: (p) => deleteVia(p),
  create_keepout_rect: (p) => createKeepoutRect(p),
  delete_region: (p) => deleteRegion(p),
  create_pour_rect: (p) => createPourRect(p),
  delete_pour: (p) => deletePour(p),

  // 规则
  create_differential_pair: (p) => createDifferentialPair(p),
  delete_differential_pair: (p) => deleteDifferentialPair(p as any),
  list_differential_pairs: () => listDifferentialPairs(),
  create_equal_length_group: (p) => createEqualLengthGroup(p),
  delete_equal_length_group: (p) => deleteEqualLengthGroup(p as any),
  list_equal_length_groups: () => listEqualLengthGroups(),

  // 丝印
  get_silkscreens: (p) => getSilkscreens(p),
  move_silkscreen: (p) => moveSilkscreen(p as any),
  auto_silkscreen: (p) => autoSilkscreen(p),

  // 原理图 / 文档
  get_schematic_state: (p) => getSchematicState(p as any),
  get_netlist: (p) => getNetlist(p as any),
  run_sch_drc: (p) => runSchDrc(p as any),
  open_document: (p) => openDocument(p as any),
};

export const ACTIONS = Object.keys(HANDLERS).sort();

export async function execute(action: string, params: Record<string, any>): Promise<any> {
  const handler = HANDLERS[action];
  if (!handler) {
    throw new Error(
      `不认识的动作 '${action}'。这个扩展（v${APP_VERSION}）支持：${ACTIONS.join(', ')}`,
    );
  }
  return await handler(params || {});
}
