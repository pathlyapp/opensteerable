/**
 * 宿主工具族：产品声明引入哪些工具，服务端按同一份配置钳死围栏 / 路由 / 工具面。
 * 渲染层只投影 chrome；缺省（中性 shell、未声明的族）全开，兼容存量产品。
 */

export const HOST_TOOL_FAMILY_IDS = [
  'terminal',
  'local-fs',
  'projects',
  'background-tasks',
  'mcp',
  'web',
  'plugins',
] as const;

export type HostToolFamilyId = (typeof HOST_TOOL_FAMILY_IDS)[number];

export interface HostToolFamilySurface {
  /** 模型可见工具 + 围栏 / 服务端能力。 */
  capability: boolean;
  /** 用户入口：按钮、菜单、项目分组、点路径打开、附件上传、可见 PTY。 */
  chrome: boolean;
}

/** 产品声明：`true` 两边开，`false` 两边关，对象可拆 chrome / capability。 */
export type HostToolsConfig = Partial<
  Record<HostToolFamilyId, boolean | { capability?: boolean; chrome?: boolean }>
>;

export type ResolvedHostTools = Record<HostToolFamilyId, HostToolFamilySurface>;

export type ApprovalMode = 'host' | 'off';

export const LOCAL_FS_TOOL_NAMES = [
  'local_exec_shell',
  'local_read_file',
  'local_write_file',
  'local_edit_file',
  'local_open_path',
  'local_run_snippet',
  'local_list_scripts',
  'local_run_script',
] as const;

const FAMILY_TOOL_PREFIX: Record<HostToolFamilyId, readonly string[]> = {
  terminal: [],
  projects: [],
  'local-fs': LOCAL_FS_TOOL_NAMES,
  'background-tasks': [
    'task_run',
    'task_send',
    'task_status',
    'task_result',
    'worktree_create',
    'worktree_list',
    'worktree_remove',
  ],
  mcp: ['mcp_list_tools', 'mcp_tool_exec'],
  web: ['web_search', 'web_fetch'],
  plugins: ['plugin_list', 'plugin_enable', 'plugin_disable', 'plugin_reload'],
};

const ALL_ON: HostToolFamilySurface = { capability: true, chrome: true };
const ALL_OFF: HostToolFamilySurface = { capability: false, chrome: false };

export function resolveHostToolSurface(
  value: boolean | { capability?: boolean; chrome?: boolean } | undefined,
): HostToolFamilySurface {
  if (value === undefined) return { ...ALL_ON };
  if (value === true) return { ...ALL_ON };
  if (value === false) return { ...ALL_OFF };
  return {
    capability: value.capability !== false,
    chrome: value.chrome === true,
  };
}

/**
 * 对象声明必须显式 `chrome: true` 才开入口。
 * `capability` 缺省为 true——只关入口写成 `{ chrome: false }` 即可。
 */
export function resolveHostTools(config?: HostToolsConfig | null): ResolvedHostTools {
  const out = {} as ResolvedHostTools;
  for (const id of HOST_TOOL_FAMILY_IDS) {
    out[id] = resolveHostToolSurface(config?.[id]);
  }
  return out;
}

export function resolveApprovalMode(value: unknown): ApprovalMode {
  return value === 'off' ? 'off' : 'host';
}

/**
 * 产品 `approval: "off"` 或 STEERABLE_APPROVAL=0 时本轮不挂 host 审批。
 * 环境变量是调试逃生口；产品字段是装配真源。
 */
export function isApprovalEnabled(input: {
  productApproval?: unknown;
  envApproval?: string;
} = {}): boolean {
  if (input.envApproval === '0') return false;
  return resolveApprovalMode(input.productApproval) === 'host';
}

export function clampExecPolicy(
  requested: unknown,
  tools: ResolvedHostTools = resolveHostTools(),
): 'workspace' | 'full' {
  if (!tools['local-fs'].chrome) return 'workspace';
  return requested === 'full' ? 'full' : 'workspace';
}

export function familyForHostToolName(name: string): HostToolFamilyId | null {
  if (name.startsWith('mcp__')) return 'mcp';
  for (const id of HOST_TOOL_FAMILY_IDS) {
    if (FAMILY_TOOL_PREFIX[id].includes(name)) return id;
  }
  return null;
}

export function isHostToolCapabilityEnabled(
  name: string,
  tools: ResolvedHostTools = resolveHostTools(),
): boolean {
  const family = familyForHostToolName(name);
  return family == null ? true : tools[family].capability;
}

export function isHostRouteAllowed(
  pathname: string,
  tools: ResolvedHostTools = resolveHostTools(),
): boolean {
  if (pathname.startsWith('/host/terminal')) return tools.terminal.chrome;
  if (pathname === '/host/attachments/save' || pathname === '/host/local/open-path') {
    return tools['local-fs'].chrome;
  }
  if (pathname.startsWith('/host/local/')) return tools['local-fs'].capability;
  return true;
}

export function sanitizeRightPanelKind(
  kind: string | null | undefined,
  tools: ResolvedHostTools = resolveHostTools(),
): string | null {
  if (!kind) return null;
  if (kind === 'terminal') return tools.terminal.chrome ? 'terminal' : null;
  return kind;
}

/** Electron IPC 通道与 HTTP `/host/*` 用同一套 chrome / capability 规则。 */
export function isHostIpcAllowed(
  channel: string,
  tools: ResolvedHostTools = resolveHostTools(),
): boolean {
  if (channel.startsWith('terminal:')) return tools.terminal.chrome;
  if (channel === 'local:open-path' || channel === 'attachments:save') {
    return tools['local-fs'].chrome;
  }
  if (channel.startsWith('local:')) return tools['local-fs'].capability;
  return true;
}

/** 本轮是否挂 host 审批对象；关掉时返回 undefined（sidecar 不弹询问）。 */
export function buildHostApproval(input: {
  productApproval?: unknown;
  envApproval?: string;
  storePath: string;
  timeoutMs?: number;
}): { mode: 'host'; timeoutMs: number; storePath: string } | undefined {
  if (!isApprovalEnabled(input)) return undefined;
  return {
    mode: 'host',
    timeoutMs: input.timeoutMs ?? 120_000,
    storePath: input.storePath,
  };
}
