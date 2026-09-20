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
  /** 画像缓存的失效依据：改配置即换键。缺省则该智能体的画像每轮重建。 */
  updatedAt?: string;
}

/**
 * 一个可委派对象的画像，连同显示名，供派发指令、名录说明与 sidecar 参数
 * 共用。两个来源共享这个结构：用户 `@` 点名的（强制派发）与常驻可委派
 * 名单里的（模型自主判断）。
 */
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
  return await buildRoster(delegates, parentToolNames, new Set());
}

/**
 * 常驻可委派名单：会话里的其他智能体也转成画像，模型**无需用户 `@`** 就能
 * 委派。技能正文或自定义提示里写「交给 X」因此能落成一次真实
 * `delegate_subagent`——在此之前 `subagent_type` 的 enum 里只有内置三个画像，
 * 这类指令 fail closed 报 `unknown subagent_type`，模型只能在正文里打出名字。
 *
 * 与提及名单的唯一区别是强制性：这里**不进** `requiredProfiles`。派不派由模型
 * 按任务判断——技能的阶段条件（「阶段 C 才交给 Word 智能体」）在拼装画像时
 * 还不可知，一律强制会把不该派的回合反复退回完成门。
 *
 * @param agents 会话可用的智能体（未归档）。
 * @param parentToolNames 父本轮模型可见工具名。
 * @param options.excludeAgentIds 不进名单的智能体：父代理自己与已在提及名单里的。
 * @param options.reservedProfileNames 已占用的画像名（内置画像 + 提及画像），避免顶掉。
 * @returns 画像花名册，按 `agents` 顺序。
 */
export async function buildAmbientDelegateRoster(
  agents: readonly SubagentAgentInput[],
  parentToolNames: readonly string[],
  options: {
    excludeAgentIds?: readonly string[];
    reservedProfileNames?: readonly string[];
  } = {},
): Promise<MentionDelegateProfile[]> {
  const excluded = new Set(options.excludeAgentIds ?? []);
  const candidates = agents.filter((agent) => !excluded.has(agent.id));
  if (candidates.length === 0) return [];
  return await buildRoster(
    candidates,
    parentToolNames,
    new Set(options.reservedProfileNames ?? []),
  );
}

async function buildRoster(
  agents: readonly SubagentAgentInput[],
  parentToolNames: readonly string[],
  reserved: Set<string>,
): Promise<MentionDelegateProfile[]> {
  const roster: MentionDelegateProfile[] = [];
  const used = new Set<string>(reserved);
  for (const agent of agents) {
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
      profile: await buildOneDelegateProfile(agent, parentToolNames),
    });
  }
  return roster;
}

/**
 * 画像构建缓存的存活时长。
 *
 * 常驻名单让每轮的画像数量从「用户点了几个」变成「用户有几个智能体」，而
 * 每份画像的 `systemPrompt` 都要过一次 `buildSystemPrompt`（内含技能目录
 * 扫描）——不缓存就是每轮多做 N 次磁盘扫描，直接加在首个 token 之前。
 *
 * 缓存键带 `updatedAt`，所以改智能体立即生效；技能**正文**落盘不改
 * `updatedAt`，靠这个存活时长兜底，最迟下一轮生效。
 */
const DELEGATE_PROFILE_TTL_MS = 15_000;

interface CachedDelegateProfile {
  builtAtMs: number;
  profile: BuiltinSubagentProfile;
}

const delegateProfileCache = new Map<string, CachedDelegateProfile>();

/** 清空画像缓存（测试用；生产靠 `updatedAt` 与存活时长失效）。 */
export function resetDelegateProfileCache(): void {
  delegateProfileCache.clear();
}

async function buildOneDelegateProfile(
  agent: SubagentAgentInput,
  parentToolNames: readonly string[],
): Promise<BuiltinSubagentProfile> {
  // 键要完整描述这份画像的输入：身份（改名/换 slug 都会换画像名与人设）、
  // `updatedAt`（改配置即失效）、父工具面（`toolFilter` 与画像 systemPrompt
  // 里的工具名录都由它派生）。只用 id 的话，任何复用 id 的调用方（内存假
  // 存储的测试）都会静默拿到另一个智能体的画像。
  const cacheKey = agent.updatedAt
    ? [
        agent.id,
        agent.updatedAt,
        agent.slug ?? '',
        agent.name,
        parentToolNames.join(','),
      ].join('\u0000')
    : null;
  if (cacheKey) {
    const hit = delegateProfileCache.get(cacheKey);
    if (hit && Date.now() - hit.builtAtMs < DELEGATE_PROFILE_TTL_MS) return hit.profile;
  }
  const profile = await buildProfileUncached(agent, parentToolNames);
  if (cacheKey) delegateProfileCache.set(cacheKey, { builtAtMs: Date.now(), profile });
  return profile;
}

async function buildProfileUncached(
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

/**
 * 可委派智能体名录：注入系统提示（realityCheck 段）。
 *
 * 技能正文与自定义提示里写的是**显示名**（`@Word智能体`），而 `subagent_type`
 * 只认 ASCII 画像名（`word-master`）。没有这张对照表，技能作者只能硬编码画像
 * 名、智能体一改名就断；模型也无从知道正文里的「@某智能体」该落成一次
 * `delegate_subagent`，于是只在回复里打出这个名字然后收尾。
 *
 * 与 {@link buildDelegateDispatchInstruction} 的分工：那份是用户点名后的**强制**
 * 派发指令（配 `requiredProfiles` 完成门兜底），这份只说明「能派谁、怎么派」。
 *
 * @param delegates 本轮可委派的智能体（提及 + 常驻名单）。
 * @returns 名录正文；空名单返回空串，本轮系统提示与改前逐字节一致。
 */
export function buildDelegateRosterHint(
  delegates: ReadonlyArray<{ name: string; profileName: string }>,
): string {
  if (delegates.length === 0) return '';
  const roster = delegates
    .map((row) => `- ${row.name} → \`subagent_type="${row.profileName}"\``)
    .join('\n');
  return [
    '',
    '',
    '## 可委派的智能体',
    '',
    '以下智能体可以通过 `delegate_subagent` 接活，画像名对照：',
    '',
    roster,
    '',
    '- 指令（含技能正文）里出现「@某智能体」或「交给某智能体」时，意思是**用 `delegate_subagent` 把这份活派给它**，`subagent_type` 填上表对应的画像名——不是在回复里打出这个名字。',
    '- 每份 `task` 必须自包含（目标、输入、交付形式、验收标准）：子代理看不到本对话。',
    '- 表里没有的名字不要猜着填，`subagent_type` 只接受上表与内置画像。',
  ].join('\n');
}

export interface TurnSubagentParam {
  profiles: Record<string, BuiltinSubagentProfile>;
  maxParallel?: number;
  /** 本轮必须收到委派的画像（被 `@` 的智能体）；sidecar 据此挂完成门。 */
  requiredProfiles?: string[];
}

/**
 * 内置画像 + 常驻可委派画像 + 本轮提及画像。被 `@` 超过 4 个时抬高池的并行上限。
 *
 * 只有**提及**画像进 `requiredProfiles`：强制派发此前只是提示词里的一句话，
 * 模型跑了别的工具再叙述「已启动」就能蒙过所有既有纪律检查。常驻画像刻意不进
 * ——它们是「可以派」，不是「本轮必须派」。
 *
 * @param mentionProfiles 本轮提及转出的画像。
 * @param ambientProfiles 常驻可委派画像；与提及画像同名时以提及为准。
 * @returns 下发给 sidecar 的 `subagent` 参数。
 */
export function mergeTurnSubagentParam(
  mentionProfiles: Record<string, BuiltinSubagentProfile>,
  ambientProfiles: Record<string, BuiltinSubagentProfile> = {},
): TurnSubagentParam {
  const mentionNames = Object.keys(mentionProfiles);
  return {
    profiles: { ...BUILTIN_SUBAGENT_PROFILES, ...ambientProfiles, ...mentionProfiles },
    ...(mentionNames.length > 4 ? { maxParallel: mentionNames.length } : {}),
    ...(mentionNames.length > 0 ? { requiredProfiles: mentionNames } : {}),
  };
}
