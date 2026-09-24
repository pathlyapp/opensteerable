/**
 * OrchestrationChildrenCard 呈现层：画像 slug → 智能体显示名 + 颜色点。
 * 纯映射由 orchestration-children-model.test.ts 覆盖；这里验 renderTaskRow。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OrchestrationChildrenCard } from './OrchestrationChildrenCard';
import type { ChildInfo } from './orchestration-children-model';
import type { LocalChatAgent } from '@/lib/local-api';

afterEach(cleanup);

const RESEARCHER: Pick<LocalChatAgent, 'id' | 'slug' | 'name' | 'color'> = {
  id: 'a1',
  slug: 'researcher',
  name: '调研员',
  color: '#2563eb',
};

const ENGINEER: Pick<LocalChatAgent, 'id' | 'slug' | 'name' | 'color'> = {
  id: 'a2',
  slug: 'script-engineer',
  name: '脚本工程师',
  color: '#16a34a',
};

const CHILDREN: ChildInfo[] = [
  { childId: '0.1', task: '调研 PDF 方案', profile: 'researcher', status: 'running' },
  { childId: '0.2', task: '写汇总脚本', profile: 'script-engineer', status: 'completed' },
];

describe('OrchestrationChildrenCard / 显示名与颜色点', () => {
  it('两行显示智能体名字而非 slug，并带各自颜色点', () => {
    const { container } = render(
      <OrchestrationChildrenCard children={CHILDREN} agents={[RESEARCHER, ENGINEER]} />,
    );

    expect(screen.getByText('调研员')).toBeTruthy();
    expect(screen.getByText('脚本工程师')).toBeTruthy();
    expect(screen.queryByText('researcher')).toBeNull();
    expect(screen.queryByText('script-engineer')).toBeNull();
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();

    const dots = Array.from(
      container.querySelectorAll<HTMLElement>('[data-agent-color-dot]'),
    );
    expect(dots.map((dot) => dot.style.backgroundColor)).toEqual([
      '#2563eb',
      '#16a34a',
    ]);
  });

  it('找不到智能体时退回 profile 原文', () => {
    render(
      <OrchestrationChildrenCard
        children={[
          { childId: '0.1', task: '扫日志', profile: 'ghost', status: 'running' },
          { childId: '0.2', task: '写脚本', profile: 'script-engineer', status: 'completed' },
        ]}
        agents={[RESEARCHER, ENGINEER]}
      />,
    );
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.getByText('脚本工程师')).toBeTruthy();
  });

  it('单个委派不画编排计划，避免和工具行重复', () => {
    render(
      <OrchestrationChildrenCard
        children={[{ childId: '0.1', task: '探环境', profile: 'explore', status: 'failed' }]}
      />,
    );
    expect(screen.queryByText('编排计划')).toBeNull();
    expect(screen.queryByText('explore')).toBeNull();
    expect(screen.queryByText('探环境')).toBeNull();
  });

  it('多个委派看板标题是子代理，不标 PARALLEL', () => {
    render(
      <OrchestrationChildrenCard children={CHILDREN} agents={[RESEARCHER, ENGINEER]} />,
    );
    expect(screen.getByText('子代理')).toBeTruthy();
    expect(screen.queryByText('编排计划')).toBeNull();
    expect(screen.queryByText('PARALLEL')).toBeNull();
  });
});
