/**
 * 桌面自动更新。产品经 `ProductConfig.updates.feedUrl` 注入 generic 通道；
 * 本模块只编排检查、下载和安装，具体传输交给 `AppUpdaterPort`
 * （生产环境是 electron-updater）。
 */

import { appendFileSync } from 'node:fs';
import { gt, valid } from 'semver';

export const APP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type AppUpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export interface AppUpdateState {
  phase: AppUpdatePhase;
  version?: string;
  percent?: number;
  message?: string;
}

export interface AppUpdateCheckResult {
  updateInfo: { version: string };
  isUpdateAvailable: boolean;
}

export interface AppUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<AppUpdateCheckResult | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): void;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  off(event: 'download-progress', listener: (progress: { percent: number }) => void): void;
  off(event: 'update-downloaded', listener: (info: { version: string }) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

export interface AppUpdateOptions {
  feedUrl?: string;
  packaged: boolean;
  currentVersion: string;
  env: NodeJS.ProcessEnv;
  updater: AppUpdaterPort;
  onState?: (state: AppUpdateState) => void;
  /** 测试注入。缺省写 `env.DEEPPATH_UPDATE_STATUS_FILE`。 */
  statusFile?: string;
}

export function appUpdateMenuAction(state: AppUpdateState): 'none' | 'check' | 'install' {
  if (state.phase === 'disabled') return 'none';
  if (state.phase === 'ready' || state.phase === 'installing') return 'install';
  return 'check';
}

export function shouldNotifyUpdateReady(previous: AppUpdatePhase, next: AppUpdateState): boolean {
  return previous !== 'ready' && next.phase === 'ready' && Boolean(next.version);
}

function resolveFeed(options: AppUpdateOptions): { enabled: false } | { enabled: true; feedUrl: string } {
  const override = options.env.DEEPPATH_UPDATE_FEED_URL?.trim() ?? '';
  const feedUrl = override || options.feedUrl?.trim() || '';
  const forceUnpackaged = options.env.DEEPPATH_APP_UPDATE === '1';
  if (!feedUrl || (!options.packaged && !forceUnpackaged)) return { enabled: false };
  return { enabled: true, feedUrl };
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export class AppUpdateController {
  private current: AppUpdateState = { phase: 'disabled' };
  private enabled = false;
  private started = false;
  private disposed = false;
  private bound = false;
  private candidate: string | undefined;
  private downloadedVersion: string | undefined;
  private checkPromise: Promise<AppUpdateState> | undefined;
  private cancelTimer: (() => void) | undefined;
  private readonly statusFile: string | undefined;

  constructor(private readonly options: AppUpdateOptions) {
    this.statusFile = options.statusFile ?? options.env.DEEPPATH_UPDATE_STATUS_FILE;
  }

  get state(): AppUpdateState {
    return this.current;
  }

  async start(): Promise<AppUpdateState> {
    if (this.started) return this.checkPromise ?? this.state;
    this.started = true;
    const target = resolveFeed(this.options);
    if (!target.enabled) return this.publish({ phase: 'disabled' });
    this.enabled = true;
    this.options.updater.autoDownload = true;
    this.options.updater.autoInstallOnAppQuit = true;
    this.options.updater.allowDowngrade = false;
    this.options.updater.setFeedURL({ provider: 'generic', url: target.feedUrl });
    this.bind();
    const first = this.checkNow();
    this.cancelTimer = defaultSchedule(() => {
      void this.checkNow();
    }, APP_UPDATE_CHECK_INTERVAL_MS);
    return first;
  }

  checkNow(): Promise<AppUpdateState> {
    if (this.disposed || !this.enabled) return Promise.resolve(this.state);
    if (this.state.phase === 'downloading' || this.state.phase === 'ready' || this.state.phase === 'installing') {
      return Promise.resolve(this.state);
    }
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.doCheck().finally(() => {
      this.checkPromise = undefined;
    });
    return this.checkPromise;
  }

  installNow(): AppUpdateState {
    if (this.disposed || this.state.phase !== 'ready' || !this.downloadedVersion) return this.state;
    const version = this.downloadedVersion;
    this.publish({ phase: 'installing', version });
    try {
      this.options.updater.quitAndInstall(false, true);
    } catch (error) {
      return this.publish({
        phase: 'error',
        version,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return this.state;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.bound) return;
    this.options.updater.off('download-progress', this.onProgress);
    this.options.updater.off('update-downloaded', this.onDownloaded);
    this.options.updater.off('error', this.onError);
    this.bound = false;
  }

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.options.updater.on('download-progress', this.onProgress);
    this.options.updater.on('update-downloaded', this.onDownloaded);
    this.options.updater.on('error', this.onError);
  }

  private readonly onProgress = (progress: { percent: number }): void => {
    if (this.downloadedVersion) return;
    this.publish({
      phase: 'downloading',
      ...(this.candidate ? { version: this.candidate } : {}),
      percent: clampPercent(progress.percent),
    });
  };

  private readonly onDownloaded = (info: { version: string }): void => {
    if (!this.isNewer(info.version)) return;
    this.downloadedVersion = info.version;
    this.candidate = info.version;
    this.publish({ phase: 'ready', version: info.version });
  };

  private readonly onError = (error: Error): void => {
    const version = this.candidate ?? this.state.version;
    this.publish({
      phase: 'error',
      ...(version ? { version } : {}),
      message: error instanceof Error ? error.message : String(error),
    });
  };

  private async doCheck(): Promise<AppUpdateState> {
    this.downloadedVersion = undefined;
    this.candidate = undefined;
    this.publish({ phase: 'checking' });
    try {
      const result = await this.options.updater.checkForUpdates();
      if (this.disposed) return this.state;
      if (this.downloadedVersion && this.isNewer(this.downloadedVersion)) {
        if (this.state.phase === 'ready' && this.state.version === this.downloadedVersion) return this.state;
        return this.publish({ phase: 'ready', version: this.downloadedVersion });
      }
      if (!result) return this.publish({ phase: 'error', message: 'app update: no check result' });
      const version = result.updateInfo.version;
      if (!result.isUpdateAvailable) return this.publish({ phase: 'idle' });
      if (valid(version) === null) {
        return this.publish({ phase: 'error', message: 'app update: feed version is invalid' });
      }
      if (!this.isNewer(version)) return this.publish({ phase: 'idle' });
      this.candidate = version;
      if (this.state.phase === 'downloading') {
        return this.publish({ phase: 'downloading', version, percent: this.state.percent ?? 0 });
      }
      return this.publish({ phase: 'downloading', version, percent: 0 });
    } catch (error) {
      if (this.disposed) return this.state;
      return this.publish({
        phase: 'error',
        ...(this.candidate ? { version: this.candidate } : {}),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private isNewer(version: string): boolean {
    return valid(version) !== null && valid(this.options.currentVersion) !== null && gt(version, this.options.currentVersion);
  }

  private publish(state: AppUpdateState): AppUpdateState {
    if (this.disposed) return this.current;
    this.current = state;
    if (this.statusFile) appendFileSync(this.statusFile, `${JSON.stringify(state)}\n`);
    this.options.onState?.(state);
    return state;
  }
}
