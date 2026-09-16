/**
 * attachments：会话附件的 renderer 侧助手。
 * 锁定：图像扩展名判定（大小写不敏感、无扩展名不算）、File→base64 的
 * 分块编码（跨块边界与空文件）、saveChatAttachments 的降级阶梯——
 * 无 chatId / 无桥 / 桥无 attachments 能力时原样返回；逐文件失败只退回
 * 该文件，整体失败退回整批（用户的选择不丢）。
 * 桥走真实的 window.electron 路径，不 mock 模块。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fileToBase64,
  isImageFile,
  saveChatAttachments,
  type AttachmentFile,
} from './attachments';

afterEach(() => {
  delete (window as { electron?: unknown }).electron;
  vi.restoreAllMocks();
});

function installBridge(save?: unknown) {
  (window as { electron?: unknown }).electron = {
    localBackend: { request: vi.fn() },
    ...(save ? { attachments: { save } } : {}),
  };
}

describe('isImageFile', () => {
  it('常见图像扩展名命中，大小写不敏感', () => {
    for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp']) {
      expect(isImageFile(p)).toBe(true);
    }
  });

  it('非图像与无扩展名不命中', () => {
    for (const p of ['a.txt', 'archive.tar.gz', 'noext', 'dot.']) {
      expect(isImageFile(p)).toBe(false);
    }
  });
});

describe('fileToBase64', () => {
  it('小文件逐字节编码', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 255])], 'x.bin');
    expect(await fileToBase64(file)).toBe('AQID/w==');
  });

  it('空文件编码为空串', async () => {
    expect(await fileToBase64(new File([], 'empty'))).toBe('');
  });

  it('跨 0x8000 分块边界的编码与一次性编码一致', async () => {
    const bytes = new Uint8Array(0x8000 + 100).fill(0x61);
    const file = new File([bytes], 'big.bin');
    const expected = Buffer.from(bytes).toString('base64');
    expect(await fileToBase64(file)).toBe(expected);
  });
});

describe('saveChatAttachments 降级阶梯', () => {
  const files: AttachmentFile[] = [{ name: 'a.txt', path: '/src/a.txt' }];

  it('无 chatId / 空列表时原样返回（同一引用）', async () => {
    expect(await saveChatAttachments(null, files)).toBe(files);
    expect(await saveChatAttachments('', files)).toBe(files);
    expect(await saveChatAttachments('chat-1', [])).toEqual([]);
  });

  it('无桥或桥无 attachments 能力时原样返回', async () => {
    expect(await saveChatAttachments('chat-1', files)).toBe(files);
    installBridge();
    expect(await saveChatAttachments('chat-1', files)).toBe(files);
  });

  it('有路径走 path 拷贝，无路径读字节走 data 上传', async () => {
    const save = vi.fn().mockResolvedValue({
      files: [
        { name: 'a.txt', path: '/stored/a.txt', size: 3 },
        { name: 'b.txt', path: '/stored/b.txt', size: 2 },
      ],
    });
    installBridge(save);
    const input: AttachmentFile[] = [
      { name: 'a.txt', path: '/src/a.txt' },
      { name: 'b.txt', path: '', file: new File([new Uint8Array([72, 105])], 'b.txt') },
    ];
    const result = await saveChatAttachments('chat-1', input);
    expect(save).toHaveBeenCalledWith({
      chatId: 'chat-1',
      files: [
        { name: 'a.txt', path: '/src/a.txt' },
        { name: 'b.txt', data: 'SGk=' },
      ],
    });
    expect(result).toEqual([
      { name: 'a.txt', path: '/stored/a.txt' },
      { name: 'b.txt', path: '/stored/b.txt' },
    ]);
  });

  it('逐文件失败只退回该文件，其余仍用落盘路径', async () => {
    const save = vi.fn().mockResolvedValue({
      files: [
        { name: 'a.txt', path: '/stored/a.txt', size: 3 },
        { name: 'b.txt', path: '', error: 'too big' },
      ],
    });
    installBridge(save);
    const input: AttachmentFile[] = [
      { name: 'a.txt', path: '/src/a.txt' },
      { name: 'b.txt', path: '/src/b.txt' },
    ];
    const result = await saveChatAttachments('chat-1', input);
    expect(result[0]).toEqual({ name: 'a.txt', path: '/stored/a.txt' });
    expect(result[1]).toBe(input[1]);
  });

  it('整体保存失败时 warn 并退回整批原始文件', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    installBridge(save);
    const result = await saveChatAttachments('chat-1', files);
    expect(result).toBe(files);
    expect(warn).toHaveBeenCalledOnce();
  });
});
