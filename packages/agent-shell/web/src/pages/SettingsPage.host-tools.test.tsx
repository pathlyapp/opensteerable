/**
 * 产品关掉设置项时综合设置页不渲染对应分段。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hidden = new Set<string>();

vi.mock('@/lib/host-tools', () => ({
  settingsChrome: (id: string) => !hidden.has(id),
}));

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => true,
  getElectronBridge: () => null,
}));

vi.mock('@/components/settings/LlmSettingsPanel', () => ({
  LlmSettingsPanel: () => <div data-testid="llm-panel" />,
}));
vi.mock('@/components/settings/InsightsSettingsPanel', () => ({
  InsightsSettingsPanel: () => null,
}));
vi.mock('@/components/settings/TelemetrySettingsPanel', () => ({
  TelemetrySettingsPanel: () => null,
}));
vi.mock('@/components/settings/UsagePanel', () => ({
  UsagePanel: () => null,
}));
vi.mock('@/components/settings/WebSearchSettingsPanel', () => ({
  WebSearchSettingsPanel: () => null,
}));
vi.mock('@/components/settings/SecuritySettingsPanel', () => ({
  SecuritySettingsPanel: () => null,
}));
vi.mock('@/components/settings/DiagnoseSettingsPanel', () => ({
  DiagnoseSettingsPanel: () => null,
}));
vi.mock('@/components/settings/AppearanceSettingsPanel', () => ({
  AppearanceSettingsPanel: () => null,
}));

const { SettingsPage } = await import('./SettingsPage');

afterEach(() => {
  cleanup();
  hidden.clear();
});

describe('SettingsPage 设置项 chrome', () => {
  it('关掉 diagnose / security / telemetry 时不渲染对应分段，界面和模型仍在', () => {
    hidden.add('diagnose');
    hidden.add('security');
    hidden.add('telemetry');
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('settings-section-appearance')).toBeTruthy();
    expect(screen.getByTestId('settings-section-llm')).toBeTruthy();
    expect(screen.queryByTestId('settings-section-diagnose')).toBeNull();
    expect(screen.queryByTestId('settings-section-security')).toBeNull();
    expect(screen.queryByTestId('settings-section-telemetry')).toBeNull();
  });
});
