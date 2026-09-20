import { describe, expect, it } from 'vitest';
import {
  expandRunCodeActions,
  summarizeRunCodeAction,
  summarizeWebAction,
  parseDelegateSubagent,
  summarizeDelegateSubagent,
  delegateSubagentDisplayName,
  parseTaskRun,
  parseTaskToolOutput,
  parseToolEnvelope,
  humanizeDelegateError,
  summarizeTaskAction,
  taskToolLabel,
  collectTurnParticipants,
  extractMentionedAgentIds,
  inspectableTaskFromAction,
  inspectTaskTitle,
} from './executed-actions-model';

// W5-2 工具卡中文摘要的纯映射层测试：web_search 出查询词与结果计数，
// web_fetch 出短 URL、HTTP 状态、体量与截断标记；失败时只出意图头，
// 不编造结果字段。

describe('summarizeWebAction / web_search', () => {
  it('成功时出查询词与结果计数', () => {
    const summary = summarizeWebAction(
      'web_search',
      { query: 'KV cache 量化' },
      { success: true, data: { result_count: 8, query: 'KV cache 量化', results: [] } },
    );
    expect(summary).toBe('搜索“KV cache 量化” → 8 条结果');
  });

  it('长查询词截断到 40 字符', () => {
    const summary = summarizeWebAction(
      'web_search',
      { query: 'a'.repeat(60) },
      { success: true, data: { result_count: 1 } },
    );
    expect(summary).toBe(`搜索“${'a'.repeat(37)}…” → 1 条结果`);
  });

  it('失败时只出意图头，不编造计数', () => {
    const summary = summarizeWebAction(
      'web_search',
      { query: 'x' },
      { success: false, error: 'web search timed out: ReadTimeout' },
    );
    expect(summary).toBe('搜索“x”');
  });

  it('data 缺失（被截断吃掉）时退化为意图头', () => {
    expect(summarizeWebAction('web_search', { query: 'x' }, { success: true })).toBe(
      '搜索“x”',
    );
  });
});

describe('summarizeWebAction / web_fetch', () => {
  it('成功时出短 URL、状态码与体量', () => {
    const summary = summarizeWebAction(
      'web_fetch',
      { url: 'https://example.com/docs/spec.html' },
      {
        success: true,
        data: {
          url: 'https://example.com/docs/spec.html',
          status: 200,
          bytes: 12_288,
          truncated: false,
        },
      },
    );
    expect(summary).toBe('抓取 example.com/docs/spec.html → 200 · 12.0 KB');
  });

  it('截断的抓取带"已截断"标记', () => {
    const summary = summarizeWebAction(
      'web_fetch',
      { url: 'https://example.com/big' },
      { success: true, data: { status: 200, bytes: 1_000_000, truncated: true } },
    );
    expect(summary).toBe('抓取 example.com/big → 200 · 976.6 KB · 已截断');
  });

  it('失败时只出意图头（SSRF 拒绝 / 超时 / 跨域重定向）', () => {
    const summary = summarizeWebAction(
      'web_fetch',
      { url: 'http://169.254.169.254/latest' },
      { success: false, error: 'refusing to fetch a non-public address' },
    );
    expect(summary).toBe('抓取 169.254.169.254/latest');
  });

  it('无法解析的 URL 原样截断展示', () => {
    const summary = summarizeWebAction(
      'web_fetch',
      { url: 'not a url at all' },
      { success: false, error: 'unsupported scheme' },
    );
    expect(summary).toBe('抓取 not a url at all');
  });
});

describe('summarizeWebAction / 其他工具', () => {
  it('非 web 工具返回 null（调用方回落通用摘要）', () => {
    expect(
      summarizeWebAction('local_exec_shell', { command: 'ls' }, { success: true }),
    ).toBeNull();
  });
});

describe('summarizeRunCodeAction / expandRunCodeActions', () => {
  it('摘要写出描述和内层工具数，而不是整段 code', () => {
    const summary = summarizeRunCodeAction(
      'run_code',
      { code: 'return tools.call("stub_a")', description: 'two stubs' },
      {
        success: true,
        data: {
          calls: [
            { tool: 'stub_a', arguments: {}, result: { success: true } },
            { tool: 'stub_b', arguments: {}, result: { success: true } },
          ],
        },
      },
    );
    expect(summary).toBe('程序「two stubs」· 2 个内层工具');
  });

  it('展开为程序行 + 内层工具行', () => {
    const rows = expandRunCodeActions([
      {
        tool: 'run_code',
        arguments: { description: 'two stubs' },
        result: {
          success: true,
          data: {
            calls: [{ tool: 'stub_a', arguments: { x: 1 }, result: { success: true } }],
          },
        },
      },
    ]);
    expect(rows.map((r) => r.tool)).toEqual(['run_code', 'stub_a']);
  });
});

describe('delegate_subagent 摘要', () => {
  const agents = [
    { id: 'a1', slug: 'researcher', name: '调研员', color: '#2563eb' },
    { id: 'a2', slug: 'script-engineer', name: '脚本工程师', color: '#16a34a' },
  ];

  it('抽出画像名和任务正文', () => {
    expect(
      parseDelegateSubagent({
        subagent_type: 'researcher',
        task: '调研 PDF 方案',
      }),
    ).toEqual({ profile: 'researcher', task: '调研 PDF 方案' });
  });

  it('显示名优先用会话智能体，再退回内置画像中文名', () => {
    expect(delegateSubagentDisplayName('researcher', agents)).toBe('调研员');
    expect(delegateSubagentDisplayName('explore', agents)).toBe('探索');
    expect(delegateSubagentDisplayName(null, agents)).toBe('子代理');
  });

  it('自建智能体的派生画像名也出中文名，不甩 agent-<id>', () => {
    const scheduler = {
      id: '85dd2139-4cbe-4997-9250-9ed4ff87a464',
      slug: null,
      name: '日程规划',
      color: '#f59e0b',
    };
    expect(
      delegateSubagentDisplayName('agent-85dd21394cbe4997', [scheduler]),
    ).toBe('日程规划');
  });

  it('本回合顶栏：父代理在前，委派去重后跟上', () => {
    expect(
      collectTurnParticipants(
        { id: 'parent', name: '电脑操作员', color: '#111111' },
        {
          agents,
          children: [{ profile: 'researcher' }, { profile: 'researcher' }],
          actions: [
            { tool: 'delegate_subagent', arguments: { subagent_type: 'script-engineer' } },
            { tool: 'delegate_subagent', arguments: { subagent_type: 'explore' } },
          ],
        },
      ),
    ).toEqual([
      { key: 'parent', name: '电脑操作员', color: '#111111' },
      { key: 'a1', name: '调研员', color: '#2563eb' },
      { key: 'a2', name: '脚本工程师', color: '#16a34a' },
      { key: 'explore', name: '探索', color: '#0ea5e9' },
    ]);
  });

  it('有 @提及时顶栏用点名的人，不用内置 explore 画像', () => {
    const planner = { id: 'p1', slug: 'planner', name: '日程规划', color: '#f59e0b' };
    const assistant = { id: 'h1', slug: 'helper', name: '智能助手', color: '#8b5cf6' };
    const parent = { id: 'op', slug: 'operator', name: '电脑操作员', color: '#111111' };
    const roster = [...agents, planner, assistant, parent];
    expect(
      extractMentionedAgentIds(
        {
          content: '@电脑操作员 @智能助手 @日程规划 你们随便做点啥',
        },
        roster,
      ),
    ).toEqual(['op', 'h1', 'p1']);
    expect(
      collectTurnParticipants(parent, {
        agents: roster,
        children: [{ profile: 'explore' }],
        actions: [{ tool: 'delegate_subagent', arguments: { subagent_type: 'explore' } }],
        mentionedAgentIds: ['op', 'h1', 'p1'],
      }),
    ).toEqual([
      { key: 'op', name: '电脑操作员', color: '#111111' },
      { key: 'h1', name: '智能助手', color: '#8b5cf6' },
      { key: 'p1', name: '日程规划', color: '#f59e0b' },
    ]);
  });

  it('任务正文超过 60 字截断', () => {
    const task = '测'.repeat(80);
    expect(summarizeDelegateSubagent({ subagent_type: 'coder', task })).toBe(
      `${'测'.repeat(57)}…`,
    );
  });
});

describe('task_run 摘要', () => {
  it('抽出任务正文、隔离和工作区名', () => {
    expect(
      parseTaskRun({
        task: '写一份今晚日程',
        worktree: true,
        worktreeName: 'agenda',
        dependsOn: ['1117d5bf-de01-4b44-81ef-a42b75ffaa0f'],
      }),
    ).toEqual({
      task: '写一份今晚日程',
      worktree: true,
      worktreeName: 'agenda',
      dependsOn: ['1117d5bf-de01-4b44-81ef-a42b75ffaa0f'],
    });
  });

  it('行头标题区分普通后台与隔离', () => {
    expect(taskToolLabel('task_run', { task: 'x' })).toBe('后台任务');
    expect(taskToolLabel('task_run', { task: 'x', worktree: true })).toBe('后台任务 · 隔离');
    expect(taskToolLabel('task_status', {})).toBe('查询任务');
    expect(taskToolLabel('task_result', {})).toBe('收取结果');
    expect(taskToolLabel('task_send', {})).toBe('转达任务');
  });

  it('摘要用任务正文；blocked 时带等待依赖', () => {
    expect(summarizeTaskAction('task_run', { task: '写一份今晚日程' })).toBe('写一份今晚日程');
    expect(
      summarizeTaskAction(
        'task_run',
        { task: '写一份今晚日程' },
        { success: true, taskId: 'abc', status: 'blocked' },
      ),
    ).toBe('写一份今晚日程 · 等待依赖');
  });
});

describe('工具结果信封', () => {
  it('拆开 CoreLoop {success, data} 并把 JSON 字符串当对象', () => {
    expect(
      parseToolEnvelope({
        success: false,
        error: 'sub-agent ended with status: budget_exhausted',
        message: '先看目录',
      }),
    ).toMatchObject({
      success: false,
      error: 'sub-agent ended with status: budget_exhausted',
      message: '先看目录',
    });
    expect(
      parseToolEnvelope(
        '{"success": true, "data": {"taskId": "abc", "status": "running"}}',
      ),
    ).toMatchObject({
      success: true,
      fields: { taskId: 'abc', status: 'running' },
    });
  });

  it('委派失败句收成中文', () => {
    expect(
      humanizeDelegateError('sub-agent ended with status: budget_exhausted'),
    ).toBe('子代理因额度耗尽结束');
  });

  it('task_status 嵌套 data.task 抽出编号和正文', () => {
    const parsed = parseTaskToolOutput({
      success: true,
      data: {
        task: {
          taskId: '3bcae2a7-8aef-4ed1-ae95-b1eccf36c10f',
          status: 'running',
          task: '你是"日程规划"角色',
        },
      },
    });
    expect(parsed.items).toEqual([
      {
        taskId: '3bcae2a7-8aef-4ed1-ae95-b1eccf36c10f',
        status: 'running',
        task: '你是"日程规划"角色',
        answer: null,
        error: null,
        worktreeLabel: null,
        hint: null,
      },
    ]);
  });
});

describe('inspectableTaskFromAction', () => {
  it('task_run 结果抽出编号和任务正文', () => {
    expect(
      inspectableTaskFromAction(
        'task_run',
        { task: '写一份今晚日程' },
        { success: true, taskId: '1117d5bf-de01-4b44-81ef-a42b75ffaa0f', status: 'running' },
      ),
    ).toEqual({
      id: '1117d5bf-de01-4b44-81ef-a42b75ffaa0f',
      title: '写一份今晚日程',
    });
  });

  it('task_status 用参数或嵌套结果里的编号', () => {
    expect(
      inspectableTaskFromAction(
        'task_status',
        { taskId: '3bcae2a7-8aef-4ed1-ae95-b1eccf36c10f' },
        {
          success: true,
          data: {
            task: {
              taskId: '3bcae2a7-8aef-4ed1-ae95-b1eccf36c10f',
              status: 'running',
              task: '你是"日程规划"角色',
            },
          },
        },
      ),
    ).toEqual({
      id: '3bcae2a7-8aef-4ed1-ae95-b1eccf36c10f',
      title: '你是"日程规划"角色',
    });
  });

  it('没有编号或非任务工具不跳转', () => {
    expect(inspectableTaskFromAction('task_run', { task: '还没回来' })).toBeNull();
    expect(
      inspectableTaskFromAction('delegate_subagent', {}, { taskId: 'x' }),
    ).toBeNull();
  });

  it('终态卡标题优先 title 再 task', () => {
    expect(inspectTaskTitle({ id: 'a', chatId: 'c', title: '过程' })).toBe('过程');
    expect(inspectTaskTitle({ id: 'a', chatId: 'c', task: '写日程' })).toBe('写日程');
    expect(inspectTaskTitle({ id: 'a', chatId: 'c' })).toBe('后台任务');
  });
});
