import { z } from 'zod';
import { BridgeLink } from '../link.js';

export function registerSchematicTools(server: any, bridge: BridgeLink) {
  server.tool('sch_get_state', '读取原理图元件与网络（当前不是原理图页时会自动切过去）', {
    designators: z.array(z.string()).optional().describe('只看这些位号，如 ["U1","R3"]（可选）'),
    includeProperties: z.boolean().optional().describe('是否带上元件的自定义属性，默认带'),
    limit: z.number().optional().describe('最多返回多少个元件'),
  }, async ({ designators, includeProperties, limit }: { designators?: string[]; includeProperties?: boolean; limit?: number }) => {
    // 整板原理图元件很多（实测 164 个），不加过滤时返回体能到几万字符。
    const params: Record<string, unknown> = {};
    if (designators !== undefined) params.designators = designators;
    if (includeProperties !== undefined) params.includeProperties = includeProperties;
    if (limit !== undefined) params.limit = limit;
    const data = await bridge.command('get_schematic_state', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('sch_get_netlist', '查网表连接关系（默认只给概览，可按网络或位号点查）', {
    nets: z.array(z.string()).optional().describe('只看这些网络挂了哪些引脚'),
    designators: z.array(z.string()).optional().describe('只看这些元件的引脚接到哪些网络'),
    raw: z.boolean().optional().describe('返回整份网表原文。慎用：真实板子上是 35 万字符'),
    type: z.string().optional().describe('网表格式，默认 JLCEDA'),
  }, async ({ nets, designators, raw, type }: { nets?: string[]; designators?: string[]; raw?: boolean; type?: string }) => {
    const params: Record<string, unknown> = {};
    if (nets !== undefined) params.nets = nets;
    if (designators !== undefined) params.designators = designators;
    if (raw !== undefined) params.raw = raw;
    if (type) params.type = type;
    const data = await bridge.command('get_netlist', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('sch_run_drc', '运行原理图 DRC', {
    strict: z.boolean().optional().describe('是否严格模式'),
  }, async ({ strict }: { strict?: boolean }) => {
    const params: Record<string, unknown> = {};
    if (strict !== undefined) params.strict = strict;
    const data = await bridge.command('run_sch_drc', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_open_document', '切换到指定文档（原理图或 PCB）', {
    uuid: z.string().describe('文档 UUID'),
  }, async ({ uuid }: { uuid: string }) => {
    const data = await bridge.command('open_document', { uuid });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });
}
