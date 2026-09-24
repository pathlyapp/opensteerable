import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuCircle,
  LuCircleCheck,
  LuCircleDot,
  LuChevronDown,
  LuListChecks,
  LuLoaderCircle,
  LuX,
} from 'react-icons/lu';
import {
  summarizeTodos,
  type SessionTodo,
  type TodoStatus,
} from './todo-list-model';

function StatusIcon({
  status,
  className,
}: {
  status: TodoStatus;
  className?: string;
}) {
  const cls = ['h-3.5 w-3.5 shrink-0', className].filter(Boolean).join(' ');
  if (status === 'completed') {
    return <LuCircleCheck className={`${cls} text-emerald-600 dark:text-emerald-400`} />;
  }
  if (status === 'in_progress') {
    return <LuCircleDot className={`${cls} text-blue-600 dark:text-blue-400`} />;
  }
  return <LuCircle className={`${cls} text-agent-muted-foreground/70`} />;
}

export function currentTodoStep(todos: SessionTodo[]): SessionTodo | null {
  return (
    todos.find((todo) => todo.status === 'in_progress') ??
    todos.find((todo) => todo.status === 'pending') ??
    todos[todos.length - 1] ??
    null
  );
}

export function todoProgressCopy(todos: SessionTodo[]): string {
  const summary = summarizeTodos(todos);
  if (summary.total === 0) return '';
  if (summary.completed === summary.total) {
    return `${summary.completed}/${summary.total} 已完成`;
  }
  const currentIndex = todos.findIndex((todo) => todo.status === 'in_progress');
  const step =
    currentIndex >= 0 ? currentIndex + 1 : Math.min(summary.completed + 1, summary.total);
  return `执行到 ${step}/${summary.total}`;
}

export function TodoItems({
  todos,
  compact = false,
}: {
  todos: SessionTodo[];
  compact?: boolean;
}) {
  return (
    <ol
      className={`m-0 list-none ${compact ? 'max-h-48 space-y-1 overflow-y-auto px-2.5 py-1.5' : 'space-y-1 px-2.5 py-1.5'}`}
    >
      {todos.map((todo) => {
        const done = todo.status === 'completed';
        const active = todo.status === 'in_progress';
        return (
          <li
            key={todo.id}
            data-testid={`todo-item-${todo.id}`}
            data-status={todo.status}
            className="flex items-start gap-2 text-[11px] leading-relaxed"
          >
            <StatusIcon status={todo.status} className="mt-[2px]" />
            <span
              className={
                done
                  ? 'text-agent-muted-foreground line-through'
                  : active
                    ? 'font-medium text-agent-foreground'
                    : 'text-agent-muted-foreground/85'
              }
            >
              {todo.content}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function SessionTodoList({ todos }: { todos: SessionTodo[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const current = useMemo(() => currentTodoStep(todos), [todos]);
  const progressLabel = useMemo(() => todoProgressCopy(todos), [todos]);
  
  const hasActive = useMemo(
    () => todos.some((t) => t.status === 'in_progress'),
    [todos],
  );
  const isAllCompleted = useMemo(() => {
    const summary = summarizeTodos(todos);
    return summary.total > 0 && summary.completed === summary.total;
  }, [todos]);

  // 执行中默认展开，全部完成默认折叠；允许用户手动点击收起或展开
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? hasActive;

  // 当任务全部执行完毕时，自动收起为紧凑胶囊
  useEffect(() => {
    if (isAllCompleted) {
      setUserToggled(false);
    }
  }, [isAllCompleted]);

  // 当新出现执行中的任务时，恢复默认展开
  useEffect(() => {
    if (hasActive) {
      setUserToggled(null);
    }
  }, [hasActive]);

  // 任务全部完成后，如果展开了浮层，点击外部区域时自动收起
  useEffect(() => {
    if (!expanded || !isAllCompleted) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setUserToggled(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [expanded, isAllCompleted]);

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center"
      data-testid="session-todo-list"
    >
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        className={[
          'flex h-6 max-w-[240px] sm:max-w-[320px] items-center gap-1.5 rounded-full px-2 text-left text-[11px] transition-all duration-200 select-none shadow-2xs',
          isAllCompleted
            ? 'border border-emerald-500/25 bg-emerald-500/[0.04] text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/[0.08]'
            : hasActive
              ? 'border border-blue-500/30 bg-blue-500/[0.06] text-blue-700 dark:text-blue-300 hover:bg-blue-500/10'
              : 'border border-agent-border/80 bg-agent-canvas text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground',
        ].join(' ')}
        aria-expanded={expanded}
      >
        {isAllCompleted ? (
          <LuCircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : hasActive ? (
          <LuLoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
        ) : current ? (
          <StatusIcon status={current.status} />
        ) : (
          <LuListChecks className="h-3.5 w-3.5 shrink-0 text-agent-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {isAllCompleted ? '任务清单' : (current?.content ?? '任务清单')}
        </span>
        {progressLabel ? (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.2 text-[10px] font-medium ${
              isAllCompleted
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : hasActive
                  ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                  : 'bg-agent-muted text-agent-muted-foreground'
            }`}
            data-testid="todo-progress"
          >
            {progressLabel}
          </span>
        ) : null}
        <LuChevronDown
          className={`h-3 w-3 shrink-0 text-current transition-transform duration-200 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {expanded && (
        <div
          className="absolute bottom-full right-0 mb-1.5 w-72 sm:w-80 overflow-hidden rounded-agent-lg border border-agent-border bg-agent-canvas/98 backdrop-blur-md shadow-xl z-40 animate-in fade-in slide-in-from-bottom-1 duration-150"
        >
          <div className="flex items-center justify-between border-b border-agent-border/60 bg-agent-muted/30 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-agent-foreground">
              <LuListChecks className="h-3.5 w-3.5 text-agent-foreground" />
              <span>任务清单</span>
            </div>
            <div className="flex items-center gap-1.5">
              {progressLabel && (
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[10px] font-medium ${
                    isAllCompleted
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                  }`}
                >
                  {progressLabel}
                </span>
              )}
              <button
                type="button"
                onClick={() => setUserToggled(false)}
                className="flex h-5 w-5 items-center justify-center rounded text-agent-muted-foreground transition-colors hover:bg-agent-foreground/10 hover:text-agent-foreground"
                title="收起清单"
                aria-label="收起清单"
              >
                <LuX className="h-3 w-3" />
              </button>
            </div>
          </div>
          <TodoItems todos={todos} compact />
        </div>
      )}
    </div>
  );
}

export default SessionTodoList;

