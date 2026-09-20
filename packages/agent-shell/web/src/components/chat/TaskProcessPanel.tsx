import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LuArrowDown, LuLoaderCircle, LuTerminal } from 'react-icons/lu';
import { DockHeaderButton, DockPanelHeader } from '@/components/DockPanelHeader';
import { getChildProcess, getTaskProcess } from '@/lib/local-api';
import { getElectronBridge } from '@/lib/electron-bridge';
import { Markdown } from '@/components/chat/Markdown';
import { TurnProcessGroup } from '@/components/chat/TurnProcessGroup';
import {
  parseTurnBlocks,
  timelineContentSignature,
  type TurnBlock,
} from '@/components/chat/turn-timeline';

export interface InspectedTask {
  id: string;
  chatId: string;
  title: string;
  /**
   * 子代理过程：按它自己的 durable record 读，而不是任务表。设了它就走
   * `GET /child-process`，`live` 期间轮询（子回合边跑边写 record）。
   */
  recordId?: string;
  /** 目标仍在运行——决定轮询与标题状态。 */
  live?: boolean;
}

const CHILD_POLL_INTERVAL_MS = 1500;

/** 连续这么多次轮询读到同一份内容就认为子代理跑完了（≈60s）。 */
const CHILD_IDLE_POLLS_UNTIL_DONE = 40;

const NEAR_BOTTOM_THRESHOLD_PX = 100;

/**
 * 右侧栏：后台任务的模型推理过程（与主对话 TurnProcessGroup 同形）。
 * 数据来自 GET /tasks/:id/process，live 增量走 task-process 广播。
 */
export function TaskProcessPanel({
  inspected,
  onClose,
  onShowTerminal,
}: {
  inspected: InspectedTask;
  onClose: () => void;
  onShowTerminal?: () => void;
}) {
  const [blocks, setBlocks] = useState<TurnBlock[]>([]);
  const [live, setLive] = useState(false);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);

  const checkAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current;
    if (!el) return;
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkAtBottom, { passive: true });
    return () => {
      el.removeEventListener('scroll', checkAtBottom);
    };
  }, [checkAtBottom]);

  // 换任务 / 首屏：没有「之前在不在底部」可言，直接钉到底。
  useLayoutEffect(() => {
    isAtBottomRef.current = true;
    scrollToBottom('auto');
    setIsAtBottom(true);
  }, [inspected.id, scrollToBottom]);

  // live 增量在 paint 前钉住底部。smooth scroll 会先露出一帧半截内容再往下
  // 滑，Windows 经典滚动条就会上下跳。
  const timelineSig = timelineContentSignature(blocks);
  useLayoutEffect(() => {
    if (!isAtBottomRef.current) return;
    scrollToBottom('auto');
  }, [timelineSig, live, scrollToBottom]);

  const childRecordId = inspected.recordId;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let lastSig: string | null = null;
    let idlePolls = 0;
    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        if (childRecordId) {
          const snapshot = await getChildProcess(childRecordId);
          if (cancelled) return;
          const next = parseTurnBlocks(snapshot.timeline) ?? [];
          const sig = timelineContentSignature(next);
          idlePolls = sig === lastSig ? idlePolls + 1 : 0;
          lastSig = sig;
          setBlocks(next);
          // 子代理跑完不会再有事件通知这个面板（它的 live 是点开那刻的快照），
          // 所以用「record 不再变化」当结束信号：停轮询、标题转「已结束」。
          if (timer !== undefined && idlePolls >= CHILD_IDLE_POLLS_UNTIL_DONE) {
            window.clearInterval(timer);
            timer = undefined;
            setLive(false);
          }
          setStale(false);
        } else {
          const snapshot = await getTaskProcess(inspected.id);
          if (cancelled) return;
          setBlocks(parseTurnBlocks(snapshot.timeline) ?? []);
          setLive(snapshot.live);
          setStale(snapshot.stale);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setBlocks([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    if (childRecordId) setLive(Boolean(inspected.live));
    void load();
    // 子代理没有 task-process 广播通道（它不是任务），运行中靠轮询它的
    // record 追进度；终态打开只读一次。
    if (childRecordId && inspected.live) {
      timer = window.setInterval(() => void load(), CHILD_POLL_INTERVAL_MS);
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [inspected.id, childRecordId, inspected.live]);

  useEffect(() => {
    if (childRecordId) return;
    const bridge = getElectronBridge();
    if (!bridge?.onTaskProcess) return;
    return bridge.onTaskProcess((payload) => {
      if (payload.taskId !== inspected.id) return;
      const next = parseTurnBlocks(payload.timeline);
      if (next) setBlocks(next);
      else if (Array.isArray(payload.timeline) && payload.timeline.length === 0) {
        setBlocks([]);
      }
      setLive(payload.live);
      if (payload.live) setStale(false);
    });
  }, [inspected.id, childRecordId]);

  const statusLabel = live
    ? '正在推理'
    : stale
      ? '进程已中断（表上仍是运行中）'
      : '已结束';
  const panelTitle = `${childRecordId ? '子代理推理' : '后台推理'} · ${statusLabel}`;

  return (
    <div
      className="flex h-full w-full flex-col bg-agent-canvas text-agent-foreground"
      data-testid="task-process-panel"
    >
      <DockPanelHeader
        title={panelTitle}
        onClose={onClose}
        closeLabel="关闭过程面板"
        actions={
          onShowTerminal && (
            <DockHeaderButton
              icon={<LuTerminal className="h-3 w-3" />}
              label="终端"
              title="切换到终端"
              onClick={onShowTerminal}
            />
          )
        }
      />
      <div className="border-b border-agent-border/60 px-2.5 py-1.5">
        <div className="line-clamp-3 text-xs leading-relaxed text-agent-foreground">
          {inspected.title}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={containerRef}
          className="h-full overflow-y-auto overflow-anchor-none p-2.5"
          data-testid="task-process-scroll"
        >
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-agent-muted-foreground">
              <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
              正在加载推理过程…
            </div>
          ) : error ? (
            <div className="text-xs text-red-600 dark:text-red-300">{error}</div>
          ) : (
            <TurnProcessGroup
              blocks={blocks}
              isStreaming={live}
              showThinkingContent
              collapseWhenFinished={false}
              agents={[]}
              chats={[]}
              emptyFallback={
                <div className="text-xs text-agent-muted-foreground">
                  {stale
                    ? '任务流已随进程结束，没有留下可回放的推理记录。'
                    : live
                      ? '任务已启动，推理过程会显示在这里。'
                      : '没有可显示的推理过程。'}
                </div>
              }
              renderAnswer={(block) => (
                <div className="text-xs leading-relaxed text-agent-foreground">
                  <Markdown agents={[]} chats={[]}>{block.content}</Markdown>
                </div>
              )}
            />
          )}
        </div>
        {!isAtBottom && !loading && (
          <button
            type="button"
            onClick={() => {
              isAtBottomRef.current = true;
              setIsAtBottom(true);
              scrollToBottom('smooth');
            }}
            className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full border border-agent-border bg-agent-canvas text-agent-foreground shadow-md transition-colors hover:bg-agent-foreground/5"
            title="回到底部"
            aria-label="回到底部"
          >
            <LuArrowDown className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export default TaskProcessPanel;
