/**
 * 桌面自动更新（generic feed + electron-updater 端口）。
 *
 * 钉住的契约：
 *  - 没有 feed，或未打包且未显式打开时，不碰更新器；
 *  - DEEPPATH_UPDATE_FEED_URL 覆盖产品 feed；DEEPPATH_APP_UPDATE=1 才允许未打包检查；
 *  - 先设 generic feed、禁止降级、自动下载、退出时安装，再挂监听，再检查；
 *  - 只有比当前版本新的合法版本才会进入下载；下载完成后可 quitAndInstall；
 *  - 下载或待安装期间不重入检查；失败可再查；dispose 后不再改状态。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  AppUpdateController,
  appUpdateMenuAction,
  shouldNotifyUpdateReady,
  toAppReleaseSnapshot,
  type AppUpdateCheckResult,
  type AppUpdaterPort,
} from '../src/app-update.js';

class FakeUpdater implements AppUpdaterPort {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  readonly calls: string[] = [];
  checkResult: AppUpdateCheckResult | null = {
    updateInfo: { version: '1.0.0' },
    isUpdateAvailable: false,
  };
  checkError: Error | null = null;
  readonly listeners = new Map<string, Set<(payload: never) => void>>();

  setFeedURL(options: { provider: 'generic'; url: string }): void {
    this.calls.push(`feed:${options.provider}:${options.url}`);
  }

  async checkForUpdates(): Promise<AppUpdateCheckResult | null> {
    this.calls.push(
      `check:autoDownload=${this.autoDownload}:autoInstall=${this.autoInstallOnAppQuit}:downgrade=${this.allowDowngrade}`,
    );
    if (this.checkError) throw this.checkError;
    return this.checkResult;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.calls.push(`quit:${String(isSilent)}:${String(isForceRunAfter)}`);
  }

  on(event: 'download-progress' | 'update-downloaded' | 'error', listener: (payload: never) => void): void {
    this.calls.push(`on:${event}`);
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: 'download-progress' | 'update-downloaded' | 'error', listener: (payload: never) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: 'download-progress' | 'update-downloaded' | 'error', payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload as never);
  }
}

function statusFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'app-update-')), 'status.jsonl');
}

function readStatus(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

async function startWith(
  updater: FakeUpdater,
  options: {
    feedUrl?: string;
    packaged?: boolean;
    currentVersion?: string;
    env?: NodeJS.ProcessEnv;
    status?: string;
  } = {},
): Promise<AppUpdateController> {
  const controller = new AppUpdateController({
    feedUrl: options.feedUrl,
    packaged: options.packaged ?? true,
    currentVersion: options.currentVersion ?? '1.0.0',
    env: options.env ?? {},
    updater,
    statusFile: options.status,
  });
  await controller.start();
  return controller;
}

describe('AppUpdateController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing without a feed or when unpackaged', async () => {
    const unpackaged = new FakeUpdater();
    const noFeed = new FakeUpdater();
    const file = statusFile();
    await startWith(unpackaged, { feedUrl: 'https://example.test/latest', packaged: false, status: file });
    await startWith(noFeed, { feedUrl: '   ', packaged: true });
    expect(unpackaged.calls).toEqual([]);
    expect(noFeed.calls).toEqual([]);
    expect(readStatus(file)).toEqual([{ phase: 'disabled' }]);
  });

  it('lets DEEPPATH_UPDATE_FEED_URL override the product feed and DEEPPATH_APP_UPDATE=1 enable unpackaged checks', async () => {
    const updater = new FakeUpdater();
    await startWith(updater, {
      feedUrl: 'https://example.test/latest',
      packaged: false,
      env: {
        DEEPPATH_APP_UPDATE: '1',
        DEEPPATH_UPDATE_FEED_URL: ' http://127.0.0.1:9/latest ',
      },
    });
    expect(updater.calls[0]).toBe('feed:generic:http://127.0.0.1:9/latest');
  });

  it('configures the generic feed before the first check', async () => {
    const updater = new FakeUpdater();
    await startWith(updater, { feedUrl: 'https://example.test/latest' });
    const checkAt = updater.calls.findIndex(call => call.startsWith('check:'));
    expect(updater.calls.slice(0, checkAt)).toEqual([
      'feed:generic:https://example.test/latest',
      'on:download-progress',
      'on:update-downloaded',
      'on:error',
    ]);
    expect(updater.calls[checkAt]).toBe('check:autoDownload=true:autoInstall=true:downgrade=false');
  });

  it('ignores an available flag when the feed version is older, equal, or not offered', async () => {
    const olderUpdater = new FakeUpdater();
    olderUpdater.checkResult = { updateInfo: { version: '0.9.0' }, isUpdateAvailable: true };
    const older = await startWith(olderUpdater, { feedUrl: 'https://example.test/latest', currentVersion: '1.0.0' });
    expect(older.state).toEqual({ phase: 'idle' });

    const sameUpdater = new FakeUpdater();
    sameUpdater.checkResult = { updateInfo: { version: '1.0.0' }, isUpdateAvailable: true };
    const same = await startWith(sameUpdater, { feedUrl: 'https://example.test/latest', currentVersion: '1.0.0' });
    expect(same.state).toEqual({ phase: 'idle' });

    const unavailable = new FakeUpdater();
    unavailable.checkResult = { updateInfo: { version: '9.0.0' }, isUpdateAvailable: false };
    const idle = await startWith(unavailable, { feedUrl: 'https://example.test/latest', currentVersion: '1.0.0' });
    expect(idle.state).toEqual({ phase: 'idle' });
  });

  it('reports an invalid feed version and a failed check without throwing', async () => {
    const invalid = new FakeUpdater();
    invalid.checkResult = { updateInfo: { version: 'not-a-version' }, isUpdateAvailable: true };
    const invalidController = await startWith(invalid, { feedUrl: 'https://example.test/latest' });
    expect(invalidController.state).toEqual({ phase: 'error', message: 'app update: feed version is invalid' });

    const missing = new FakeUpdater();
    missing.checkResult = null;
    const missingController = await startWith(missing, { feedUrl: 'https://example.test/latest' });
    expect(missingController.state).toEqual({ phase: 'error', message: 'app update: no check result' });

    const failed = new FakeUpdater();
    failed.checkError = new Error('feed unreachable');
    const failedController = await startWith(failed, { feedUrl: 'https://example.test/latest' });
    expect(failedController.state).toEqual({ phase: 'error', message: 'feed unreachable' });
  });

  it('downloads a newer version, clamps progress, then becomes ready', async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { updateInfo: { version: '1.2.0' }, isUpdateAvailable: true };
    const percents: number[] = [];
    const file = statusFile();
    const controller = new AppUpdateController({
      feedUrl: 'https://example.test/latest',
      packaged: true,
      currentVersion: '1.0.0',
      env: {},
      updater,
      statusFile: file,
      onState: state => {
        if (state.phase === 'downloading') percents.push(state.percent ?? -1);
      },
    });
    await controller.start();
    expect(controller.state).toEqual({ phase: 'downloading', version: '1.2.0', percent: 0 });

    updater.emit('download-progress', { percent: 40 });
    updater.emit('download-progress', { percent: 140 });
    updater.emit('download-progress', { percent: -5 });
    expect(percents).toEqual([0, 40, 100, 0]);

    updater.emit('update-downloaded', { version: '0.1.0' });
    expect(controller.state.phase).toBe('downloading');
    updater.emit('update-downloaded', { version: '1.2.0' });
    expect(controller.state).toEqual({ phase: 'ready', version: '1.2.0' });
    expect(readStatus(file).at(-1)).toEqual({ phase: 'ready', version: '1.2.0' });
  });

  it('keeps a download that finishes during the check', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = async () => {
      updater.calls.push('check:during');
      updater.emit('download-progress', { percent: 80 });
      updater.emit('update-downloaded', { version: '2.0.0' });
      return { updateInfo: { version: '2.0.0' }, isUpdateAvailable: true };
    };
    const controller = await startWith(updater, { feedUrl: 'https://example.test/latest', currentVersion: '1.0.0' });
    expect(controller.state).toEqual({ phase: 'ready', version: '2.0.0' });
  });

  it('does not start another check while downloading or ready, and retries after an error', async () => {
    const updater = new FakeUpdater();
    let release: (result: AppUpdateCheckResult) => void = () => {};
    updater.checkForUpdates = () =>
      new Promise(resolve => {
        updater.calls.push('check');
        release = resolve;
      });
    const controller = new AppUpdateController({
      feedUrl: 'https://example.test/latest',
      packaged: true,
      currentVersion: '1.0.0',
      env: {},
      updater,
    });
    const first = controller.start();
    const joined = controller.checkNow();
    release({ updateInfo: { version: '1.4.0' }, isUpdateAvailable: true });
    await first;
    await joined;
    expect(updater.calls.filter(call => call === 'check')).toHaveLength(1);
    expect(controller.state.phase).toBe('downloading');

    await controller.checkNow();
    expect(updater.calls.filter(call => call === 'check')).toHaveLength(1);

    updater.emit('update-downloaded', { version: '1.4.0' });
    await controller.checkNow();
    expect(updater.calls.filter(call => call === 'check')).toHaveLength(1);

    updater.emit('error', new Error('disk full'));
    expect(controller.state).toEqual({ phase: 'error', version: '1.4.0', message: 'disk full' });
    updater.checkForUpdates = async () => {
      updater.calls.push('check');
      return { updateInfo: { version: '1.0.0' }, isUpdateAvailable: false };
    };
    await controller.checkNow();
    expect(updater.calls.filter(call => call === 'check')).toHaveLength(2);
    expect(controller.state).toEqual({ phase: 'idle' });
  });

  it('installs only a ready update', async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { updateInfo: { version: '1.2.0' }, isUpdateAvailable: true };
    const controller = await startWith(updater, { feedUrl: 'https://example.test/latest', currentVersion: '1.0.0' });
    controller.installNow();
    expect(updater.calls.some(call => call.startsWith('quit:'))).toBe(false);

    updater.emit('update-downloaded', { version: '1.2.0' });
    expect(controller.installNow()).toEqual({ phase: 'installing', version: '1.2.0' });
    expect(updater.calls.at(-1)).toBe('quit:false:true');

    const again = new FakeUpdater();
    again.checkResult = { updateInfo: { version: '1.2.0' }, isUpdateAvailable: true };
    const second = await startWith(again, { feedUrl: 'https://example.test/latest', currentVersion: '1.0.0' });
    again.emit('update-downloaded', { version: '1.2.0' });
    again.quitAndInstall = () => {
      throw new Error('shipit failed');
    };
    expect(second.installNow()).toEqual({ phase: 'error', version: '1.2.0', message: 'shipit failed' });
  });

  it('stops publishing after dispose and checks again on the interval', async () => {
    const updater = new FakeUpdater();
    const seen: string[] = [];
    const controller = new AppUpdateController({
      feedUrl: 'https://example.test/latest',
      packaged: true,
      currentVersion: '1.0.0',
      env: {},
      updater,
      onState: state => seen.push(state.phase),
    });
    const interval = vi.spyOn(global, 'setInterval');
    await controller.start();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), APP_UPDATE_CHECK_INTERVAL_MS);

    controller.dispose();
    updater.emit('download-progress', { percent: 10 });
    expect(seen).toEqual(['checking', 'idle']);
    expect(updater.listeners.get('download-progress')?.size ?? 0).toBe(0);
  });

  it('does not schedule a check when updates are disabled', async () => {
    const interval = vi.spyOn(global, 'setInterval');
    await startWith(new FakeUpdater(), { packaged: false, feedUrl: 'https://example.test/latest' });
    expect(interval).not.toHaveBeenCalled();
  });
});

describe('app release snapshot', () => {
  it('maps the installed version and the updater phase for the sidebar', () => {
    expect(toAppReleaseSnapshot('0.2.2', { phase: 'disabled' })).toEqual({
      version: '0.2.2',
      enabled: false,
      phase: 'disabled',
    });
    expect(
      toAppReleaseSnapshot('0.2.2', { phase: 'downloading', version: '0.3.0', percent: 40 }),
    ).toEqual({
      version: '0.2.2',
      enabled: true,
      phase: 'downloading',
      availableVersion: '0.3.0',
      percent: 40,
    });
    expect(toAppReleaseSnapshot('0.2.2', { phase: 'error', message: 'offline' })).toEqual({
      version: '0.2.2',
      enabled: true,
      phase: 'error',
      message: 'offline',
    });
  });
});

describe('app update menu', () => {
  it('installs a ready update, checks otherwise, and hides the action when disabled', () => {
    expect(appUpdateMenuAction({ phase: 'disabled' })).toBe('none');
    expect(appUpdateMenuAction({ phase: 'idle' })).toBe('check');
    expect(appUpdateMenuAction({ phase: 'error', message: 'x' })).toBe('check');
    expect(appUpdateMenuAction({ phase: 'downloading', version: '1.2.0', percent: 1 })).toBe('check');
    expect(appUpdateMenuAction({ phase: 'ready', version: '1.2.0' })).toBe('install');
    expect(appUpdateMenuAction({ phase: 'installing', version: '1.2.0' })).toBe('install');
    expect(shouldNotifyUpdateReady('downloading', { phase: 'ready', version: '1.2.0' })).toBe(true);
    expect(shouldNotifyUpdateReady('ready', { phase: 'ready', version: '1.2.0' })).toBe(false);
    expect(shouldNotifyUpdateReady('checking', { phase: 'ready' })).toBe(false);
  });
});
