/**
 * CreateProjectModal：名称必填、源文件夹可追加多个；编辑模式回填后保存。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronBridge } from '@/lib/electron-bridge';

let bridgeStub: ElectronBridge | null = null;

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => bridgeStub !== null,
  getElectronBridge: () => bridgeStub,
}));

vi.mock('@/brand', () => ({
  BRAND_NAME: '测试助手',
}));

const { CreateProjectModal } = await import('./CreateProjectModal');

afterEach(() => {
  cleanup();
  bridgeStub = null;
});

function renderModal(
  onCreate = vi.fn(async () => {}),
  onClose = vi.fn(),
) {
  render(<CreateProjectModal open onClose={onClose} onCreate={onCreate} />);
  return { onCreate, onClose };
}

describe('CreateProjectModal', () => {
  beforeEach(() => {
    bridgeStub = {
      runtime: 'local',
      platform: 'darwin',
      local: {
        selectDirectory: vi.fn(async () => ({
          canceled: false,
          filePaths: ['/tmp/src-a'],
        })),
        captureScreenshot: vi.fn(async () => ({ success: false as const, error: '未实现' })),
      },
      localBackend: {
        request: vi.fn() as unknown as ElectronBridge['localBackend']['request'],
        startStream: vi.fn(async () => null),
        cancelStream: vi.fn(),
      },
    };
  });

  it('空名称时创建按钮不可用', () => {
    renderModal();
    expect((screen.getByTestId('create-project-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('填名称后创建，不带源文件夹', async () => {
    const { onCreate, onClose } = renderModal();
    fireEvent.change(screen.getByTestId('create-project-name'), { target: { value: '演示' } });
    fireEvent.click(screen.getByTestId('create-project-submit'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: '演示', sourceFolders: [] }));
    expect(onClose).toHaveBeenCalled();
  });

  it('可附加源文件夹再提交', async () => {
    const { onCreate } = renderModal();
    fireEvent.change(screen.getByTestId('create-project-name'), { target: { value: '演示' } });
    fireEvent.click(screen.getByTestId('create-project-add-folder'));
    await waitFor(() => expect(screen.getByText('/tmp/src-a')).toBeTruthy());
    fireEvent.click(screen.getByTestId('create-project-submit'));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ name: '演示', sourceFolders: ['/tmp/src-a'] }),
    );
  });

  it('无系统选择器时可用输入框添加源文件夹', async () => {
    bridgeStub = null;
    const { onCreate } = renderModal();
    fireEvent.change(screen.getByTestId('create-project-name'), { target: { value: '演示' } });
    fireEvent.change(screen.getByTestId('create-project-folder-path'), {
      target: { value: '~/code/src' },
    });
    fireEvent.click(screen.getByTestId('create-project-add-folder'));
    await waitFor(() => expect(screen.getByText('~/code/src')).toBeTruthy());
    fireEvent.click(screen.getByTestId('create-project-submit'));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ name: '演示', sourceFolders: ['~/code/src'] }),
    );
  });

  it('编辑模式回填名称和多个源文件夹，保存时一并提交', async () => {
    const onCreate = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <CreateProjectModal
        open
        mode="edit"
        initial={{ name: '项目甲', sourceFolders: ['/tmp/old'] }}
        onClose={onClose}
        onCreate={onCreate}
      />,
    );

    expect(screen.getByTestId('edit-project-dialog')).toBeTruthy();
    expect(screen.getByDisplayValue('项目甲')).toBeTruthy();
    expect(screen.getByText('/tmp/old')).toBeTruthy();

    fireEvent.change(screen.getByTestId('edit-project-folder-path'), {
      target: { value: '/tmp/new' },
    });
    fireEvent.click(screen.getByTestId('edit-project-add-folder'));
    await waitFor(() => expect(screen.getByText('/tmp/new')).toBeTruthy());

    fireEvent.change(screen.getByTestId('edit-project-name'), { target: { value: '项目甲改' } });
    fireEvent.click(screen.getByTestId('edit-project-submit'));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: '项目甲改',
        sourceFolders: ['/tmp/old', '/tmp/new'],
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('编辑模式可移除源文件夹后保存空列表', async () => {
    const onCreate = vi.fn(async () => {});
    render(
      <CreateProjectModal
        open
        mode="edit"
        initial={{ name: '项目甲', sourceFolders: ['/tmp/old'] }}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByLabelText('移除 /tmp/old'));
    fireEvent.click(screen.getByTestId('edit-project-submit'));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ name: '项目甲', sourceFolders: [] }),
    );
  });

  it('编辑模式删除需两段确认', async () => {
    const onDelete = vi.fn(async () => {});
    render(
      <CreateProjectModal
        open
        mode="edit"
        initial={{ name: '项目甲', sourceFolders: [] }}
        onClose={vi.fn()}
        onCreate={vi.fn(async () => {})}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByTestId('edit-project-delete'));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('edit-project-delete'));
    await waitFor(() => expect(onDelete).toHaveBeenCalled());
  });
});
