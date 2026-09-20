/**
 * CreateProjectModal：名称必填、源文件夹可追加、提交把两者交给 onCreate。
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
});
