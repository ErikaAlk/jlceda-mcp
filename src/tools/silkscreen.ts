import { z } from 'zod';
import { BridgeLink } from '../link.js';

export function registerSilkscreenTools(server: any, bridge: BridgeLink) {
  server.tool('pcb_move_silkscreen', '移动丝印文字', {
    primitiveId: z.string().describe('丝印图元 ID'),
    x: z.number().describe('X 坐标 (mil)'),
    y: z.number().describe('Y 坐标 (mil)'),
    rotation: z.number().optional().describe('旋转角度'),
  }, async ({ primitiveId, x, y, rotation }: { primitiveId: string; x: number; y: number; rotation?: number }) => {
    const params: Record<string, unknown> = { primitiveId, x, y };
    if (rotation !== undefined) params.rotation = rotation;
    const data = await bridge.command('move_silkscreen', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_auto_silkscreen', '自动排列丝印，避开焊盘/过孔/其它丝印', {
    onlyConflicted: z.boolean().optional().describe('只处理已经有冲突的（默认全处理）'),
    maxMoves: z.number().optional().describe('最多挪几条，默认 80'),
  }, async ({ onlyConflicted, maxMoves }: { onlyConflicted?: boolean; maxMoves?: number }) => {
    const params: Record<string, unknown> = {};
    if (onlyConflicted !== undefined) params.onlyConflicted = onlyConflicted;
    if (maxMoves !== undefined) params.maxMoves = maxMoves;
    const data = await bridge.command('auto_silkscreen', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_get_silkscreens', '查询丝印文字，可顺带检测压焊盘/出板框/互相重叠', {
    includeConflicts: z.boolean().optional().describe('是否一并返回冲突检测结果'),
    onlyConflicted: z.boolean().optional().describe('只返回有冲突的（隐含开启检测）'),
  }, async ({ includeConflicts, onlyConflicted }: { includeConflicts?: boolean; onlyConflicted?: boolean }) => {
    // 旧版这里一个参数都不传，扩展里那套冲突检测等于永远关着，白写。
    const params: Record<string, unknown> = {};
    if (includeConflicts !== undefined) params.includeConflicts = includeConflicts;
    if (onlyConflicted !== undefined) params.onlyConflicted = onlyConflicted;
    const data = await bridge.command('get_silkscreens', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
