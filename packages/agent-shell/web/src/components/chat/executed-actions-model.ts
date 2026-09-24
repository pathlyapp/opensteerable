/**
 * ExecutedActionsCard 的纯函数半侧（W5-2）：web_search / web_fetch 的
 * 中文摘要。从 action.arguments / action.result 提取关键信息，让工具卡
 * 一眼可读（查了什么、抓了什么、几条结果、HTTP 状态），而不是甩原始 JSON。
 *
 * result 的形态：sidecar ToolResult `{ success, data?, error? }`；桌面
 * CoreLoop 路径上 data 可能被 context-compactor 截断过大字段，但
 * result_count / status / bytes / truncated 这些小字段原样保留。
 */

import { findAgentForProfile } from './orchestration-children-model';

interface WebToolResultData {
  result_count?: unknown;
  status?: unknown;
  bytes?: unknown;
  truncated?: unknown;
  url?: unknown;
}

function resultData(result: unknown): WebToolResultData | null {
  if (!result || typeof result !== 'object') return null;
  const data = (result as { data?: unknown }).data;
  return data && typeof data === 'object' ? (data as WebToolResultData) : null;
}

function shortUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    const path = u.pathname === '/' ? '' : u.pathname;
    const text = `${u.host}${path}`;
    return text.length > 48 ? `${text.slice(0, 45)}…` : text;
  } catch {
    return raw.length > 48 ? `${raw.slice(0, 45)}…` : raw;
  }
}

function formatBytes(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/**
 * web_search / web_fetch 的卡片摘要；非这两个工具返回 null（调用方回落到
 * 通用参数摘要）。
 */
export function summarizeWebAction(
  tool: string,
  args: unknown,
  result: unknown,
): string | null {
  const obj =
    args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const data = resultData(result);
  const failed =
    result &&
    typeof result === 'object' &&
    (result as { success?: unknown }).success === false;

  if (tool === 'web_search') {
    const query = typeof obj.query === 'string' ? obj.query : '';
    const head = `搜索“${query.length > 40 ? `${query.slice(0, 37)}…` : query}”`;
    if (failed || !data) return head;
    const count = typeof data.result_count === 'number' ? data.result_count : null;
    return count === null ? head : `${head} → ${count} 条结果`;
  }
  if (tool === 'web_fetch') {
    const head = `抓取 ${shortUrl(obj.url) ?? '未知地址'}`;
    if (failed || !data) return head;
    const parts: string[] = [];
    if (typeof data.status === 'number') parts.push(String(data.status));
    const size = formatBytes(data.bytes);
    if (size) parts.push(size);
    if (data.truncated === true) parts.push('已截断');
    return parts.length > 0 ? `${head} → ${parts.join(' · ')}` : head;
  }
  return null;
}

interface RunCodeCall {
  tool?: unknown;
  arguments?: unknown;
  result?: unknown;
}

/**
 * run_code 的卡片摘要：描述 + 内层工具次数，而不是整段程序 JSON。
 */
export function summarizeRunCodeAction(
  tool: string,
  args: unknown,
  result: unknown,
): string | null {
  if (tool !== 'run_code') return null;
  const obj =
    args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const description =
    typeof obj.description === 'string' && obj.description.trim()
      ? obj.description.trim()
      : '程序';
  const head =
    description.length > 40 ? `${description.slice(0, 37)}…` : description;
  const data = resultData(result);
  const calls = Array.isArray((data as { calls?: unknown } | null)?.calls)
    ? ((data as { calls: RunCodeCall[] }).calls)
    : [];
  const failed =
    result &&
    typeof result === 'object' &&
    (result as { success?: unknown }).success === false;
  if (failed) return `程序「${head}」失败`;
  return calls.length > 0
    ? `程序「${head}」· ${calls.length} 个内层工具`
    : `程序「${head}」`;
}

export interface ExecutedActionLike {
  tool: string;
  arguments?: unknown;
  result?: unknown;
  sandbox?: { backend?: string; enforcement: string };
}

export interface DelegateSubagentView {
  profile: string | null;
  task: string | null;
}

const BUILTIN_DELEGATE_LABELS: Record<string, string> = {
  explore: '探索',
  research: '调研',
  coder: '编程',
  'general-purpose': '通用',
};

const BUILTIN_DELEGATE_COLORS: Record<string, string> = {
  explore: '#0ea5e9',
  research: '#2563eb',
  coder: '#16a34a',
  'general-purpose': '#7c3aed',
};

export interface TurnParticipant {
  key: string;
  name: string;
  color: string;
}

type AgentRef = { id: string; slug: string | null; name: string; color?: string | null };

function participantFromProfile(
  profile: string,
  agents: ReadonlyArray<AgentRef>,
): TurnParticipant {
  const match = findAgentForProfile(profile, agents);
  return {
    key: match?.id ?? profile,
    name: match?.name ?? BUILTIN_DELEGATE_LABELS[profile] ?? profile,
    color: match?.color || BUILTIN_DELEGATE_COLORS[profile] || '#7c3aed',
  };
}

/**
 * 本回合顶栏要画的智能体。用户 `@提及` 了谁就画谁（含父代理若未点名则
 * 仍放最前）；没有提及才回落到实际 `delegate_subagent` / 子代理生命周期，
 * 避免内置画像「探索」顶替用户点名的智能助手、日程规划。
 */
export function collectTurnParticipants(
  parent: { id: string; name: string; color?: string | null } | null,
  input: {
    agents?: ReadonlyArray<AgentRef>;
    children?: ReadonlyArray<{ profile?: string }>;
    actions?: ReadonlyArray<{ tool: string; arguments?: unknown }>;
    mentionedAgentIds?: string[];
  },
): TurnParticipant[] {
  const agents = input.agents ?? [];
  const out: TurnParticipant[] = [];
  const seen = new Set<string>();
  const push = (item: TurnParticipant) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    out.push(item);
  };
  const pushAgent = (agent: AgentRef) => {
    push({
      key: agent.id,
      name: agent.name,
      color: agent.color || '#7c3aed',
    });
  };
  const mentioned = (input.mentionedAgentIds ?? []).filter((id) => id.length > 0);
  if (mentioned.length > 0) {
    if (parent && !mentioned.includes(parent.id)) {
      push({
        key: parent.id,
        name: parent.name,
        color: parent.color || '#7c3aed',
      });
    }
    for (const id of mentioned) {
      const agent = agents.find((item) => item.id === id);
      if (agent) pushAgent(agent);
    }
    return out;
  }
  if (parent) {
    push({
      key: parent.id,
      name: parent.name,
      color: parent.color || '#7c3aed',
    });
  }
  for (const child of input.children ?? []) {
    if (child.profile) push(participantFromProfile(child.profile, agents));
  }
  for (const action of input.actions ?? []) {
    if (action.tool !== 'delegate_subagent') continue;
    const { profile } = parseDelegateSubagent(action.arguments);
    if (profile) push(participantFromProfile(profile, agents));
  }
  return out;
}

const MENTION_TOKEN = /(?<=^|\s)@([^\s@]+)/g;

function mentionedIdsFromMetadata(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const meta = JSON.parse(raw) as { mentionedAgentIds?: unknown };
    if (!Array.isArray(meta.mentionedAgentIds)) return [];
    return meta.mentionedAgentIds.filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
  } catch {
    return [];
  }
}

/** 上一轮用户消息里点名的智能体：优先 metadata，否则按正文 `@名` 扫描。 */
export function extractMentionedAgentIds(
  user: { content?: string; messageMetadata?: string | null } | null | undefined,
  agents: ReadonlyArray<AgentRef>,
): string[] {
  if (!user) return [];
  const fromMeta = mentionedIdsFromMetadata(user.messageMetadata);
  if (fromMeta.length > 0) {
    const known = new Set(agents.map((agent) => agent.id));
    return fromMeta.filter((id) => known.has(id));
  }
  const content = user.content ?? '';
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of content.matchAll(MENTION_TOKEN)) {
    const name = match[1];
    const agent = agents.find((item) => item.name === name || item.slug === name);
    if (!agent || seen.has(agent.id)) continue;
    seen.add(agent.id);
    ids.push(agent.id);
  }
  return ids;
}

/**
 * `delegate_subagent` 的参数投影：画像名 + 自包含任务正文。
 */
export function parseDelegateSubagent(args: unknown): DelegateSubagentView {
  if (!args || typeof args !== 'object') return { profile: null, task: null };
  const obj = args as Record<string, unknown>;
  const profile =
    typeof obj.subagent_type === 'string' && obj.subagent_type.trim()
      ? obj.subagent_type.trim()
      : null;
  const task =
    typeof obj.task === 'string' && obj.task.trim() ? obj.task.trim() : null;
  return { profile, task };
}

/**
 * 把 `subagent_type` 映射成卡片上的显示名：先匹配会话智能体，再退回内置画像中文名，再退回画像原文。
 */
export function delegateSubagentDisplayName(
  profile: string | null,
  agents: ReadonlyArray<{ id: string; slug: string | null; name: string }>,
): string {
  if (!profile) return '子代理';
  const match = findAgentForProfile(profile, agents);
  if (match) return match.name;
  return BUILTIN_DELEGATE_LABELS[profile] ?? profile;
}

/** 任务正文作行摘要；没有任务时返回 null，调用方不再回落 JSON。 */
export function summarizeDelegateSubagent(args: unknown): string | null {
  const { task } = parseDelegateSubagent(args);
  if (!task) return null;
  return clip(task);
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const ENVELOPE_KEYS = new Set([
  'success',
  'error',
  'message',
  'data',
  'needsFollowup',
  'terminal',
  'nextAction',
]);

/** Sidecar `ToolResult` plus JSON 字符串；`fields` 是 data 与顶层业务字段的合并。 */
export interface ToolEnvelope {
  success: boolean | null;
  error: string | null;
  message: string | null;
  fields: Record<string, unknown>;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function parseToolEnvelope(result: unknown): ToolEnvelope {
  const parsed = parseJsonValue(result);
  const obj = asObject(parsed);
  if (!obj) {
    return {
      success: null,
      error: null,
      message: typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null,
      fields: {},
    };
  }
  const data = asObject(obj.data);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!ENVELOPE_KEYS.has(key) && value !== undefined) fields[key] = value;
  }
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (key === 'durationMs' || value === undefined) continue;
      fields[key] = value;
    }
  }
  const dataText = typeof obj.data === 'string' && obj.data.trim() ? obj.data.trim() : null;
  return {
    success: typeof obj.success === 'boolean' ? obj.success : null,
    error: stringField(obj, 'error'),
    message: stringField(obj, 'message') ?? dataText,
    fields,
  };
}

const DELEGATE_STATUS_ZH: Record<string, string> = {
  budget_exhausted: '额度耗尽',
  failed: '失败',
  cancelled: '已取消',
};

/** 把 sidecar 的英文失败句收成行头/错误栏可读的中文。 */
export function humanizeDelegateError(error: string | null): string | null {
  if (!error) return null;
  if (error.includes('orchestration_budget_exceeded')) return '编排额度已用尽';
  const ended = error.match(/sub-agent ended with status:\s*(\S+)/i);
  if (ended) {
    const status = ended[1].replace(/[.,;]+$/, '');
    return `子代理因${DELEGATE_STATUS_ZH[status] ?? status}结束`;
  }
  if (error.includes('budget_exhausted')) return '子代理因额度耗尽结束';
  return error;
}

export interface TaskSnapshotView {
  taskId: string | null;
  status: string | null;
  task: string | null;
  answer: string | null;
  error: string | null;
  worktreeLabel: string | null;
  hint: string | null;
}

function worktreeLabel(obj: Record<string, unknown>): string | null {
  const path = stringField(obj, 'worktreePath');
  if (path) return path;
  const wt = asObject(obj.worktree);
  if (!wt) return null;
  const wtPath = stringField(wt, 'path');
  const branch = stringField(wt, 'branch');
  if (wtPath && branch) return `${wtPath} · ${branch}`;
  return wtPath ?? branch;
}

function snapshotFromRecord(obj: Record<string, unknown>): TaskSnapshotView {
  return {
    taskId: stringField(obj, 'taskId'),
    status: stringField(obj, 'status'),
    task: stringField(obj, 'task'),
    answer: stringField(obj, 'answer') ?? stringField(obj, 'answerPreview'),
    error: stringField(obj, 'error'),
    worktreeLabel: worktreeLabel(obj),
    hint: stringField(obj, 'hint'),
  };
}

function snapshotUseful(view: TaskSnapshotView): boolean {
  return Boolean(
    view.taskId || view.status || view.task || view.answer || view.worktreeLabel || view.hint,
  );
}

/** `task_*` 工具结果：兼容扁平返回和 CoreLoop `{success, data:{task}}`。 */
export function parseTaskToolOutput(result: unknown): {
  items: TaskSnapshotView[];
  hint: string | null;
  error: string | null;
} {
  const env = parseToolEnvelope(result);
  const nested = asObject(env.fields.task);
  const items: TaskSnapshotView[] = [];
  if (Array.isArray(env.fields.tasks)) {
    for (const row of env.fields.tasks) {
      const obj = asObject(row);
      if (!obj) continue;
      const view = snapshotFromRecord(obj);
      if (snapshotUseful(view)) items.push(view);
    }
  } else if (nested) {
    const view = snapshotFromRecord(nested);
    if (snapshotUseful(view)) items.push(view);
  } else {
    const view = snapshotFromRecord(env.fields);
    if (snapshotUseful(view)) items.push(view);
  }
  return {
    items,
    hint: stringField(env.fields, 'hint'),
    error: env.error,
  };
}

/** 右侧过程栏的打开目标。终态卡用 `task` 当标题。 */
export interface InspectTaskInput {
  id: string;
  chatId: string;
  title?: string;
  task?: string;
  /** 子代理过程：按它自己的 durable record 读，而不是任务表。 */
  recordId?: string;
  /** 目标仍在运行——面板据此轮询并显示「正在推理」。 */
  live?: boolean;
}

export function inspectTaskTitle(input: InspectTaskInput): string {
  return input.title ?? input.task ?? '后台任务';
}

/** 工具行能打开右侧「后台推理」时抽出 taskId 和标题。 */
export function inspectableTaskFromAction(
  tool: string,
  args: unknown,
  result?: unknown,
): { id: string; title: string } | null {
  if (!isTaskFamilyTool(tool)) return null;
  const parsed = parseTaskToolOutput(result);
  const argId = stringField(asObject(args), 'taskId');
  const id = parsed.items[0]?.taskId ?? argId;
  if (!id) return null;
  const title =
    parseTaskRun(args).task
    ?? parsed.items[0]?.task
    ?? parsed.items[0]?.hint
    ?? '后台任务';
  return { id, title };
}

export interface TaskRunView {
  task: string | null;
  worktree: boolean;
  worktreeName: string | null;
  dependsOn: string[];
}

/** `task_run` 的参数投影。 */
export function parseTaskRun(args: unknown): TaskRunView {
  const obj = asObject(args);
  const dependsOn = Array.isArray(obj?.dependsOn)
    ? obj.dependsOn.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  return {
    task: stringField(obj, 'task'),
    worktree: obj?.worktree === true,
    worktreeName: stringField(obj, 'worktreeName'),
    dependsOn,
  };
}

export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

export const TASK_FAMILY_TOOLS = [
  'task_run',
  'task_send',
  'task_status',
  'task_result',
] as const;

export type TaskFamilyTool = (typeof TASK_FAMILY_TOOLS)[number];

export function isTaskFamilyTool(tool: string): tool is TaskFamilyTool {
  return (TASK_FAMILY_TOOLS as readonly string[]).includes(tool);
}

/** 行头标题：不露出 `task_run` 这类工具原名。 */
export function taskToolLabel(tool: string, args: unknown): string | null {
  switch (tool) {
    case 'task_run':
      return parseTaskRun(args).worktree ? '后台任务 · 隔离' : '后台任务';
    case 'task_send':
      return '转达任务';
    case 'task_status':
      return '查询任务';
    case 'task_result':
      return '收取结果';
    default:
      return null;
  }
}

function taskRunStatus(result: unknown): string | null {
  const env = parseToolEnvelope(result);
  const direct = stringField(env.fields, 'status');
  if (direct) return direct;
  const nested = asObject(env.fields.task);
  return nested ? stringField(nested, 'status') : null;
}

/** `task_*` 家族的行摘要。 */
export function summarizeTaskAction(
  tool: string,
  args: unknown,
  result?: unknown,
): string | null {
  if (tool === 'task_run') {
    const parsed = parseTaskRun(args);
    if (!parsed.task) return null;
    const head = clip(parsed.task);
    if (taskRunStatus(result) === 'blocked') return `${head} · 等待依赖`;
    if (parsed.worktree) return `${head} · 隔离工作区`;
    return head;
  }
  if (tool === 'task_send') {
    const message = stringField(asObject(args), 'message');
    return message ? clip(message) : null;
  }
  if (tool === 'task_status') {
    const id = stringField(asObject(args), 'taskId');
    if (id) return shortTaskId(id);
    const total = asObject(result)?.total;
    return typeof total === 'number' ? `${total} 个任务` : '本会话';
  }
  if (tool === 'task_result') {
    const id = stringField(asObject(args), 'taskId');
    return id ? shortTaskId(id) : null;
  }
  return null;
}

/** Flatten a run_code action into the outer program plus inner tool rows. */
export function expandRunCodeActions<T extends ExecutedActionLike>(actions: T[]): T[] {
  const out: T[] = [];
  for (const action of actions) {
    out.push(action);
    if (action.tool !== 'run_code') continue;
    const data = resultData(action.result) as { calls?: RunCodeCall[] } | null;
    const calls = Array.isArray(data?.calls) ? data.calls : [];
    for (const call of calls) {
      const name = typeof call.tool === 'string' ? call.tool : 'tool';
      out.push({
        ...action,
        tool: name,
        arguments: call.arguments,
        result: call.result,
      });
    }
  }
  return out;
}
