/**
 * `@` 提及 → 子代理委派（W1）端到端：handleStream 下发 sidecar 的
 * subagent.profiles / 派发指令 / 父代理身份，并落库 mentionedAgentIds
 * 与助手 agentId。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  h,
  makeEmitCapture,
  makeToolRouter,
  resetRouterTestkit,
} from './router-testkit.js';
import { LocalBackendRouter } from '../../src/local-backend/router.js';
import type { ToolRouter } from '../../src/tool-router.js';
import { BUILTIN_SUBAGENT_PROFILES } from '../../src/local-backend/subagent-profiles.js';

function makeRouter(): LocalBackendRouter {
  return new LocalBackendRouter(
    makeToolRouter({
      schemas: [
        { name: 'local_read_file', description: '读文件', inputSchema: { type: 'object' }, mode: 'read' },
        { name: 'local_write_file', description: '写文件', inputSchema: { type: 'object' }, mode: 'write' },
        { name: 'local_exec_shell', description: '执行命令', inputSchema: { type: 'object' }, mode: 'read' },
        { name: 'web_search', description: '搜索', inputSchema: { type: 'object' }, mode: 'read' },
        { name: 'web_fetch', description: '抓取', inputSchema: { type: 'object' }, mode: 'read' },
      ],
    }) as unknown as ToolRouter,
    { store: h.store },
  );
}

function installStream(
  script?: (options: Record<string, any>) => void,
) {
  const seen: Array<Record<string, any>> = [];
  h.supervisor = { call: async () => ({}), cancelChat: async () => {} };
  h.streamImpl = async (options) => {
    seen.push(options);
    script?.(options);
    return { status: 'completed' };
  };
  return { seen };
}

beforeEach(() => {
  resetRouterTestkit();
});

afterEach(() => {
  delete process.env.STEERABLE_AUTO_CONTINUE;
  delete process.env.STEERABLE_APPROVAL;
});

async function seedBoundChat() {
  const parent = await h.store.createChatAgent({
    name: '电脑操作员',
    slug: 'local-assistant',
    rolePrompt: '你是电脑操作员，负责拆分任务并汇总。',
  });
  const chat = await h.store.createChat('新对话', parent.id, null);
  return { parent, chat };
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('handleStream / @提及委派', () => {
  it('单个提及：人设仍是父代理，提及进 subagent.profiles，并注入派发指令', async () => {
    const { parent, chat } = await seedBoundChat();
    const researcher = await h.store.createChatAgent({
      name: '调研员',
      slug: 'researcher',
      rolePrompt: '多轮联网调研，结论必须带来源 URL',
      toolPolicy: {
        mode: 'allowlist',
        tools: ['web_fetch', 'web_search', 'local_read_file'],
      },
    });
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        body: {
          message: '@调研员 查一下 PDF 金额提取方案',
          mentionedAgentId: researcher.id,
        },
      },
      makeEmitCapture().emit,
    );

    expect(seen).toHaveLength(1);
    const prompt = seen[0].systemPrompt as string;
    expect(prompt).toContain('【当前角色】电脑操作员');
    expect(prompt).toContain('你是电脑操作员');
    expect(prompt).not.toContain('【当前角色】调研员');

    const lastUser = seen[0].messages.at(-1);
    expect(lastUser.content).toContain('delegate_subagent');
    expect(lastUser.content).toContain('调研员');
    expect(lastUser.content).toContain('同一轮');
    expect(lastUser.content).toContain('有依赖');

    const subagent = seen[0].subagent as {
      profiles: Record<string, { description?: string; toolFilter?: string[]; concurrent?: boolean; maxRounds?: number; systemPrompt?: string }>;
      maxParallel?: number;
    };
    expect(subagent.profiles.explore).toEqual(BUILTIN_SUBAGENT_PROFILES.explore);
    expect(subagent.profiles.researcher.description).toContain('调研员');
    expect(subagent.profiles.researcher.toolFilter).toEqual([
      'local_read_file',
      'web_search',
      'web_fetch',
    ]);
    expect(subagent.profiles.researcher.concurrent).toBe(true);
    expect(subagent.profiles.researcher.maxRounds).toBeUndefined();
    expect(subagent.profiles.researcher.systemPrompt).toContain('调研员');
    expect(subagent.maxParallel).toBeUndefined();

    const stored = await h.store.listMessages(chat.id, 10);
    const user = stored.find((m) => m.role === 'user')!;
    const assistant = stored.find((m) => m.role === 'assistant')!;
    expect(parseMeta(user.messageMetadata).mentionedAgentIds).toEqual([researcher.id]);
    expect(parseMeta(assistant.messageMetadata).agentId).toBe(parent.id);

    const listed = await makeRouter().handle({
      method: 'GET',
      path: `/api/v2/chats/${chat.id}/messages`,
    });
    const messages = (listed.data as { messages: Array<{ role: string; agentId?: string }> }).messages;
    const listedAssistant = messages.find((m) => m.role === 'assistant');
    expect(listedAssistant?.agentId).toBe(parent.id);
  });

  it('多个提及：下发多画像，父身份不变', async () => {
    const { chat } = await seedBoundChat();
    const researcher = await h.store.createChatAgent({
      name: '调研员',
      slug: 'researcher',
      rolePrompt: '多轮联网调研',
      toolPolicy: { mode: 'allowlist', tools: ['web_search', 'web_fetch', 'local_read_file'] },
    });
    const engineer = await h.store.createChatAgent({
      name: '脚本工程师',
      slug: 'script-engineer',
      rolePrompt: '写脚本解题并自验',
      toolPolicy: { mode: 'all', tools: [] },
    });
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        body: {
          message: '@调研员 @脚本工程师 先调研再写脚本',
          mentionedAgentIds: [researcher.id, engineer.id],
        },
      },
      makeEmitCapture().emit,
    );

    const prompt = seen[0].systemPrompt as string;
    expect(prompt).toContain('【当前角色】电脑操作员');
    expect(prompt).not.toContain('同时具备以下');

    const lastUser = seen[0].messages.at(-1).content as string;
    expect(lastUser).toContain('调研员');
    expect(lastUser).toContain('脚本工程师');
    expect(lastUser).toContain('researcher');
    expect(lastUser).toContain('script-engineer');

    const profiles = seen[0].subagent.profiles as Record<string, { concurrent?: boolean; maxRounds?: number }>;
    expect(profiles.researcher.concurrent).toBe(true);
    expect(profiles['script-engineer'].concurrent).toBe(false);
    expect(profiles['script-engineer'].maxRounds).toBeUndefined();
  });

  it('手打的 @名字 不带 id 也能派发，并下发 requiredProfiles', async () => {
    const { chat } = await seedBoundChat();
    await h.store.createChatAgent({
      name: '智能助手',
      slug: 'helper',
      rolePrompt: '通用助理',
      toolPolicy: { mode: 'all', tools: [] },
    });
    await h.store.createChatAgent({
      name: '日程规划',
      slug: 'scheduler',
      rolePrompt: '排日程',
      toolPolicy: { mode: 'allowlist', tools: ['local_read_file'] },
    });
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        // 渲染层只在 `@` 菜单点选时带 mentionedAgentIds；手打没有。
        body: { message: '@电脑操作员 @智能助手 @日程规划 你们随便做点啥' },
      },
      makeEmitCapture().emit,
    );

    const lastUser = seen[0].messages.at(-1).content as string;
    expect(lastUser).toContain('delegate_subagent');
    expect(lastUser).toContain('智能助手');
    expect(lastUser).toContain('日程规划');

    const subagent = seen[0].subagent as {
      profiles: Record<string, unknown>;
      requiredProfiles?: string[];
    };
    expect(subagent.profiles.helper).toBeDefined();
    expect(subagent.profiles.scheduler).toBeDefined();
    // 父代理被点名 → 它自己的副本也是一个子代理。
    expect(subagent.profiles['local-assistant']).toBeDefined();
    expect(subagent.requiredProfiles).toEqual([
      'local-assistant',
      'helper',
      'scheduler',
    ]);

    const stored = await h.store.listMessages(chat.id, 10);
    const user = stored.find((m) => m.role === 'user')!;
    expect(parseMeta(user.messageMetadata).mentionedAgentIds).toHaveLength(3);
  });

  it('点名父代理自己：也起一份自己的副本，父身份不变', async () => {
    const { parent, chat } = await seedBoundChat();
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        body: {
          message: '@电脑操作员 你自己做',
          mentionedAgentId: parent.id,
        },
      },
      makeEmitCapture().emit,
    );

    // 父代理仍是本轮的人设与汇总者。
    expect(seen[0].systemPrompt).toContain('【当前角色】电脑操作员');

    const lastUser = seen[0].messages.at(-1).content as string;
    expect(lastUser).toContain('delegate_subagent');
    expect(lastUser).toContain('就是你自己的画像');

    expect(seen[0].subagent.profiles.explore).toEqual(BUILTIN_SUBAGENT_PROFILES.explore);
    expect(seen[0].subagent.profiles[parent.slug!]).toBeDefined();
    expect(seen[0].subagent.requiredProfiles).toEqual([parent.slug!]);
    expect(seen[0].subagent.maxParallel).toBeUndefined();
  });

  it('提及 5 个 → maxParallel 跟着抬', async () => {
    const { chat } = await seedBoundChat();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const agent = await h.store.createChatAgent({
        name: `专家${i}`,
        slug: `expert-${i}`,
        rolePrompt: `角色${i}`,
        toolPolicy: { mode: 'allowlist', tools: ['local_read_file'] },
      });
      ids.push(agent.id);
    }
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        body: { message: '五路并行', mentionedAgentIds: ids },
      },
      makeEmitCapture().emit,
    );
    expect(seen[0].subagent.maxParallel).toBe(5);
    for (let i = 1; i <= 5; i += 1) {
      expect(seen[0].subagent.profiles[`expert-${i}`]).toBeDefined();
    }
  });

  it('无提及、会话只有父代理时只下发内置画像，不注入派发指令', async () => {
    const { chat } = await seedBoundChat();
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        body: { message: '普通一问' },
      },
      makeEmitCapture().emit,
    );
    expect(seen[0].subagent.profiles).toEqual(BUILTIN_SUBAGENT_PROFILES);
    expect(seen[0].subagent.maxParallel).toBeUndefined();
    expect(seen[0].messages.at(-1).content).toBe('普通一问');
    expect(seen[0].systemPrompt).toContain('【当前角色】电脑操作员');
    expect(seen[0].systemPrompt).not.toContain('可委派的智能体');
  });

  it('没有 @ 时其他智能体也进画像与系统提示名录，但不强制派发', async () => {
    const { parent, chat } = await seedBoundChat();
    await h.store.createChatAgent({
      name: 'Word智能体',
      slug: 'word-master',
      rolePrompt: '按定版初稿生成 Word 文件',
      toolPolicy: { mode: 'all', tools: [] },
    });
    await h.store.createChatAgent({
      name: 'PPT智能体',
      slug: 'ppt-master',
      rolePrompt: '按已生成的 DOCX 生成 PPT',
      toolPolicy: { mode: 'allowlist', tools: ['local_read_file', 'web_search'] },
    });
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        // 技能正文里写「@Word智能体」，用户输入框里没有点名任何人。
        body: { message: '生成三会议案Word文件' },
      },
      makeEmitCapture().emit,
    );

    // 画像在 enum 里 → 技能/提示里的委派不再 fail closed。
    const subagent = seen[0].subagent as {
      profiles: Record<string, { description?: string; toolFilter?: string[] }>;
      requiredProfiles?: string[];
      maxParallel?: number;
    };
    expect(subagent.profiles['word-master'].description).toContain('Word智能体');
    expect(subagent.profiles['ppt-master'].toolFilter).toEqual([
      'local_read_file',
      'web_search',
    ]);
    expect(subagent.profiles.explore).toEqual(BUILTIN_SUBAGENT_PROFILES.explore);
    // 父代理自己不进常驻名单。
    expect(subagent.profiles['local-assistant']).toBeUndefined();

    // 「可以派」而非「必须派」：不挂完成门，也不注入强制派发指令。
    expect(subagent.requiredProfiles).toBeUndefined();
    expect(seen[0].messages.at(-1).content).toBe('生成三会议案Word文件');

    // 系统提示给出显示名 → 画像名对照，模型才知道 @Word智能体 该怎么落地。
    const prompt = seen[0].systemPrompt as string;
    expect(prompt).toContain('可委派的智能体');
    expect(prompt).toContain('Word智能体 → `subagent_type="word-master"`');
    expect(prompt).toContain('PPT智能体 → `subagent_type="ppt-master"`');
    expect(prompt).toContain('【当前角色】电脑操作员');
    expect(prompt).not.toContain(`subagent_type="${parent.slug}"`);
  });

  it('提及与常驻并存：只有被提及的进 requiredProfiles，两者都在名录里', async () => {
    const { chat } = await seedBoundChat();
    const researcher = await h.store.createChatAgent({
      name: '调研员',
      slug: 'researcher',
      rolePrompt: '多轮联网调研',
      toolPolicy: { mode: 'allowlist', tools: ['web_search', 'web_fetch'] },
    });
    await h.store.createChatAgent({
      name: 'Word智能体',
      slug: 'word-master',
      rolePrompt: '生成 Word 文件',
    });
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        body: { message: '@调研员 先查一下', mentionedAgentId: researcher.id },
      },
      makeEmitCapture().emit,
    );

    const subagent = seen[0].subagent as {
      profiles: Record<string, unknown>;
      requiredProfiles?: string[];
    };
    expect(subagent.profiles.researcher).toBeDefined();
    expect(subagent.profiles['word-master']).toBeDefined();
    expect(subagent.requiredProfiles).toEqual(['researcher']);

    const prompt = seen[0].systemPrompt as string;
    expect(prompt).toContain('调研员 → `subagent_type="researcher"`');
    expect(prompt).toContain('Word智能体 → `subagent_type="word-master"`');
    // 强制派发只点名被 @ 的那位。
    const lastUser = seen[0].messages.at(-1).content as string;
    expect(lastUser).toContain('调研员');
    expect(lastUser).not.toContain('Word智能体');
  });

  it('loadAllSkills 的被提及智能体：技能正文进子代理 systemPrompt', async () => {
    h.loadSkills.mockResolvedValue([
      {
        name: 'csv-tools',
        displayName: '',
        description: '',
        priority: 100,
        tags: [],
        conditions: [],
        match: 'any',
        layer: 'catalog',
        modelInvocable: true,
        content: 'CSV_EMBEDDED_GUIDANCE unique-skill-body',
        dirName: '90-csv-tools',
        skillsDir: '/skills',
      },
    ]);
    const { chat } = await seedBoundChat();
    const helper = await h.store.createChatAgent({
      name: '智能助手',
      slug: 'all-round-assistant',
      rolePrompt: '你是智能助手',
      loadAllSkills: true,
    });
    const { seen } = installStream();
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        body: { message: '@智能助手 帮我看 CSV', mentionedAgentId: helper.id },
      },
      makeEmitCapture().emit,
    );
    expect(seen[0].subagent.profiles['all-round-assistant'].systemPrompt).toContain(
      'CSV_EMBEDDED_GUIDANCE unique-skill-body',
    );
  });

  it('子代理生命周期落进助手 metadata，刷新后仍能 fold 出 profile', async () => {
    const { chat } = await seedBoundChat();
    const researcher = await h.store.createChatAgent({
      name: '调研员',
      slug: 'researcher',
      rolePrompt: '多轮联网调研',
    });
    installStream((opts) => {
      opts.onChildEvent?.({
        kind: 'child_spawned',
        childId: '0.1',
        task: '调研 PDF 方案',
        depth: 1,
        profile: 'researcher',
      });
      opts.onChildEvent?.({
        kind: 'child_completed',
        childId: '0.1',
        status: 'completed',
      });
    });
    await makeRouter().handleStream(
      {
        method: 'POST',
        path: `/api/v2/chats/${chat.id}/send`,
        body: {
          message: '@调研员 调研一下',
          mentionedAgentIds: [researcher.id],
        },
      },
      makeEmitCapture().emit,
    );
    const assistant = (await h.store.listMessages(chat.id, 10)).find(
      (m) => m.role === 'assistant',
    );
    expect(parseMeta(assistant?.messageMetadata).orchestrationChildEvents).toEqual([
      {
        kind: 'child_spawned',
        childId: '0.1',
        task: '调研 PDF 方案',
        depth: 1,
        profile: 'researcher',
      },
      {
        kind: 'child_completed',
        childId: '0.1',
        status: 'completed',
      },
    ]);
  });
});
