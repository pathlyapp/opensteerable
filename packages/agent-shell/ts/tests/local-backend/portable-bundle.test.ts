import { describe, expect, it } from 'vitest';

import {
  llmSectionFromSettings,
  previewPortable,
  rewriteAttachmentRefs,
} from '../../src/local-backend/portable-bundle.js';

describe('portable bundle', () => {
  it('默认不把模型钥匙写进配置段', () => {
    const section = llmSectionFromSettings(
      {
        provider: 'openai-compat',
        vendorId: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'sk-secret',
      },
      false,
    );
    expect(section.apiKeyIncluded).toBe(false);
    expect(section).not.toHaveProperty('apiKey');
    expect(section.model).toBe('deepseek-chat');
  });

  it('勾选包含钥匙时原样写入', () => {
    const section = llmSectionFromSettings({ apiKey: 'sk-secret', model: 'm' }, true);
    expect(section.apiKeyIncluded).toBe(true);
    expect(section.apiKey).toBe('sk-secret');
  });

  it('不认识的版本直接拒绝', () => {
    expect(previewPortable({ kind: 'steerable-config', schemaVersion: 2, sections: {} })).toEqual({
      error: '无法读取这份文件，需要更新客户端',
    });
  });

  it('把消息里的旧附件路径换成新会话路径', () => {
    const text = '看这个\n- `/data/attachments/chat-old/纪要.docx`';
    expect(rewriteAttachmentRefs(text, '纪要.docx', '/data/attachments/chat-new/纪要.docx')).toBe(
      '看这个\n- `/data/attachments/chat-new/纪要.docx`',
    );
  });

  it('对话预览统计消息和未打包的大附件', () => {
    const preview = previewPortable({
      kind: 'steerable-chat',
      schemaVersion: 1,
      chat: { title: '周报' },
      messages: [{ role: 'user', content: 'hi' }],
      attachments: [
        { name: 'a.txt', size: 3, data: 'YQ==' },
        { name: 'big.bin', size: 99, omitted: true },
      ],
      truncated: false,
    });
    expect(preview).toMatchObject({
      kind: 'steerable-chat',
      chat: {
        title: '周报',
        messageCount: 1,
        attachmentCount: 1,
        omittedAttachmentCount: 1,
      },
    });
  });

  it('对话预览记下项目名', () => {
    const preview = previewPortable({
      kind: 'steerable-chat',
      schemaVersion: 1,
      chat: { title: '周报' },
      project: {
        name: '客户A',
        folderPath: '/tmp/client-a',
        sourceFolders: ['/tmp/src'],
        trusted: false,
      },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(preview).toMatchObject({
      kind: 'steerable-chat',
      chat: { title: '周报', projectName: '客户A', projectCount: 1 },
    });
  });

  it('多条对话包汇总条数和消息数', () => {
    const preview = previewPortable({
      kind: 'steerable-chats',
      schemaVersion: 1,
      chats: [
        {
          kind: 'steerable-chat',
          schemaVersion: 1,
          chat: { title: '周报' },
          messages: [{ role: 'user', content: 'hi' }],
        },
        {
          kind: 'steerable-chat',
          schemaVersion: 1,
          chat: { title: '纪要' },
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
          ],
        },
      ],
    });
    expect(preview).toMatchObject({
      kind: 'steerable-chats',
      chat: { title: '2 条对话', messageCount: 3, count: 2 },
    });
  });
});
