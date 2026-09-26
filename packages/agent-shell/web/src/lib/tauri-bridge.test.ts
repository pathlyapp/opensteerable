import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  html2canvas: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('html2canvas', () => ({ default: mocks.html2canvas }));

import { createTauriBridge } from './tauri-bridge';

beforeEach(() => {
  vi.clearAllMocks();
  window.__DEEPPATH_BS__ = {
    platform: 'darwin',
    flavor: 'generic',
    brandName: 'Test',
  };
  mocks.listen.mockResolvedValue(vi.fn());
});

afterEach(() => {
  delete window.__DEEPPATH_BS__;
});

describe('createTauriBridge', () => {
  it('keeps the shared HTTP backend and invokes narrow native commands', async () => {
    mocks.invoke.mockResolvedValue({ canceled: false, filePaths: ['/tmp/work'] });
    const bridge = createTauriBridge();

    expect(typeof bridge.localBackend.request).toBe('function');
    await expect(bridge.local!.selectDirectory({ title: 'Workspace' })).resolves.toEqual({
      canceled: false,
      filePaths: ['/tmp/work'],
    });
    expect(mocks.invoke).toHaveBeenCalledWith('host_select_directory', {
      options: { title: 'Workspace' },
    });
  });

  it('renders the selected WebView region and copies it through Rust', async () => {
    mocks.html2canvas.mockResolvedValue({
      width: 200,
      height: 100,
      toDataURL: () => 'data:image/png;base64,cG5n',
    });
    mocks.invoke.mockResolvedValue({ success: true, width: 200, height: 100 });
    const bridge = createTauriBridge();

    await expect(
      bridge.local!.captureScreenshot({ x: 1, y: 2, width: 100, height: 50 }),
    ).resolves.toEqual({ success: true, width: 200, height: 100 });
    expect(mocks.invoke).toHaveBeenCalledWith('host_capture_screenshot', {
      image: { pngBase64: 'cG5n', width: 200, height: 100 },
    });
  });

  it('reads the release snapshot and listens for updater events', async () => {
    const snapshot = {
      version: '0.2.2',
      enabled: true,
      phase: 'idle' as const,
    };
    mocks.invoke.mockResolvedValue(snapshot);
    const bridge = createTauriBridge();
    await expect(bridge.app!.snapshot()).resolves.toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith('app_release_snapshot');

    const onState = vi.fn();
    const off = bridge.app!.onState(onState);
    expect(mocks.listen).toHaveBeenCalledWith('app-update-state', expect.any(Function));
    off();
  });

  it('forwards native menu events with the existing channel names', () => {
    const bridge = createTauriBridge();
    const callback = vi.fn();
    bridge.onMenuNewChat!(callback);

    expect(mocks.listen).toHaveBeenCalledWith('menu:new-chat', expect.any(Function));
  });
});
