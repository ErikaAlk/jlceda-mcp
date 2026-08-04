import { z } from 'zod';
import { BridgeLink } from '../link.js';

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

export function registerStateTools(server: any, bridge: BridgeLink) {
  server.tool('pcb_get_state', '获取 PCB 完整状态（元件、网络、板框等）', {}, async () => {
    return json(await bridge.command('get_state'));
  });

  server.tool('pcb_screenshot', '截取当前 PCB 编辑器截图', {}, async () => {
    // 扩展返回 { base64, mimeType }。旧版这里读的是 data.image，而扩展给的是
    // data.imageDataUrl —— 字段名对不上，所以截图工具从来没真的返回过图片。
    const data = (await bridge.command('screenshot')) as any;
    if (typeof data?.base64 === 'string' && data.base64) {
      return {
        content: [
          {
            type: 'image' as const,
            data: data.base64,
            mimeType: String(data.mimeType || 'image/png'),
          },
        ],
      };
    }
    return json(data);
  });

  server.tool('pcb_run_drc', '运行 PCB 设计规则检查 (DRC)', {}, async () => {
    return json(await bridge.command('run_drc'));
  });

  server.tool(
    'pcb_get_tracks',
    '查询走线段',
    {
      net: z.string().optional().describe('网络名称（可选）'),
      layer: z.number().optional().describe('层号（可选）'),
    },
    async ({ net, layer }: { net?: string; layer?: number }) => {
      const params: Record<string, unknown> = {};
      if (net !== undefined) params.net = net;
      if (layer !== undefined) params.layer = layer;
      return json(await bridge.command('get_tracks', params));
    },
  );

  server.tool(
    'pcb_get_pads',
    '查询焊盘信息，可按元件位号或网络过滤',
    {
      designator: z.string().optional().describe('元件位号，如 U1（可选）'),
      nets: z.array(z.string()).optional().describe('只看这些网络上的焊盘（可选）'),
      includeBBox: z.boolean().optional().describe('是否返回外框（可选，慢一些）'),
    },
    async ({
      designator,
      nets,
      includeBBox,
    }: {
      designator?: string;
      nets?: string[];
      includeBBox?: boolean;
    }) => {
      const params: Record<string, unknown> = {};
      if (designator !== undefined) params.designator = designator;
      if (nets !== undefined) params.nets = nets;
      if (includeBBox !== undefined) params.includeBBox = includeBBox;
      return json(await bridge.command('get_pads', params));
    },
  );

  server.tool(
    'pcb_get_net_primitives',
    '查询指定网络的所有图元',
    { net: z.string().describe('网络名称') },
    async ({ net }: { net: string }) => json(await bridge.command('get_net_primitives', { net })),
  );

  server.tool('pcb_get_board_info', '获取工程信息（板名、原理图/PCB 的 UUID）', {}, async () => {
    return json(await bridge.command('get_board_info'));
  });

  server.tool('pcb_get_feature_support', '查询当前 EDA 版本支持哪些桥接功能', {}, async () => {
    return json(await bridge.command('get_feature_support'));
  });

  server.tool('pcb_ping', '检查与 嘉立创EDA 的桥接是否连通', {}, async () => {
    return json(await bridge.command('ping'));
  });

  // 这个工具不走 EDA，只报本地链路状态 —— EDA 没连上时它照样能回答，
  // 正好用来分辨「是 EDA 没连上」还是「命令本身失败」。
  server.tool('bridge_status', '查看桥接链路状态（不需要 EDA 在线也能用）', {}, async () => {
    const status = bridge.status();
    return json({
      ...status,
      brokerRole: status.brokerRole === 'owner' ? '本进程在当 broker' : '连到别的进程的 broker',
      hint: status.eda
        ? '链路正常，可以直接调用其它 pcb_* 工具。'
        : '嘉立创EDA 还没接进来：确认 EDA 已打开，且顶部菜单「JLC MCP」第一行显示「已连接」。',
    });
  });
}
