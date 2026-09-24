/**
 * 项目默认家目录：`Documents/<应用名>/<项目名>/`。
 *
 * 新建项目不再等于「选一个已有文件夹」——项目是带名字的容器，
 * 家目录由本模块分配并创建。用户另加的源文件夹是附加只读根，
 * 不替代这个家目录。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBrand } from './brand.js';
import { getDocumentsDir } from './runtime.js';

const UNSAFE_DIR_CHARS = /[\\/:*?"<>|]/g;

/** 把 `~` / `~/…` 展开成绝对路径；其它输入原样（已 trim）。 */
export function expandUserPath(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function sanitizeProjectDirName(name: string): string {
  const trimmed = name
    .trim()
    .replace(UNSAFE_DIR_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '');
  return trimmed || '未命名项目';
}

/** `Documents/<应用显示名>`：该应用下所有托管项目的父目录。 */
export function appProjectsRoot(options?: {
  documentsDir?: string;
  appFolderName?: string;
}): string {
  const documents = options?.documentsDir ?? getDocumentsDir();
  const appName = options?.appFolderName ?? getBrand().displayName;
  return path.join(documents, sanitizeProjectDirName(appName));
}

/**
 * 为项目名分配尚未占用的家目录路径（不落盘）。
 * 已存在同名目录时追加 `-2`、`-3`…
 */
export function allocateProjectHome(
  projectName: string,
  options?: {
    documentsDir?: string;
    appFolderName?: string;
    exists?: (folderPath: string) => boolean;
  },
): string {
  const root = appProjectsRoot(options);
  const base = sanitizeProjectDirName(projectName);
  const exists = options?.exists ?? ((folderPath) => fs.existsSync(folderPath));
  let candidate = path.join(root, base);
  if (!exists(candidate)) return candidate;
  for (let i = 2; i < 1000; i += 1) {
    candidate = path.join(root, `${base}-${i}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error('无法分配项目目录：重名过多');
}

export function ensureProjectHome(folderPath: string): void {
  fs.mkdirSync(folderPath, { recursive: true });
}

/** 无项目对话的工作区子目录名（与托管项目家目录并列，避免撞名）。 */
export const CHAT_WORKSPACES_DIR = 'conversations';

/**
 * 无项目对话的工作区路径：`Documents/<应用名>/conversations/<chatId>/`。
 * 不落盘；调用方用 {@link ensureChatWorkspace} 创建。
 */
export function chatWorkspacePath(
  chatId: string,
  options?: {
    documentsDir?: string;
    appFolderName?: string;
  },
): string {
  const id = sanitizeProjectDirName(chatId);
  return path.join(appProjectsRoot(options), CHAT_WORKSPACES_DIR, id);
}

/** 确保无项目对话工作区存在，返回绝对路径。 */
export function ensureChatWorkspace(
  chatId: string,
  options?: {
    documentsDir?: string;
    appFolderName?: string;
  },
): string {
  const folderPath = chatWorkspacePath(chatId, options);
  ensureProjectHome(folderPath);
  return folderPath;
}
