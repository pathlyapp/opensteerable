/**
 * 项目默认家目录：`Documents/<应用名>/<项目名>/`。
 *
 * 新建项目不再等于「选一个已有文件夹」——项目是带名字的容器，
 * 家目录由本模块分配并创建。用户另加的源文件夹是附加只读根，
 * 不替代这个家目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getBrand } from './brand.js';
import { getDocumentsDir } from './runtime.js';

const UNSAFE_DIR_CHARS = /[\\/:*?"<>|]/g;

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
