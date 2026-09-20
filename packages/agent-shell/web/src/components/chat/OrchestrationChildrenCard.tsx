import { useMemo } from 'react';
import {
  OrchestrationPlanCard,
  ORCHESTRATION_DOT_CLASS,
  ORCHESTRATION_STATUS_LABEL,
} from '@steerable/agent-ui/cards';
import {
  childrenToCardModel,
  findAgentForProfile,
  shouldShowOrchestrationBoard,
  type ChildInfo,
} from './orchestration-children-model';
import type { LocalChatAgent } from '@/lib/local-api';

/**
 * OrchestrationChildrenCard — the desktop surface of the framework's P3.1
 * multi-agent orchestration. Adapts the live `ChildInfo` list (accumulated
 * from `orchestration_child` SSE events) onto the framework's
 * `OrchestrationPlanCard`: one row per child, status dot per row. The card
 * payload is synthesized from spawn events, so there is no separate "plan"
 * step: the plan IS the set of spawned children.
 *
 * Rows are overridden (`renderTaskRow`) to add the agent's colored initial
 * next to its display name, matching the `@提及` chip in the composer and in
 * user bubbles. Status labels and dot colors come from the card's own
 * exported tables so the two surfaces cannot drift.
 *
 * The mapping logic lives in `./orchestration-children-model` (pure,
 * runtime-dependency-free) so node-side tests do not pull the agent-ui
 * dist build. A single delegate child is not rendered here: the tool row
 * already shows 「委派 ·」.
 *
 * **Currently unmounted.** Nothing renders this card: every child is a
 * `delegate_subagent` call, and that tool row carries the same progress
 * (执行中 → 已完成) plus the expandable task brief and the child's report.
 * `ChildInfo` and the event fold stay in use — they feed the turn's agent
 * badges — so putting the board back is one JSX line in `AssistantMessage`.
 */

export type { ChildInfo } from './orchestration-children-model';

export function OrchestrationChildrenCard({
  children,
  agents = [],
}: {
  children: ChildInfo[];
  agents?: ReadonlyArray<Pick<LocalChatAgent, 'id' | 'slug' | 'name' | 'color'>>;
}) {
  const { payload, taskStatuses } = useMemo(
    () => childrenToCardModel(children),
    [children],
  );
  const delegateOnly = children.every((child) => Boolean(child.profile));

  if (!shouldShowOrchestrationBoard(children)) return null;
  return (
    <OrchestrationPlanCard
      payload={payload}
      taskStatuses={taskStatuses}
      headerLabel={delegateOnly ? '子代理' : undefined}
      hideMode={delegateOnly}
      renderTaskRow={(task, status) => {
        // 没有匹配的智能体：编排六件套的子代理（只有 lineage id）或被删掉的
        // 智能体，显示画像原文。
        const agent = findAgentForProfile(task.agentId, agents);
        const displayName = agent?.name ?? task.agentId;
        return (
          <li className="flex items-start gap-2 text-sm">
            <span
              className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${ORCHESTRATION_DOT_CLASS[status]}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  data-agent-color-dot=""
                  className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white"
                  style={{ backgroundColor: agent?.color || '#7c3aed' }}
                  aria-hidden
                >
                  {displayName.trim()[0]?.toUpperCase() ?? 'A'}
                </span>
                <span className="font-medium text-[var(--agent-foreground,#111827)]">
                  {displayName}
                </span>
                <span className="text-xs text-[var(--agent-muted-foreground,#6b7280)]">
                  {ORCHESTRATION_STATUS_LABEL[status]}
                </span>
              </div>
              {task.prompt ? (
                <p className="mt-0.5 line-clamp-2 text-xs text-[var(--agent-muted-foreground,#6b7280)]">
                  {task.prompt}
                </p>
              ) : null}
            </div>
          </li>
        );
      }}
      defaultExpanded
    />
  );
}

export default OrchestrationChildrenCard;
