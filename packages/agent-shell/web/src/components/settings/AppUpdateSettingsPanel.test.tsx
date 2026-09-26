import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppReleaseSnapshot } from '@/lib/electron-bridge';

const app = vi.hoisted(() => ({
  snapshot: vi.fn<() => Promise<AppReleaseSnapshot>>(),
  check: vi.fn<() => Promise<AppReleaseSnapshot>>(),
  install: vi.fn<() => Promise<AppReleaseSnapshot>>(),
  onState: vi.fn(() => () => {}),
}));

vi.mock('@/lib/electron-bridge', () => ({
  getElectronBridge: () => ({ app }),
}));

const { AppUpdateSettingsPanel } = await import('./AppUpdateSettingsPanel');

afterEach(() => {
  cleanup();
  app.snapshot.mockReset();
  app.check.mockReset();
  app.install.mockReset();
  app.onState.mockReset();
  app.onState.mockReturnValue(() => {});
});

describe('AppUpdateSettingsPanel', () => {
  it('shows the installed version and checks for an update', async () => {
    app.snapshot.mockResolvedValue({ version: '0.2.2', enabled: true, phase: 'idle' });
    app.check.mockResolvedValue({
      version: '0.2.2',
      enabled: true,
      phase: 'idle',
      message: '已是最新',
    });
    render(<AppUpdateSettingsPanel />);

    expect((await screen.findByTestId('settings-app-version')).textContent).toBe('v0.2.2');
    fireEvent.click(screen.getByTestId('settings-app-update'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-app-update').textContent).toBe('已是最新');
    });
    expect(app.check).toHaveBeenCalledOnce();
  });

  it('installs a downloaded update', async () => {
    app.snapshot.mockResolvedValue({
      version: '0.2.2',
      enabled: true,
      phase: 'ready',
      availableVersion: '0.3.0',
    });
    app.install.mockResolvedValue({
      version: '0.2.2',
      enabled: true,
      phase: 'installing',
      availableVersion: '0.3.0',
    });
    render(<AppUpdateSettingsPanel />);

    expect(await screen.findByText('重启并安装 0.3.0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settings-app-update'));
    await waitFor(() => {
      expect(app.install).toHaveBeenCalledOnce();
      expect(screen.getByTestId('settings-app-update').textContent).toBe('正在安装');
    });
    expect(app.check).not.toHaveBeenCalled();
  });

  it('renders nothing without a desktop release', () => {
    app.snapshot.mockRejectedValue(new Error('unavailable'));
    const { container } = render(<AppUpdateSettingsPanel />);
    expect(container.textContent).toBe('');
  });
});
