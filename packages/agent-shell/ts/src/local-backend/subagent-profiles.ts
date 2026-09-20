/**
 * 内置 subagent_type 画像集（CC `.claude/agents` parity）以及
 * ChatAgent → 提及子代理画像的映射（`@` 委派 W1）。
 *
 * 桌面不再向 sidecar 传裸 `subagent: true`——命名画像让每个委派带
 * 工具域 / 轮次上限 / 并发性 / 系统提示，模型按画像 description 选择
 * 委派对象（画像名与用途经工具 schema 广告给模型）。
 *
 * 设计约束：
 * - 画像的 toolFilter 引用的是桌面模型可见工具面（tool-router）里的
 *   真实工具名；收窄即权限边界（explore 够不到写工具是构造性的）。
 * - per-profile model 刻意不设：跟随父模型；模型路由留给设置面。
 * - 画像系统提示是种进子 loop 的第一条 system 消息（子代理看不到
 *   主对话的系统提示，画像提示就是它的全部角色设定）。
 * - W2 落地前 toolFilter 必须与父本轮工具面取交集（子 ⊆ 父）。
 */

import {
  isToolAllowed,
  mergeAgentCapabilities,
  normalizeToolPolicy,
  resolveSkillExcludes,
  type AgentCapabilityInput,
  type AgentToolPolicy,
} from './agent-capability.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { loadSkills } from './skill-loader.js';

export interface BuiltinSubagentProfile {
  toolFilter?: string[];
  maxRounds?: number;
  concurrent?: boolean;
  description: string;
  systemPrompt?: string;
}

/** 映射用的智能体子集（身份 + 能力面），不依赖存储层类型。 */
export interface SubagentAgentInput extends AgentCapabilityInput {
  id: string;
  slug: string | null;
  name: string;
  rolePrompt: string | null;
  description?: string | null;
}

/** 一次 `@` 提及转出的画像，连同显示名，供派发指令与 sidecar 参数共用。 */
export interface MentionDelegateProfile {
  /** 被提及智能体的 id——调用方据此认出自提及那一行。 */
  agentId: string;
  name: string;
  profileName: string;
  profile: BuiltinSubagentProfile;
}

/** 只读工具域：探索与调研画像共享的「摸不到写操作」基线。 */
const READ_ONLY_TOOLS = [
  'local_read_file',
  'local_list_scripts',
  'local_open_path',
  'web_search',
  'web_fetch',
  'mcp_list_tools',
];

const READ_ONLY_TOOL_SET = new Set(READ_ONLY_TOOLS);

export const BUILTIN_SUBAGENT_PROFILES: Record<string, BuiltinSubagentProfile> = {
  explore: {
    toolFilter: READ_ONLY_TOOLS,
    concurrent: true,
    description:
      '只读代码侦察。搜索、读文件、定位「在哪里/是什么」类问题；不做任何修改，返回带路径:行号的发现。',
    systemPrompt: [
      '你是只读探索代理，任务是在代码库中定位信息并汇报发现。',
      '纪律：',
      '1) 你的工具域只有只读工具——不要尝试修改、创建、删除任何文件；',
      '2) 汇报必须具体：文件路径:行号、关键片段、明确结论；',
      '3) 找不到就明说找不到，并列出你查过的位置——禁止猜测。',
    ].join('\n'),
  },
  research: {
    toolFilter: [...READ_ONLY_TOOLS, 'local_write_file'],
    concurrent: true,
    description:
      '深度调研。多轮 web 搜索/抓取并交叉验证，给出带来源 URL 的结论；可把报告写入文件。',
    systemPrompt: [
      '你是调研代理，任务是对一个问题做深度调研并给出可核验的结论。',
      '纪律：',
      '1) 每个事实性主张都必须来自真实抓取结果，并附来源 URL；',
      '2) 至少两个独立来源交叉验证关键结论，来源冲突时并列呈现；',
      '3) 需要交付长报告时用 local_write_file 落盘并在汇报中给出路径；',
      '4) 查不到就明说，禁止编造来源或数据。',
    ].join('\n'),
  },
  coder: {
    // 不设 toolFilter：全工具域。写操作串行（concurrent: false），避免两个
    // 实现代理同时改同一批文件。
    concurrent: false,
    description:
      '全工具实现代理。改代码、跑命令、自验结果；适合自包含的实现/修复任务。',
    systemPrompt: [
      '你是实现代理，接到的是自包含的实现任务。',
      '纪律：',
      '1) 直接动手：真实调用工具改代码/跑命令，不要用文本描述代替执行；',
      '2) 完成后必须验证：跑相关测试或构建，把真实输出作为依据；',
      '3) 汇报改动清单 + 验证结果 + 遗留风险，禁止编造工具返回。',
    ].join('\n'),
  },
};

/**
 * chat.stream 的 `subagent` 参数：内置画像集。调用方（普通回合与
 * task-service 后台任务）共享同一份——任务回合的子代理画像与主对话
 * 一致，编排语义不随入口分叉。
 */
export function builtinSubagentParam(): { profiles: Record<string, BuiltinSubagentProfile> } {
  return { profiles: BUILTIN_SUBAGENT_PROFILES };
}

/**
 * 画像名：优先稳定 ASCII slug，否则英文名 slugify，再否则 `agent-<id>`。
 *
 * @param agent 被提及的智能体。
 * @returns 可作为 `subagent_type` enum 的画像名。
 */
export function profileNameForAgent(agent: {
  id: string;
  slug: string | null;
  name: string;
}): string {
  const slug = agent.slug?.trim() ?? '';
  if (isStableProfileName(slug)) return slug;
  const fromName = slugifyProfileName(agent.name);
  if (fromName) return fromName;
  const fromId = agent.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return fromId ? `agent-${fromId}` : 'agent';
}

function isStableProfileName(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
}

function slugifyProfileName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * W2 过渡期：子策略放行的工具与父本轮工具面取交集。
 * 交集等于父全集时不设 filter（子继承父的工具域）。
 *
 * @param childPolicy 子智能体自己的工具策略。
 * @param parentToolNames 父本轮已经广告给模型的工具名。
 * @returns 子代理 toolFilter；`undefined` 表示不比父更窄。
 */
export function resolveChildToolFilter(
  childPolicy: AgentToolPolicy,
  parentToolNames: readonly string[],
): string[] | undefined {
  const policy = normalizeToolPolicy(childPolicy);
  const allowed = parentToolNames.filter((name) => isToolAllowed(policy, name));
  // `all` 且交集等于父全集 → 不设 filter，子代理继承父的工具域。
  // allowlist / denylist 始终下发交集清单，即使碰巧等于父全集——画像
  // roster 要让模型看见该子代理真正收窄后的工具面。
  if (policy.mode === 'all') return undefined;
  return allowed;
}

function isReadOnlyToolDomain(toolNames: readonly string[]): boolean {
  return toolNames.every((name) => READ_ONLY_TOOL_SET.has(name));
}

function profileDescription(agent: SubagentAgentInput): string {
  const summary = (agent.rolePrompt || agent.description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return summary ? `${agent.name} — ${summary}` : agent.name;
}

/**
 * 把本轮被 `@` 的智能体译成 sidecar 画像（含 W1 夹紧）。
 *
 * @param delegates 被 `@` 的智能体，按提及顺序（含被点名的父代理本身）。
 * @param parentToolNames 父本轮模型可见工具名。
 * @returns 画像名 → 画像。
 */
export async function buildMentionSubagentProfiles(
  delegates: readonly SubagentAgentInput[],
  parentToolNames: readonly string[],
): Promise<Record<string, BuiltinSubagentProfile>> {
  const roster = await buildMentionDelegateRoster(delegates, parentToolNames);
  return Object.fromEntries(roster.map((row) => [row.profileName, row.profile]));
}

/**
 * 与 {@link buildMentionSubagentProfiles} 同源，额外带显示名供派发指令使用。
 *
 * @param delegates 被 `@` 的智能体，按提及顺序（含被点名的父代理本身）。
 * @param parentToolNames 父本轮模型可见工具名。
 * @returns 提及顺序的画像花名册。
 */
export async function buildMentionDelegateRoster(
  delegates: readonly SubagentAgentInput[],
  parentToolNames: readonly string[],
): Promise<MentionDelegateProfile[]> {
  const roster: MentionDelegateProfile[] = [];
  const used = new Set<string>();
  for (const agent of delegates) {
    let profileName = profileNameForAgent(agent);
    if (used.has(profileName)) {
      const suffix = agent.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
      profileName = suffix ? `${profileName}-${suffix}` : `${profileName}-dup`;
    }
    used.add(profileName);
    roster.push({
      agentId: agent.id,
      name: agent.name,
      profileName,
      profile: await buildOneMentionProfile(agent, parentToolNames),
    });
  }
  return roster;
}

async function buildOneMentionProfile(
  agent: SubagentAgentInput,
  parentToolNames: readonly string[],
): Promise<BuiltinSubagentProfile> {
  const toolFilter = resolveChildToolFilter(agent.toolPolicy, parentToolNames);
  const domain = toolFilter ?? parentToolNames;
  const readOnly = isReadOnlyToolDomain(domain);
  const capability = mergeAgentCapabilities([agent]);
  const excludeSkillNames = capability.allowExternalSkills
    ? ['plan-mode']
    : resolveSkillExcludes(
        capability,
        await loadSkills({ ignoreConditions: true }),
        ['plan-mode'],
      );
  const personaPreamble = agent.rolePrompt
    ? `【当前角色】${agent.name}\n${agent.rolePrompt}`
    : '';
  const built = await buildSystemPrompt({
    personaPreamble,
    identityName: agent.name,
    pinnedSkillNames: capability.pinnedSkills,
    ignoreConditions: capability.loadAllSkills,
    excludeSkillNames,
    toolNames: domain,
  });
  return {
    ...(toolFilter ? { toolFilter } : {}),
    concurrent: readOnly,
    description: profileDescription(agent),
    systemPrompt: built.prompt,
  };
}

/**
 * 注入本轮最后一条用户消息的强制派发指令。
 *
 * 被点名的父代理自己也在名单里（`isSelf`）：它要起一个独立副本去跑那份
 * 子任务，而不是顺手自己做——否则 `requiredProfiles` 完成门会一直把回合
 * 退回来。
 *
 * @param delegates 被点名的子代理（显示名 + 画像名 + 实际工具面 + 是否是自己）。
 * @returns 派发指令正文。
 */
export function buildDelegateDispatchInstruction(
  delegates: ReadonlyArray<{
    name: string;
    profileName: string;
    toolFilter?: string[];
    isSelf?: boolean;
  }>,
): string {
  const names = delegates.map((row) => row.name).join('、');
  const roster = delegates
    .map((row) => {
      const tools = row.toolFilter?.length
        ? `本轮可用工具：${row.toolFilter.join('、')}`
        : '本轮可用工具与你相同';
      const self = row.isSelf ? '就是你自己的画像，起一个独立副本去跑；' : '';
      return `- **${row.name}**（subagent_type=\`${row.profileName}\`）：${self}${tools}`;
    })
    .join('\n');
  const hasSelf = delegates.some((row) => row.isSelf);
  return [
    `用户点名了 **${names}**。本轮你必须把活交给它们，用 \`delegate_subagent\`（\`subagent_type\` 填画像名），每人至少一份子任务。`,
    '',
    roster,
    '',
    '- 子任务**彼此独立**时：一句话说明分工，紧接着在**同一轮**把全部调用发出，并把可并行的排在一起。',
    '- 子任务**有依赖**时：按依赖顺序分轮派发，并把前一轮的结论写进后一轮的 `task`。',
    '- 每份 `task` 必须自包含（目标、输入、交付形式、验收标准）——子代理看不到本对话。',
    '- 禁止只写分工然后停手；也禁止漏掉任何一位被点名的代理。',
    ...(hasSelf
      ? [
          '- 名单里包含你自己时同样要发 `delegate_subagent`：那是一个看不到本对话的独立副本，自己顺手做不算完成派发。',
        ]
      : []),
    '- 若某子代理注明了本轮可用工具，不要尝试让它调用未列出的工具。',
  ].join('\n');
}

export interface TurnSubagentParam {
  profiles: Record<string, BuiltinSubagentProfile>;
  maxParallel?: number;
  /** 本轮必须收到委派的画像（被 `@` 的智能体）；sidecar 据此挂完成门。 */
  requiredProfiles?: string[];
}

/**
 * 内置画像 + 本轮提及画像。被 `@` 超过 4 个时抬高池的并行上限。
 *
 * 提及画像同时作为 `requiredProfiles` 下发：强制派发此前只是提示词里的
 * 一句话，模型跑了别的工具再叙述「已启动」就能蒙过所有既有纪律检查。
 *
 * @param mentionProfiles 本轮提及转出的画像；空对象则与 {@link builtinSubagentParam} 相同。
 * @returns 下发给 sidecar 的 `subagent` 参数。
 */
export function mergeTurnSubagentParam(
  mentionProfiles: Record<string, BuiltinSubagentProfile>,
): TurnSubagentParam {
  const mentionNames = Object.keys(mentionProfiles);
  return {
    profiles: { ...BUILTIN_SUBAGENT_PROFILES, ...mentionProfiles },
    ...(mentionNames.length > 4 ? { maxParallel: mentionNames.length } : {}),
    ...(mentionNames.length > 0 ? { requiredProfiles: mentionNames } : {}),
  };
}
