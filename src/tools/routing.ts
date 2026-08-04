import { z } from 'zod';
import { BridgeLink } from '../link.js';

export function registerRoutingTools(server: any, bridge: BridgeLink) {
  server.tool('pcb_route_track', '画走线', {
    net: z.string().describe('网络名称'),
    points: z.array(z.object({ x: z.number(), y: z.number() })).describe('走线路径点 (mil)'),
    layer: z.number().describe('层号 (1=顶层, 2=底层)'),
    width: z.number().describe('线宽 (mil)'),
  }, async ({ net, points, layer, width }: { net: string; points: { x: number; y: number }[]; layer: number; width: number }) => {
    const data = await bridge.command('route_track', { net, points, layer, width });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_create_via', '创建过孔', {
    net: z.string().describe('网络名称'),
    x: z.number().describe('X 坐标 (mil)'),
    y: z.number().describe('Y 坐标 (mil)'),
    drill: z.number().describe('钻孔直径 (mil)'),
    diameter: z.number().describe('过孔外径 (mil)'),
  }, async ({ net, x, y, drill, diameter }: { net: string; x: number; y: number; drill: number; diameter: number }) => {
    // 扩展侧叫 holeDiameter。旧版发的是 drill，被静默忽略，
    // 所有过孔都按默认 10mil 钻孔建出来 —— 是那种不报错但结果是错的 bug。
    const data = await bridge.command('create_via', {
      net,
      x,
      y,
      holeDiameter: drill,
      diameter,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_delete_tracks', '删除走线', {
    primitiveIds: z.array(z.string()).describe('走线图元 ID 列表'),
  }, async ({ primitiveIds }: { primitiveIds: string[] }) => {
    const data = await bridge.command('delete_tracks', { primitiveIds });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_delete_via', '删除过孔', {
    primitiveIds: z.array(z.string()).describe('过孔图元 ID 列表'),
  }, async ({ primitiveIds }: { primitiveIds: string[] }) => {
    const data = await bridge.command('delete_via', { primitiveIds });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });
}
