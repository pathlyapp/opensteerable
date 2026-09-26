import type { AppReleasePhase, AppReleaseSnapshot } from './electron-bridge';

export interface AppReleaseView {
  version: string | null;
  actionLabel: string | null;
  actionTitle?: string;
  clickable: boolean;
  /** 已下载、可以重启安装。 */
  emphasize: boolean;
}

export function sidebarUpdateClickable(phase: AppReleasePhase): boolean {
  return phase === 'idle' || phase === 'error' || phase === 'ready';
}

export function sidebarUpdateLabel(
  snap: AppReleaseSnapshot,
  confirmedCurrent: boolean,
): string | null {
  if (!snap.enabled || snap.phase === 'disabled') return null;
  switch (snap.phase) {
    case 'checking':
      return '检查中';
    case 'downloading':
      return typeof snap.percent === 'number' ? `下载 ${Math.round(snap.percent)}%` : '下载中';
    case 'ready':
      return snap.availableVersion ? `升级 ${snap.availableVersion}` : '升级';
    case 'installing':
      return '正在安装';
    case 'error':
      return '重试';
    case 'idle':
      if (snap.availableVersion) return `发现 ${snap.availableVersion}`;
      if (snap.message) return snap.message;
      return confirmedCurrent ? '已是最新' : '检查更新';
    default:
      return '检查更新';
  }
}

export function sidebarUpdateTitle(snap: AppReleaseSnapshot): string | undefined {
  if (snap.phase === 'error' || (snap.phase === 'idle' && snap.availableVersion)) {
    return snap.message;
  }
  if (snap.phase === 'ready' && snap.availableVersion) {
    return `重启并安装 ${snap.availableVersion}`;
  }
  if (snap.phase === 'downloading') return '正在下载更新';
  return undefined;
}

export function sidebarReleaseView(
  snap: AppReleaseSnapshot | null,
  confirmedCurrent: boolean,
): AppReleaseView {
  if (!snap?.version) {
    return { version: null, actionLabel: null, clickable: false, emphasize: false };
  }
  return {
    version: snap.version,
    actionLabel: sidebarUpdateLabel(snap, confirmedCurrent),
    actionTitle: sidebarUpdateTitle(snap),
    clickable: snap.enabled && sidebarUpdateClickable(snap.phase),
    emphasize: snap.phase === 'ready',
  };
}
