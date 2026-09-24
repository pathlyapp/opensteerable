/**
 * 宿主桥选择逻辑：显式 HostBridge、Electron、Tauri、BS 依次降级。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getElectronBridge,
  getHostBridge,
  isDesktopHost,
  isElectron,
} from './electron-bridge';

afterEach(() => {
  delete (window as { steerableHost?: unknown }).steerableHost;
  delete (window as { electron?: unknown }).electron;
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as { __DEEPPATH_BS__?: unknown }).__DEEPPATH_BS__;
});

describe('getHostBridge', () => {
  it('两种桥都不存在时返回 null（纯浏览器演示态）', () => {
    expect(getHostBridge()).toBeNull();
    expect(isDesktopHost()).toBe(false);
    expect(isElectron()).toBe(false);
  });

  it('显式 HostBridge 优先于兼容桥', () => {
    const host = { runtime: 'local', platform: 'darwin' };
    const electron = { runtime: 'local', platform: 'win32' };
    (window as { steerableHost?: unknown }).steerableHost = host;
    (window as { electron?: unknown }).electron = electron;
    expect(getHostBridge()).toBe(host);
    expect(getElectronBridge()).toBe(host);
    expect(isDesktopHost()).toBe(true);
  });

  it('window.electron 存在时原样返回', () => {
    const fake = { runtime: 'local', platform: 'darwin' };
    (window as { electron?: unknown }).electron = fake;
    expect(getElectronBridge()).toBe(fake);
    expect(isElectron()).toBe(true);
  });

  it('仅 __DEEPPATH_BS__ 时落到 HTTP 桥，平台取自注入的引导信息', () => {
    (window as { __DEEPPATH_BS__?: unknown }).__DEEPPATH_BS__ = {
      platform: 'linux',
      flavor: 'generic',
      brandName: 'Test',
    };
    const bridge = getElectronBridge();
    expect(bridge).not.toBeNull();
    expect(bridge!.runtime).toBe('local');
    expect(bridge!.platform).toBe('linux');
    // HTTP 桥的传输面齐全（fetch 实现，无需 Electron）。
    expect(typeof bridge!.localBackend.request).toBe('function');
    expect(isElectron()).toBe(true);
    // 单例：再次取桥是同一个对象。
    expect(getElectronBridge()).toBe(bridge);
  });

  it('window.electron 优先于 __DEEPPATH_BS__', () => {
    const fake = { runtime: 'local', platform: 'darwin' };
    (window as { electron?: unknown }).electron = fake;
    (window as { __DEEPPATH_BS__?: unknown }).__DEEPPATH_BS__ = {
      platform: 'linux',
      flavor: 'generic',
      brandName: 'Test',
    };
    expect(getElectronBridge()).toBe(fake);
  });

  it('Tauri loopback 页面使用 Tauri 桥并保留 HTTP 后端', () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    (window as { __DEEPPATH_BS__?: unknown }).__DEEPPATH_BS__ = {
      platform: 'darwin',
      flavor: 'generic',
      brandName: 'Test',
    };
    const bridge = getHostBridge();
    expect(bridge).not.toBeNull();
    expect(bridge!.platform).toBe('darwin');
    expect(typeof bridge!.localBackend.request).toBe('function');
    expect(isDesktopHost()).toBe(true);
  });
});
