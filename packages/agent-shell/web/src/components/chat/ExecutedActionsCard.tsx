import type { ReactNode } from 'react';
import { LuCircleCheck, LuCircleX, LuListTodo } from 'react-icons/lu';
import { ToolExecutionCard } from '@steerable/agent-ui/cards';
import type { ToolExecutionPayload } from '@steerable/agent-protocol';
import type { LocalChatAgent } from '@/lib/local-api';
import { UnifiedDiff } from './UnifiedDiff';
import {
  summarizeRunCodeAction,
  summarizeWebAction,
  expandRunCodeActions,
  parseDelegateSubagent,
  summarizeDelegateSubagent,
  delegateSubagentDisplayName,
  parseTaskRun,
  parseTaskToolOutput,
  parseToolEnvelope,
  humanizeDelegateError,
  summarizeTaskAction,
  taskToolLabel,
  isTaskFamilyTool,
  inspectableTaskFromAction,
  shortTaskId,
  type InspectTaskInput,
} from './executed-actions-model';
import {
  findAgentForProfile,
  matchChildForDelegation,
  type ChildInfo,
} from './orchestration-children-model';

/**
 * ExecutedActionsCard — visual surface for the `executed_actions` SSE event
 * emitted by local-backend after each tool-call round.
 *
 * Per `src/local-backend/router.ts` each entry is:
 *   { tool, mode, policy, shellClassification, arguments, result }
 *
 * The list rendering is delegated to `@steerable/agent-ui/cards`'
 * `ToolExecutionCard`; this file is the thin local adapter that:
 *   1. Maps the local-backend `ExecutedAction` shape to the framework's
 *      canonical `ToolExecutionPayload` (id / name / status / args / output).
 *   2. Adds the "已自动执行 N 个操作" summary banner above the list — the
 *      framework intentionally leaves grouping policy to the host app since
 *      different products count successes / failures differently.
 */

export interface ExecutedAction {
  /** Sidecar tool-call id; used to update a running row when the result lands. */
  id?: string;
  tool: string;
  mode?: string;
  policy?: unknown;
  shellClassification?: string;
  arguments?: unknown;
  result?: unknown;
  /**
   * W4-2: per-exec sandbox marker (`data._sandbox` lifted by the CoreLoop).
   * enforcement: full = OS deny-by-default; partial = documented gap (e.g.
   * port-only egress); none = no backend on this platform.
   */
  sandbox?: { backend?: string; enforcement: string };
}

interface ExecutedActionsCardProps {
  actions: ExecutedAction[];
  /** Drop the outer card chrome when nested in a turn-process group. */
  compact?: boolean;
  /** Show args/output instead of a one-line summary. Defaults to collapsed. */
  defaultExpanded?: boolean;
  /** Used to map `delegate_subagent` 画像名 to the agent's display name + color. */
  agents?: ReadonlyArray<Pick<LocalChatAgent, 'id' | 'slug' | 'name' | 'color'>>;
  chatId?: string | null;
  onInspectTask?: (task: InspectTaskInput) => void;
  /**
   * 本回合的子代理生命周期。委派行据此找到子代理自己的 record，点一下就能
   * 在右侧看它的推理过程。
   */
  orchestrationChildren?: ChildInfo[];
}

function deriveStatus(action: ExecutedAction): ToolExecutionPayload['status'] {
  const result = action.result;
  if (result === undefined || result === null) return 'running';
  const env = parseToolEnvelope(result);
  if (env.success === false || env.error) return 'failed';
  if (env.success === true) return 'succeeded';
  if (typeof result !== 'object') return 'succeeded';
  if ('error' in result) return 'failed';
  return 'succeeded';
}

function summarizeArguments(args: unknown): string | null {
  if (args === null || args === undefined) return null;
  if (typeof args === 'string') return args.length > 60 ? args.slice(0, 57) + '…' : args;
  if (typeof args !== 'object') return String(args);
  const obj = args as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'query', 'path', 'file', 'target', 'message']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 60 ? v.slice(0, 57) + '…' : v;
    }
  }
  return null;
}

function sandboxBadge(sandbox: ExecutedAction['sandbox']): string | null {
  if (!sandbox) return null;
  switch (sandbox.enforcement) {
    case 'full':
      return '[沙箱]';
    case 'partial':
      return '[沙箱·部分]';
    default:
      return '[未沙箱]';
  }
}

function actionToTool(action: ExecutedAction, idx: number): ToolExecutionPayload {
  const status = deriveStatus(action);
  const env = parseToolEnvelope(action.result);
  const errorText =
    status === 'failed'
      ? action.tool === 'delegate_subagent'
        ? humanizeDelegateError(env.error)
        : env.error
      : null;
  // W5-2: web_search/web_fetch 用结构化中文摘要（查询词/URL + 结果计数/
  // 状态码），其余工具走通用参数摘要。
  const summary =
    (action.tool === 'delegate_subagent'
      ? summarizeDelegateSubagent(action.arguments)
      : null) ??
    (isTaskFamilyTool(action.tool)
      ? summarizeTaskAction(action.tool, action.arguments, action.result)
      : null) ??
    summarizeRunCodeAction(action.tool, action.arguments, action.result) ??
    summarizeWebAction(action.tool, action.arguments, action.result) ??
    summarizeArguments(action.arguments);
  const badge = sandboxBadge(action.sandbox);
  return {
    id: action.id ?? `${action.tool}-${idx}`,
    name: action.tool,
    status,
    summary: badge ? `${badge} ${summary ?? ''}`.trim() : summary,
    args: action.arguments,
    output: action.result,
    error: errorText,
    durationMs: null,
    icon: null,
    expandable: true,
  };
}

/**
 * renderOutput slot for ToolExecutionCard: when a tool result carries a
 * unified `diff` (local_edit_file), render it as a coloured diff; otherwise
 * fall back to the default JSON/text view.
 */
function renderActionOutput(output: unknown): ReactNode {
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    if (typeof obj.diff === 'string' && obj.diff.length > 0) {
      const { diff, ...rest } = obj;
      const hasRest = Object.keys(rest).some(
        (k) => k !== 'success' && rest[k] !== undefined && rest[k] !== null,
      );
      return (
        <div className="space-y-2">
          <UnifiedDiff diff={diff} />
          {hasRest && (
            <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5 text-[11px] text-agent-foreground">
              {JSON.stringify(rest, null, 2)}
            </pre>
          )}
        </div>
      );
    }
  }
  if (output === undefined || output === null) return null;
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return (
    <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5 text-[11px] text-agent-foreground">
      {text}
    </pre>
  );
}

const BUILTIN_DELEGATE_COLORS: Record<string, string> = {
  explore: '#0ea5e9',
  research: '#2563eb',
  coder: '#16a34a',
  'general-purpose': '#7c3aed',
};

function delegateColor(
  profile: string | null,
  agents: ReadonlyArray<Pick<LocalChatAgent, 'id' | 'slug' | 'name' | 'color'>>,
): string {
  if (profile) {
    const agent = findAgentForProfile(profile, agents);
    if (agent?.color) return agent.color;
    if (BUILTIN_DELEGATE_COLORS[profile]) return BUILTIN_DELEGATE_COLORS[profile];
  }
  return '#7c3aed';
}

function DelegateLead({
  name,
  color,
}: {
  name: string;
  color: string;
}) {
  return (
    <span
      data-agent-color-dot=""
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white"
      style={{ backgroundColor: color }}
      aria-hidden
    >
      {name.trim()[0]?.toUpperCase() ?? 'A'}
    </span>
  );
}

function renderDelegateArgs(
  args: unknown,
  agents: ReadonlyArray<Pick<LocalChatAgent, 'id' | 'slug' | 'name' | 'color'>>,
): ReactNode {
  const { profile, task } = parseDelegateSubagent(args);
  if (!profile && !task) {
    return (
      <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5 text-[11px] text-agent-foreground">
        {typeof args === 'string' ? args : JSON.stringify(args, null, 2)}
      </pre>
    );
  }
  // 自建智能体没有 slug 时画像名是 `agent-<id 片段>`，对用户无意义——出中文名。
  const displayName = delegateSubagentDisplayName(profile, agents);
  return (
    <div className="space-y-1.5 text-[11px] text-agent-foreground">
      {profile ? (
        <section>
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-agent-muted-foreground">
            子代理
          </div>
          <div className="text-[11px]">{displayName}</div>
        </section>
      ) : null}
      {task ? (
        <section>
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-agent-muted-foreground">
            任务
          </div>
          <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5">
            {task}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

function renderDelegateOutput(output: unknown): ReactNode {
  const env = parseToolEnvelope(output);
  if (env.message) {
    return (
      <div className="space-y-1.5">
        {kvBlock(
          '回报',
          <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5">
            {env.message}
          </pre>,
        )}
      </div>
    );
  }
  if (env.error || env.success === false) {
    return <div className="text-[11px] text-agent-muted-foreground">没有文字回报</div>;
  }
  return renderActionOutput(output);
}

function TaskLead() {
  return (
    <span
      data-task-lead=""
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded bg-amber-100/80 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
      aria-hidden
    >
      <LuListTodo className="h-2.5 w-2.5" />
    </span>
  );
}

const TASK_STATUS_ZH: Record<string, string> = {
  running: '已启动',
  blocked: '等待依赖',
  completed: '已完成',
  failed: '失败',
};

function kvBlock(label: string, value: ReactNode): ReactNode {
  return (
    <section>
      <div className="mb-0.5 text-[10px] uppercase tracking-wider text-agent-muted-foreground">
        {label}
      </div>
      <div className="text-[11px] text-agent-foreground">{value}</div>
    </section>
  );
}

function renderTaskArgs(tool: string, args: unknown): ReactNode {
  if (tool === 'task_run') {
    const parsed = parseTaskRun(args);
    if (!parsed.task && parsed.dependsOn.length === 0 && !parsed.worktree) {
      return renderActionOutput(args);
    }
    return (
      <div className="space-y-1.5">
        {parsed.task
          ? kvBlock(
              '任务',
              <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5">
                {parsed.task}
              </pre>,
            )
          : null}
        {parsed.dependsOn.length > 0
          ? kvBlock('依赖', parsed.dependsOn.map(shortTaskId).join('、'))
          : null}
        {parsed.worktree
          ? kvBlock('工作区', parsed.worktreeName ? `隔离 · ${parsed.worktreeName}` : '隔离')
          : null}
      </div>
    );
  }
  const obj = args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
  const taskId = typeof obj?.taskId === 'string' ? obj.taskId : null;
  const message = typeof obj?.message === 'string' ? obj.message : null;
  if (!taskId && !message) return renderActionOutput(args);
  return (
    <div className="space-y-1.5">
      {taskId ? kvBlock('编号', <span className="font-mono">{shortTaskId(taskId)}</span>) : null}
      {message
        ? kvBlock(
            '消息',
            <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5">
              {message}
            </pre>,
          )
        : null}
    </div>
  );
}

function renderTaskOutput(output: unknown): ReactNode {
  const parsed = parseTaskToolOutput(output);
  if (parsed.items.length === 0 && !parsed.hint) {
    return renderActionOutput(output);
  }
  return (
    <div className="space-y-2">
      {parsed.items.map((item, index) => (
        <div key={item.taskId ?? `task-${index}`} className="space-y-1.5">
          {item.taskId
            ? kvBlock('编号', <span className="font-mono">{shortTaskId(item.taskId)}</span>)
            : null}
          {item.status ? kvBlock('状态', TASK_STATUS_ZH[item.status] ?? item.status) : null}
          {item.task
            ? kvBlock(
                '任务',
                <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5">
                  {item.task}
                </pre>,
              )
            : null}
          {item.worktreeLabel ? kvBlock('工作区', item.worktreeLabel) : null}
          {item.hint ? kvBlock('说明', item.hint) : null}
          {item.answer
            ? kvBlock(
                '结果',
                <pre className="whitespace-pre-wrap break-words rounded bg-agent-muted/40 px-2 py-1.5">
                  {item.answer}
                </pre>,
              )
            : null}
          {item.error ? kvBlock('原因', item.error) : null}
        </div>
      ))}
      {parsed.hint && parsed.items.every((item) => item.hint !== parsed.hint)
        ? kvBlock('说明', parsed.hint)
        : null}
    </div>
  );
}

function toolCardExtras(
  action: ExecutedAction,
  agents: ReadonlyArray<Pick<LocalChatAgent, 'id' | 'slug' | 'name' | 'color'>>,
): {
  label?: string;
  lead?: ReactNode;
  renderArgs?: (args: unknown) => ReactNode;
  renderOutput?: (output: unknown) => ReactNode;
} {
  if (action.tool === 'delegate_subagent') {
    const { profile } = parseDelegateSubagent(action.arguments);
    const displayName = delegateSubagentDisplayName(profile, agents);
    return {
      label: `委派 · ${displayName}`,
      lead: <DelegateLead name={displayName} color={delegateColor(profile, agents)} />,
      renderArgs: (args) => renderDelegateArgs(args, agents),
      renderOutput: renderDelegateOutput,
    };
  }
  if (isTaskFamilyTool(action.tool)) {
    return {
      label: taskToolLabel(action.tool, action.arguments) ?? undefined,
      lead: <TaskLead />,
      renderArgs: (args) => renderTaskArgs(action.tool, args),
      renderOutput: renderTaskOutput,
    };
  }
  return { renderOutput: renderActionOutput };
}

function inspectActivate(
  action: ExecutedAction,
  chatId: string | null | undefined,
  onInspectTask?: (task: InspectTaskInput) => void,
  child?: ChildInfo,
): { onActivate?: () => void; activateTitle?: string } {
  if (!chatId || !onInspectTask) return {};
  if (action.tool === 'delegate_subagent') {
    if (!child?.recordId) return {};
    const { task } = parseDelegateSubagent(action.arguments);
    return {
      onActivate: () =>
        onInspectTask({
          id: child.childId,
          chatId,
          recordId: child.recordId,
          live: child.status === 'running',
          title: task ?? '子代理任务',
        }),
      activateTitle: '查看子代理执行过程',
    };
  }
  const target = inspectableTaskFromAction(action.tool, action.arguments, action.result);
  if (!target) return {};
  return {
    onActivate: () => onInspectTask({ id: target.id, chatId, title: target.title }),
    activateTitle: '查看后台执行过程',
  };
}

/** 逐行配对委派与子代理：同画像多份活时按出现顺序对上。 */
function delegationChildren(
  actions: readonly ExecutedAction[],
  children: readonly ChildInfo[],
): Map<number, ChildInfo> {
  const paired = new Map<number, ChildInfo>();
  if (children.length === 0) return paired;
  const taken = new Set<string>();
  actions.forEach((action, index) => {
    if (action.tool !== 'delegate_subagent') return;
    const match = matchChildForDelegation(
      parseDelegateSubagent(action.arguments),
      children,
      taken,
    );
    if (!match) return;
    taken.add(match.childId);
    paired.set(index, match);
  });
  return paired;
}

/** Inline tool rows for a mixed think→act timeline (no summary banner). */
export function ToolsFlow({
  actions,
  compact = false,
  defaultExpanded = false,
  agents = [],
  chatId = null,
  onInspectTask,
  orchestrationChildren = [],
}: ExecutedActionsCardProps) {
  if (!actions || actions.length === 0) return null;
  const expanded = expandRunCodeActions(actions);
  const childByIndex = delegationChildren(expanded, orchestrationChildren);
  return (
    <div
      className={
        compact
          ? 'overflow-hidden rounded-agent-md border border-agent-border/80 bg-agent-canvas'
          : 'my-2 overflow-hidden rounded-agent-md border border-agent-border bg-agent-canvas'
      }
    >
      <div className="space-y-px">
        {expanded.map((action, i) => {
          const extras = toolCardExtras(action, agents);
          const inspect = inspectActivate(action, chatId, onInspectTask, childByIndex.get(i));
          return (
            <ToolExecutionCard
              key={action.id ?? `${action.tool}-${i}`}
              payload={actionToTool(action, i)}
              defaultExpanded={defaultExpanded}
              label={extras.label}
              lead={extras.lead}
              renderArgs={extras.renderArgs}
              renderOutput={extras.renderOutput ?? renderActionOutput}
              onActivate={inspect.onActivate}
              activateTitle={inspect.activateTitle}
              className="rounded-none border-0 border-t border-agent-border first:border-t-0"
            />
          );
        })}
      </div>
    </div>
  );
}

export function ExecutedActionsCard({
  actions,
  agents = [],
  chatId = null,
  onInspectTask,
  orchestrationChildren = [],
}: ExecutedActionsCardProps) {
  if (!actions || actions.length === 0) return null;

  const expanded = expandRunCodeActions(actions);
  const childByIndex = delegationChildren(expanded, orchestrationChildren);
  const successCount = expanded.filter((a) => deriveStatus(a) === 'succeeded').length;
  const failureCount = expanded.filter((a) => deriveStatus(a) === 'failed').length;
  const runningCount = expanded.filter((a) => deriveStatus(a) === 'running').length;

  return (
    <div className="my-1.5 overflow-hidden rounded-agent-md border border-agent-border bg-agent-canvas">
      <div className="flex items-center justify-between border-b border-agent-border bg-agent-muted/30 px-2.5 py-1">
        <div className="flex items-center gap-1.5 text-xs">
          {failureCount === 0 ? (
            <LuCircleCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <LuCircleX className="h-3.5 w-3.5 text-agent-destructive" />
          )}
          <span className="font-medium text-agent-foreground">
            已自动执行 {expanded.length} 个操作
          </span>
        </div>
        <span className="text-[11px] text-agent-muted-foreground">
          {runningCount > 0
            ? `${runningCount} 执行中`
            : failureCount > 0
              ? `${successCount} 成功 · ${failureCount} 失败`
              : `全部成功`}
        </span>
      </div>
      <div className="space-y-px">
        {expanded.map((action, i) => {
          const extras = toolCardExtras(action, agents);
          const inspect = inspectActivate(action, chatId, onInspectTask, childByIndex.get(i));
          return (
            <ToolExecutionCard
              key={action.id ?? `${action.tool}-${i}`}
              payload={actionToTool(action, i)}
              label={extras.label}
              lead={extras.lead}
              renderArgs={extras.renderArgs}
              renderOutput={extras.renderOutput ?? renderActionOutput}
              onActivate={inspect.onActivate}
              activateTitle={inspect.activateTitle}
              className="rounded-none border-0 border-t border-agent-border first:border-t-0"
            />
          );
        })}
      </div>
    </div>
  );
}

export default ExecutedActionsCard;
