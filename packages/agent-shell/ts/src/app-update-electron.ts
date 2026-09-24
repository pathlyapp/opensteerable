/**
 * electron-updater 适配。只在桌面主进程启用更新时加载。
 */

import log from 'electron-log';
import electronUpdater from 'electron-updater';
import type { AppUpdateCheckResult, AppUpdaterPort } from './app-update.js';

export function createElectronAppUpdater(): AppUpdaterPort {
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = log;
  return {
    get autoDownload() {
      return autoUpdater.autoDownload;
    },
    set autoDownload(value: boolean) {
      autoUpdater.autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return autoUpdater.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(value: boolean) {
      autoUpdater.autoInstallOnAppQuit = value;
    },
    get allowDowngrade() {
      return autoUpdater.allowDowngrade;
    },
    set allowDowngrade(value: boolean) {
      autoUpdater.allowDowngrade = value;
    },
    setFeedURL(options) {
      autoUpdater.setFeedURL(options);
    },
    async checkForUpdates(): Promise<AppUpdateCheckResult | null> {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return null;
      return {
        updateInfo: { version: result.updateInfo.version },
        isUpdateAvailable: result.isUpdateAvailable,
      };
    },
    quitAndInstall(isSilent, isForceRunAfter) {
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
    },
    on(event, listener) {
      if (event === 'download-progress') {
        autoUpdater.on('download-progress', listener as (progress: { percent: number }) => void);
      } else if (event === 'update-downloaded') {
        autoUpdater.on('update-downloaded', listener as (info: { version: string }) => void);
      } else {
        autoUpdater.on('error', listener as (error: Error) => void);
      }
    },
    off(event, listener) {
      if (event === 'download-progress') {
        autoUpdater.off('download-progress', listener as (progress: { percent: number }) => void);
      } else if (event === 'update-downloaded') {
        autoUpdater.off('update-downloaded', listener as (info: { version: string }) => void);
      } else {
        autoUpdater.off('error', listener as (error: Error) => void);
      }
    },
  };
}
