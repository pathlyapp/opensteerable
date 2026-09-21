/**
 * 项目默认家目录：Documents/<应用名>/<项目名>/，重名追加 -2。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import {
  allocateProjectHome,
  appProjectsRoot,
  chatWorkspacePath,
  CHAT_WORKSPACES_DIR,
  ensureChatWorkspace,
  expandUserPath,
  sanitizeProjectDirName,
} from '../src/project-home.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('expandUserPath', () => {
  it('展开 ~ 与 ~/…，其它路径只 trim', () => {
    expect(expandUserPath('~')).toBe(os.homedir());
    expect(expandUserPath('~/src')).toBe(path.join(os.homedir(), 'src'));
    expect(expandUserPath('  /tmp/a  ')).toBe('/tmp/a');
  });
});

describe('sanitizeProjectDirName', () => {
  it('去掉路径分隔符与尾部点，空白名回落未命名', () => {
    expect(sanitizeProjectDirName('  a/b:c  ')).toBe('a-b-c');
    expect(sanitizeProjectDirName('foo.')).toBe('foo');
    expect(sanitizeProjectDirName('   ')).toBe('未命名项目');
  });
});

describe('allocateProjectHome', () => {
  it('落在 Documents/应用名/项目名，已存在则追加序号', () => {
    const documentsDir = mkdtempSync(path.join(tmpdir(), 'proj-home-'));
    temps.push(documentsDir);
    const first = allocateProjectHome('演示', {
      documentsDir,
      appFolderName: '测试助手',
    });
    expect(first).toBe(path.join(documentsDir, '测试助手', '演示'));
    mkdirSync(first, { recursive: true });
    const second = allocateProjectHome('演示', {
      documentsDir,
      appFolderName: '测试助手',
    });
    expect(second).toBe(path.join(documentsDir, '测试助手', '演示-2'));
  });

  it('appProjectsRoot 用应用显示名做父目录', () => {
    expect(appProjectsRoot({ documentsDir: '/tmp/docs', appFolderName: 'Steerable Shell' })).toBe(
      path.join('/tmp/docs', 'Steerable Shell'),
    );
  });
});

describe('ensureChatWorkspace', () => {
  it('落在 Documents/应用名/conversations/chatId 并创建目录', () => {
    const documentsDir = mkdtempSync(path.join(tmpdir(), 'chat-ws-'));
    temps.push(documentsDir);
    const folder = ensureChatWorkspace('chat-abc', {
      documentsDir,
      appFolderName: '测试助手',
    });
    expect(folder).toBe(
      path.join(documentsDir, '测试助手', CHAT_WORKSPACES_DIR, 'chat-abc'),
    );
    expect(folder).toBe(
      chatWorkspacePath('chat-abc', { documentsDir, appFolderName: '测试助手' }),
    );
    expect(existsSync(folder)).toBe(true);
  });
});
