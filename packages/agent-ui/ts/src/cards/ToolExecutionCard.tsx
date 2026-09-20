/**
 * `<ToolExecutionCard />`
 *
 * Unified renderer for a single tool / action invocation. Replaces both
 * deeppath's ActionSegment inline strip and deeppath-agent's
 * ExecutedActionsCard: one row per call with status / duration / expandable
 * args + output JSON. The optional `renderArgs` / `renderOutput` slots let an
 * app substitute a custom JSON viewer or rich payload renderer.
 */
import * as React from 'react';
import type { ToolExecutionPayload } from '@steerable/agent-protocol';
import {
  CheckIcon,
  LoaderIcon,
  AlertIcon,
  ZapIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlayIcon,
  StopIcon,
} from './icons.js';

type Status = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

const STATUS_LABEL: Record<Status, string> = {
  pending: '待执行',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_TONE: Record<Status, string> = {
  pending: 'text-[var(--agent-muted-foreground,#6b7280)]',
  running: 'text-amber-600',
  succeeded: 'text-emerald-600',
  failed: 'text-rose-600',
  cancelled: 'text-[var(--agent-muted-foreground,#9ca3af)]',
};

export interface ToolExecutionCardProps {
  payload: ToolExecutionPayload;
  className?: string;
  defaultExpanded?: boolean;
  /** Replaces the default zap icon before the tool name. */
  lead?: React.ReactNode;
  /** Header title; defaults to `payload.name`. */
  label?: string;
  renderArgs?: (args: unknown) => React.ReactNode;
  renderOutput?: (output: unknown) => React.ReactNode;
  /** Header body click (chevron still toggles expand). */
  onActivate?: () => void;
  activateTitle?: string;
}

function StatusIcon({ status }: { status: Status }) {
  const cls = STATUS_TONE[status];
  switch (status) {
    case 'running':
      return <LoaderIcon size={12} className={cls} />;
    case 'succeeded':
      return <CheckIcon size={12} className={cls} />;
    case 'failed':
      return <AlertIcon size={12} className={cls} />;
    case 'cancelled':
      return <StopIcon size={12} className={cls} />;
    default:
      return <PlayIcon size={12} className={cls} />;
  }
}

function defaultRender(value: unknown): React.ReactNode {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className="whitespace-pre-wrap break-words rounded bg-[var(--agent-muted,#f3f4f6)] px-2 py-1.5 text-[11px] text-[var(--agent-foreground,#111827)]">
      {text}
    </pre>
  );
}

export const ToolExecutionCard: React.FC<ToolExecutionCardProps> = ({
  payload,
  className,
  defaultExpanded = false,
  lead,
  label,
  renderArgs,
  renderOutput,
  onActivate,
  activateTitle,
}) => {
  const expandable = payload.expandable !== false;
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const status = (payload.status ?? 'pending') as Status;
  const title = label ?? payload.name;

  return (
    <div
      className={[
        'steerable-tool-execution rounded-lg border border-[var(--agent-border,#e5e7eb)] bg-[var(--agent-card-bg,#fff)] text-xs',
        className,
      ].filter(Boolean).join(' ')}
    >
      <div className="flex w-full items-stretch">
        {expandable && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex shrink-0 items-center px-2.5 py-1 text-[var(--agent-muted-foreground,#6b7280)]"
            aria-expanded={expanded}
            aria-label={expanded ? '收起详情' : '展开详情'}
          >
            {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (onActivate) onActivate();
            else if (expandable) setExpanded((v) => !v);
          }}
          className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2.5 text-left ${expandable ? '' : 'pl-2.5'} ${onActivate ? 'cursor-pointer hover:bg-[var(--agent-muted,#f3f4f6)]/60' : ''}`}
          aria-expanded={onActivate ? undefined : expanded}
          aria-label={onActivate ? activateTitle : undefined}
          title={onActivate ? activateTitle : undefined}
          data-testid={onActivate ? 'tool-activate' : undefined}
        >
          {lead ?? (
            <ZapIcon size={12} className="shrink-0 text-[var(--agent-muted-foreground,#6b7280)]" />
          )}
          <span className="shrink-0 font-medium text-[var(--agent-foreground,#111827)]">
            {title}
          </span>
          {payload.summary && (
            <span className="min-w-0 flex-1 truncate text-[var(--agent-muted-foreground,#6b7280)]">
              {payload.summary}
            </span>
          )}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
            <StatusIcon status={status} />
            <span className={STATUS_TONE[status]}>{STATUS_LABEL[status]}</span>
            {typeof payload.durationMs === 'number' && (
              <span className="text-[var(--agent-muted-foreground,#9ca3af)]">· {payload.durationMs}ms</span>
            )}
          </span>
        </button>
      </div>
      {expandable && expanded && (
        <div className="space-y-1.5 border-t border-[var(--agent-border,#e5e7eb)] px-2.5 py-1.5">
          {payload.args !== undefined && (
            <section>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--agent-muted-foreground,#6b7280)]">
                输入
              </div>
              {renderArgs ? renderArgs(payload.args) : defaultRender(payload.args)}
            </section>
          )}
          {payload.output !== undefined && (
            <section>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--agent-muted-foreground,#6b7280)]">
                输出
              </div>
              {renderOutput ? renderOutput(payload.output) : defaultRender(payload.output)}
            </section>
          )}
          {payload.error && (
            <section>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-rose-600">错误</div>
              <pre className="whitespace-pre-wrap break-words rounded bg-rose-50/60 px-2 py-1.5 text-[11px] text-rose-700">
                {payload.error}
              </pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolExecutionCard;
