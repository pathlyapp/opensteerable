/**
 * `GET /api/v2/child-process`：子代理（`delegate_subagent`）的推理过程。
 *
 * 子回合写自己的 durable record（`<父 record>:child:<lineage id>`，随
 * child_spawned 上报），这条路由按 record 直读并重建成与主对话同形的
 * TurnBlock，供右侧过程面板渲染。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { h, makeToolRouter, resetRouterTestkit } from './router-testkit.js';
import { LocalBackendRouter } from '../../src/local-backend/router.js';
import type { ToolRouter } from '../../src/tool-router.js';

function makeRouter(): LocalBackendRouter {
  return new LocalBackendRouter(makeToolRouter({ schemas: [] }) as unknown as ToolRouter, {
    store: h.store,
  });
}

beforeEach(() => {
  resetRouterTestkit();
});

describe('GET /api/v2/child-process', () => {
  it('按 record 重建子代理的思考与工具行', async () => {
    h.sidecarHistory.set('chat-1:child:0.1', [
      { kind: 'user', message: { role: 'user', content: '排今晚日程' } },
      {
        kind: 'assistant',
        message: {
          role: 'assistant',
          content: '先看一下日历。',
          reasoning: '我需要先确认今天几号',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'local_read_file', arguments: '{"path":"cal.md"}' },
            },
          ],
        },
      },
      {
        kind: 'tool',
        message: {
          role: 'tool',
          name: 'local_read_file',
          tool_call_id: 'c1',
          content: '{"success":true,"data":{"text":"空"}}',
        },
      },
      { kind: 'assistant', message: { role: 'assistant', content: '排好了。' } },
    ]);

    const res = await makeRouter().handle({
      method: 'GET',
      path: '/api/v2/child-process?recordId=chat-1%3Achild%3A0.1',
    });

    expect(res.status).toBe(200);
    const data = res.data as { recordId: string; timeline: Array<Record<string, unknown>> };
    expect(data.recordId).toBe('chat-1:child:0.1');
    expect(data.timeline.map((block) => block.type)).toEqual([
      'reasoning',
      'text',
      'tools',
      'text',
    ]);
    const tools = data.timeline[2] as { actions: Array<{ tool: string; success?: boolean }> };
    expect(tools.actions[0].tool).toBe('local_read_file');
    expect(tools.actions[0].success).toBe(true);
  });

  it('缺 recordId 是 400', async () => {
    const res = await makeRouter().handle({
      method: 'GET',
      path: '/api/v2/child-process',
    });
    expect(res.status).toBe(400);
  });

  it('没有这条 record 时返回空时间线，不报错', async () => {
    const res = await makeRouter().handle({
      method: 'GET',
      path: '/api/v2/child-process?recordId=chat-9%3Achild%3A0.9',
    });
    expect(res.status).toBe(200);
    expect((res.data as { timeline: unknown[] }).timeline).toEqual([]);
  });
});
