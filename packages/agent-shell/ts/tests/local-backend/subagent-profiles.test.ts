/**
 * ChatAgent → 子代理画像映射（W1）。
 *
 * 覆盖：allowlist / denylist / all 的 toolFilter、W2 过渡期与父工具面取交集、
 * concurrent 由只读 vs 写/执行推导、slug、description、
 * loadAllSkills / 勾选技能正文进 systemPrompt、派发指令两种形状、
 * 5 个提及抬 maxParallel。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillModule } from '../../src/local-backend/skill-loader.js';

const mocks = vi.hoisted(() => ({
  loadSkills: vi.fn(),
  findSkill: vi.fn(),
}));

vi.mock('../../src/local-backend/skill-loader.js', () => ({
  loadSkills: mocks.loadSkills,
  findSkill: mocks.findSkill,
}));

import {
  BUILTIN_SUBAGENT_PROFILES,
  buildDelegateDispatchInstruction,
  buildMentionSubagentProfiles,
  mergeTurnSubagentParam,
  profileNameForAgent,
  type SubagentAgentInput,
} from '../../src/local-backend/subagent-profiles.js';

const PARENT_TOOLS = [
  'local_read_file',
  'local_write_file',
  'local_exec_shell',
  'web_search',
  'web_fetch',
];

function makeAgent(overrides: Partial<SubagentAgentInput> = {}): SubagentAgentInput {
  return {
    id: 'agent-researcher',
    slug: 'researcher',
    name: '调研员',
    rolePrompt: '多轮联网调研，结论必须带来源 URL',
    description: null,
    skillIds: [],
    allowExternalSkills: true,
    loadAllSkills: false,
    toolPolicy: { mode: 'all', tools: [] },
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillModule>): SkillModule {
  return {
    name: 'skill',
    displayName: '',
    description: '',
    priority: 100,
    tags: [],
    conditions: [],
    match: 'any',
    layer: 'catalog',
    modelInvocable: true,
    content: '',
    dirName: 'skill',
    skillsDir: '/skills',
    ...overrides,
  };
}

const CSV_SKILL = makeSkill({
  name: 'csv-tools',
  dirName: '90-csv-tools',
  content: 'CSV_EMBEDDED_GUIDANCE unique-skill-body',
});

beforeEach(() => {
  mocks.loadSkills.mockReset();
  mocks.findSkill.mockReset();
  mocks.loadSkills.mockResolvedValue([]);
});

describe('profileNameForAgent', () => {
  it('优先用稳定 ASCII slug', () => {
    expect(profileNameForAgent(makeAgent({ slug: 'researcher' }))).toBe('researcher');
  });

  it('无 slug 时从英文名 slugify', () => {
    expect(profileNameForAgent(makeAgent({ slug: null, name: 'Script Engineer' }))).toBe(
      'script-engineer',
    );
  });

  it('中文名且无 slug 时回落到 agent-<id>', () => {
    expect(profileNameForAgent(makeAgent({ id: 'uuid-调研', slug: null, name: '调研员' }))).toBe(
      'agent-uuid',
    );
  });
});

describe('buildMentionSubagentProfiles / toolFilter', () => {
  it('allowlist → 该清单与父工具面的交集', async () => {
    const profiles = await buildMentionSubagentProfiles(
      [
        makeAgent({
          toolPolicy: {
            mode: 'allowlist',
            tools: ['web_fetch', 'web_search', 'local_read_file', 'local_exec_shell'],
          },
        }),
      ],
      ['web_fetch', 'web_search', 'local_read_file'],
    );
    expect(profiles.researcher.toolFilter).toEqual([
      'web_fetch',
      'web_search',
      'local_read_file',
    ]);
    expect(profiles.researcher.toolFilter).not.toContain('local_exec_shell');
  });

  it('denylist → 父工具面减去禁名单', async () => {
    const profiles = await buildMentionSubagentProfiles(
      [makeAgent({ toolPolicy: { mode: 'denylist', tools: ['local_exec_shell'] } })],
      PARENT_TOOLS,
    );
    expect(profiles.researcher.toolFilter).toEqual([
      'local_read_file',
      'local_write_file',
      'web_search',
      'web_fetch',
    ]);
  });

  it('all 且父未收窄 → 不设 toolFilter（继承父全集）', async () => {
    const profiles = await buildMentionSubagentProfiles(
      [makeAgent({ slug: 'script-engineer', name: '脚本工程师', toolPolicy: { mode: 'all', tools: [] } })],
      PARENT_TOOLS,
    );
    expect(profiles['script-engineer'].toolFilter).toBeUndefined();
  });

  it('W2 过渡期：子 allowlist 超出父工具面的部分被夹掉', async () => {
    const profiles = await buildMentionSubagentProfiles(
      [
        makeAgent({
          toolPolicy: { mode: 'allowlist', tools: ['local_read_file', 'local_exec_shell'] },
        }),
      ],
      ['local_read_file'],
    );
    expect(profiles.researcher.toolFilter).toEqual(['local_read_file']);
  });
});

describe('buildMentionSubagentProfiles / concurrent', () => {
  it('只读工具域 → concurrent:true，不另钉轮次墙', async () => {
    const profiles = await buildMentionSubagentProfiles(
      [
        makeAgent({
          toolPolicy: {
            mode: 'allowlist',
            tools: ['web_fetch', 'web_search', 'local_read_file'],
          },
        }),
      ],
      PARENT_TOOLS,
    );
    expect(profiles.researcher.concurrent).toBe(true);
    expect(profiles.researcher.maxRounds).toBeUndefined();
  });

  it('含写/执行 → concurrent:false，不另钉轮次墙', async () => {
    const profiles = await buildMentionSubagentProfiles(
      [makeAgent({ slug: 'script-engineer', name: '脚本工程师', toolPolicy: { mode: 'all', tools: [] } })],
      PARENT_TOOLS,
    );
    expect(profiles['script-engineer'].concurrent).toBe(false);
    expect(profiles['script-engineer'].maxRounds).toBeUndefined();
  });
});

describe('buildMentionSubagentProfiles / systemPrompt 与 description', () => {
  it('description 含显示名与 rolePrompt 摘要', async () => {
    const profiles = await buildMentionSubagentProfiles([makeAgent()], PARENT_TOOLS);
    expect(profiles.researcher.description).toContain('调研员');
    expect(profiles.researcher.description).toContain('来源 URL');
  });

  it('systemPrompt 含角色身份与 rolePrompt', async () => {
    const profiles = await buildMentionSubagentProfiles([makeAgent()], PARENT_TOOLS);
    expect(profiles.researcher.systemPrompt).toContain('调研员');
    expect(profiles.researcher.systemPrompt).toContain('多轮联网调研');
  });

  it('loadAllSkills 时技能正文进 systemPrompt', async () => {
    mocks.loadSkills.mockResolvedValue([CSV_SKILL]);
    const profiles = await buildMentionSubagentProfiles(
      [makeAgent({ loadAllSkills: true })],
      PARENT_TOOLS,
    );
    expect(profiles.researcher.systemPrompt).toContain('CSV_EMBEDDED_GUIDANCE unique-skill-body');
  });

  it('勾选 skillIds 的技能正文进 systemPrompt', async () => {
    mocks.loadSkills.mockResolvedValue([CSV_SKILL]);
    const profiles = await buildMentionSubagentProfiles(
      [makeAgent({ skillIds: ['90-csv-tools'] })],
      PARENT_TOOLS,
    );
    expect(profiles.researcher.systemPrompt).toContain('CSV_EMBEDDED_GUIDANCE unique-skill-body');
  });
});

describe('buildDelegateDispatchInstruction', () => {
  it('点名显示名、画像名，并写清独立/依赖两种形状', () => {
    const text = buildDelegateDispatchInstruction([
      {
        name: '调研员',
        profileName: 'researcher',
        toolFilter: ['web_fetch', 'web_search', 'local_read_file'],
      },
      { name: '脚本工程师', profileName: 'script-engineer' },
    ]);
    expect(text).toContain('调研员');
    expect(text).toContain('脚本工程师');
    expect(text).toContain('delegate_subagent');
    expect(text).toContain('researcher');
    expect(text).toContain('script-engineer');
    expect(text).toContain('同一轮');
    expect(text).toContain('有依赖');
    expect(text).toContain('自包含');
    expect(text).toContain('禁止只写分工然后停手');
    expect(text).toContain('web_fetch');
    expect(text).toContain('本轮可用工具与你相同');
    expect(text).not.toContain('就是你自己的画像');
  });

  it('名单含父代理自己时，说清要起独立副本而不是顺手做', () => {
    const text = buildDelegateDispatchInstruction([
      { name: '电脑操作员', profileName: 'local-assistant', isSelf: true },
      { name: '日程规划', profileName: 'scheduler' },
    ]);
    expect(text).toContain('就是你自己的画像');
    expect(text).toContain('自己顺手做不算完成派发');
  });
});

describe('mergeTurnSubagentParam', () => {
  it('无提及时只有内置画像，不抬 maxParallel，也不要求派发', () => {
    const param = mergeTurnSubagentParam({});
    expect(param.profiles).toEqual(BUILTIN_SUBAGENT_PROFILES);
    expect(param.maxParallel).toBeUndefined();
    expect(param.requiredProfiles).toBeUndefined();
  });

  it('提及画像作为 requiredProfiles 下发（内置画像不强制）', () => {
    const param = mergeTurnSubagentParam({
      researcher: { description: '调研员', concurrent: true },
    });
    expect(param.requiredProfiles).toEqual(['researcher']);
  });

  it('提及画像并入内置集；超过 4 个时 maxParallel 跟着抬', () => {
    const mentions = Object.fromEntries(
      ['d1', 'd2', 'd3', 'd4', 'd5'].map((name) => [
        name,
        { description: name, concurrent: true, maxRounds: 12 },
      ]),
    );
    const param = mergeTurnSubagentParam(mentions);
    expect(param.profiles.explore).toEqual(BUILTIN_SUBAGENT_PROFILES.explore);
    expect(param.profiles.d5).toBeDefined();
    expect(param.maxParallel).toBe(5);
  });
});
