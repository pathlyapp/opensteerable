/**
 * 渲染层读构建期注入的宿主工具族 / 安全询问。
 * 解析规则与 ts/src/host-tools.ts 对齐：缺省全开；对象必须显式 chrome:true。
 */

export type HostToolFamilyId =
  | 'terminal'
  | 'local-fs'
  | 'projects'
  | 'background-tasks'
  | 'mcp'
  | 'web'
  | 'plugins';

export interface HostToolFamilySurface {
  capability: boolean;
  chrome: boolean;
}

export type HostToolsConfig = Partial<
  Record<HostToolFamilyId, boolean | { capability?: boolean; chrome?: boolean }>
>;

export type ResolvedHostTools = Record<HostToolFamilyId, HostToolFamilySurface>;

const FAMILY_IDS: readonly HostToolFamilyId[] = [
  'terminal',
  'local-fs',
  'projects',
  'background-tasks',
  'mcp',
  'web',
  'plugins',
];

function resolveSurface(
  value: boolean | { capability?: boolean; chrome?: boolean } | undefined,
): HostToolFamilySurface {
  if (value === undefined || value === true) return { capability: true, chrome: true };
  if (value === false) return { capability: false, chrome: false };
  return {
    capability: value.capability !== false,
    chrome: value.chrome === true,
  };
}

export function resolveWebHostTools(config?: HostToolsConfig | null): ResolvedHostTools {
  const out = {} as ResolvedHostTools;
  for (const id of FAMILY_IDS) {
    out[id] = resolveSurface(config?.[id]);
  }
  return out;
}

function readHostToolsConfig(): HostToolsConfig {
  const raw = import.meta.env.VITE_HOST_TOOLS;
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    return parsed && typeof parsed === 'object' ? (parsed as HostToolsConfig) : {};
  } catch {
    return {};
  }
}

let cached: ResolvedHostTools | null = null;

export function getWebHostTools(): ResolvedHostTools {
  cached ??= resolveWebHostTools(readHostToolsConfig());
  return cached;
}

export function hostToolChrome(id: HostToolFamilyId): boolean {
  return getWebHostTools()[id].chrome;
}

export function hostToolCapability(id: HostToolFamilyId): boolean {
  return getWebHostTools()[id].capability;
}

export function isWebApprovalEnabled(): boolean {
  return import.meta.env.VITE_APPROVAL !== 'off';
}

export type ChatModeId = 'agent' | 'plan';

const DEFAULT_CHAT_MODES: ChatModeId[] = ['agent', 'plan'];

export function resolveWebChatModes(value?: unknown): ChatModeId[] {
  if (!Array.isArray(value)) return [...DEFAULT_CHAT_MODES];
  const allowed = DEFAULT_CHAT_MODES.filter((id) => value.includes(id));
  return allowed.length > 0 ? allowed : ['agent'];
}

function readChatModesConfig(): unknown {
  const raw = import.meta.env.VITE_CHAT_MODES;
  if (!raw) return undefined;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return undefined;
  }
}

let cachedModes: ChatModeId[] | null = null;

export function getWebChatModes(): ChatModeId[] {
  cachedModes ??= resolveWebChatModes(readChatModesConfig());
  return cachedModes;
}

export function clampWebChatMode(requested: unknown): ChatModeId {
  return requested === 'plan' && getWebChatModes().includes('plan') ? 'plan' : 'agent';
}

export const SETTINGS_ITEM_IDS = [
  'agents',
  'skills',
  'mcp',
  'appearance',
  'llm',
  'web-search',
  'usage',
  'diagnose',
  'security',
  'insights',
  'telemetry',
] as const;

export type SettingsItemId = (typeof SETTINGS_ITEM_IDS)[number];

export const GENERAL_SETTINGS_ITEM_IDS = [
  'appearance',
  'llm',
  'web-search',
  'usage',
  'diagnose',
  'security',
  'insights',
  'telemetry',
] as const;

export type SettingsChromeConfig = Partial<Record<SettingsItemId, boolean>>;

export type ResolvedSettingsChrome = Record<SettingsItemId, boolean>;

function settingsFollowsHostTool(id: SettingsItemId, tools: ResolvedHostTools): boolean {
  if (id === 'skills') return tools.plugins.chrome;
  if (id === 'mcp') return tools.mcp.chrome;
  if (id === 'web-search') return tools.web.chrome;
  return true;
}

export function resolveWebSettingsChrome(
  value?: unknown,
  tools: ResolvedHostTools = resolveWebHostTools(),
): ResolvedSettingsChrome {
  const config =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const out = {} as ResolvedSettingsChrome;
  for (const id of SETTINGS_ITEM_IDS) {
    out[id] = config[id] !== false && settingsFollowsHostTool(id, tools);
  }
  return out;
}

function readSettingsConfig(): unknown {
  const raw = import.meta.env.VITE_SETTINGS;
  if (!raw) return undefined;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return undefined;
  }
}

let cachedSettings: ResolvedSettingsChrome | null = null;

export function getWebSettingsChrome(): ResolvedSettingsChrome {
  cachedSettings ??= resolveWebSettingsChrome(readSettingsConfig(), getWebHostTools());
  return cachedSettings;
}

export function settingsChrome(id: SettingsItemId): boolean {
  return getWebSettingsChrome()[id];
}

export function hasGeneralSettingsChrome(): boolean {
  const chrome = getWebSettingsChrome();
  return GENERAL_SETTINGS_ITEM_IDS.some((id) => chrome[id]);
}

export function sanitizeRightPanelKind(kind: string | null | undefined): string | null {
  if (!kind) return null;
  if (kind === 'terminal') return hostToolChrome('terminal') ? 'terminal' : null;
  return kind;
}

/** 测试用：清掉缓存，让下次按新 env 重读。 */
export function resetWebHostToolsForTests(): void {
  cached = null;
  cachedModes = null;
  cachedSettings = null;
}
