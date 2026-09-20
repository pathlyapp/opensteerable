/**
 * ChatProjectBadge / ProjectPickerButton：空列表可直接新建项目。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProject } from '@/lib/local-api';

const createProject = vi.fn();
const updateChatProject = vi.fn();
const updateProject = vi.fn();

vi.mock('@/lib/local-api', () => ({
  createProject: (...args: unknown[]) => createProject(...args),
  updateChatProject: (...args: unknown[]) => updateChatProject(...args),
  updateProject: (...args: unknown[]) => updateProject(...args),
}));

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => true,
  getElectronBridge: () => ({
    local: { selectDirectory: vi.fn() },
  }),
}));

vi.mock('@/brand', () => ({
  BRAND_NAME: '测试助手',
}));

const { ChatProjectBadge, ProjectPickerButton } = await import('./ChatProjectBadge');

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  createProject.mockReset();
  updateChatProject.mockReset();
  updateProject.mockReset();
  createProject.mockResolvedValue({
    success: true,
    project: {
      id: 'proj-new',
      name: '演示',
      folderPath: '/tmp/demo',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } satisfies LocalProject,
  });
  updateChatProject.mockResolvedValue({});
});

describe('ChatProjectBadge 空项目', () => {
  it('关联到项目标题旁和空态都有新建入口，创建后绑定当前会话', async () => {
    const onProjectsChanged = vi.fn(async () => {});
    const onChatProjectChanged = vi.fn(async () => {});
    render(
      <ChatProjectBadge
        chatId="chat-1"
        project={null}
        projects={[]}
        onProjectsChanged={onProjectsChanged}
        onChatProjectChanged={onChatProjectChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /选择项目/ }));
    expect(screen.getByText('关联到项目')).toBeTruthy();
    expect(screen.getByText('还没有项目')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '新建项目' })[0]);
    expect(screen.getByTestId('create-project-dialog')).toBeTruthy();

    fireEvent.change(screen.getByTestId('create-project-name'), { target: { value: '演示' } });
    fireEvent.click(screen.getByTestId('create-project-submit'));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: '演示' }));
    await waitFor(() => expect(updateChatProject).toHaveBeenCalledWith('chat-1', 'proj-new'));
    expect(onProjectsChanged).toHaveBeenCalled();
    expect(onChatProjectChanged).toHaveBeenCalled();
  });
});

describe('ProjectPickerButton 空项目', () => {
  it('空态点新建项目会打开弹窗并在创建后选中', async () => {
    const onChange = vi.fn();
    const onProjectsChanged = vi.fn(async () => {});
    render(
      <ProjectPickerButton
        projects={[]}
        value={null}
        onChange={onChange}
        onProjectsChanged={onProjectsChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /选择项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建项目' }));
    fireEvent.change(screen.getByTestId('create-project-name'), { target: { value: '演示' } });
    fireEvent.click(screen.getByTestId('create-project-submit'));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: '演示' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('proj-new'));
    expect(onProjectsChanged).toHaveBeenCalled();
  });
});
