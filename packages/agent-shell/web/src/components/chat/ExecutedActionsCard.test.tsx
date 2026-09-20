import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolsFlow } from './ExecutedActionsCard';

afterEach(cleanup);

describe('ToolsFlow / todo_write', () => {
  it('keeps the compact tool row in the turn process, not a checklist', () => {
    render(
      <ToolsFlow
        actions={[
          {
            tool: 'todo_write',
            arguments: {
              todos: [
                { id: 'a', content: '调研仓库', status: 'completed' },
                { id: 'b', content: '写补丁', status: 'in_progress' },
              ],
            },
            result: { success: true },
          },
        ]}
      />,
    );

    expect(screen.getByText('todo_write')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.queryByTestId('todo-write-card')).toBeNull();
    expect(screen.queryByTestId('todo-item-a')).toBeNull();
    expect(screen.queryByText('调研仓库')).toBeNull();
  });
});

describe('ToolsFlow / delegate_subagent', () => {
  it('行头显示委派 · 智能体名和任务摘要，不露出工具原名', () => {
    const { container } = render(
      <ToolsFlow
        agents={[
          { id: 'a1', slug: 'researcher', name: '调研员', color: '#2563eb' },
        ]}
        actions={[
          {
            tool: 'delegate_subagent',
            arguments: {
              subagent_type: 'researcher',
              task: '调研 PDF 方案并给出带 URL 的结论',
            },
          },
        ]}
      />,
    );

    expect(screen.getByText('委派 · 调研员')).toBeTruthy();
    expect(screen.getByText('调研 PDF 方案并给出带 URL 的结论')).toBeTruthy();
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.queryByText('delegate_subagent')).toBeNull();
    const dot = container.querySelector('[data-agent-color-dot]') as HTMLElement | null;
    expect(dot?.style.backgroundColor).toBe('#2563eb');
  });

  it('内置画像无匹配智能体时用中文名', () => {
    render(
      <ToolsFlow
        actions={[
          {
            tool: 'delegate_subagent',
            arguments: { subagent_type: 'explore', task: '扫一下仓库结构' },
            result: { success: true, data: '找到 3 个入口' },
          },
        ]}
      />,
    );
    expect(screen.getByText('委派 · 探索')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
  });
});

describe('ToolsFlow / task_run', () => {
  it('行头显示后台任务和任务摘要，不露出工具原名', () => {
    render(
      <ToolsFlow
        actions={[
          {
            tool: 'task_run',
            arguments: { task: '写一份今晚的时间块安排，落成文件' },
            result: { success: true, taskId: '1117d5bf-de01-4b44-81ef-a42b75ffaa0f', status: 'running' },
          },
        ]}
      />,
    );
    expect(screen.getByText('后台任务')).toBeTruthy();
    expect(screen.getByText('写一份今晚的时间块安排，落成文件')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.queryByText('task_run')).toBeNull();
  });

  it('worktree 任务行头带隔离', () => {
    render(
      <ToolsFlow
        actions={[
          {
            tool: 'task_run',
            arguments: { task: '改代码', worktree: true },
          },
        ]}
      />,
    );
    expect(screen.getByText('后台任务 · 隔离')).toBeTruthy();
    expect(screen.getByText('改代码 · 隔离工作区')).toBeTruthy();
  });
});

describe('ToolsFlow / 展开输出', () => {
  it('委派失败展示中文原因和子代理回报，不甩 JSON', () => {
    render(
      <ToolsFlow
        defaultExpanded
        actions={[
          {
            tool: 'delegate_subagent',
            arguments: { subagent_type: 'explore', task: '探环境' },
            result:
              '{"success": false, "error": "sub-agent ended with status: budget_exhausted", "message": "I\'ll start by exploring the target directory structure"}',
          },
        ]}
      />,
    );
    expect(screen.getByText('子代理因额度耗尽结束')).toBeTruthy();
    expect(screen.getByText(/I'll start by exploring the target directory structure/)).toBeTruthy();
    expect(screen.queryByText(/"success": false/)).toBeNull();
  });

  it('查询任务拆开 data.task，显示编号和状态', () => {
    render(
      <ToolsFlow
        defaultExpanded
        actions={[
          {
            tool: 'task_status',
            arguments: { taskId: '3bcae2a7-8aef-4ed1-ae95-b1eccf36c10f' },
            result: {
              success: true,
              data: {
                task: {
                  taskId: '3bcae2a7-8aef-4ed1-ae95-b1eccf36c10f',
                  status: 'running',
                  task: '你是"日程规划"角色。现在是 2026-09-20（周日）',
                },
              },
            },
          },
        ]}
      />,
    );
    expect(screen.getByText('查询任务')).toBeTruthy();
    expect(screen.getAllByText('3bcae2a7').length).toBeGreaterThan(0);
    expect(screen.getByText('已启动')).toBeTruthy();
    expect(screen.getByText(/你是"日程规划"角色/)).toBeTruthy();
    expect(screen.queryByText(/"success": true/)).toBeNull();
  });
});

describe('ToolsFlow / 委派展开', () => {
  it('输入区出子代理中文名，不打原始画像名', () => {
    render(
      <ToolsFlow
        defaultExpanded
        agents={[
          {
            id: '85dd2139-4cbe-4997-9250-9ed4ff87a464',
            slug: null,
            name: '日程规划',
            color: '#f59e0b',
          },
        ]}
        actions={[
          {
            tool: 'delegate_subagent',
            arguments: { subagent_type: 'agent-85dd21394cbe4997', task: '排下周日程' },
            result: { success: true, message: '排好了' },
          },
        ]}
      />,
    );
    expect(screen.getByText('子代理')).toBeTruthy();
    expect(screen.getAllByText('日程规划').length).toBeGreaterThan(0);
    expect(screen.queryByText('agent-85dd21394cbe4997')).toBeNull();
  });
});

describe('ToolsFlow / 后台任务跳转', () => {
  it('点行头打开右侧过程栏，箭头仍只展开详情', () => {
    const onInspectTask = vi.fn();
    render(
      <ToolsFlow
        chatId="chat-1"
        onInspectTask={onInspectTask}
        actions={[
          {
            tool: 'task_run',
            arguments: { task: '写一份今晚的时间块安排' },
            result: {
              success: true,
              taskId: '1117d5bf-de01-4b44-81ef-a42b75ffaa0f',
              status: 'running',
            },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('tool-activate'));
    expect(onInspectTask).toHaveBeenCalledWith({
      id: '1117d5bf-de01-4b44-81ef-a42b75ffaa0f',
      chatId: 'chat-1',
      title: '写一份今晚的时间块安排',
    });
    expect(screen.queryByText('输入')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
    expect(screen.getByText('输入')).toBeTruthy();
    expect(onInspectTask).toHaveBeenCalledTimes(1);
  });

  it('委派行点开子代理过程：带上它自己的 record', () => {
    const onInspectTask = vi.fn();
    render(
      <ToolsFlow
        chatId="chat-1"
        onInspectTask={onInspectTask}
        orchestrationChildren={[
          {
            childId: '0.1',
            profile: 'scheduler',
            task: '排今晚日程',
            status: 'completed',
            recordId: 'chat-1:child:0.1',
          },
        ]}
        actions={[
          {
            tool: 'delegate_subagent',
            arguments: { subagent_type: 'scheduler', task: '排今晚日程' },
            result: { success: true, message: '排好了' },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('tool-activate'));
    expect(onInspectTask).toHaveBeenCalledWith({
      id: '0.1',
      chatId: 'chat-1',
      recordId: 'chat-1:child:0.1',
      live: false,
      title: '排今晚日程',
    });
  });

  it('子代理还没有 record（历史回合）时委派行不可点', () => {
    const onInspectTask = vi.fn();
    render(
      <ToolsFlow
        chatId="chat-1"
        onInspectTask={onInspectTask}
        orchestrationChildren={[
          { childId: '0.1', profile: 'scheduler', task: '排今晚日程', status: 'completed' },
        ]}
        actions={[
          {
            tool: 'delegate_subagent',
            arguments: { subagent_type: 'scheduler', task: '排今晚日程' },
          },
        ]}
      />,
    );
    expect(screen.queryByTestId('tool-activate')).toBeNull();
    expect(onInspectTask).not.toHaveBeenCalled();
  });

  it('委派行点开子代理过程：带上它自己的 record', () => {
    const onInspectTask = vi.fn();
    render(
      <ToolsFlow
        chatId="chat-1"
        onInspectTask={onInspectTask}
        orchestrationChildren={[
          {
            childId: '0.1',
            profile: 'scheduler',
            task: '排今晚日程',
            status: 'completed',
            recordId: 'chat-1:child:0.1',
          },
        ]}
        actions={[
          {
            tool: 'delegate_subagent',
            arguments: { subagent_type: 'scheduler', task: '排今晚日程' },
            result: { success: true, message: '排好了' },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('tool-activate'));
    expect(onInspectTask).toHaveBeenCalledWith({
      id: '0.1',
      chatId: 'chat-1',
      recordId: 'chat-1:child:0.1',
      live: false,
      title: '排今晚日程',
    });
  });

  it('子代理还没有 record（历史回合）时委派行不可点', () => {
    const onInspectTask = vi.fn();
    render(
      <ToolsFlow
        chatId="chat-1"
        onInspectTask={onInspectTask}
        orchestrationChildren={[
          { childId: '0.1', profile: 'scheduler', task: '排今晚日程', status: 'completed' },
        ]}
        actions={[
          {
            tool: 'delegate_subagent',
            arguments: { subagent_type: 'scheduler', task: '排今晚日程' },
          },
        ]}
      />,
    );
    expect(screen.queryByTestId('tool-activate')).toBeNull();
    expect(onInspectTask).not.toHaveBeenCalled();
  });

  it('没有 taskId 时不挂跳转', () => {
    const onInspectTask = vi.fn();
    render(
      <ToolsFlow
        chatId="chat-1"
        onInspectTask={onInspectTask}
        actions={[{ tool: 'task_run', arguments: { task: '还没回来' } }]}
      />,
    );
    expect(screen.queryByTestId('tool-activate')).toBeNull();
    fireEvent.click(screen.getByText('后台任务'));
    expect(onInspectTask).not.toHaveBeenCalled();
  });
});
