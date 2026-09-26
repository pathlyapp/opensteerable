import { describe, expect, it } from 'vitest';
import { sidebarReleaseView, sidebarUpdateLabel } from './app-release';
import type { AppReleaseSnapshot } from './electron-bridge';

function snap(overrides: Partial<AppReleaseSnapshot> = {}): AppReleaseSnapshot {
  return {
    version: '0.2.2',
    enabled: true,
    phase: 'idle',
    ...overrides,
  };
}

describe('sidebar release labels', () => {
  it('hides the update action when the host has no feed', () => {
    expect(sidebarUpdateLabel(snap({ enabled: false, phase: 'disabled' }), false)).toBeNull();
    expect(sidebarReleaseView(snap({ enabled: false, phase: 'disabled' }), false)).toEqual({
      version: '0.2.2',
      actionLabel: null,
      actionTitle: undefined,
      clickable: false,
      emphasize: false,
    });
  });

  it('offers a check, then reports the current build or a newer one', () => {
    expect(sidebarUpdateLabel(snap(), false)).toBe('检查更新');
    expect(sidebarUpdateLabel(snap(), true)).toBe('已是最新');
    expect(sidebarUpdateLabel(snap({ message: '已是最新' }), false)).toBe('已是最新');
    expect(
      sidebarUpdateLabel(
        snap({ availableVersion: '0.3.0', message: '开发构建不安装更新' }),
        false,
      ),
    ).toBe('发现 0.3.0');
  });

  it('shows download progress and an install action', () => {
    expect(sidebarUpdateLabel(snap({ phase: 'checking' }), false)).toBe('检查中');
    expect(sidebarUpdateLabel(snap({ phase: 'downloading', percent: 40 }), false)).toBe('下载 40%');
    expect(sidebarUpdateLabel(snap({ phase: 'ready', availableVersion: '0.3.0' }), false)).toBe(
      '升级 0.3.0',
    );
    expect(sidebarReleaseView(snap({ phase: 'ready', availableVersion: '0.3.0' }), false)).toMatchObject({
      actionLabel: '升级 0.3.0',
      actionTitle: '重启并安装 0.3.0',
      clickable: true,
      emphasize: true,
    });
    expect(sidebarUpdateLabel(snap({ phase: 'installing', availableVersion: '0.3.0' }), false)).toBe(
      '正在安装',
    );
    expect(sidebarUpdateLabel(snap({ phase: 'error', message: 'offline' }), false)).toBe('重试');
  });
});
