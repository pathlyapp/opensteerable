/**
 * AgentSidebar — parity rewrite that mirrors the visual + interaction
 * surface of `deeppath/apps/web/src/app/agent/AgentSidebar.tsx`.
 *
 * ## Agent picker semantics (this was a UX bug — read before changing!)
 *
 * Two distinct concepts share the agent list, and conflating them was the
 * original sin of the first cut:
 *
 *   • **selectedAgentId** — "which agent will the NEXT `+ 新对话` use".
 *     Driven by user clicks in the sidebar. Persists until the user clicks
 *     another agent. Defaults to this flavor's builtin expert on first load
 *     （场景产品 → 包的主打专家；无包产品 → shell 默认智能体）.
 *   • **activeChatAgentId** — "which agent the CURRENT chat is bound to"
 *     (URL-driven, can't be re-bound without a backend endpoint). Purely
 *     informational in the sidebar — there's no UI for switching mid-chat
 *     yet.
 *
 * The original code computed `displayAgentId = activeChatAgentId ?? selectedAgentId`
 * and lit up THAT row. Result: when the user was inside a chat and clicked a
 * DIFFERENT agent, the click silently mutated `selectedAgentId`, but the
 * highlight stayed pinned to the chat's existing agent → the user saw zero
 * feedback and assumed the button was broken. They only noticed selection
 * worked after clicking `+ 新对话` and seeing the new agent in the new chat.
 *
 * Current behavior:
 *   1. **Row highlight always tracks `selectedAgentId`** — click = visible
 *      response, no exceptions.
 *   2. **Current chat's agent gets a "当前" pill** — small badge to the
 *      right of the row, never blocks selection feedback.
 *   3. **Navigating to a chat auto-syncs `selectedAgentId = chat.agentId`**
 *      via a useEffect on `activeChatAgentId`. This way the user's mental
 *      model "I'm working with agent X" stays consistent: switching chat
 *      switches the selection; clicking an agent overrides it.
 *   4. **When `selectedAgentId !== activeChatAgentId`** (the user has
 *      explicitly diverged), an inline `+ 用「name」新建对话` CTA appears
 *      below the agent list. This makes the "your click set up a new chat"
 *      contract impossible to miss.
 *
 * ## Other intentional differences from the cloud sibling
 *
 *   • Active chat id comes from the URL (`useParams().chatId`) rather than
 *     a Context (we drive navigation, not vice versa).
 *   • Agent CRUD lives on `/settings?section=agents`（侧栏「智能体管理」），
 *     not a modal. Custom agents show up in ChatInput's expert picker.
 *   • Cmd+N / Cmd+T trigger `menu:new-chat` / `menu:open-terminal` via the
 *     preload bridge; we subscribe here so the shortcuts work regardless of
 *     focused window. The terminal is a toggleable panel BESIDE the chat
 *     (owned by AgentLayout), not a route and not a separate window.
 *
 * Layout map:
 *
 *   ┌─────────────────────────────────┐
 *   │ ✨ Product Agent          +•   │ ← + has a color dot of the selected agent
 *   ├─────────────────────────────────┤
 *   │  v 专家团队 · 3                 │
 *   │   ● 教练         (selected)     │ ← highlight = selectedAgentId
 *   │   ● 文学顾问            · 当前  │ ← "当前" pill = activeChatAgentId
 *   │   ● 哲学家                      │
 *   │   + 用「教练」新建对话          │ ← inline CTA when sel ≠ current
 *   ├──── divider ────────────────────┤
 *   │ ＋ 新对话                       │  ← 只打开落地页，有内容才落库
 *   │ ⬡ 智能体管理                     │ ← /settings?section=agents（独立页）
 *   │ ⬡ Skill 设置                    │ ← /settings?section=skills（独立页）
 *   │ 🔌 MCP 设置                     │ ← /settings?section=mcp（独立页）
 *   │  会话 v                     📁+ │ ← 📁+ 打开新建项目弹窗
 *   │  v 📁 项目A · 3      (hover: +··)│ ← + 新建对话；·· 菜单：重命名/换目录/访达/删
 *   │   ...（项目内对话）              │
 *   │   今天                          │
 *   │   ...（无项目对话，按日期分组）  │ ← 无项目排在项目分组之后
 *   ├─────────────────────────────────┤
 *   │ ▢_ 终端                 ⌘T     │
 *   │ ⚙ 设置                          │ ← /settings（模型 + 洞察/遥测/用量/搜索/安全）
 *   └─────────────────────────────────┘
 *
 * 项目模式：项目 = 名字 + 托管家目录（Documents/<应用名>/<项目名>/）+
 * 可选源文件夹。写入/命令围栏在家目录；源文件夹只放宽读取。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  LuChevronDown,
  LuChevronUp,
  LuMessageSquare,
  LuCloudCog,
  LuTrash2,
  LuLoaderCircle,
  LuTerminal,
  LuSettings,
  LuPlus,
  LuPanelLeftClose,
  LuBlocks,
  LuBot,
  LuFolder,
  LuFolderOpen,
  LuFolderPlus,
  LuPencil,
  LuPlug,
  LuEllipsis,
} from "react-icons/lu";
import { parseChatTitle } from "@/lib/chat-title";
import { getDateGroupLabel, getDateGroupPriority } from "@/lib/date-groups";
import { getElectronBridge, isElectron } from "@/lib/electron-bridge";
import { hostToolChrome } from "@/lib/host-tools";
import {
  createProject,
  deleteProject,
  listProjects,
  openLocalPath,
  updateProject,
  type LocalChat,
  type LocalChatAgent,
  type LocalProject,
} from "@/lib/local-api";
import type { UseChatsAndAgentsResult } from "@/hooks/useChatsAndAgents";
import type { PackChatSlotContribution } from "@/packs/registry";
import type { RightPanelState } from "@/layouts/AgentLayout";
import { BrandLockup } from "@/components/BrandLockup";
import { CreateProjectModal } from "@/components/CreateProjectModal";

const DEFAULT_DOT_COLOR = "#7c3aed";

function agentInitial(agent: LocalChatAgent | null): string {
  const name = (agent?.name || "").trim();
  return name ? name[0].toUpperCase() : "A";
}

function AgentDot({
  agent,
  size = 18,
}: {
  agent: LocalChatAgent | null;
  size?: number;
}) {
  const color = agent?.color || DEFAULT_DOT_COLOR;
  return (
    <span
      className="inline-flex flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white shadow-sm"
      style={{ width: size, height: size, backgroundColor: color }}
    >
      {agentInitial(agent)}
    </span>
  );
}

function placeProjectMenu(anchor: HTMLElement): { top: number; left: number } {
  const box = anchor.getBoundingClientRect();
  const width = 224;
  const left = Math.min(box.right + 4, window.innerWidth - width - 8);
  return { top: Math.max(8, box.top), left };
}

function ProjectOverflowMenu({
  project,
  chatCount,
  anchor,
  revealLabel,
  confirmDelete,
  deleting,
  onClose,
  onRename,
  onChangeFolder,
  onReveal,
  onDelete,
}: {
  project: LocalProject;
  chatCount: number;
  anchor: HTMLElement;
  revealLabel: string;
  confirmDelete: boolean;
  deleting: boolean;
  onClose: () => void;
  onRename: () => void;
  onChangeFolder: () => void;
  onReveal?: () => void;
  onDelete: () => void;
}) {
  const pos = placeProjectMenu(anchor);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="fixed inset-0 z-[90]" onClick={onClose} />
      <div
        role="menu"
        className="fixed z-[91] w-56 overflow-hidden rounded-2xl border border-agent-border bg-agent-canvas p-1 shadow-lg"
        style={pos}
        data-testid="project-overflow-menu"
      >
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-agent-foreground">
            <LuFolder className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
            <span className="min-w-0 truncate">{project.name}</span>
          </div>
          <div className="mt-0.5 pl-[22px] text-[10px] text-agent-muted-foreground">
            {chatCount} 个会话
          </div>
          <div
            className="mt-0.5 truncate pl-[22px] font-mono text-[10px] text-agent-muted-foreground/70"
            title={project.folderPath}
          >
            {project.folderPath}
          </div>
        </div>
        <div className="mx-1 my-1 border-t border-agent-border/60" />
        <button
          type="button"
          role="menuitem"
          title="重命名项目"
          onClick={onRename}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-foreground/5"
        >
          <LuPencil className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          重命名
        </button>
        <button
          type="button"
          role="menuitem"
          title="编辑项目"
          onClick={onChangeFolder}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-foreground/5"
        >
          <LuFolderOpen className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          编辑项目
        </button>
        {onReveal && (
        <button
          type="button"
          role="menuitem"
          title={revealLabel}
          onClick={onReveal}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-agent-foreground hover:bg-agent-foreground/5"
        >
          <LuFolder className="h-3.5 w-3.5 shrink-0 text-agent-muted-foreground" />
          {revealLabel}
        </button>
        )}
        <div className="mx-1 my-1 border-t border-agent-border/60" />
        <button
          type="button"
          role="menuitem"
          disabled={deleting}
          title={
            confirmDelete
              ? "再次点击确认删除（会话会保留为无项目对话）"
              : "删除项目（会话保留为无项目对话）"
          }
          onClick={onDelete}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-agent-destructive/10 ${
            confirmDelete ? "text-agent-destructive" : "text-agent-foreground"
          }`}
        >
          <LuTrash2 className={`h-3.5 w-3.5 shrink-0 ${deleting ? "animate-pulse" : ""}`} />
          {confirmDelete ? "再次点击确认删除" : "删除项目"}
        </button>
      </div>
    </>,
    document.body,
  );
}

interface AgentSidebarProps {
  data: UseChatsAndAgentsResult;
  /** 右侧栏当前打开的面板：null / 'terminal' / 包槽位 id（互斥）。 */
  rightPanel: RightPanelState;
  /** 切换右侧栏面板显隐——面板不是路由也不是独立窗口，只是布局里的一栏。 */
  onToggleRightPanel: (kind: string) => void;
  /** 包注册的聊天页槽位（分段控件里每个槽位一个按钮）；空 = 只有终端。 */
  chatSlots: readonly PackChatSlotContribution[];
  /** 收起侧边栏（AgentLayout 换成窄 rail，展开按钮在 rail 上）。 */
  onCollapse: () => void;
}

export function AgentSidebar({
  data,
  rightPanel,
  onToggleRightPanel,
  chatSlots,
  onCollapse,
}: AgentSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { chatId: currentChatId } = useParams<{ chatId?: string }>();
  const bridge = getElectronBridge();
  const onSettingsPage = location.pathname === "/settings";
  // /settings?section=skills|mcp|agents|（缺省 = 综合设置）—— 各自高亮。
  const settingsSection = useMemo(
    () => new URLSearchParams(location.search).get("section"),
    [location.search],
  );
  const onGeneralSettings =
    onSettingsPage &&
    settingsSection !== "skills" &&
    settingsSection !== "mcp" &&
    settingsSection !== "agents";
  const onNewChatHome = !currentChatId && !onSettingsPage;

  const {
    chats,
    agents,
    isLoading: isChatLoading,
    error,
    setSelectedAgentId,
    deleteChat,
    isLoadingMoreChats,
    hasMoreChats,
    loadMoreChats,
  } = data;

  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform));
    }
  }, []);
  const [confirmDeleteChatId, setConfirmDeleteChatId] = useState<string | null>(
    null,
  );
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // ───── 项目模式 ─────
  // 项目列表从 local-backend 拉取（electron-store 持久化）。会话按
  // projectId 分组：项目分组在上（组头 hover：+ 新建对话 / ·· 菜单），
  // 无项目对话在下（日期分组）。
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(
    null,
  );
  const [renamingValue, setRenamingValue] = useState("");
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<
    string | null
  >(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  );
  const [projectError, setProjectError] = useState<string | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{
    id: string;
    anchor: HTMLElement;
  } | null>(null);

  const showProjectsChrome = hostToolChrome("projects");

  const fetchProjects = useCallback(async () => {
    if (!isElectron() || !hostToolChrome("projects")) return;
    try {
      const res = await listProjects();
      setProjects(res.projects || []);
    } catch (err) {
      console.error("获取项目列表失败:", err);
      setProjectError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const handleCreateProject = useCallback(
    async (input: { name: string; sourceFolders: string[] }) => {
      setProjectError(null);
      try {
        await createProject({
          name: input.name,
          ...(input.sourceFolders.length > 0
            ? { sourceFolders: input.sourceFolders }
            : {}),
        });
        await fetchProjects();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProjectError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [fetchProjects],
  );

  const handleRenameProject = useCallback(
    async (projectId: string) => {
      const name = renamingValue.trim();
      setRenamingProjectId(null);
      if (!name) return;
      try {
        await updateProject(projectId, { name });
        await fetchProjects();
      } catch (err) {
        setProjectError(err instanceof Error ? err.message : String(err));
      }
    },
    [renamingValue, fetchProjects],
  );

  const handleUpdateProject = useCallback(
    async (
      projectId: string,
      input: { name: string; sourceFolders: string[] },
    ) => {
      setProjectError(null);
      try {
        await updateProject(projectId, {
          name: input.name,
          sourceFolders: input.sourceFolders,
        });
        await fetchProjects();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProjectError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [fetchProjects],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      if (deletingProjectId === projectId) return;
      try {
        setDeletingProjectId(projectId);
        await deleteProject(projectId);
        setConfirmDeleteProjectId(null);
        setProjectMenu(null);
        setEditingProjectId(null);
        await fetchProjects();
        await data.refreshChats();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProjectError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setDeletingProjectId(null);
      }
    },
    [deletingProjectId, fetchProjects, data],
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      // 与会话删除同款两段确认：第一次点击武装红色按钮，第二次才真删。
      if (confirmDeleteProjectId !== projectId) {
        setConfirmDeleteProjectId(projectId);
        return;
      }
      try {
        await removeProject(projectId);
      } catch {
        // 横幅已写 projectError
      }
    },
    [confirmDeleteProjectId, removeProject],
  );

  const closeProjectMenu = useCallback(() => {
    setProjectMenu(null);
    setConfirmDeleteProjectId(null);
  }, []);

  const handleRevealProjectFolder = useCallback(async (folderPath: string) => {
    setProjectError(null);
    try {
      const res = await openLocalPath(folderPath);
      if (!res.success && res.error) setProjectError(res.error);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  // Keep the shared "next new chat" agent aligned with the current chat. The
  // actual picker now lives in ChatInput, so the sidebar no longer renders the
  // expert list itself.
  const activeChatAgentId = useMemo(() => {
    if (!currentChatId) return null;
    return chats.find((c) => c.id === currentChatId)?.agentId ?? null;
  }, [chats, currentChatId]);

  // Auto-sync `selectedAgentId` when the user navigates to a chat. Without
  // this, the user lands in chat A (built on agent X), opens the sidebar,
  // sees agent Y still highlighted from a stale selection, and gets confused
  // about which agent is "active". Following the URL keeps the mental model
  // straight: "the agent I'm currently working with is the highlighted one".
  // Any explicit click in the sidebar overrides this back to the clicked
  // agent (see handlePickAgent).
  useEffect(() => {
    if (activeChatAgentId) setSelectedAgentId(activeChatAgentId);
  }, [activeChatAgentId, setSelectedAgentId]);

  // 「新对话」只打开落地页，不落库。有内容才在 EmptyChatGate 提交时
  // createChat。项目组头的「+」带上 projectId，落地页预选该项目。
  const handleOpenNewChat = useCallback(
    (projectId?: string) => {
      if (projectId) {
        navigate(`/agent?projectId=${encodeURIComponent(projectId)}`);
        return;
      }
      navigate("/agent");
    },
    [navigate],
  );

  const normalizedChats = useMemo(() => {
    return chats
      .map((chat) => {
        const updated = chat.updatedAt ? new Date(chat.updatedAt) : null;
        const created = new Date(chat.createdAt);
        const sortDate =
          updated && !Number.isNaN(updated.getTime())
            ? updated
            : !Number.isNaN(created.getTime())
              ? created
              : new Date();
        const { displayTitle, isAutomation } = parseChatTitle(chat.title);
        return {
          id: chat.id,
          title: displayTitle || "新会话",
          isAutomation,
          isPinned: chat.isPinned,
          sortDate,
          agentId: chat.agentId ?? null,
          projectId: chat.projectId ?? null,
        };
      })
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return b.sortDate.getTime() - a.sortDate.getTime();
      });
  }, [chats]);

  // 顶层按项目分组：无项目对话（含项目已被删但列表还没刷新的孤儿会话）
  // 保持原有的日期分组；每个项目一个分组，组内按 pin + 时间排序。
  const knownProjectIds = useMemo(
    () =>
      showProjectsChrome
        ? new Set(projects.map((p) => p.id))
        : new Set<string>(),
    [projects, showProjectsChrome],
  );

  const noProjectChats = useMemo(
    () =>
      normalizedChats.filter(
        (c) => !c.projectId || !knownProjectIds.has(c.projectId),
      ),
    [normalizedChats, knownProjectIds],
  );

  const projectGroups = useMemo(
    () =>
      showProjectsChrome
        ? projects.map((project) => ({
            project,
            items: normalizedChats.filter((c) => c.projectId === project.id),
          }))
        : [],
    [projects, normalizedChats, showProjectsChrome],
  );

  const chatGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        label: string;
        priority: number;
        items: typeof normalizedChats;
      }
    >();
    // 置顶会话独立成组排在所有日期分组之前：pin-first 排序若只带进日期
    // 分组，「5 天前置顶的会话」会排在「今天」的普通会话之后，置顶语义
    // 就只剩组内有效——与用户点图钉时的预期不符。
    noProjectChats.forEach((chat) => {
      const label = chat.isPinned ? "置顶" : getDateGroupLabel(chat.sortDate);
      if (!map.has(label)) {
        map.set(label, {
          label,
          priority: chat.isPinned ? 0 : getDateGroupPriority(label),
          items: [],
        });
      }
      map.get(label)!.items.push(chat);
    });
    return Array.from(map.values()).sort((a, b) => a.priority - b.priority);
  }, [noProjectChats]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      if (deletingChatId === id) return;
      // Two-step confirm — first click arms the red button, second click
      // actually deletes. Matches the cloud sibling exactly so users don't
      // get muscle-memory whiplash.
      if (confirmDeleteChatId !== id) {
        setConfirmDeleteChatId(id);
        return;
      }
      try {
        setDeletingChatId(id);
        const ok = await deleteChat(id);
        if (ok) {
          setConfirmDeleteChatId(null);
          if (id === currentChatId) navigate("/agent");
        }
      } finally {
        setDeletingChatId(null);
      }
    },
    [confirmDeleteChatId, deleteChat, deletingChatId, currentChatId, navigate],
  );

  // 单条会话行——无项目日期分组和项目分组共用同一个渲染，避免两份 JSX。
  const renderChatRow = (chat: (typeof normalizedChats)[number]) => {
    const isCurrent = currentChatId === chat.id;
    const isConfirmingDelete = confirmDeleteChatId === chat.id;
    const isDeleting = deletingChatId === chat.id;
    const chatAgent = agents.find((a) => a.id === chat.agentId) ?? null;
    return (
      <div
        key={chat.id}
        className="group/item relative"
        data-testid="sidebar-chat-row"
        data-chat-id={chat.id}
      >
        <button
          type="button"
          onClick={() => {
            setConfirmDeleteChatId(null);
            navigate(`/agent/${chat.id}`);
          }}
          className={[
            "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors duration-200",
            isCurrent
              ? "bg-agent-foreground/10 font-medium text-agent-foreground"
              : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
          ].join(" ")}
          title={
            chat.isAutomation ? `[由自动化触发] ${chat.title}` : chat.title
          }
        >
          {chat.isPinned && (
            <span className="shrink-0 text-[10px]" aria-label="已置顶">
              📌
            </span>
          )}
          {chat.isAutomation && (
            <LuCloudCog
              className="h-3 w-3 shrink-0 text-agent-muted-foreground"
              aria-label="由自动化触发"
            />
          )}
          <AgentDot agent={chatAgent} size={16} />
          <span className="min-w-0 truncate leading-none">{chat.title}</span>
        </button>
        {/* Gradient mask so the trash button doesn't paint
            over the chat title — fade matches the row's
            own background (canvas when selected, muted when
            hovered). */}
        <div
          aria-hidden="true"
          className={[
            "pointer-events-none absolute inset-y-0 right-0 w-12 rounded-r-full transition-opacity duration-200",
            isConfirmingDelete
              ? isCurrent
                ? "bg-gradient-to-l from-agent-canvas via-agent-canvas/95 to-transparent opacity-100"
                : "bg-gradient-to-l from-agent-muted via-agent-muted/95 to-transparent opacity-100"
              : isCurrent
                ? "bg-gradient-to-l from-agent-canvas via-agent-canvas/95 to-transparent opacity-0 group-hover/item:opacity-100"
                : "bg-gradient-to-l from-agent-muted via-agent-muted/95 to-transparent opacity-0 group-hover/item:opacity-100",
          ].join(" ")}
        />
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void handleDeleteChat(chat.id);
          }}
          disabled={isDeleting}
          className={[
            "absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full transition-all duration-200",
            isConfirmingDelete
              ? "bg-agent-destructive/10 text-agent-destructive opacity-100 hover:bg-agent-destructive/20"
              : "text-agent-muted-foreground opacity-0 hover:bg-agent-foreground/5 hover:text-agent-destructive group-hover/item:opacity-100 focus:opacity-100",
            "disabled:cursor-not-allowed disabled:opacity-100",
          ].join(" ")}
          title={isConfirmingDelete ? "再次点击确认删除" : "删除会话"}
          aria-label={isConfirmingDelete ? "再次点击确认删除" : "删除会话"}
          data-testid="sidebar-chat-delete"
        >
          <LuTrash2
            className={["h-3.5 w-3.5", isDeleting ? "animate-pulse" : ""].join(
              " ",
            )}
          />
        </button>
      </div>
    );
  };

  // Cmd+N from the app menu — wired in src/main.ts:createMenu (sends
  // `menu:new-chat`). The bridge methods are optional because non-Electron
  // dev previews don't have them.
  useEffect(() => {
    if (!bridge?.onMenuNewChat) return;
    bridge.onMenuNewChat(() => {
      handleOpenNewChat();
    });
    return () => {
      bridge.offMenuNewChat?.();
    };
  }, [bridge, handleOpenNewChat]);

  // Auto-load next page when the chat scroller approaches the bottom.
  // Throttled by `isLoadingMoreChats` inside the hook.
  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container || !chatsExpanded) return;

    const maybeLoadMore = () => {
      if (!hasMoreChats || isLoadingMoreChats) return;
      const nearBottom =
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - 60;
      if (nearBottom) void loadMoreChats();
    };
    container.addEventListener("scroll", maybeLoadMore, { passive: true });
    const tickId = window.requestAnimationFrame(maybeLoadMore);
    return () => {
      container.removeEventListener("scroll", maybeLoadMore);
      window.cancelAnimationFrame(tickId);
    };
  }, [
    hasMoreChats,
    isLoadingMoreChats,
    loadMoreChats,
    chatsExpanded,
    normalizedChats.length,
  ]);

  // Cmd+T from the app menu — wired in src/main.ts:createMenu (sends
  // `menu:open-terminal`). Same pattern as `menu:new-chat` above. The
  // terminal is a toggleable panel beside the chat, so this just flips
  // the layout state owned by AgentLayout.
  const showTerminalChrome = hostToolChrome("terminal");

  useEffect(() => {
    if (!showTerminalChrome || !bridge?.onMenuOpenTerminal) return;
    bridge.onMenuOpenTerminal(() => {
      onToggleRightPanel("terminal");
    });
    return () => {
      bridge.offMenuOpenTerminal?.();
    };
  }, [bridge, onToggleRightPanel, showTerminalChrome]);

  const hasElectron = isElectron();

  return (
    <div className="flex h-full w-full flex-col border-r border-agent-border/60 bg-agent-muted/70 backdrop-blur-md">
      {/* ───── Brand + actions ───── */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between px-2.5">
        <BrandLockup onClick={() => handleOpenNewChat()} />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-full text-agent-muted-foreground transition-colors duration-200 hover:bg-agent-foreground/5 hover:text-agent-foreground"
            title="收起侧边栏"
            aria-label="收起侧边栏"
          >
            <LuPanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ───── 会话 ───── */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* 新对话 + 智能体 / Skill / MCP 设置入口 — 横版行按钮，各自打开独立设置页 */}
        <div className="flex-shrink-0 space-y-0.5 px-2.5 pb-0.5">
          <button
            type="button"
            onClick={() => handleOpenNewChat()}
            className={[
              "flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
              onNewChatHome
                ? "bg-agent-foreground/10 font-medium text-agent-foreground"
                : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
            ].join(" ")}
            title="新建对话"
            data-testid="sidebar-new-chat"
          >
            <LuPlus className="h-3.5 w-3.5" />
            <span>新对话</span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/settings?section=agents")}
            className={[
              "flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
              onSettingsPage && settingsSection === "agents"
                ? "bg-agent-foreground/10 font-medium text-agent-foreground"
                : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
            ].join(" ")}
            title="智能体管理"
            data-testid="sidebar-agent-settings"
          >
            <LuBot className="h-3.5 w-3.5" />
            <span>智能体管理</span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/settings?section=skills")}
            className={[
              "flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
              onSettingsPage && settingsSection === "skills"
                ? "bg-agent-foreground/10 font-medium text-agent-foreground"
                : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
            ].join(" ")}
            title="Skill 设置"
            data-testid="sidebar-skill-settings"
          >
            <LuBlocks className="h-3.5 w-3.5" />
            <span>Skill 设置</span>
          </button>
          <button
            type="button"
            onClick={() => navigate("/settings?section=mcp")}
            className={[
              "flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
              onSettingsPage && settingsSection === "mcp"
                ? "bg-agent-foreground/10 font-medium text-agent-foreground"
                : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
            ].join(" ")}
            title="MCP 设置"
            data-testid="sidebar-mcp-settings"
          >
            <LuPlug className="h-3.5 w-3.5" />
            <span>MCP 设置</span>
          </button>
        </div>
        <div className="flex flex-shrink-0 items-center justify-between py-1 pl-2.5 pr-2.5">
          <button
            type="button"
            onClick={() => setChatsExpanded((v) => !v)}
            className="flex h-6 items-center rounded-full px-2.5 text-xs font-semibold tracking-wider text-agent-muted-foreground transition-colors hover:bg-agent-foreground/5 hover:text-agent-foreground"
          >
            会话
            <span className="ml-1">
              {chatsExpanded ? (
                <LuChevronUp className="h-3 w-3" />
              ) : (
                <LuChevronDown className="h-3 w-3" />
              )}
            </span>
          </button>
          <div className="flex items-center gap-1">
            {hasElectron && showProjectsChrome && (
              <button
                type="button"
                onClick={() => setCreateProjectOpen(true)}
                className="flex h-6 w-6 items-center justify-center rounded-full text-agent-muted-foreground transition-colors duration-200 hover:bg-agent-foreground/5 hover:text-agent-foreground"
                title="新建项目"
                aria-label="新建项目"
              >
                <LuFolderPlus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {chatsExpanded && (
          <div
            ref={chatScrollRef}
            className="flex-1 overflow-y-auto px-2.5 pb-1"
          >
            {isChatLoading && chats.length === 0 && projects.length === 0 ? (
              <div className="flex items-center justify-center py-4 text-xs text-agent-muted-foreground">
                <LuLoaderCircle className="mr-1.5 h-3 w-3 animate-spin" />
                加载中...
              </div>
            ) : chatGroups.length === 0 && projectGroups.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 py-4 text-xs text-agent-muted-foreground">
                <LuMessageSquare className="h-4 w-4 text-agent-muted-foreground/60" />
                暂无会话
              </div>
            ) : (
              <>
                {/* 项目分组在前：组头可折叠，hover 出 + 新建对话 / ·· 菜单 */}
                {showProjectsChrome &&
                  projectGroups.map(({ project, items }) => (
                  <div key={project.id} className="mb-1">
                    <div className="group/proj relative">
                      {renamingProjectId === project.id ? (
                        <form
                          className="flex items-center px-2.5 pb-1 pt-1.5"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleRenameProject(project.id);
                          }}
                        >
                          <input
                            autoFocus
                            value={renamingValue}
                            onChange={(event) =>
                              setRenamingValue(event.target.value)
                            }
                            onBlur={() => void handleRenameProject(project.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape")
                                setRenamingProjectId(null);
                            }}
                            className="h-6 w-full rounded-agent-md border border-agent-border bg-agent-canvas px-2 text-xs text-agent-foreground focus:outline-none focus:ring-2 focus:ring-agent-foreground/30"
                          />
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleProjectCollapsed(project.id)}
                            className="flex w-full min-w-0 items-center px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-agent-muted-foreground/80 transition-colors hover:text-agent-foreground"
                            title={`${project.name}\n${project.folderPath}`}
                          >
                            <LuFolder className="mr-1 h-3 w-3 shrink-0" />
                            <span className="min-w-0 truncate normal-case">
                              {project.name}
                            </span>
                            <span className="ml-0.5 shrink-0">
                              {collapsedProjectIds.has(project.id) ? (
                                <LuChevronDown className="h-3 w-3" />
                              ) : (
                                <LuChevronUp className="h-3 w-3" />
                              )}
                            </span>
                            {items.length > 0 && (
                              <span className="ml-1 shrink-0 font-normal">
                                · {items.length}
                              </span>
                            )}
                          </button>
                          <div
                            className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity ${
                              projectMenu?.id === project.id
                                ? "opacity-100"
                                : "opacity-0 group-hover/proj:opacity-100"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => handleOpenNewChat(project.id)}
                              className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                              title="在此项目下新建对话"
                            >
                              <LuPlus className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              aria-label="项目菜单"
                              aria-expanded={projectMenu?.id === project.id}
                              onClick={(event) => {
                                const button = event.currentTarget;
                                setConfirmDeleteProjectId(null);
                                setProjectMenu((current) =>
                                  current?.id === project.id
                                    ? null
                                    : { id: project.id, anchor: button },
                                );
                              }}
                              className="flex h-5 w-5 items-center justify-center rounded-full text-agent-muted-foreground hover:bg-agent-foreground/10 hover:text-agent-foreground"
                              title="项目菜单"
                            >
                              <LuEllipsis className="h-3 w-3" />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    {!collapsedProjectIds.has(project.id) && (
                      <div className="space-y-0.5">
                        {items.length === 0 ? (
                          <div className="px-2.5 py-0.5 text-[11px] text-agent-muted-foreground/60">
                            暂无会话 — hover 项目名点 + 新建
                          </div>
                        ) : (
                          items.map((chat) => renderChatRow(chat))
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {/* 无项目对话排在项目分组之后：保持原有日期分组 */}
                {chatGroups.map((group) => (
                  <div key={group.label} className="mb-1">
                    <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-agent-muted-foreground/80">
                      {group.label}
                    </div>
                    <div className="space-y-0.5">
                      {group.items.map((chat) => renderChatRow(chat))}
                    </div>
                  </div>
                ))}
              </>
            )}
            {(chatGroups.length > 0 || projectGroups.length > 0) && (
              <div className="px-2 py-2 text-center text-[11px] text-agent-muted-foreground">
                {isLoadingMoreChats ? (
                  <span className="inline-flex items-center gap-1">
                    <LuLoaderCircle className="h-3 w-3 animate-spin" />
                    加载更多...
                  </span>
                ) : hasMoreChats ? (
                  "继续下滑加载更多"
                ) : (
                  `共 ${normalizedChats.length} 个会话`
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {(error || projectError) && (
        <div
          className="flex-shrink-0 border-t border-agent-destructive/40 bg-agent-destructive/10 px-2.5 py-1.5 text-[11px] text-agent-destructive"
          role="alert"
        >
          {error ?? projectError}
        </div>
      )}

      {/* ───── Footer: 右侧面板切换（终端 | 包槽位）+ 设置 ───── */}
      <div className="flex-shrink-0 border-t border-agent-border/40 px-2.5 py-1.5">
        {chatSlots.length === 0 ? (
          showTerminalChrome ? (
          <button
            type="button"
            onClick={() => onToggleRightPanel("terminal")}
            className={[
              "flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
              rightPanel === "terminal"
                ? "bg-agent-foreground/10 font-medium text-agent-foreground"
                : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-foreground",
            ].join(" ")}
            title={`${rightPanel === "terminal" ? "关闭" : "打开"}终端面板 (${isMac ? "⌘T" : "Ctrl+T"})`}
            data-testid="sidebar-terminal"
          >
            <LuTerminal className="h-3.5 w-3.5" />
            <span>终端</span>
            <span className="ml-auto text-[10px] text-agent-muted-foreground/70">
              {isMac ? "⌘T" : "Ctrl+T"}
            </span>
          </button>
          ) : null
        ) : (
          <div
            role="group"
            aria-label="右侧面板切换"
            className="flex h-7 w-full items-center gap-0.5 rounded-full bg-agent-foreground/5 p-0.5"
          >
            {showTerminalChrome ? (
            <button
              type="button"
              onClick={() => onToggleRightPanel("terminal")}
              className={[
                "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-colors",
                rightPanel === "terminal"
                  ? "bg-agent-foreground/10 text-agent-foreground"
                  : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
              ].join(" ")}
              title={`${rightPanel === "terminal" ? "关闭" : "打开"}终端面板`}
              data-testid="sidebar-terminal"
            >
              <LuTerminal className="h-3.5 w-3.5" />
              <span>终端</span>
            </button>
            ) : null}
            {chatSlots.map((slot) => (
              <button
                key={slot.slotId}
                type="button"
                onClick={() => onToggleRightPanel(slot.slotId)}
                className={[
                  "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-colors",
                  rightPanel === slot.slotId
                    ? "bg-agent-foreground/10 text-agent-foreground"
                    : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
                ].join(" ")}
                title={`${rightPanel === slot.slotId ? "关闭" : "打开"}${slot.title}`}
                data-testid={`sidebar-slot-${slot.slotId}`}
              >
                <slot.Icon className="h-3.5 w-3.5" />
                <span>{slot.title}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className={[
            "mt-0.5 flex h-7 w-full items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors",
            onGeneralSettings
              ? "bg-agent-foreground/10 font-medium text-agent-foreground"
              : "text-agent-muted-foreground hover:bg-agent-foreground/5 hover:text-agent-foreground",
          ].join(" ")}
          title="设置"
          data-testid="sidebar-llm-settings"
        >
          <LuSettings className="h-3.5 w-3.5" />
          <span>设置</span>
        </button>
      </div>

      {projectMenu &&
        (() => {
          const project = projects.find((item) => item.id === projectMenu.id);
          if (!project) return null;
          const chatCount =
            projectGroups.find((group) => group.project.id === project.id)
              ?.items.length ?? 0;
          return (
            <ProjectOverflowMenu
              project={project}
              chatCount={chatCount}
              anchor={projectMenu.anchor}
              revealLabel={isMac ? "在访达中显示" : "在文件管理器中显示"}
              confirmDelete={confirmDeleteProjectId === project.id}
              deleting={deletingProjectId === project.id}
              onClose={closeProjectMenu}
              onRename={() => {
                setProjectMenu(null);
                setRenamingProjectId(project.id);
                setRenamingValue(project.name);
              }}
              onChangeFolder={() => {
                setProjectMenu(null);
                setEditingProjectId(project.id);
              }}
              onReveal={
                hostToolChrome("local-fs")
                  ? () => {
                      setProjectMenu(null);
                      void handleRevealProjectFolder(project.folderPath);
                    }
                  : undefined
              }
              onDelete={() => void handleDeleteProject(project.id)}
            />
          );
        })()}

      <CreateProjectModal
        open={createProjectOpen}
        onClose={() => setCreateProjectOpen(false)}
        onCreate={handleCreateProject}
      />
      {editingProjectId &&
        (() => {
          const project = projects.find((item) => item.id === editingProjectId);
          if (!project) return null;
          return (
            <CreateProjectModal
              open
              mode="edit"
              initial={{
                name: project.name,
                sourceFolders: project.sourceFolders ?? [],
              }}
              onClose={() => setEditingProjectId(null)}
              onCreate={(input) => handleUpdateProject(project.id, input)}
              onDelete={() => removeProject(project.id)}
            />
          );
        })()}
    </div>
  );
}

// Re-export for callers that still import the type from here.
export type { LocalChat, LocalChatAgent };
