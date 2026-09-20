/**
 * 项目默认家目录：Documents/<应用名>/<项目名>/，重名追加 -2。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  allocateProjectHome,
  appProjectsRoot,
  sanitizeProjectDirName,
} from '../src/project-home.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
