/**
 * 对话包 / 配置包的文件格式。纯函数：不读库、不写盘。
 *
 * 文件是一个 JSON 对象。`kind` 区分配置、单条对话和多条对话，`schemaVersion` 只认 1。
 * 钥匙（模型 Key、搜索 Key、MCP 环境变量）默认不进包；`includeSecrets`
 * 为 true 时原样写入，导入方要自己确认。
 */

export const PORTABLE_SCHEMA_VERSION = 1;
export const PORTABLE_MESSAGE_LIMIT = 1000;

export const PORTABLE_CONFIG_KIND = 'steerable-config';
export const PORTABLE_CHAT_KIND = 'steerable-chat';
export const PORTABLE_CHATS_KIND = 'steerable-chats';

export const SERVER_SECTION_IDS = [
  'llm',
  'webSearch',
  'telemetry',
  'insights',
  'mcp',
  'agents',
  'skills',
] as const;

export const CLIENT_SECTION_IDS = ['appearance', 'execPolicy'] as const;

export type ServerSectionId = (typeof SERVER_SECTION_IDS)[number];
export type ClientSectionId = (typeof CLIENT_SECTION_IDS)[number];
export type PortableSectionId = ServerSectionId | ClientSectionId;

const SECTION_LABELS: Record<PortableSectionId, string> = {
  appearance: '界面',
  execPolicy: '命令权限',
  llm: '本地模型',
  webSearch: '网络搜索',
  telemetry: '遥测',
  insights: '帮助改进产品',
  mcp: 'MCP 服务',
  agents: '智能体',
  skills: '技能引用',
};

export interface PortablePreviewSection {
  id: PortableSectionId;
  label: string;
  detail: string;
  clientOnly: boolean;
  hasSecret: boolean;
}

export interface PortableChatSummary {
  title: string;
  messageCount: number;
  attachmentCount: number;
  omittedAttachmentCount: number;
  truncated: boolean;
  /** 多条对话包里的会话数。单条对话包不带这个字段。 */
  count?: number;
  /** 单条对话所属项目，或多条包里只有一个项目时的名字。 */
  projectName?: string;
  /** 包里出现的项目数。没有项目时不带。 */
  projectCount?: number;
}

/** 项目登记。只含名称和目录位置，不含目录里的文件。 */
export interface PortableProject {
  name: string;
  folderPath: string;
  sourceFolders: string[];
  trusted: boolean;
}

export interface PortablePreview {
  kind: typeof PORTABLE_CONFIG_KIND | typeof PORTABLE_CHAT_KIND | typeof PORTABLE_CHATS_KIND;
  includeSecrets: boolean;
  sections: PortablePreviewSection[];
  chat?: PortableChatSummary;
}

export interface PortableLlmSection {
  provider?: string;
  vendorId?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  systemPrompt?: string;
  maxTotalTokens?: number;
  compat?: unknown;
  presets?: unknown;
  execTimeoutSeconds?: number;
  apiKeyIncluded: boolean;
  apiKey?: string;
}

export interface PortableWebSearchSection {
  provider?: string;
  apiKeyIncluded: boolean;
  apiKey?: string;
}

export interface PortableMcpSection {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  enabled: boolean;
  envIncluded: boolean;
  env?: Record<string, string>;
}

export interface PortableAgentSection {
  name: string;
  slug?: string | null;
  icon?: string | null;
  color?: string | null;
  description?: string | null;
  rolePrompt?: string | null;
  forbiddenPrompt?: string | null;
  skillIds?: string[];
  toolPolicy?: unknown;
  allowExternalSkills?: boolean;
  loadAllSkills?: boolean;
  isArchived?: boolean;
  sortOrder?: number;
}

export interface PortableSkillSection {
  names: string[];
}

export interface PortableInsightsSection {
  shareBehavior?: boolean;
  shareConversation?: boolean;
  shareProfile?: boolean;
  promptedAt?: string;
  apiBase?: string;
  profile?: {
    displayName?: string;
    email?: string;
    company?: string;
    note?: string;
  };
}

export interface PortableTelemetrySection {
  endpoint?: string;
  privacyMode?: string;
  serviceName?: string;
}

export interface PortableAppearanceSection {
  thinkingDisplay?: string;
}

export interface PortableExecPolicySection {
  policy?: string;
}

export interface PortableConfigSections {
  llm?: PortableLlmSection;
  webSearch?: PortableWebSearchSection;
  telemetry?: PortableTelemetrySection;
  insights?: PortableInsightsSection;
  mcp?: PortableMcpSection[];
  agents?: PortableAgentSection[];
  skills?: PortableSkillSection;
  appearance?: PortableAppearanceSection;
  execPolicy?: PortableExecPolicySection;
}

export interface PortableConfigDocument {
  kind: typeof PORTABLE_CONFIG_KIND;
  schemaVersion: number;
  exportedAt: string;
  includeSecrets: boolean;
  sections: PortableConfigSections;
}

export interface PortableChatMessage {
  role: string;
  content: string;
  messageMetadata: string | null;
  createdAt: string;
}

export interface PortableChatAttachment {
  name: string;
  size: number;
  /** base64。过大时缺省，并标 `omitted`。 */
  data?: string;
  omitted?: boolean;
}

export interface PortableChatDocument {
  kind: typeof PORTABLE_CHAT_KIND;
  schemaVersion: number;
  exportedAt: string;
  chat: {
    title: string;
    agentId: string | null;
    isPinned: boolean;
    systemPrompt: string | null;
    pinnedRefs: unknown;
  };
  /** 所属项目。没有项目时缺省。目录里的文件不在这里。 */
  project?: PortableProject;
  messages: PortableChatMessage[];
  truncated: boolean;
  attachments: PortableChatAttachment[];
}

export type PortableDocument = PortableConfigDocument | PortableChatDocument;

const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

export function isServerSectionId(value: string): value is ServerSectionId {
  return (SERVER_SECTION_IDS as readonly string[]).includes(value);
}

export function isClientSectionId(value: string): value is ClientSectionId {
  return (CLIENT_SECTION_IDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 读项目登记。缺名字或缺家目录时当作没有项目，不把目录内容读进来。 */
export function readPortableProject(raw: unknown): PortableProject | null {
  if (!isRecord(raw)) return null;
  const name = asString(raw.name)?.trim() ?? '';
  const folderPath = asString(raw.folderPath)?.trim() ?? '';
  if (!name || !folderPath) return null;
  const sourceFolders = Array.isArray(raw.sourceFolders)
    ? raw.sourceFolders.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  return {
    name,
    folderPath,
    sourceFolders,
    trusted: raw.trusted === true,
  };
}

function thinkingLabel(mode: unknown): string {
  if (mode === 'hidden') return '隐藏';
  if (mode === 'full') return '完整显示';
  if (mode === 'peek') return '显示5行';
  return '未识别的显示档位';
}

function execLabel(policy: unknown): string {
  if (policy === 'full') return '完整权限';
  if (policy === 'workspace') return '工作区';
  return '未识别的权限';
}

export function llmSectionFromSettings(
  settings: Record<string, unknown>,
  includeSecrets: boolean,
): PortableLlmSection {
  const apiKey = asString(settings.apiKey);
  const includeKey = includeSecrets && Boolean(apiKey);
  return {
    provider: asString(settings.provider),
    vendorId: asString(settings.vendorId),
    model: asString(settings.model),
    baseUrl: asString(settings.baseUrl),
    temperature: typeof settings.temperature === 'number' ? settings.temperature : undefined,
    systemPrompt: asString(settings.systemPrompt),
    maxTotalTokens: typeof settings.maxTotalTokens === 'number' ? settings.maxTotalTokens : undefined,
    compat: settings.compat,
    presets: settings.presets,
    execTimeoutSeconds:
      typeof settings.execTimeoutSeconds === 'number' ? settings.execTimeoutSeconds : undefined,
    apiKeyIncluded: includeKey,
    ...(includeKey ? { apiKey } : {}),
  };
}

export function webSearchSectionFromSettings(
  settings: { provider?: string; apiKey?: string | null },
  includeSecrets: boolean,
): PortableWebSearchSection {
  const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey : undefined;
  const includeKey = includeSecrets && Boolean(apiKey);
  return {
    provider: settings.provider,
    apiKeyIncluded: includeKey,
    ...(includeKey ? { apiKey } : {}),
  };
}

export function mcpSectionFromServer(
  server: {
    name: string;
    command: string;
    args: string[];
    cwd?: string;
    enabled: boolean;
    env: Record<string, string>;
  },
  includeSecrets: boolean,
): PortableMcpSection {
  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    cwd: server.cwd,
    enabled: server.enabled,
    envIncluded: includeSecrets,
    ...(includeSecrets ? { env: { ...server.env } } : {}),
  };
}

/**
 * 把消息正文和 metadata 里的旧附件绝对路径换成新会话里的路径。
 * 只改 `/attachments/<chatId>/<文件名>` 这一段，文件名必须整段匹配。
 */
export function rewriteAttachmentRefs(text: string, name: string, newPath: string): string {
  if (!name || !text.includes('/attachments/')) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '[^\\s`\'"]';
  const end = '[\\s`\'"]';
  return text.replace(
    new RegExp(`${boundary}*/attachments/${boundary}+/${escaped}(?=${end}|$)`, 'g'),
    () => newPath,
  );
}

function sectionPreview(id: PortableSectionId, value: unknown): PortablePreviewSection | null {
  const label = SECTION_LABELS[id];
  const clientOnly = isClientSectionId(id);
  if (id === 'llm' && isRecord(value)) {
    const model = asString(value.model) || '未填模型';
    const vendor = asString(value.vendorId) || asString(value.provider) || '模型';
    const hasSecret = value.apiKeyIncluded === true;
    return {
      id,
      label,
      detail: `${vendor} · ${model}${hasSecret ? ' · 含钥匙' : ''}`,
      clientOnly,
      hasSecret,
    };
  }
  if (id === 'webSearch' && isRecord(value)) {
    const hasSecret = value.apiKeyIncluded === true;
    return {
      id,
      label,
      detail: `${asString(value.provider) || '搜索'}${hasSecret ? ' · 含钥匙' : ''}`,
      clientOnly,
      hasSecret,
    };
  }
  if (id === 'mcp' && Array.isArray(value)) {
    const hasSecret = value.some((item) => isRecord(item) && item.envIncluded === true);
    return {
      id,
      label,
      detail: `${value.length} 个服务${hasSecret ? ' · 含环境变量' : ''}`,
      clientOnly,
      hasSecret,
    };
  }
  if (id === 'agents' && Array.isArray(value)) {
    return { id, label, detail: `${value.length} 个自定义智能体`, clientOnly, hasSecret: false };
  }
  if (id === 'skills' && isRecord(value) && Array.isArray(value.names)) {
    return { id, label, detail: `${value.names.length} 个技能名`, clientOnly, hasSecret: false };
  }
  if (id === 'telemetry' && isRecord(value)) {
    return {
      id,
      label,
      detail: asString(value.endpoint) || '未配置端点',
      clientOnly,
      hasSecret: false,
    };
  }
  if (id === 'insights' && isRecord(value)) {
    return { id, label, detail: '同意项与资料', clientOnly, hasSecret: false };
  }
  if (id === 'appearance' && isRecord(value)) {
    return { id, label, detail: thinkingLabel(value.thinkingDisplay), clientOnly, hasSecret: false };
  }
  if (id === 'execPolicy' && isRecord(value)) {
    return { id, label, detail: execLabel(value.policy), clientOnly, hasSecret: false };
  }
  return null;
}

function previewConfig(doc: Record<string, unknown>): PortablePreview | { error: string } {
  const sections = isRecord(doc.sections) ? doc.sections : null;
  if (!sections) return { error: '配置包缺少 sections' };
  const listed: PortablePreviewSection[] = [];
  for (const id of [...CLIENT_SECTION_IDS, ...SERVER_SECTION_IDS]) {
    if (!(id in sections)) continue;
    const row = sectionPreview(id, sections[id]);
    if (row) listed.push(row);
  }
  return {
    kind: PORTABLE_CONFIG_KIND,
    includeSecrets: doc.includeSecrets === true,
    sections: listed,
  };
}

function previewChat(doc: Record<string, unknown>): PortablePreview | { error: string } {
  const chat = isRecord(doc.chat) ? doc.chat : null;
  if (!chat || typeof chat.title !== 'string' || !chat.title.trim()) {
    return { error: '对话包缺少标题' };
  }
  if (!Array.isArray(doc.messages)) return { error: '对话包缺少 messages' };
  const attachments = Array.isArray(doc.attachments) ? doc.attachments : [];
  const withData = attachments.filter((item) => isRecord(item) && typeof item.data === 'string' && !item.omitted);
  const omitted = attachments.filter((item) => isRecord(item) && item.omitted === true);
  const project = readPortableProject(doc.project);
  return {
    kind: PORTABLE_CHAT_KIND,
    includeSecrets: false,
    sections: [],
    chat: {
      title: chat.title.trim(),
      messageCount: doc.messages.length,
      attachmentCount: withData.length,
      omittedAttachmentCount: omitted.length,
      truncated: doc.truncated === true,
      ...(project ? { projectName: project.name, projectCount: 1 } : {}),
    },
  };
}

/** 读一份导出文件。版本或 kind 不对时返回错误文案，不抛。 */
export function previewPortable(raw: unknown): PortablePreview | { error: string } {
  if (!isRecord(raw)) return { error: '文件不是 JSON 对象' };
  if (raw.schemaVersion !== PORTABLE_SCHEMA_VERSION) {
    return { error: '无法读取这份文件，需要更新客户端' };
  }
  if (raw.kind === PORTABLE_CONFIG_KIND) return previewConfig(raw);
  if (raw.kind === PORTABLE_CHAT_KIND) return previewChat(raw);
  if (raw.kind === PORTABLE_CHATS_KIND) return previewChats(raw);
  return { error: '无法识别的导出文件' };
}

function previewChats(doc: Record<string, unknown>): PortablePreview | { error: string } {
  if (!Array.isArray(doc.chats) || doc.chats.length === 0) return { error: '对话包里没有对话' };
  const titles: string[] = [];
  const projectNames = new Set<string>();
  let messageCount = 0;
  let attachmentCount = 0;
  let omittedAttachmentCount = 0;
  let truncated = false;
  for (const item of doc.chats) {
    if (!isRecord(item)) return { error: '对话包里有无法读取的会话' };
    const one = previewChat(item);
    if ('error' in one || !one.chat) {
      return 'error' in one ? one : { error: '对话包里有无法读取的会话' };
    }
    titles.push(one.chat.title);
    if (one.chat.projectName) projectNames.add(one.chat.projectName);
    messageCount += one.chat.messageCount;
    attachmentCount += one.chat.attachmentCount;
    omittedAttachmentCount += one.chat.omittedAttachmentCount;
    truncated = truncated || one.chat.truncated;
  }
  const count = titles.length;
  const projectCount = projectNames.size;
  const onlyProject = projectCount === 1 ? [...projectNames][0] : undefined;
  return {
    kind: PORTABLE_CHATS_KIND,
    includeSecrets: false,
    sections: [],
    chat: {
      title: count === 1 ? (titles[0] ?? '未命名') : `${count} 条对话`,
      messageCount,
      attachmentCount,
      omittedAttachmentCount,
      truncated,
      count,
      ...(projectCount > 0 ? { projectCount, ...(onlyProject ? { projectName: onlyProject } : {}) } : {}),
    },
  };
}

export function readConfigDocument(raw: unknown): PortableConfigDocument | { error: string } {
  const preview = previewPortable(raw);
  if ('error' in preview) return preview;
  if (preview.kind !== PORTABLE_CONFIG_KIND) return { error: '这是对话包，不能当作配置导入' };
  return raw as PortableConfigDocument;
}

export function readChatDocument(raw: unknown): PortableChatDocument | { error: string } {
  const preview = previewPortable(raw);
  if ('error' in preview) return preview;
  if (preview.kind !== PORTABLE_CHAT_KIND) return { error: '这是配置包，请在设置页导入' };
  const doc = raw as PortableChatDocument;
  const messages = doc.messages.filter(
    (message) =>
      message &&
      MESSAGE_ROLES.has(message.role) &&
      typeof message.content === 'string',
  );
  return { ...doc, messages };
}

export function selectedServerSections(
  sections: PortableConfigSections,
  selected: readonly string[] | undefined,
): ServerSectionId[] {
  const present = SERVER_SECTION_IDS.filter((id) => sections[id] !== undefined);
  if (!selected) return [...present];
  const allow = new Set(selected);
  return present.filter((id) => allow.has(id));
}
