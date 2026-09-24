/**
 * BS 宿主没有 Electron `dialog.showOpenDialog`（`ELECTRON_RUN_AS_NODE=1`）。
 * 本模块用各平台系统选择器弹出「选文件夹」，返回与 preload
 * `local.selectDirectory` 相同的 `{ canceled, filePaths }`。
 *
 * 取消、无 DISPLAY、命令不存在都记为 canceled，让 UI 走手动输入路径。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NativeFolderDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface NativeFolderDialogOptions {
  title?: string;
}

export interface NativeFolderDialogDeps {
  platform?: NodeJS.Platform;
  run?: (cmd: string, args: readonly string[]) => Promise<{ stdout: string }>;
}

function sanitizePrompt(title: string | undefined): string {
  const raw = (title ?? '选择文件夹').replace(/[\r\n]+/g, ' ').slice(0, 80);
  return raw.replace(/["\\]/g, '');
}

function picked(stdout: string): NativeFolderDialogResult {
  const folder = stdout.trim().replace(/[/\\]+$/, '');
  return folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] };
}

export async function selectNativeDirectory(
  options: NativeFolderDialogOptions = {},
  deps: NativeFolderDialogDeps = {},
): Promise<NativeFolderDialogResult> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? ((cmd, args) => execFileAsync(cmd, [...args]));
  const title = sanitizePrompt(options.title);
  try {
    if (platform === 'darwin') {
      const { stdout } = await run('osascript', [
        '-e',
        `POSIX path of (choose folder with prompt "${title}")`,
      ]);
      return picked(stdout);
    }
    if (platform === 'win32') {
      const escaped = title.replace(/'/g, "''");
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        `$d.Description = '${escaped}'`,
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
      ].join('; ');
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script]);
      return picked(stdout);
    }
    try {
      const { stdout } = await run('zenity', [
        '--file-selection',
        '--directory',
        `--title=${title}`,
      ]);
      return picked(stdout);
    } catch {
      const { stdout } = await run('kdialog', [
        '--getexistingdirectory',
        process.env.HOME || '/',
        title,
      ]);
      return picked(stdout);
    }
  } catch {
    return { canceled: true, filePaths: [] };
  }
}
