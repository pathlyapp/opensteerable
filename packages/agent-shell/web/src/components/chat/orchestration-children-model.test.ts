import { describe, expect, it } from 'vitest';
import {
  childrenToCardModel,
  extractPersistedOrchestrationChildren,
  findAgentForProfile,
  matchChildForDelegation,
  foldOrchestrationChildEvents,
  shouldShowOrchestrationBoard,
  type ChildInfo,
} from './orchestration-children-model';

// OrchestrationChildrenCard 的纯映射层测试：agent.child 生命周期事件累积出的
// ChildInfo 列表 → OrchestrationPlanCard 的 payload + taskStatuses。卡片本身
// 的点击展开/收起交互由框架 agent-ui 的 cards.test.tsx 覆盖；桌面端到端
// （真实 Electron + CDP 模拟用户操作）由 scripts/desktop-canary.mjs 覆盖。

describe('childrenToCardModel / P3.1 编排卡片映射', () => {
  it('空列表产出空任务面', () => {
    const { payload, taskStatuses } = childrenToCardModel([]);
    expect(payload.tasks).toEqual([]);
    expect(taskStatuses).toEqual({});
  });

  it('spawn 的子代理进 tasks，id/agentId 用 lineage childId', () => {
    const children: ChildInfo[] = [
      { childId: '0.1', task: '扫日志', depth: 1, status: 'running' },
      { childId: '0.2', task: '读配置', depth: 1, status: 'running' },
    ];
    const { payload } = childrenToCardModel(children);
    expect(payload.mode).toBe('parallel');
    expect(payload.tasks).toEqual([
      { id: '0.1', agentId: '0.1', prompt: '扫日志' },
      { id: '0.2', agentId: '0.2', prompt: '读配置' },
    ]);
  });

  it('生命周期状态映射到卡片状态点', () => {
    const children: ChildInfo[] = [
      { childId: '0.1', status: 'running' },
      { childId: '0.2', status: 'completed' },
      { childId: '0.3', status: 'failed' },
      { childId: '0.4', status: 'cancelled' },
      { childId: '0.5', status: 'interrupted' },
    ];
    const { taskStatuses } = childrenToCardModel(children);
    expect(taskStatuses).toEqual({
      '0.1': 'running',
      '0.2': 'ok',
      '0.3': 'failed',
      '0.4': 'skipped',
      // interrupted 是可恢复的暂停，不是终态
      '0.5': 'pending',
    });
  });

  it('未知状态退化为 pending；缺 task 时 prompt 为空串', () => {
    const { payload, taskStatuses } = childrenToCardModel([
      { childId: '0.1', status: 'mystery' },
    ]);
    expect(taskStatuses['0.1']).toBe('pending');
    expect(payload.tasks[0].prompt).toBe('');
  });

  it('delegate 子代理的 agentId 显示 profile 名(delegate-on-pool)', () => {
    // delegate_subagent 的 child_spawned 事件带 profile;卡片把 profile
    // 作为执行者名显示,无 profile 的编排子代理仍退回 lineage childId。
    const children: ChildInfo[] = [
      { childId: '0.1', task: '扫日志', profile: 'researcher', status: 'running' },
      { childId: '0.2', task: '读配置', profile: 'general-purpose', status: 'completed' },
      { childId: '0.3', task: '六件套子代理', status: 'running' },
    ];
    const { payload } = childrenToCardModel(children);
    expect(payload.tasks).toEqual([
      { id: '0.1', agentId: 'researcher', prompt: '扫日志' },
      { id: '0.2', agentId: 'general-purpose', prompt: '读配置' },
      { id: '0.3', agentId: '0.3', prompt: '六件套子代理' },
    ]);
  });
});

describe('shouldShowOrchestrationBoard', () => {
  it('0 或 1 个孩子不画看板', () => {
    expect(shouldShowOrchestrationBoard([])).toBe(false);
    expect(
      shouldShowOrchestrationBoard([
        { childId: '0.1', task: '探环境', profile: 'explore', status: 'failed' },
      ]),
    ).toBe(false);
  });

  it('两个及以上才画', () => {
    expect(
      shouldShowOrchestrationBoard([
        { childId: '0.1', profile: 'researcher', status: 'running' },
        { childId: '0.2', profile: 'coder', status: 'running' },
      ]),
    ).toBe(true);
  });
});

describe('foldOrchestrationChildEvents / 切回重建子代理列表', () => {
  it('空事件流产出空列表', () => {
    expect(foldOrchestrationChildEvents([])).toEqual([]);
  });

  it('spawn → completed → resumed 折叠为终态/恢复态', () => {
    const list = foldOrchestrationChildEvents([
      { kind: 'child_spawned', childId: '0.1', task: '扫日志', depth: 1 },
      { kind: 'child_completed', childId: '0.1', status: 'completed' },
      { kind: 'child_resumed', childId: '0.1', status: 'running' },
    ]);
    expect(list).toEqual([{ childId: '0.1', task: '扫日志', depth: 1, status: 'running' }]);
  });

  it('child_spawned 的 profile 经 fold 存活，完成态仍保留', () => {
    const list = foldOrchestrationChildEvents([
      {
        kind: 'child_spawned',
        childId: '0.1',
        task: '调研 PDF 方案',
        depth: 1,
        profile: 'researcher',
      },
      { kind: 'child_completed', childId: '0.1', status: 'completed' },
    ]);
    expect(list).toEqual([
      {
        childId: '0.1',
        task: '调研 PDF 方案',
        depth: 1,
        profile: 'researcher',
        status: 'completed',
      },
    ]);
  });

  it('未 spawn 就出现的终端事件被跳过', () => {
    expect(
      foldOrchestrationChildEvents([{ kind: 'child_failed', childId: 'ghost' }]),
    ).toEqual([]);
  });

  it('重复 spawn 幂等，不会产生重复条目', () => {
    const list = foldOrchestrationChildEvents([
      { kind: 'child_spawned', childId: '0.1', task: 'A' },
      { kind: 'child_spawned', childId: '0.1', task: 'A' },
    ]);
    expect(list).toHaveLength(1);
  });

  it('findAgentForProfile 按 slug / id 找回智能体，找不到为 undefined', () => {
    const agents = [
      { id: 'a1', slug: 'researcher', name: '调研员', color: '#2563eb' },
      { id: 'a2', slug: 'script-engineer', name: '脚本工程师', color: '#16a34a' },
    ];
    expect(findAgentForProfile('researcher', agents)).toEqual(agents[0]);
    expect(findAgentForProfile('a2', agents)).toEqual(agents[1]);
    // 编排六件套的子代理只有 lineage id，卡片退回画像原文。
    expect(findAgentForProfile('0.1', agents)).toBeUndefined();
  });

  it('findAgentForProfile 认得宿主的派生画像名（自建智能体没有 slug）', () => {
    // 纯中文名 slugify 后为空 → 宿主回落 `agent-<id 前 16 位字母数字>`。
    const scheduler = {
      id: '85dd2139-4cbe-4997-9250-9ed4ff87a464',
      slug: null,
      name: '日程规划',
    };
    const english = { id: 'b2', slug: null, name: 'Data Cleaner' };
    const agents = [scheduler, english];

    expect(findAgentForProfile('agent-85dd21394cbe4997', agents)).toEqual(scheduler);
    // 英文名能 slugify，画像名就是它。
    expect(findAgentForProfile('data-cleaner', agents)).toEqual(english);
    // 花名册重名时会加 id 后缀去重，同样要认。
    expect(findAgentForProfile('data-cleaner-b2', agents)).toEqual(english);
    expect(findAgentForProfile('agent-ffffffffffffffff', agents)).toBeUndefined();
  });

  it('matchChildForDelegation 按任务正文配对，同画像多份活按顺序消费', () => {
    const children: ChildInfo[] = [
      { childId: '0.1', profile: 'scheduler', task: '排今晚日程', status: 'completed' },
      { childId: '0.2', profile: 'scheduler', task: '排下周日程', status: 'running' },
    ];
    expect(
      matchChildForDelegation({ profile: 'scheduler', task: '排下周日程' }, children)?.childId,
    ).toBe('0.2');
    // 同一份活的第二行不该再认领已配对的孩子。
    const taken = new Set(['0.1']);
    expect(
      matchChildForDelegation({ profile: 'scheduler', task: '排今晚日程' }, children, taken),
    ).toBeUndefined();
    // 画像不同就不是它。
    expect(
      matchChildForDelegation({ profile: 'helper', task: '排今晚日程' }, children),
    ).toBeUndefined();
  });

  it('fold 保留子代理的 recordId（委派行跳转右侧过程栏要用）', () => {
    expect(
      foldOrchestrationChildEvents([
        {
          kind: 'child_spawned',
          childId: '0.1',
          task: '排下周日程',
          profile: 'scheduler',
          recordId: 'chat-1:child:0.1',
        },
        { kind: 'child_completed', childId: '0.1', status: 'completed' },
      ]),
    ).toEqual([
      {
        childId: '0.1',
        task: '排下周日程',
        depth: undefined,
        profile: 'scheduler',
        recordId: 'chat-1:child:0.1',
        status: 'completed',
      },
    ]);
  });

  it('extractPersistedOrchestrationChildren 从助手 metadata fold 出卡片', () => {
    const seeded = extractPersistedOrchestrationChildren([
      {
        id: 'asst-1',
        role: 'assistant',
        messageMetadata: JSON.stringify({
          orchestrationChildEvents: [
            {
              kind: 'child_spawned',
              childId: '0.1',
              task: '调研 PDF 方案',
              profile: 'researcher',
            },
            { kind: 'child_completed', childId: '0.1', status: 'completed' },
          ],
        }),
      },
      { id: 'user-1', role: 'user', messageMetadata: null },
      {
        id: 'asst-legacy',
        role: 'assistant',
        messageMetadata: JSON.stringify({ agentId: 'parent' }),
      },
    ]);
    expect(seeded).toEqual({
      'asst-1': [
        {
          childId: '0.1',
          task: '调研 PDF 方案',
          profile: 'researcher',
          status: 'completed',
        },
      ],
    });
  });

  it('extractPersistedOrchestrationChildren 忽略畸形 metadata', () => {
    expect(
      extractPersistedOrchestrationChildren([
        { id: 'bad', role: 'assistant', messageMetadata: '{not-json' },
        {
          id: 'empty',
          role: 'assistant',
          messageMetadata: JSON.stringify({ orchestrationChildEvents: [] }),
        },
      ]),
    ).toEqual({});
  });

  it('非法条目（缺 kind/childId）被忽略', () => {
    // 刻意传入非结构化条目验证鲁棒性——运行时可从 JSON 收到任意形状。
    const list = foldOrchestrationChildEvents([
      { childId: '0.1' },
      { kind: 'child_spawned' },
      null,
      42,
    ] as unknown as Parameters<typeof foldOrchestrationChildEvents>[0]);
    expect(list).toEqual([]);
  });
});
