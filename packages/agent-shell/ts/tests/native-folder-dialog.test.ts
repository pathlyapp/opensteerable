/**
 * 系统文件夹选择器：按平台拼命令；取消 / 命令失败都记 canceled。
 */
import { describe, expect, it, vi } from 'vitest';
import { selectNativeDirectory } from '../src/native-folder-dialog.js';

describe('selectNativeDirectory', () => {
  it('darwin：osascript choose folder，去掉尾部斜杠', async () => {
    const run = vi.fn(async () => ({ stdout: '/tmp/picked/\n' }));
    await expect(
      selectNativeDirectory({ title: '添加源文件夹' }, { platform: 'darwin', run }),
    ).resolves.toEqual({ canceled: false, filePaths: ['/tmp/picked'] });
    expect(run).toHaveBeenCalledWith('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "添加源文件夹")',
    ]);
  });

  it('prompt 去掉引号与换行，避免注入 osascript 字符串', async () => {
    const run = vi.fn(async () => ({ stdout: '/tmp/x' }));
    await selectNativeDirectory(
      { title: 'say "hi"\nnext' },
      { platform: 'darwin', run },
    );
    expect(run.mock.calls[0][1][1]).toBe(
      'POSIX path of (choose folder with prompt "say hi next")',
    );
  });

  it('win32：走 powershell FolderBrowserDialog', async () => {
    const run = vi.fn(async () => ({ stdout: 'C:\\Users\\me\\src' }));
    await expect(
      selectNativeDirectory({ title: "O'Brien" }, { platform: 'win32', run }),
    ).resolves.toEqual({ canceled: false, filePaths: ['C:\\Users\\me\\src'] });
    expect(run.mock.calls[0][0]).toBe('powershell.exe');
    expect(run.mock.calls[0][1].join(' ')).toContain("O''Brien");
  });

  it('linux：zenity 失败则回落 kdialog', async () => {
    const run = vi.fn(async (cmd: string) => {
      if (cmd === 'zenity') throw new Error('not found');
      return { stdout: '/home/me/src' };
    });
    await expect(
      selectNativeDirectory({ title: '选目录' }, { platform: 'linux', run }),
    ).resolves.toEqual({ canceled: false, filePaths: ['/home/me/src'] });
    expect(run).toHaveBeenNthCalledWith(1, 'zenity', [
      '--file-selection',
      '--directory',
      '--title=选目录',
    ]);
    expect(run.mock.calls[1][0]).toBe('kdialog');
  });

  it('用户取消或命令失败 → canceled', async () => {
    const run = vi.fn(async () => {
      throw new Error('User canceled.');
    });
    await expect(
      selectNativeDirectory({}, { platform: 'darwin', run }),
    ).resolves.toEqual({ canceled: true, filePaths: [] });
  });

  it('空输出视为取消', async () => {
    const run = vi.fn(async () => ({ stdout: '  \n' }));
    await expect(
      selectNativeDirectory({}, { platform: 'darwin', run }),
    ).resolves.toEqual({ canceled: true, filePaths: [] });
  });
});
