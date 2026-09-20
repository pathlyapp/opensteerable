import type { OrchestrationTaskStatus } from '@steerable/agent-ui/cards';
import type { OrchestrationPlanPayload } from '@steerable/agent-protocol';

/**
 * Pure model half of OrchestrationChildrenCard — no React and no runtime
 * framework imports (type-only, erased at build), so the desktop's node
 * vitest suite can exercise the mapping without the agent-ui dist build.
 *
 * The sidecar emits `agent.child` lifecycle notifications for orchestration
 * children AND for `delegate_subagent` delegations (delegate-on-pool); the
 * router forwards them as `orchestration_child` SSE events and AgentPage
 * accumulates them into the `ChildInfo` list below.
 */

export interface ChildInfo {
  childId: string;
  /** Spawn task text (only `child_spawned` carries it). */
  task?: string;
  depth?: number;
  /** Resolved subagent profile (delegate children; `general-purpose` when
   * the delegation named no subagent_type). Rendered as the task's agent. */
  profile?: string;
  /** running | completed | failed | cancelled | interrupted */
  status: string;
  /** 子代理自己的 durable record；右侧过程面板据此回看它的推理与工具。 */
  recordId?: string;
}

/**
 * 把一次 `delegate_subagent` 调用对上它的子代理。
 *
 * 工具行只有画像名与任务正文，子代理的 record 在生命周期事件里；`task` 就是
 * 这次调用的 `task` 参数，所以两者精确相等。同一画像被派了多份活时按顺序
 * 消费，`taken` 记下已配对的 childId。
 *
 * @param call 这次委派的画像名与任务正文。
 * @param children 本回合累积的子代理列表。
 * @param taken 已被前面的行配对掉的 childId。
 * @returns 命中的子代理，或 undefined（历史回合没有事件、六件套子代理等）。
 */
export function matchChildForDelegation(
  call: { profile: string | null; task: string | null },
  children: ReadonlyArray<ChildInfo>,
  taken: ReadonlySet<string> = new Set(),
): ChildInfo | undefined {
  return children.find((child) => {
    if (taken.has(child.childId)) return false;
    if (call.task && child.task && child.task.trim() !== call.task.trim()) return false;
    if (!call.task && child.task) return false;
    if (call.profile && child.profile && child.profile !== call.profile) return false;
    return true;
  });
}

/**
 * 画像名的派生规则，与宿主 `local-backend/subagent-profiles.ts` 的
 * `profileNameForAgent` 一致（两包不能互相 import：那边带 fs / sqlite）。
 *
 * 没有 slug 的自建智能体（中文名 slugify 后为空）会拿到
 * `agent-<id 前 16 位字母数字>` 这种派生名——只按 slug/id 反查就映射不回来，
 * 行头只能显示这串 id。所以这里把宿主的整条链都列成候选。
 */
function profileNameCandidates(agent: {
  id: string;
  slug: string | null;
  name: string;
}): string[] {
  const candidates = [agent.id];
  const slug = agent.slug?.trim() ?? '';
  if (slug) candidates.push(slug);
  if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(slug)) return candidates;
  const fromName = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const alnumId = agent.id.replace(/[^a-zA-Z0-9]/g, '');
  const derived = fromName || (alnumId ? `agent-${alnumId.slice(0, 16)}` : 'agent');
  candidates.push(derived);
  // 同名画像在花名册里会加 id 后缀去重（`buildMentionDelegateRoster`）。
  if (alnumId) candidates.push(`${derived}-${alnumId.slice(0, 8)}`);
  return candidates;
}

/**
 * 把画像名（slug / 派生名 / lineage id）映射回智能体记录，调用方据此取显示名
 * 与颜色。没有匹配（编排六件套的子代理、已删除的智能体）时返回 undefined，
 * 由调用方退回画像原文。
 *
 * @param profileOrId `child_spawned.profile`、`subagent_type`，或六件套的 lineage childId。
 * @param agents 当前会话可见的智能体列表。
 */
export function findAgentForProfile<
  T extends { id: string; slug: string | null; name: string },
>(profileOrId: string, agents: ReadonlyArray<T>): T | undefined {
  return agents.find((agent) =>
    profileNameCandidates(agent).includes(profileOrId),
  );
}

const STATUS_MAP: Record<string, OrchestrationTaskStatus> = {
  running: 'running',
  completed: 'ok',
  failed: 'failed',
  cancelled: 'skipped',
  // Interrupted = paused-but-resumable; renders as pending (not terminal).
  interrupted: 'pending',
};

/**
 * Pure projection of the live child list onto the card model — the card
 * itself is click-tested in `@steerable/agent-ui`.
 */
export function childrenToCardModel(children: ChildInfo[]): {
  payload: OrchestrationPlanPayload;
  taskStatuses: Record<string, OrchestrationTaskStatus>;
} {
  return {
    payload: {
      mode: 'parallel',
      tasks: children.map((c) => ({
        id: c.childId,
        // 委派子代理显示其 profile 名(如 researcher / general-purpose);
        // 编排六件套的子代理没有 profile,退回 lineage childId。
        agentId: c.profile ?? c.childId,
        prompt: c.task ?? '',
      })),
    },
    taskStatuses: Object.fromEntries(
      children.map((c) => [c.childId, STATUS_MAP[c.status] ?? 'pending']),
    ),
  };
}

/**
 * 子代理看板只在「不止一个孩子」时有用。单次 `delegate_subagent` 已经
 * 出现在工具行「委派 ·」，再画「编排计划 · 1 个子任务」是同一件事。
 */
export function shouldShowOrchestrationBoard(children: ChildInfo[]): boolean {
  return children.length >= 2;
}

/**
 * Fold the accumulated raw sidecar `agent.child` lifecycle events (as
 * forwarded by the backend's `orchestration_child` SSE payload) back into a
 * `ChildInfo[]`. Used to rebuild the in-flight child list when re-attaching
 * to a running turn (where the original event stream was consumed by a now
 * unmounted view).
 */
export function foldOrchestrationChildEvents(
  events: ReadonlyArray<Record<string, unknown>>,
): ChildInfo[] {
  const list: ChildInfo[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const kind = typeof ev.kind === 'string' ? ev.kind : '';
    const childId = typeof ev.childId === 'string' ? ev.childId : '';
    if (!kind || !childId) continue;
    const idx = list.findIndex((c) => c.childId === childId);
    if (kind === 'child_spawned') {
      if (idx >= 0) continue;
      list.push({
        childId,
        task: typeof ev.task === 'string' ? ev.task : undefined,
        depth: typeof ev.depth === 'number' ? ev.depth : undefined,
        profile: typeof ev.profile === 'string' ? ev.profile : undefined,
        // 子代理自己的 durable record：委派行靠它跳转右侧过程栏。
        recordId: typeof ev.recordId === 'string' ? ev.recordId : undefined,
        status: 'running',
      });
      continue;
    }
    if (idx < 0) continue;
    const status =
      kind === 'child_completed'
        ? 'completed'
        : kind === 'child_failed'
          ? 'failed'
          : kind === 'child_cancelled'
            ? 'cancelled'
            : kind === 'child_interrupted'
              ? 'interrupted'
              : kind === 'child_resumed'
                ? 'running'
                : list[idx].status;
    list[idx] = { ...list[idx], status };
  }
  return list;
}

/**
 * 从助手消息 `messageMetadata.orchestrationChildEvents` 水合子代理卡片。
 * 刷新后没有 live SSE，只能靠落库事件经 `foldOrchestrationChildEvents` 重建。
 */
export function extractPersistedOrchestrationChildren(
  messages:
    | ReadonlyArray<{
        id: string;
        role?: string;
        messageMetadata?: string | null;
      }>
    | undefined,
): Record<string, ChildInfo[]> {
  const seeded: Record<string, ChildInfo[]> = {};
  if (!messages || messages.length === 0) return seeded;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.messageMetadata) continue;
    try {
      const metadata = JSON.parse(message.messageMetadata) as {
        orchestrationChildEvents?: unknown;
      };
      if (!Array.isArray(metadata.orchestrationChildEvents)) continue;
      const events = metadata.orchestrationChildEvents.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      );
      const list = foldOrchestrationChildEvents(events);
      if (list.length > 0) seeded[message.id] = list;
    } catch {
      // Ignore malformed legacy metadata.
    }
  }
  return seeded;
}
