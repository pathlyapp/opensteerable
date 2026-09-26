import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { h, makeToolRouter, resetRouterTestkit } from './router-testkit.js';
import { LocalBackendRouter } from '../../src/local-backend/router.js';
import { setProductConfig } from '../../src/product-config.js';
import { ProjectRegistry, type ProjectRecord } from '../../src/project-registry.js';
import type { ScopedStore } from '../../src/storage/scoped-store.js';
import type { ToolRouter } from '../../src/tool-router.js';

function memoryProjects(): ProjectRegistry {
  let rows: ProjectRecord[] | undefined;
  return new ProjectRegistry({
    get: () => rows,
    set: (_key, value) => {
      rows = value;
    },
  });
}

function makeRouter(projects?: ProjectRegistry): LocalBackendRouter {
  return new LocalBackendRouter(
    makeToolRouter(projects ? { projectRegistry: projects } : {}) as unknown as ToolRouter,
    { store: h.store as unknown as ScopedStore },
  );
}

beforeEach(() => {
  resetRouterTestkit();
});

describe('portable routes', () => {
  it('产品没打开时接口不存在', async () => {
    const router = makeRouter();
    const res = await router.handle({ method: 'GET', path: '/api/v2/portable/config' });
    expect(res.status).toBe(404);
  });

  it('导出配置默认去掉模型钥匙', async () => {
    setProductConfig({ portable: true });
    await h.store.setLlmSettings({
      provider: 'openai-compat',
      vendorId: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret',
    });
    const router = makeRouter();
    const res = await router.handle({ method: 'GET', path: '/api/v2/portable/config' });
    expect(res.status).toBe(200);
    const data = res.data as {
      includeSecrets: boolean;
      sections: { llm: { apiKey?: string; apiKeyIncluded: boolean; model: string } };
    };
    expect(data.includeSecrets).toBe(false);
    expect(data.sections.llm.model).toBe('deepseek-chat');
    expect(data.sections.llm.apiKeyIncluded).toBe(false);
    expect(data.sections.llm.apiKey).toBeUndefined();
  });

  it('导入配置不带钥匙时保留本机已有钥匙', async () => {
    setProductConfig({ portable: true });
    await h.store.setLlmSettings({
      provider: 'openai-compat',
      model: 'old-model',
      apiKey: 'sk-keep',
    });
    const router = makeRouter();
    const res = await router.handle({
      method: 'POST',
      path: '/api/v2/portable/config',
      body: {
        sections: ['llm'],
        document: {
          kind: 'steerable-config',
          schemaVersion: 1,
          exportedAt: '2026-01-01T00:00:00.000Z',
          includeSecrets: false,
          sections: {
            llm: {
              provider: 'openai-compat',
              vendorId: 'deepseek',
              model: 'deepseek-chat',
              baseUrl: 'https://api.deepseek.com',
              apiKeyIncluded: false,
            },
          },
        },
      },
    });
    expect(res.status).toBe(200);
    const saved = await h.store.getLlmSettings();
    expect(saved?.model).toBe('deepseek-chat');
    expect(saved?.apiKey).toBe('sk-keep');
  });

  it('导入对话生成新会话并保留思考 metadata', async () => {
    setProductConfig({ portable: true });
    const router = makeRouter();
    const res = await router.handle({
      method: 'POST',
      path: '/api/v2/portable/chats',
      body: {
        document: {
          kind: 'steerable-chat',
          schemaVersion: 1,
          exportedAt: '2026-01-01T00:00:00.000Z',
          chat: {
            title: '搬过来的',
            agentId: null,
            isPinned: true,
            systemPrompt: null,
            pinnedRefs: null,
          },
          messages: [
            { role: 'user', content: '你好', messageMetadata: null, createdAt: '2026-01-01T00:00:00.000Z' },
            {
              role: 'assistant',
              content: '在',
              messageMetadata: '{"reasoning":"想一下"}',
              createdAt: '2026-01-01T00:00:01.000Z',
            },
          ],
          truncated: false,
          attachments: [],
        },
      },
    });
    expect(res.status).toBe(200);
    const chatId = (res.data as { chatId: string }).chatId;
    const chat = await h.store.getChat(chatId);
    expect(chat?.title).toBe('搬过来的');
    expect(chat?.isPinned).toBe(true);
    const messages = await h.store.listMessages(chatId, 10);
    expect(messages.map((message) => message.content).sort()).toEqual(['你好', '在']);
    expect(messages.find((message) => message.role === 'assistant')?.messageMetadata).toContain('想一下');
  });

  it('一次导入多条对话，每条都是新会话', async () => {
    setProductConfig({ portable: true });
    const router = makeRouter();
    const chat = (title: string, content: string) => ({
      kind: 'steerable-chat',
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      chat: { title, agentId: null, isPinned: false, systemPrompt: null, pinnedRefs: null },
      messages: [{ role: 'user', content, messageMetadata: null, createdAt: '2026-01-01T00:00:00.000Z' }],
      truncated: false,
      attachments: [],
    });
    const res = await router.handle({
      method: 'POST',
      path: '/api/v2/portable/chats',
      body: {
        document: {
          kind: 'steerable-chats',
          schemaVersion: 1,
          exportedAt: '2026-01-01T00:00:00.000Z',
          chats: [chat('第一段', '甲'), chat('第二段', '乙')],
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ title: '2 条对话', messageCount: 2, chatCount: 2 });
    const firstId = (res.data as { chatId: string }).chatId;
    const second = await h.store.listChats(1, 10);
    const titles = second.chats.map((item) => item.title).sort();
    expect(titles).toEqual(['第一段', '第二段']);
    expect(await h.store.getChat(firstId)).toBeTruthy();
  });

  it('导出对话带上所属项目，不带目录里的文件', async () => {
    setProductConfig({ portable: true });
    const home = await mkdtemp(path.join(tmpdir(), 'portable-proj-'));
    const marker = 'do-not-pack-this-file';
    try {
      await writeFile(path.join(home, 'notes.txt'), marker);
      const registry = memoryProjects();
      const project = registry.create({
        name: '客户A',
        folderPath: home,
        sourceFolders: ['/tmp/source-a'],
      });
      registry.setTrusted(project.id, true);
      await h.store.createChatWithId('chat-proj', '周报', 'agent-1', project.id);
      await h.store.addMessage('chat-proj', 'user', '你好');

      const exported = await makeRouter(registry).handle({
        method: 'GET',
        path: '/api/v2/chats/chat-proj/portable',
      });
      expect(exported.status).toBe(200);
      expect(exported.data).toMatchObject({
        project: {
          name: '客户A',
          folderPath: home,
          sourceFolders: ['/tmp/source-a'],
          trusted: true,
        },
      });
      expect(JSON.stringify(exported.data)).not.toContain(marker);

      const restored = path.join(home, 'restored-empty');
      const doc = exported.data as { project: { folderPath: string } };
      doc.project.folderPath = restored;
      const fresh = memoryProjects();
      const imported = await makeRouter(fresh).handle({
        method: 'POST',
        path: '/api/v2/portable/chats',
        body: { document: exported.data },
      });
      expect(imported.status).toBe(200);
      const created = fresh.get('客户A');
      expect(created?.folderPath).toBe(restored);
      expect(created?.trusted).toBe(true);
      expect(created?.sourceFolders).toEqual(['/tmp/source-a']);
      const chatId = (imported.data as { chatId: string }).chatId;
      expect((await h.store.getChat(chatId))?.projectId).toBe(created?.id);

      const again = memoryProjects();
      const kept = again.create({ name: '客户A', folderPath: home });
      const reused = await makeRouter(again).handle({
        method: 'POST',
        path: '/api/v2/portable/chats',
        body: { document: exported.data },
      });
      expect(reused.status).toBe(200);
      const reusedId = (reused.data as { chatId: string }).chatId;
      expect((await h.store.getChat(reusedId))?.projectId).toBe(kept.id);
      expect(again.get('客户A')?.folderPath).toBe(home);
      expect(again.list()).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
