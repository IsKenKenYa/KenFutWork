"use client";

import type { ExecutionMode, ProjectSummary } from "@kenfutwork/shared";
import {
  Blocks,
  Brain,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Loader2,
  MessageSquare,
  Mic,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelsTopLeft,
  Plug,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatContextMenu,
  useChatContextMenu,
} from "@/components/chat/chat-context-menu";
import {
  ComposerContextMenu,
  useComposerContextMenu,
} from "@/components/chat/composer-context-menu";
import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { RunStopButton } from "@/components/chat/run-stop-button";
import { ToolOutputRenderer } from "@/components/chat/tool-block-view";
import { KenFutWorkLogo } from "@/components/icons/kenfutwork-logo";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ContextUsageButton } from "@/components/workbench/context-usage-button";
import {
  ComposerCompactSelect,
  THINKING_OPTIONS,
  TIER_OPTIONS,
} from "@/components/workbench/composer-compact-select";
import { ElapsedEntry } from "@/components/workbench/elapsed-entry";
import { GitBranchSelect } from "@/components/workbench/git-branch-select";
import { McpModal } from "@/components/workbench/mcp-modal";
import { PluginMarketModal } from "@/components/workbench/plugin-market-modal";
import {
  SettingsModal,
  type SettingsTab,
} from "@/components/workbench/settings-modal";
import { SidebarRow } from "@/components/workbench/sidebar-row";
import { SkillsModal } from "@/components/workbench/skills-modal";
import { SubagentDirectoryView } from "@/components/workbench/subagent-directory-view";
import {
  WorkbenchSidePanel,
  type WorkbenchPanelTab,
} from "@/components/workbench/workbench-side-panel";
import { onBrowserOpen } from "@/lib/browser-panel";
import { TodoProgressPanel } from "@/components/workbench/todo-progress-panel";
import { UserMenu, type WorkbenchUser } from "@/components/workbench/user-menu";
import { WorkDirectorySelect } from "@/components/workbench/work-directory-select";
import { useWebSocket } from "@/hooks/use-websocket";
import { useAuth } from "@/lib/auth-context";
import { commitGitAll } from "@/lib/code-git-api";
import {
  usageFromEvent,
  type RunUsageSnapshot,
} from "@/lib/context-usage";
import { resolveDesignAutoCanvas } from "@/lib/design-auto-canvas";
import { getServerBaseUrl } from "@/lib/env";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_CONVERSATION_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  panelWidthLimits,
} from "@/lib/panel-layout";
import { PluginPanelButtons } from "@/lib/plugin-panels";
import { dropPartialAssistantTail } from "@/lib/run-events";
import { formatElapsedSeconds, parseTimestampMs } from "@/lib/elapsed";
import { describeRunFailure } from "@/lib/run-failure";
import {
  createProject,
  deleteProject,
  fetchProjects,
  fetchViewer,
  updateProject,
} from "@/lib/server-api";
import {
  closeAllSubagents,
  completeSubagent,
  isSubagentTool,
  type SubagentEntry,
  upsertSubagentStarted,
} from "@/lib/subagent-directory";
import {
  resolveWorkDirProject,
  workDirectoryPromptHint,
  pickWorkDirectory as workDirPick,
} from "@/lib/work-directory";
import {
  resolveWorkbenchSurface,
  type WorkbenchMode,
} from "@/lib/workbench-surface";
import {
  previewGroup,
  resolveTaskIndicator,
  SESSION_PREVIEW_LIMIT,
} from "@/lib/workbench-task-list";
import type { TodoItem } from "@/lib/todo-progress";
import {
  applyTaskToolEvent,
  type TaskToolEntry,
} from "@/lib/workbench-tools";

/**
 * Agent 工作台（产品主入口）：Code / Design 双模式（DEC-2）。
 * 模式切换、插件市场、任务列表与个人中心全部内聚在左侧栏（TRAE 式），
 * 设置与插件市场为居中模态；design 模式的画布经项目面板自动打开（KenFutWork
 * 仅作为 design 模式及其依赖能力的承载）。
 */

interface TaskMessage {
  role: "user" | "assistant";
  text: string;
  /**
   * 这条消息「工作了多久」（毫秒）：从这条消息的第一个字到本轮终态。
   * 用户口径：「工作时间每个 AI 对话消息都要显示，而不是只显示一部分」——
   * 所以是**每条**助手消息各自记一份，而不是只在会话头显示一个总时长。
   */
  elapsedMs?: number;
  /** 这条消息开始的时间（内部用：终态时据此算 elapsedMs）。 */
  startedAt?: number;
}

type WorkbenchModelOption = {
  id: string;
  name: string;
  providerName?: string | undefined;
  vision?: boolean | undefined;
  contextWindow?: number | undefined;
};

/**
 * 结算最后一条助手消息的耗时（终态时调用）。
 *
 * 口径：**这一条消息到上一条之间**的整段时间（含中间的思考与工具调用）——
 * 只算它自己「从第一个字到这一刻」会恒等于 0（实测：模型把回复一口气吐完，
 * 第一个字与最后一个字相差几十毫秒，界面上就成了「已工作 0 秒」）。
 */
function settleAssistantElapsed(task: WorkbenchTask): WorkbenchTask {
  const messages = [...task.messages];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.startedAt === undefined) {
    return task;
  }
  const elapsedMs = Math.max(0, Date.now() - last.startedAt);
  messages[messages.length - 1] = {
    role: "assistant",
    text: last.text,
    elapsedMs,
    // **保留起点**：下一条消息要拿「上一条的起点 + 它的耗时」推算自己从哪一刻开始
    startedAt: last.startedAt,
  };
  return { ...task, messages };
}

interface WorkbenchTask {
  id: string; // conversationId
  sessionId: string;
  title: string;
  mode: WorkbenchMode;
  createdAt: number;
  messages: TaskMessage[];
  status: "running" | "completed" | "failed";
  /** 所属项目（projects 实体 id）；null = 未分组 */
  projectId?: string | null;
  /** 归档后不显示在项目分组中，仅出现在「已归档」区 */
  archived?: boolean;
  /**
   * 本轮的工具调用轨迹（工作台此前**完全忽略** tool.* 事件，用户只看得到模型的话术，
   * 看不到工具跑了什么——联网搜索的来源列表因此从未在 Code 模式里出现过，
   * 产品早就写好的来源渲染器只管着已退役的旧对话 UI）。
   */
  tools?: TaskToolEntry[];
  /** 最近一轮 run 的起止（ISO，来自 run.started / 终态事件；R1-1 工作时间） */
  runStartedAt?: string | undefined;
  runEndedAt?: string | undefined;
  /** 子代理运行条目（R1-3：由 task/video_generate 工具事件推导） */
  subagents?: SubagentEntry[];
  /** agent 自己维护的待办表（R1-2：由 write_todos 工具事件推导） */
  todos?: TodoItem[];
  /** 本轮用量快照（R4-1：服务端 run.usage 事件，上下文容量/缓存命中浮层的数据源） */
  usage?: RunUsageSnapshot;
}

/**
 * 工具调用一行：名称 + 状态；完成的 `web_search` 直接把来源渲染成可点击列表
 * （复用既有 `ToolOutputRenderer`——它本来就为联网搜索写好了来源视图，
 * 只是此前没有任何 Code 模式消费方）。
 */
/**
 * 对话里的工具调用行：**默认折叠**，只留「状态点 + 工具名 + 状态」一行，点一下展开输出。
 *
 * 折叠是默认值而不是可选开关：一轮任务里工具调用可能有十几条（web_search 的来源列表尤其长），
 * 全展开会把对话正文挤没。展开状态自持（每个工具行各管各的），不写进任务数据。
 */
function WorkbenchToolRow({ tool }: { tool: TaskToolEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(tool.output) || Boolean(tool.summary);
  const statusText = tool.status === "running" ? "执行中…" : "已完成";
  return (
    <div className="w-fit max-w-full rounded-xl border border-border/60 bg-card px-3 py-2">
      <button
        type="button"
        disabled={!hasDetail}
        aria-expanded={hasDetail ? expanded : undefined}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={`flex items-center gap-2 text-xs text-muted-foreground ${
          hasDetail ? "cursor-pointer hover:text-foreground" : ""
        }`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            tool.status === "running"
              ? "animate-pulse bg-amber-500"
              : "bg-emerald-500"
          }`}
        />
        <span className="font-mono">{tool.toolName}</span>
        <span>{statusText}</span>
        {hasDetail && (
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="currentColor"
          >
            <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06L7.28 11.78a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        )}
      </button>
      {expanded ? (
        tool.output ? (
          <div className="mt-2">
            <ToolOutputRenderer toolName={tool.toolName} output={tool.output} />
          </div>
        ) : (
          <div className="mt-1 text-xs text-muted-foreground">
            {tool.summary}
          </div>
        )
      ) : null}
    </div>
  );
}

const MODE_META: Record<  WorkbenchMode,
  {
    label: string;
    title: string;
    placeholder: string;
    chips: string[];
  }
> = {
  code: {
    label: "Code",
    title: "Code with KenFutWork",
    placeholder:
      "帮你编写代码、调试 Bug、优化性能等开发工作，交付生产级代码产物。",
    chips: ["应用开发", "项目理解", "游戏创意", "工具脚本"],
  },
  design: {
    label: "Design",
    title: "Design with KenFutWork",
    placeholder: "从想法到设计，生成可交付的页面原型。",
    chips: ["设计还原", "概念成稿", "规范出图"],
  },
};

const TASKS_STORAGE_KEY = "workbench-tasks";

/** 「未分组」在「显示更多」展开状态里的分组 key（项目 id 不会取到这个名字）。 */
const UNGROUPED_KEY = "__ungrouped__";

function loadTasks(mode: WorkbenchMode): WorkbenchTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(`${TASKS_STORAGE_KEY}:${mode}`);
    if (!raw) return [];
    // 迁移：旧数据无 projectId/archived 字段时补默认值
    return (JSON.parse(raw) as WorkbenchTask[]).map((t) => ({
      ...t,
      projectId: t.projectId ?? null,
      archived: t.archived ?? false,
    }));
  } catch {
    return [];
  }
}

function saveTasks(mode: WorkbenchMode, tasks: WorkbenchTask[]) {
  try {
    window.localStorage.setItem(
      `${TASKS_STORAGE_KEY}:${mode}`,
      JSON.stringify(tasks.slice(0, 100)),
    );
  } catch {
    // 存储失败不阻塞会话
  }
}

export function Workbench() {
  const router = useRouter();
  const { user, session, loading, signOut } = useAuth();
  const getToken = useCallback(() => session?.access_token ?? null, [session]);
  const ws = useWebSocket(getToken);

  const [mode, setMode] = useState<WorkbenchMode>("code");
  const [tasksByMode, setTasksByMode] = useState<
    Record<WorkbenchMode, WorkbenchTask[]>
  >({ code: [], design: [] });
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  /** Design 模式的输入交给画布页（`/canvas?...&prompt=`）自动发送，不落到工作台会话视图。 */
  const [canvasPrompt, setCanvasPrompt] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  // Code 模式对话区右键菜单（原生菜单在应用内浏览器不弹，用户无法复制/粘贴）
  const chatMenu = useChatContextMenu();
  const codeMessagesRef = useRef<HTMLDivElement>(null);

  /**
   * 转录列预留的滚动条走廊宽度（`scrollbar-gutter: stable` 让滚动条不挤动内容，
   * 但那条走廊只属于 scroller——标题行与输入区若不留同样一条，三块内容就对不齐
   * （实测窄列差 10px、居中时中心差 5px）。宽度与平台/缩放有关，故量一次写进 CSS 变量。
   */
  const [scrollbarLane, setScrollbarLane] = useState(0);
  useEffect(() => {
    const measure = () => {
      const el = codeMessagesRef.current;
      if (!el) return;
      setScrollbarLane(el.offsetWidth - el.clientWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeTaskId]);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  /** Code 模式输入框（右键编辑菜单需要拿它的选区）。 */
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerMenu = useComposerContextMenu({
    value: followUp,
    setValue: setFollowUp,
    textareaRef: composerRef,
    onNotice: setChatNotice,
  });
  useEffect(() => {
    if (!chatNotice) return;
    const timer = window.setTimeout(() => setChatNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [chatNotice]);
  const [tier, setTier] = useState("default");
  /**
   * Code 模式的「工作目录项目」（服务端 projects, kind='code'）。
   * 「工作目录=项目」：用户选的每个工作目录就是一个项目，对话挂在它下面。
   */
  const [codeProjects, setCodeProjects] = useState<ProjectSummary[]>([]);
  const [thinking, setThinking] = useState("default");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("agent");
  const [executionModes, setExecutionModes] = useState<
    Array<{
      id: ExecutionMode;
      label: string;
      description: string;
      inputDirective?: string | undefined;
    }>
  >([]);
  const [models, setModels] = useState<WorkbenchModelOption[]>([]);
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Design 模式：项目面板（创建/列表）+ 原版画布内嵌
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  /** 画布项目列表至少取过一次（成功或失败）——自动进画布的判据之一，避免拉取途中误建画布。 */
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Code 模式：本地工作目录（File System Access API，浏览器支持时可用）
  const [workDirName, setWorkDirName] = useState<string | null>(null);
  /** 目录选择的反馈（不支持/失败）；成功或取消时清空。 */
  const [workDirNotice, setWorkDirNotice] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  // 侧栏底部个人中心 + 模态（设置 / 插件市场）
  const [workbenchUser, setWorkbenchUser] = useState<WorkbenchUser | null>(
    null,
  );
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  /** 平台管理员标记：仅用于「显示后台入口」，鉴权在服务端（/api/admin/*）。 */
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  const activeRunIdRef = useRef<string | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  activeTaskIdRef.current = activeTaskId;

  /** tasksByMode 的镜像：事件回调里要读最新任务（状态更新是异步的）。 */
  const tasksByModeRef = useRef<Record<WorkbenchMode, WorkbenchTask[]>>({
    code: [],
    design: [],
  });
  tasksByModeRef.current = tasksByMode;

  const tasks = tasksByMode[mode];
  /**
   * 当前选中的项目：Code 模式在「工作目录项目」（kind='code'）里找，Design 在画布
   * 项目（kind='design'）里找。两类项目在服务端就分开了，故同一 selectedProjectId
   * 不会跨模式误命中。
   */
  const selectedProject =
    (mode === "code" ? codeProjects : projects).find(
      (p) => p.id === selectedProjectId,
    ) ?? null;

  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  /**
   * 对话视图里工作目录/分支该显示哪个项目：**以对话自己绑定的项目为准**
   * （run 的作用域就是它的主画布）。只认页面的 `selectedProjectId` 会让打开历史
   * 对话时两个 chip 消失/显示成别的工作目录——用户反馈「对话开始之后不显示」。
   */
  const conversationProject =
    mode === "code" && activeTask?.projectId
      ? (codeProjects.find((p) => p.id === activeTask.projectId) ?? null)
      : null;

  /** 最近一次「本轮自动提交」的时间戳（仅用于给用户一个可见回执 + 刷新分支 chip）。 */
  const [lastAutoCommitAt, setLastAutoCommitAt] = useState<string | null>(null);

  /**
   * 右栏停靠面板（R3-1）：变更 / 文档 / 子智能体 三个视图。
   *
   * 形态取自参考图（`扩展插件-添加终端、浏览器、变更等功能.png`：右栏是多标签面板；
   * `子代理和git显示位置.png`：右侧面板带标签）。此前把「变更列表 / 文档」塞在分支下拉与
   * 工作目录下拉里——那是**形态做错**：这些是「边看边改」的长驻视图，不是一次性弹层内容。
   */
  /** 左侧栏宽度（可拖拽，持久化：与右栏面板同样，宽度是用户偏好）。 */
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return 256;
    const saved = Number(window.localStorage.getItem("workbench:sidebar-width"));
    return Number.isFinite(saved) &&
      saved >= MIN_SIDEBAR_WIDTH &&
      saved <= MAX_SIDEBAR_WIDTH
      ? saved
      : 256;
  });

  const startSidebarResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const clamp = (next: number) =>
      Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next));
    const onMove = (moveEvent: MouseEvent) => {
      setSidebarWidth(clamp(startWidth + (moveEvent.clientX - startX)));
    };
    const onUp = (upEvent: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.localStorage.setItem(
        "workbench:sidebar-width",
        String(clamp(startWidth + (upEvent.clientX - startX))),
      );
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  /**
   * 视口宽度（面板上限要按它现算：视口 − 左栏 − 对话列最小宽度）。
   * 窗口尺寸变化时重算，面板会被收回到新上限内（见 lib/panel-layout）。
   */
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const panelLimits = useMemo(
    () => panelWidthLimits({ windowWidth, sidebarWidth, sidebarCollapsed }),
    [windowWidth, sidebarWidth, sidebarCollapsed],
  );

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<WorkbenchPanelTab>("changes");

  /**
   * 转录里点链接 → 自动打开右栏「浏览器」标签（用户口径：点对话里的 URL 就在右边打开）。
   * 订阅放工作台：面板只渲染，开合与切标签由这里决定。
   */
  useEffect(
    () =>
      onBrowserOpen(() => {
        setPanelOpen(true);
        setPanelTab("browser");
      }),
    [],
  );

  /** 侧栏里被收起的工作目录项目 id（默认全展开；持久化到 localStorage）。 */
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);

  /**
   * 侧栏里「显示更多」展开过的分组（项目 id / 未分组用常量 key；持久化）。
   * 一个工作目录下几十条对话时，默认只露前 `SESSION_PREVIEW_LIMIT` 条。
   */
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);

  /**
   * 已结束但用户还没打开过的对话 id（侧栏图标显示实心气泡）。
   * 跑完的那一刻若不在当前会话，就标记未读；打开即清（见下面的 effect）。
   */
  const [unreadTaskIds, setUnreadTaskIds] = useState<string[]>([]);

  /**
   * 本页确实在跑的那条会话（侧栏转圈只认它）。
   * 不能拿任务数据里的 `status === "running"` 当判据：那是「起过表、还没收到终态」，
   * 进程重启/关页会留下永远转圈的陈旧记录（实测侧栏一排假转圈）。
   */
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  /** 主区判定：Design 模式恒为画布（不变量集中在 resolveWorkbenchSurface 与它的测试里）。 */
  const surface = resolveWorkbenchSurface({
    hasActiveTask: activeTask !== null,
    hasSelectedProject: selectedProject !== null,
    mode,
  });

  // 鉴权守卫
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // 任务列表载入 + 思考强度偏好
  useEffect(() => {
    setTasksByMode({
      code: loadTasks("code"),
      design: loadTasks("design"),
    });
    try {
      const rawCollapsed = window.localStorage.getItem(
        "workbench:collapsed-projects",
      );
      setCollapsedProjects(
        rawCollapsed ? (JSON.parse(rawCollapsed) as string[]) : [],
      );
    } catch {
      setCollapsedProjects([]);
    }
    try {
      setThinking(
        window.localStorage.getItem("workbench:thinking") ?? "default",
      );
    } catch {
      // 存储不可用时用默认档
    }
    try {
      // 上次选的模型；目录拉回后再校验是否仍存在（见下面的 setModel 回调）
      setModel(window.localStorage.getItem("workbench:model") ?? "");
    } catch {
      // 存储不可用：由目录第一条兜底
    }
    try {
      const rawExpanded = window.localStorage.getItem(
        "workbench:expanded-groups",
      );
      setExpandedGroups(
        rawExpanded ? (JSON.parse(rawExpanded) as string[]) : [],
      );
    } catch {
      setExpandedGroups([]);
    }
  }, []);

  // 未读数按模式各存一份（切模式不该把另一边清空）
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`workbench-unread:${mode}`);
      setUnreadTaskIds(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setUnreadTaskIds([]);
    }
  }, [mode]);

  /** 未读标记的读写：写 localStorage 与 state 一起（打开会话即清）。 */
  const setTaskUnread = useCallback(
    (taskId: string, unread: boolean) => {
      setUnreadTaskIds((prev) => {
        const already = prev.includes(taskId);
        if (already === unread) return prev;
        const next = unread
          ? [...prev, taskId]
          : prev.filter((id) => id !== taskId);
        try {
          window.localStorage.setItem(
            `workbench-unread:${mode}`,
            JSON.stringify(next),
          );
        } catch {
          // 存储失败不影响本次会话内的标记
        }
        return next;
      });
    },
    [mode],
  );

  // 打开（或新建）会话即视为已读
  useEffect(() => {
    if (activeTaskId) setTaskUnread(activeTaskId, false);
  }, [activeTaskId, setTaskUnread]);

  /** 「显示更多 / 收起」：按分组切换并持久化（分组 key = 项目 id / 未分组常量）。 */
  const toggleGroupExpanded = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = prev.includes(groupKey)
        ? prev.filter((key) => key !== groupKey)
        : [...prev, groupKey];
      try {
        window.localStorage.setItem(
          "workbench:expanded-groups",
          JSON.stringify(next),
        );
      } catch {
        // 存储失败不影响使用
      }
      return next;
    });
  }, []);

  /** run → 所属会话的映射（放在 ref 里供挂载期注册的事件回调读）。 */
  const runTaskIdRef = useRef<string | null>(null);
  /** 事件回调的 deps 只有 ws/mode，未读标记经 ref 读最新实现。 */
  const setTaskUnreadRef = useRef(setTaskUnread);
  setTaskUnreadRef.current = setTaskUnread;

  const handleThinkingChange = useCallback((next: string) => {
    setThinking(next);
    try {
      window.localStorage.setItem("workbench:thinking", next);
    } catch {
      // 存储失败不阻塞
    }
  }, []);

  // 个人中心用户信息（真实 viewer）
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetchViewer(token)
      .then((viewer) =>
        setWorkbenchUser({
          displayName: viewer.profile.displayName,
          email: viewer.profile.email,
          avatarUrl: viewer.profile.avatarUrl ?? null,
        }),
      )
      .catch(() => {});
  }, [session]);

  const refreshProjects = useCallback(() => {
    const token = session?.access_token;
    if (!token) return;
    // 两类项目各取一份：design=画布项目，code=工作目录项目（「工作目录=项目」）。
    // 都在服务端一处持有，客户端不再另造 localStorage 项目（那是两套真相的来源）。
    fetchProjects(token, "design")
      .then((data) => {
        setProjects(data.projects);
        setProjectsLoaded(true);
      })
      .catch(() => {
        // 拉取失败也标记「已尝试」：否则 Design 模式会永远停在编排器；
        // 自动建画布只试一次，失败后由用户从侧栏手动新建。
        setProjectsLoaded(true);
      });
    fetchProjects(token, "code")
      .then((data) => setCodeProjects(data.projects))
      .catch(() => {});
  }, [session]);

  // 项目列表（两个模式各自一份 kind）
  useEffect(() => {
    if (session?.access_token) refreshProjects();
  }, [session, refreshProjects]);

  // 执行模式词汇表（需 token）
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetch(`${getServerBaseUrl()}/api/execution-modes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : { modes: [] }))
      .then(
        (data: {
          modes: Array<{
            id: ExecutionMode;
            label: string;
            description: string;
            inputDirective?: string | undefined;
          }>;
        }) => setExecutionModes(data.modes),
      )
      .catch(() => {});
  }, [session]);

  // 平台管理员标记（FORM-10）：决定是否显示「管理后台」入口，鉴权在服务端
  useEffect(() => {
    const token = session?.access_token;
    if (!token) {
      setIsPlatformAdmin(false);
      return;
    }
    let cancelled = false;
    fetch(`${getServerBaseUrl()}/api/admin/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : { isAdmin: false }))
      .then((data: { isAdmin?: boolean }) => {
        if (!cancelled) setIsPlatformAdmin(Boolean(data.isAdmin));
      })
      .catch(() => {
        if (!cancelled) setIsPlatformAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // 嵌入画布删除项目后回传：清选中并刷新列表
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | { type?: string; projectId?: string }
        | null
        | undefined;
      if (data?.type === "workbench:project-created") {
        refreshProjects();
        // 画布里点「新建项目」：宿主直接把选中切到新项目（画布区随之打开新画布）。
        // 不这样做，用户会觉得「点了没反应」；而画布那边若自行开新标签，就会被「弹走」。
        if (data.projectId) setSelectedProjectId(data.projectId);
        return;
      }
      if (data?.type !== "workbench:project-deleted") return;
      setSelectedProjectId((current) =>
        current === data.projectId ? null : current,
      );
      refreshProjects();
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [refreshProjects]);

  /** 直接以指定名称创建项目（侧栏 + 号，跳过输入框）。 */
  const createProjectNamed = useCallback(
    async (name: string): Promise<ProjectSummary | null> => {
      const token = session?.access_token;
      if (!token) return null;
      setCreatingProject(true);
      try {
        const result = await createProject(token, { name });
        setProjects((prev) => [result.project, ...prev]);
        return result.project;
      } catch {
        return null;
      } finally {
        setCreatingProject(false);
      }
    },
    [session],
  );

  /** 项目重命名（updateProject API）。 */
  const renameProject = useCallback(
    async (projectId: string, name: string) => {
      const token = session?.access_token;
      if (!token) return;
      try {
        await updateProject(token, projectId, { name });
        setProjects((prev) =>
          prev.map((p) => (p.id === projectId ? { ...p, name } : p)),
        );
      } catch {
        // 失败保留旧名
      }
    },
    [session],
  );

  /** 项目删除：调 API 并清理本地两个模式的对话记录。 */
  const removeProject = useCallback(
    async (projectId: string) => {
      const token = session?.access_token;
      if (!token) return;
      try {
        await deleteProject(token, projectId);
      } catch {
        // mock/网络失败仍继续清本地，避免幽灵项目卡住 UI
      }
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setSelectedProjectId((current) =>
        current === projectId ? null : current,
      );
      setTasksByMode((prev) => {
        const next: typeof prev = { code: [], design: [] };
        for (const m of ["code", "design"] as const) {
          const kept = prev[m]
            .filter((t) => t.projectId !== projectId)
            .map((t) => (t.projectId == null ? t : t));
          next[m] = kept;
          saveTasks(m, kept);
        }
        return next;
      });
      setActiveTaskId(null);
      refreshProjects();
    },
    [session, refreshProjects],
  );

  // ── 对话（task）动作：重命名 / 归档 / 删除 / 恒恢复 ──
  const renameTask = useCallback(
    (taskId: string, title: string) => {
      setTasksByMode((prev) => {
        const list = prev[mode].map((t) =>
          t.id === taskId ? { ...t, title } : t,
        );
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
    },
    [mode],
  );

  const setTaskArchived = useCallback(
    (taskId: string, archived: boolean) => {
      setTasksByMode((prev) => {
        const list = prev[mode].map((t) =>
          t.id === taskId ? { ...t, archived } : t,
        );
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      if (archived) {
        setActiveTaskId((current) => (current === taskId ? null : current));
      }
    },
    [mode],
  );

  // ── Code 项目（工作目录项目，kind='code'，与 Design 的画布项目分开）──
  /** 建工作目录项目并选中（「工作目录=项目」）；失败返回 null 由调用方提示。 */
  const createCodeProject = useCallback(
    async (name: string): Promise<ProjectSummary | null> => {
      const token = session?.access_token;
      if (!token) return null;
      setCreatingProject(true);
      try {
        const result = await createProject(token, { kind: "code", name });
        setCodeProjects((prev) => [result.project, ...prev]);
        return result.project;
      } catch {
        return null;
      } finally {
        setCreatingProject(false);
      }
    },
    [session],
  );

  const renameCodeProject = useCallback(
    async (id: string, name: string) => {
      const token = session?.access_token;
      if (!token) return;
      try {
        await updateProject(token, id, { name });
        setCodeProjects((prev) =>
          prev.map((p) => (p.id === id ? { ...p, name } : p)),
        );
      } catch {
        // 失败保留旧名
      }
    },
    [session],
  );

  const removeCodeProject = useCallback(
    async (id: string) => {
      const token = session?.access_token;
      if (token) {
        try {
          await deleteProject(token, id);
        } catch {
          // 服务端删除失败仍继续清本地，避免幽灵项目卡住 UI
        }
      }
      setCodeProjects((prev) => prev.filter((p) => p.id !== id));
      setSelectedProjectId((current) => (current === id ? null : current));
      // 其下对话转为未分组
      setTasksByMode((prev) => {
        const list = prev.code.map((t) =>
          t.projectId === id ? { ...t, projectId: null } : t,
        );
        saveTasks("code", list);
        return { ...prev, code: list };
      });
    },
    [session],
  );

  const deleteTask = useCallback(
    (taskId: string) => {
      setTasksByMode((prev) => {
        const list = prev[mode].filter((t) => t.id !== taskId);
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      setActiveTaskId((current) => (current === taskId ? null : current));
    },
    [mode],
  );

  // Design 模式自动进画布：无选中项目时选第一个；列表为空则自动建「未命名画布」。
  // 判定抽到 `resolveDesignAutoCanvas`（纯函数 + 单测），这里只做副作用。
  /** 自动建画布只试一次：项目列表拉取失败时避免每次渲染都重发创建请求。 */
  const autoCanvasTriedRef = useRef(false);
  useEffect(() => {
    const decision = resolveDesignAutoCanvas({
      mode,
      activeTaskId,
      creatingProject,
      projectsLoaded,
      designProjectIds: projects.map((p) => p.id),
      selectedProjectId,
      autoCreateTried: autoCanvasTriedRef.current,
    });
    if (decision.kind === "select") {
      setSelectedProjectId(decision.projectId);
      return;
    }
    if (decision.kind === "create") {
      autoCanvasTriedRef.current = true;
      void createProjectNamed("未命名画布").then((project) => {
        if (project) setSelectedProjectId(project.id);
      });
    }
  }, [
    mode,
    activeTaskId,
    creatingProject,
    projectsLoaded,
    projects,
    selectedProjectId,
    createProjectNamed,
  ]);

  // 权限档位（DEC-4）与模型目录（含 BYOK 实例）：读取当前值
  useEffect(() => {
    if (!session?.access_token) return;
    fetch(`${getServerBaseUrl()}/api/permissions/tier`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.tier) setTier(data.tier);
      })
      .catch(() => {});
    // 模型目录（带凭证并入 BYOK 实例）
    fetch(`${getServerBaseUrl()}/api/models`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((data: { models: WorkbenchModelOption[] }) => {
        setModels(data.models);
        /**
         * 默认取「上次选的」（`workbench:model`），失效才回落目录第一条。
         *
         * 只取第一条会踩到：目录顺序取决于实例创建序，工作区里常同时挂着多个实例
         * （自带的、替身、平台池），刷新后默认模型可能变成用户没要的那个实例——
         * 实测因此拿着一个失效实例的 Key 每轮 401。
         */
        setModel((current) =>
          current && data.models.some((m) => m.id === current)
            ? current
            : (data.models[0]?.id ?? ""),
        );
      })
      .catch(() => {});
  }, [session]);

  /** 模型选择：记住到 localStorage（与 thinking 同一口径）。 */
  const handleModelChange = useCallback((next: string) => {
    setModel(next);
    try {
      window.localStorage.setItem("workbench:model", next);
    } catch {
      // 存储失败不阻塞
    }
  }, []);

  // 流事件 → 任务消息
  useEffect(() => {
    const off = ws.onEvent((evt) => {
      const type = (evt as { type?: string }).type;
      const runId = (evt as { runId?: string }).runId;
      /**
       * 事件归属：run 起跑时记下的那个会话，而不是「此刻打开的会话」——
       * 用户在运行中切到别的对话时，delta/工具/终态都还该落在原来那条对话上
       * （否则串到当前打开的会话里），且终态要能把后台那条对话标成未读。
       */
      const taskId = runTaskIdRef.current ?? activeTaskIdRef.current;
      if (!taskId) return;
      const apply = (mutate: (task: WorkbenchTask) => WorkbenchTask) => {
        setTasksByMode((prev) => {
          const list = prev[mode];
          const next = list.map((t) => (t.id === taskId ? mutate(t) : t));
          const nextAll = { ...prev, [mode]: next };
          saveTasks(mode, next);
          return nextAll;
        });
      };
      /** 终态：不在前台就标未读（侧栏图标转实心），并把转圈收掉。 */
      const markUnreadIfBackground = () => {
        setRunningTaskId(null);
        if (taskId !== activeTaskIdRef.current) {
          setTaskUnreadRef.current(taskId, true);
        }
      };
      /**
       * 重试：服务端整段重跑并**换一个新 runId**（事件里带的就是新 id）。
       * 这条必须在 runId 过滤**之前**处理——新 id 与跟踪值不相等，按常规过滤会被丢掉，
       * 紧接着这一轮所有事件（含终态）一起丢，任务永远停在「运行中」。
       */
      if (type === "run.retrying") {
        if (!runId || !activeRunIdRef.current) return;
        activeRunIdRef.current = runId;
        // 整段重来：丢掉上一轮已流出的半截回复，避免新旧内容接在一起
        apply((task) => ({
          ...task,
          messages: dropPartialAssistantTail(task.messages),
        }));
        return;
      }
      if (!runId || runId !== activeRunIdRef.current) return;
      if (type === "run.started") {
        // 服务端权威起表时刻（覆盖提交时的本地乐观值）
        const ts = (evt as { timestamp?: string }).timestamp;
        if (ts) apply((task) => ({ ...task, runStartedAt: ts }));
      } else if (type === "tool.started" || type === "tool.completed") {
        // 工具轨迹对所有工具都记（含被工具门拒绝的合成事件），子代理工具另进目录。
        // 曾经这里写成「先处理子代理、非子代理直接 return」，把通用分支变成死代码。
        apply((task) =>
          applyTaskToolEvent(
            task,
            evt as Parameters<typeof applyTaskToolEvent>[1],
          ),
        );
      } else if (type === "run.usage") {
        // 本轮最后一次模型调用的累计用量（上下文容量 / 缓存命中浮层）
        const usage = usageFromEvent(evt);
        if (usage) apply((task) => ({ ...task, usage }));
      } else if (type === "message.delta") {
        const delta = (evt as { delta?: string }).delta ?? "";
        if (!delta) return;
        apply((task) => {
          const messages = [...task.messages];
          const last = messages[messages.length - 1];
          if (last && last.role === "assistant") {
            messages[messages.length - 1] = {
              ...last,
              text: last.text + delta,
            };
          } else {
            // 新的一条助手消息：起点取「上一条结束的时刻」，没有就退到本轮起点——
            // 这样它记的是这一段的整段时间（含中间的思考与工具调用）
            const previousEnd = [...messages]
              .reverse()
              .find((m) => m.role === "assistant" && m.elapsedMs !== undefined);
            // 只有上一条**同时有起点与耗时**时才能链式推——老数据（只有耗时没有起点）
            // 直接相加会得到「0 + 耗时」这种荒唐的绝对时刻（实测显示成 49 万小时）
            const previousEndMs =
              previousEnd?.startedAt !== undefined &&
              previousEnd.elapsedMs !== undefined
                ? previousEnd.startedAt + previousEnd.elapsedMs
                : null;
            const runStart = task.runStartedAt
              ? parseTimestampMs(task.runStartedAt)
              : null;
            messages.push({
              role: "assistant",
              text: delta,
              startedAt: previousEndMs ?? runStart ?? Date.now(),
            });
          }
          return { ...task, messages };
        });
      } else if (type === "run.completed") {
        const ts = (evt as { timestamp?: string }).timestamp;
        apply((task) =>
          settleAssistantElapsed({
            ...task,
            status: "completed",
            ...(ts ? { runEndedAt: ts } : {}),
            ...(task.subagents && ts
              ? { subagents: closeAllSubagents(task.subagents, ts) }
              : {}),
          }),
        );
        // 每轮成功结束自动提交一次（Code 模式 + 已绑项目），让对话在 git 里有迹可循
        if (mode === "code") {
          void autoCommitTurn(taskId);
        }
        markUnreadIfBackground();
      } else if (type === "billing.error") {
        // 平台池额度/套餐拦截（FORM-10）：服务端给的是可读原因，
        // 直接透出，别让用户只看到「运行失败，请重试」。
        const message =
          (evt as { message?: string }).message ?? "额度不足，请联系管理员。";
        apply((task) => ({
          ...task,
          status: "failed",
          messages: [...task.messages, { role: "assistant", text: message }],
        }));
        markUnreadIfBackground();
      } else if (type === "run.failed") {
        // 服务端在 error.message 里给的是可读原因（如「模型流已 180 秒没有任何
        // 输出（上游停滞）」「run 未绑定项目」）。此前一律丢弃、只显示固定文案，
        // 用户无法判断该重试、换模型还是去建项目——这里按 billing.error 的同一
        // 口径透出；确实没有原因时才回落到通用文案。
        const failureText = describeRunFailure(evt);
        const failedTs = (evt as { timestamp?: string }).timestamp;
        apply((task) => ({
          ...task,
          status: "failed",
          ...(failedTs ? { runEndedAt: failedTs } : {}),
          ...(task.subagents && failedTs
            ? { subagents: closeAllSubagents(task.subagents, failedTs) }
            : {}),
          messages: [
            ...task.messages,
            { role: "assistant", text: failureText },
          ],
        }));
        markUnreadIfBackground();
      } else if (type === "run.canceled") {
        const canceledTs = (evt as { timestamp?: string }).timestamp;
        apply((task) =>
          settleAssistantElapsed({
            ...task,
            status: "completed",
            ...(canceledTs ? { runEndedAt: canceledTs } : {}),
            ...(task.subagents && canceledTs
              ? { subagents: closeAllSubagents(task.subagents, canceledTs) }
              : {}),
          }),
        );
        // 用户自己按的停止：算已读，但转圈要收掉
        setRunningTaskId(null);
      }
    });
    return off;
  }, [ws, mode]);

  const handleTierChange = useCallback(
    async (next: string) => {
      setTier(next);
      if (!session?.access_token) return;
      try {
        await fetch(`${getServerBaseUrl()}/api/permissions/tier`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ tier: next }),
        });
      } catch {
        // 权限档位失败不阻塞任务
      }
    },
    [session],
  );

  const pickWorkDirectory = useCallback(async () => {
    const result = await workDirPick(window);
    if (result.status === "picked") {
      setWorkDirName(result.name);
      setWorkDirNotice(null);
      // Code 模式：**工作目录即项目**。run 的生产后端要求绑定项目
      // （缺 canvasId 会立刻失败），而浏览器只拿得到目录名——所以这里按目录名
      // 建同名项目并选中，run 以该项目的主画布为作用域，文件落在项目的沙箱目录里。
      if (mode === "code") {
        // 目录名 → 工作目录项目：同名复用，没有就自动建（服务端 kind='code'）
        const plan = resolveWorkDirProject(result.name, codeProjects);
        if (plan.kind === "reuse") {
          setSelectedProjectId(plan.projectId);
          return;
        }
        const created = await createCodeProject(plan.name);
        if (created) {
          setSelectedProjectId(created.id);
          return;
        }
        setWorkDirNotice(
          "已选定目录名，但项目创建失败，本次运行可能无法开始。",
        );
      }
      return;
    }
    if (result.status === "cancelled") {
      // 用户主动取消：不打扰
      return;
    }
    // 不支持/失败都必须说出来（曾经是静默 return + 空 catch）
    setWorkDirNotice(result.notice);
  }, [mode, codeProjects, createCodeProject]);

  /**
   * 「不在项目中工作」：清掉工作目录与项目选择。
   * run 会退回会话自身的作用域（服务端懒供给的 Code 载体），不再绑定工作目录项目。
   */
  const clearWorkDirectory = useCallback(() => {
    setWorkDirName(null);
    setWorkDirNotice(null);
    setSelectedProjectId(null);
  }, []);

  const switchMode = useCallback((next: WorkbenchMode) => {
    setMode(next);
    setActiveTaskId(null);
  }, []);

  const startTask = useCallback(
    async (text: string) => {
      if (!text.trim() || !session?.access_token) return;

      if (mode === "design") {
        // Design 模式：主区是画布，对话属于画布页自己的助手面板。
        // 这里把输入交给画布（`/canvas?id=...&prompt=...` 由画布页自动发送），
        // **不**创建工作任务、**不**激活会话视图——否则对话框会把画布顶掉。
        setPrompt("");
        setCanvasPrompt(text.trim());
        return;
      }

      const sessionId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();

      // Code 模式：工作目录=项目。选了工作目录却没有对应项目（项目被删过、或历史
      // 会话只留了目录名）时按目录名自动补建——否则 run 绑不上项目会整轮秒失败。
      let resolvedProject = mode === "code" ? selectedProject : null;
      if (mode === "code" && !resolvedProject && workDirName) {
        const plan = resolveWorkDirProject(workDirName, codeProjects);
        resolvedProject =
          plan.kind === "reuse"
            ? (codeProjects.find((p) => p.id === plan.projectId) ?? null)
            : await createCodeProject(plan.name);
        if (resolvedProject) setSelectedProjectId(resolvedProject.id);
      }
      // 作用域：项目主画布优先；未选工作目录时退回会话自身（服务端懒供给 Code 载体）
      const runCanvasId =
        mode === "code"
          ? (resolvedProject?.primaryCanvas?.id ?? conversationId)
          : conversationId;

      const title = text.trim().slice(0, 24) || "新任务";
      const task: WorkbenchTask = {
        id: conversationId,
        sessionId,
        title,
        mode,
        createdAt: Date.now(),
        messages: [{ role: "user", text: text.trim() }],
        status: "running",
        projectId: mode === "code" ? (resolvedProject?.id ?? null) : null,
        archived: false,
        // 先用本地时钟乐观起表，run.started 事件到达后以服务端时间戳为准
        runStartedAt: new Date().toISOString(),
      };
      setTasksByMode((prev) => {
        const list = [task, ...prev[mode]];
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      setActiveTaskId(task.id);
      setPrompt("");
      setSubmitting(true);

      // 失败兜底：WS 命令可能被丢弃（重连窗口）或 ack 丢失。没有兜底时任务会永远停在
      // 「生成中」，且 submitting 不归位会让发送按钮**永久禁用**——用户只能刷新页面。
      const markFailed = (text: string) => {
        setTasksByMode((prev) => {
          const list = prev[mode].map((t) =>
            t.id === task.id && t.status === "running"
              ? {
                  ...t,
                  status: "failed" as const,
                  runEndedAt: new Date().toISOString(),
                  messages: [
                    ...t.messages,
                    { role: "assistant" as const, text },
                  ],
                }
              : t,
          );
          saveTasks(mode, list);
          return { ...prev, [mode]: list };
        });
        setSubmitting(false);
      };

      if (!ws.connected) {
        markFailed("与服务端的连接未就绪（正在重连），请稍后重试。");
        return;
      }

      let acked = false;
      /**
       * ack 超时：**不能一律报「请重试」**。
       *
       * 实测：服务端把 ack 推给一条已经断掉的连接（`ack_sent delivered=false`），客户端
       * 12s 后照报「运行请求未被服务端确认…请重试」——可那个 run 其实已经在跑了。盲重试
       * 会造出重复 run（重复扣额度、重复副作用）。所以：连接断着就先等着（服务端重连时
       * 按 lastSeq 重放事件，本轮会自己接上），只有「连接正常却收不到 ack」或「长时间没
       * 恢复」才判失败。
       */
      const ACK_TIMEOUT_MS = 12_000;
      const ACK_MAX_WAIT_MS = 90_000;
      let waitedMs = 0;
      let ackTimer: number;
      const checkAck = () => {
        if (acked) return;
        waitedMs += ACK_TIMEOUT_MS;
        if (!ws.connected && waitedMs < ACK_MAX_WAIT_MS) {
          ackTimer = window.setTimeout(checkAck, 6_000);
          return;
        }
        markFailed(
          ws.connected
            ? "运行请求未被服务端确认（连接正常但未收到确认），请重试。"
            : "与服务端的连接长时间未恢复，本轮未能确认；重连后会自动同步，若一直无输出再重试。",
        );
      };
      ackTimer = window.setTimeout(checkAck, ACK_TIMEOUT_MS);

      ws.startRun(
        {
          sessionId,
          conversationId,
          // state 后端要求 run 挂项目。Code 模式下「工作目录=项目」：选中项目时
          // 用它的主画布作作用域（同一项目的多次运行共享同一沙箱目录）；
          // 未选工作目录时退回 conversationId，由服务端懒供给会话。
          canvasId: runCanvasId,
          // 模式指令（inputDirective）由服务端 pre-step 事件缝注入，客户端不再拼接
          prompt: `${
            mode === "code" && workDirName
              ? `${workDirectoryPromptHint(workDirName)}

`
              : ""
          }${
            thinking === "default"
              ? ""
              : `【思考强度：${thinking}】
`
          }${text.trim()}`,
          ...(model ? { model } : {}),
          executionMode,
        },
        (ack) => {
          acked = true;
          window.clearTimeout(ackTimer);
          const payload = ack.payload as { runId?: string } | undefined;
          if (payload?.runId) {
            activeRunIdRef.current = payload.runId;
            // 事件归属：本轮 run 属于哪个会话（用户中途切走也不会串台）
            runTaskIdRef.current = task.id;
            setRunningTaskId(task.id);
          }
          setSubmitting(false);
        },
      );
    },
    [
      mode,
      model,
      workDirName,
      thinking,
      executionMode,
      selectedProject,
      codeProjects,
      createCodeProject,
      session,
      ws,
    ],
  );

  const handleSignOut = useCallback(() => {
    void signOut();
    router.push("/login");
  }, [signOut, router]);

  /**
   * 本轮结束自动提交（「每次对话用 git 跟踪」）：Code 模式 + 已绑工作目录项目时，
   * 把这一轮的改动提交到工作目录的仓库里，便于回滚。
   *
   * 静默失败：不是 git 仓库 / 改动的就是没东西可提交 / git 不可用——都不打扰用户
   * （分支 chip 上本来就写着「非 Git 仓库」）。
   */
  /** 事件回调注册在挂载期（deps 只有 ws/mode），必须经 ref 读最新值——否则拿到的是
      首轮的 null（实测：自动提交静默不触发，就是因为闭包里的 token/项目是 null）。 */
  const autoCommitContextRef = useRef<{ token: string | null; canvasId: string | null }>({
    token: null,
    canvasId: null,
  });
  autoCommitContextRef.current = {
    token: session?.access_token ?? null,
    canvasId: selectedProject?.primaryCanvas?.id ?? null,
  };

  const autoCommitTurn = useCallback(
    async (taskId: string | null) => {
      const { token, canvasId } = autoCommitContextRef.current;
      if (!token || !canvasId || !taskId) return;
      const task = tasksByModeRef.current.code.find((t) => t.id === taskId);
      if (!task) return;
      const round = Math.max(
        1,
        task.messages.filter((m) => m.role === "assistant").length,
      );
      try {
        await commitGitAll(token, canvasId, `${task.title}（第 ${round} 轮）`);
        setLastAutoCommitAt(new Date().toISOString());
      } catch {
        // 没有仓库 / 无改动可提交：跳过
      }
    },
    [],
  );

  /** 任务视图内继续追问：追加 user 消息并复用同一会话发起新 run。 */
  const continueTask = useCallback(
    (text: string) => {
      const taskId = activeTaskId;
      if (!text.trim() || !taskId || !session?.access_token) return;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      setTasksByMode((prev) => {
        const list = prev[mode].map((t) =>
          t.id === taskId
            ? {
                ...t,
                messages: [
                  ...t.messages,
                  { role: "user" as const, text: text.trim() },
                ],
                status: "running" as const,
                // 新一轮起表，清掉上一轮的终态时刻
                runStartedAt: new Date().toISOString(),
                runEndedAt: undefined,
              }
            : t,
        );
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      setSubmitting(true);
      const thinkingHint =
        thinking === "default" ? "" : `【思考强度：${thinking}】\n`;
      const history = task.messages
        .slice(-12)
        .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text}`)
        .join("\n\n");
      const historyBlock = history
        ? `【对话历史（供参考，延续上文语境）】\n${history}\n\n【本轮用户消息】\n`
        : "";
      // 模式指令由服务端 pre-step 事件缝注入；这里只随载荷声明当前模式，
      // 服务端按 threadId 重新激活（continueTask 复用同一 thread）
      // 作用域必须与首轮一致：Code 模式下 run 挂的是项目主画布（工作目录=项目），
      // 追问若退回 conversationId 会换到另一个沙箱目录，上一轮写的文件就"消失"了。
      const taskProject =
        mode === "code" && task.projectId
          ? codeProjects.find((p) => p.id === task.projectId)
          : null;
      const taskCanvasId = taskProject?.primaryCanvas?.id ?? task.id;
      ws.startRun(
        {
          sessionId: task.sessionId,
          conversationId: task.id,
          canvasId: taskCanvasId,
          prompt: `${thinkingHint}${historyBlock}${text.trim()}`,
          ...(model ? { model } : {}),
          executionMode,
        },
        (ack) => {
          const payload = ack.payload as { runId?: string } | undefined;
          if (payload?.runId) {
            activeRunIdRef.current = payload.runId;
            runTaskIdRef.current = taskId;
            setRunningTaskId(taskId);
          }
          setSubmitting(false);
        },
      );
    },
    [
      activeTaskId,
      tasks,
      mode,
      model,
      thinking,
      executionMode,
      session,
      ws,
      codeProjects,
    ],
  );

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }
  if (!user) return null;

  const meta = MODE_META[mode];

  const modeItems = (["code", "design"] as const).map((m) => ({
    id: m,
    label: MODE_META[m].label,
    icon:
      m === "code" ? (
        <Code2 className="h-4 w-4 shrink-0" />
      ) : (
        <Palette className="h-4 w-4 shrink-0" />
      ),
  }));

  return (
    <div
      className="flex h-screen bg-background text-foreground"
      style={
        {
          "--workbench-sidebar": `${
            sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidth
          }px`,
        } as React.CSSProperties
      }
    >
      {sidebarCollapsed ? (
        /* 收起态：图标栏（模式切换 + 插件市场 + 底部头像） */
        <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-card py-2">
          <KenFutWorkLogo className="mb-1 size-7 shrink-0" />
          <button
            type="button"
            aria-label="展开侧栏"
            onClick={() => setSidebarCollapsed(false)}
            className="rounded-md p-2 hover:bg-muted"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <div className="my-1 w-6 border-t" />
          {modeItems.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              aria-label={item.label}
              data-active={mode === item.id}
              onClick={() => switchMode(item.id)}
              className="rounded-md p-2 hover:bg-muted data-[active=true]:bg-muted data-[active=true]:text-foreground data-[active=false]:text-muted-foreground"
            >
              {item.icon}
            </button>
          ))}
          <button
            type="button"
            title="插件市场"
            aria-label="插件市场"
            onClick={() => setPluginsOpen(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Layers className="h-4 w-4" />
          </button>
          <div className="mt-auto">
            <UserMenu
              user={workbenchUser}
              collapsed
              isAdmin={isPlatformAdmin}
              onOpenSettings={() => setSettingsTab("general")}
              onOpenAdmin={() => router.push("/admin")}
              onSignOut={handleSignOut}
            />
          </div>
        </aside>
      ) : (
        /* 展开态：logo + 模式切换 + 插件市场 + 项目(design) + 任务列表 + 底部个人中心 */
        <aside
          style={{ width: sidebarWidth }}
          className="relative flex shrink-0 flex-col border-r bg-card"
        >
          {/* 拖拽把手：贴侧栏右边缘；向右拖 = 变宽 */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            onMouseDown={startSidebarResize}
            className="absolute top-0 -right-0.5 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-foreground/20"
          />
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <span className="flex items-center gap-2">
              <KenFutWorkLogo className="size-7 text-foreground" />
              {/* 字标：加粗放大 + 品牌「岚」渐变（低饱和双色，深浅色各一套） */}
              <span className="bg-gradient-to-r from-[#2F3459] to-[#575E96] bg-clip-text text-lg font-bold tracking-tight text-transparent dark:from-[#A6ACD8] dark:to-[#C3C8E6]">
                KenFutWork
              </span>
            </span>
            <button
              type="button"
              aria-label="收起侧栏"
              onClick={() => setSidebarCollapsed(true)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          {/* 模式切换（开关式：一个分段控件内左右切换 Code / Design） */}
          <div className="px-3 pt-1 pb-0.5">
            <div
              role="radiogroup"
              aria-label="模式切换"
              className="flex items-center gap-1 rounded-lg bg-muted p-1"
            >
              {modeItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === item.id}
                  data-active={mode === item.id}
                  onClick={() => switchMode(item.id)}
                  className="flex min-h-[30px] flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:shadow-sm"
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mx-3 my-2 border-t" />

          <nav className="space-y-0.5 px-2">
            <button
              type="button"
              onClick={() => setPluginsOpen(true)}
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Layers className="h-4 w-4 shrink-0" /> 插件市场
            </button>
            <button
              type="button"
              onClick={() => setSkillsOpen(true)}
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Blocks className="h-4 w-4 shrink-0" /> 技能
            </button>
            <button
              type="button"
              onClick={() => setMcpOpen(true)}
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plug className="h-4 w-4 shrink-0" /> MCP
            </button>
            {/* 插件面板（能力 `ui`）：侧栏槽位 */}
            <PluginPanelButtons
              accessToken={session?.access_token ?? null}
              slot="sidebar"
              renderButton={(panel, open) => (
                <button
                  key={panel.id}
                  type="button"
                  onClick={open}
                  title={`插件 ${panel.pluginId} 提供的面板`}
                  className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <PanelsTopLeft className="h-4 w-4 shrink-0" /> {panel.title}
                </button>
              )}
            />
          </nav>

          <div className="mx-3 my-2 border-t" />

          {mode === "design" ? (
            /* Design：项目列表（+ 直接创建，无任务列表） */
            <div className="flex min-h-0 flex-1 flex-col px-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-xs text-muted-foreground">项目</span>
                <button
                  type="button"
                  aria-label="创建项目"
                  title="创建项目"
                  disabled={creatingProject}
                  onClick={() => {
                    void createProjectNamed("未命名画布").then((project) => {
                      if (project) setSelectedProjectId(project.id);
                    });
                  }}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-1">
                {projects.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {creatingProject ? "创建中…" : "暂无项目"}
                  </p>
                ) : (
                  projects.map((p) => (
                    <SidebarRow
                      key={p.id}
                      label={p.name}
                      active={selectedProjectId === p.id}
                      icon={
                        <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      }
                      onOpen={() => {
                        setSelectedProjectId(p.id);
                        setActiveTaskId(null);
                      }}
                      onRename={(next) => void renameProject(p.id, next)}
                      onDelete={() => void removeProject(p.id)}
                    />
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Code：项目列表（工作目录=项目，下面挂对话；右键重命名/归档/删除） */
            <div className="flex min-h-0 flex-1 flex-col px-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-xs text-muted-foreground">工作目录</span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="新建工作目录"
                    title="新建工作目录"
                    disabled={creatingProject}
                    onClick={() => {
                      void createCodeProject("未命名工作目录").then(
                        (project) => {
                          if (project) setSelectedProjectId(project.id);
                        },
                      );
                    }}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="新建对话"
                    title={
                      selectedProject
                        ? `在「${selectedProject.name}」下新建对话`
                        : "选中工作目录后新建对话会自动关联它"
                    }
                    onClick={() => {
                      // 新建对话：保留当前选中的工作目录，新对话即挂在它下面
                      setActiveTaskId(null);
                    }}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-1">
                {(() => {
                  const knownProjectIds = new Set(
                    codeProjects.map((p) => p.id),
                  );
                  /**
                   * 未分组 = 没有项目，或 projectId 指向一个已不存在的项目。
                   * 后者是必须的防御：项目被删/换库后，任务若仍带着孤儿 id，
                   * 既进不了任何项目分组、也不进未分组——对话会「凭空消失」。
                   */
                  const ungrouped = tasks.filter(
                    (t) =>
                      !t.archived &&
                      (t.projectId == null ||
                        !knownProjectIds.has(t.projectId)),
                  );
                  const archived = tasks.filter((t) => t.archived);
                  const taskRow = (t: WorkbenchTask) => {
                    const indicator = resolveTaskIndicator(
                      t.status === "running" && runningTaskId === t.id,
                      unreadTaskIds.includes(t.id),
                    );
                    return (
                      <SidebarRow
                        key={t.id}
                        label={t.title}
                        active={activeTaskId === t.id}
                        icon={
                          indicator === "running" ? (
                            /* 与对话图标同色（不再用琥珀色：侧栏一排转圈太抢眼） */
                            <Loader2
                              aria-label="运行中"
                              className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                            />
                          ) : (
                            <MessageSquare
                              className={`h-3.5 w-3.5 shrink-0 ${
                                indicator === "unread"
                                  ? "fill-current text-foreground"
                                  : "text-muted-foreground"
                              }`}
                            />
                          )
                        }
                        onOpen={() => setActiveTaskId(t.id)}
                        onRename={(next) => renameTask(t.id, next)}
                        onArchive={() => setTaskArchived(t.id, true)}
                        onDelete={() => deleteTask(t.id)}
                      />
                    );
                  };
                  /**
                   * 分组内的对话列表：默认只露前 `SESSION_PREVIEW_LIMIT` 条，
                   * 其余收进「显示更多」——一个工作目录下几十条对话时，侧栏不该被单个
                   * 工作目录撑满（展开状态按分组持久化）。
                   */
                  const taskGroup = (groupKey: string, items: WorkbenchTask[]) => {
                    const { visible, hiddenCount } = previewGroup(
                      items,
                      expandedGroups.includes(groupKey),
                    );
                    return (
                      <div className="ml-4 space-y-0.5 border-l pl-1">
                        {visible.map(taskRow)}
                        {hiddenCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleGroupExpanded(groupKey)}
                            className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            显示更多
                          </button>
                        ) : null}
                        {items.length > SESSION_PREVIEW_LIMIT &&
                        expandedGroups.includes(groupKey) ? (
                          <button
                            type="button"
                            onClick={() => toggleGroupExpanded(groupKey)}
                            className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground"
                          >
                            收起
                          </button>
                        ) : null}
                      </div>
                    );
                  };
                  return (
                    <>
                      {codeProjects.map((p) => {
                        const items = tasks.filter(
                          (t) => !t.archived && t.projectId === p.id,
                        );
                        return (
                          <div key={p.id}>
                            <SidebarRow
                              label={p.name}
                              active={selectedProjectId === p.id}
                              icon={
                                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              }
                              expanded={!collapsedProjects.includes(p.id)}
                              onToggleExpanded={() =>
                                setCollapsedProjects((prev) => {
                                  const next = prev.includes(p.id)
                                    ? prev.filter((id) => id !== p.id)
                                    : [...prev, p.id];
                                  try {
                                    window.localStorage.setItem(
                                      "workbench:collapsed-projects",
                                      JSON.stringify(next),
                                    );
                                  } catch {
                                    // 存储失败不影响使用
                                  }
                                  return next;
                                })
                              }
                              onOpen={() => {
                                setSelectedProjectId(p.id);
                                setWorkDirName(p.name);
                                setWorkDirNotice(null);
                              }}
                              onRename={(next) =>
                                void renameCodeProject(p.id, next)
                              }
                              onDelete={() => void removeCodeProject(p.id)}
                            />
                            {collapsedProjects.includes(p.id) ? null : (
                              items.length === 0 ? (
                                <div className="ml-4 space-y-0.5 border-l pl-1">
                                  <p className="px-2 py-1 text-xs text-muted-foreground/70">
                                    暂无对话
                                  </p>
                                </div>
                              ) : (
                                taskGroup(p.id, items)
                              )
                            )}
                          </div>
                        );
                      })}
                      {ungrouped.length > 0 ? (
                        <div>
                          <p className="px-2 py-1 text-xs text-muted-foreground">
                            未分组
                          </p>
                          {taskGroup(UNGROUPED_KEY, ungrouped)}
                        </div>
                      ) : null}
                      {archived.length > 0 ? (
                        <details className="px-1">
                          <summary className="cursor-pointer px-1 py-1 text-xs text-muted-foreground hover:text-foreground">
                            已归档（{archived.length}）
                          </summary>
                          <div className="ml-4 space-y-0.5 border-l pl-1">
                            {archived.map((t) => (
                              <SidebarRow
                                key={t.id}
                                label={t.title}
                                icon={
                                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                                }
                                onOpen={() => setActiveTaskId(t.id)}
                                onRename={(next) => renameTask(t.id, next)}
                                onRestore={() => setTaskArchived(t.id, false)}
                                onDelete={() => deleteTask(t.id)}
                              />
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* 底部：个人中心（头像弹出） */}
          <div className="border-t p-2">
            <UserMenu
              user={workbenchUser}
              collapsed={false}
              isAdmin={isPlatformAdmin}
              onOpenSettings={() => setSettingsTab("general")}
              onOpenAdmin={() => router.push("/admin")}
              onSignOut={handleSignOut}
            />
          </div>
        </aside>
      )}

      {/* 主区：Design＝画布（恒为画布，见 resolveWorkbenchSurface）/ Code＝任务视图 或 居中编排器 */}
      <main className="min-w-0 flex-1 overflow-hidden bg-card">
        {surface === "canvas" ? (
          /* Design：选中项目后画布自动打开（原版 KenFutWork 画布，对话在画布内助手里） */
          <iframe
            key={`${selectedProject?.primaryCanvas.id}:${canvasPrompt ?? ""}`}
            src={`/canvas?id=${selectedProject?.primaryCanvas.id}${
              canvasPrompt ? `&prompt=${encodeURIComponent(canvasPrompt)}` : ""
            }`}
            title={`${selectedProject?.name ?? ""} 画布`}
            className="h-full w-full border-0"
          />
        ) : activeTask ? (
          /* 转录列 + 右栏停靠面板（面板收起时返回 null，不占宽）。 */
          <div className="flex h-full">
          <div
            className="flex h-full min-w-0 flex-1 flex-col"
            style={
              { "--scrollbar-lane": `${scrollbarLane}px` } as React.CSSProperties
            }
          >
            {/* 标题行：会话标题 + 本轮回执 + 插件面板入口；右端贴住工作目录与分支。
                这两个 chip 取**对话自己绑定的项目**（run 的作用域就是它），
                不依赖侧栏选中态——否则打开历史对话时它们会消失（用户反馈）。 */}
            <div className="shrink-0 pr-[var(--scrollbar-lane,0px)]">
              <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 pt-6 pb-4">
              <h1 className="min-w-0 truncate text-lg font-medium">
                {activeTask.title}
              </h1>
              {lastAutoCommitAt ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  已自动提交本轮
                </span>
              ) : null}
              {/* 插件面板（能力 `ui`）：对话槽位 */}
              <PluginPanelButtons
                accessToken={session?.access_token ?? null}
                slot="conversation"
                renderButton={(panel, open) => (
                  <button
                    key={panel.id}
                    type="button"
                    onClick={open}
                    title={`插件 ${panel.pluginId} 提供的面板`}
                    className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    <PanelsTopLeft className="h-3.5 w-3.5" />
                    {panel.title}
                  </button>
                )}
              />
              {mode === "code" ? (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <WorkDirectorySelect
                    projects={codeProjects}
                    selectedProjectId={conversationProject?.id ?? null}
                    lockedHint={
                      conversationProject
                        ? `本次对话已绑定工作目录「${conversationProject.name}」`
                        : "本次对话没有绑定工作目录"
                    }
                    busy={creatingProject}
                    onSelect={() => undefined}
                    onOpenFolder={() => undefined}
                    onClear={() => undefined}
                  />
                  <GitBranchSelect
                    accessToken={session?.access_token ?? null}
                    canvasId={conversationProject?.primaryCanvas.id ?? null}
                    /* 自动提交后 key 变化 → 重新拉取更改统计 */
                    key={`${conversationProject?.primaryCanvas.id ?? ""}:${lastAutoCommitAt ?? ""}`}
                  />
                  {/* 面板开关：与参考图一致，右栏由这个键开合 */}
                  <button
                    type="button"
                    aria-label="面板"
                    aria-expanded={panelOpen}
                    title={panelOpen ? "收起面板" : "打开面板（变更 / 文档 / 子智能体）"}
                    onClick={() => setPanelOpen((current) => !current)}
                    className="rounded-md border p-1.5 text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground data-[active=true]:border-foreground/30 data-[active=true]:text-foreground"
                    data-active={panelOpen}
                  >
                    <PanelRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
              </div>
            </div>
            <div
              ref={codeMessagesRef}
              className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
              onContextMenu={chatMenu.open}
            >
              <div className="mx-auto w-full max-w-3xl space-y-4 px-6 pb-2">
              {activeTask.runStartedAt ? (
                <ElapsedEntry
                  startedAt={activeTask.runStartedAt}
                  endedAt={activeTask.runEndedAt}
                  running={activeTask.status === "running"}
                />
              ) : null}
              {/* 目标 + 进度（R1-2）：模型用了 write_todos 才出现，条数从事件流推导 */}
              {activeTask.todos && activeTask.todos.length > 0 ? (
                <TodoProgressPanel
                  /* 目标 = 本轮的用户诉求（最后一条用户消息），不是首条——
                     首条是这条对话最初问的，跟当前这轮的待办不是一回事 */
                  goal={
                    [...activeTask.messages]
                      .reverse()
                      .find((message) => message.role === "user")?.text ??
                    activeTask.title
                  }
                  items={activeTask.todos}
                  running={activeTask.status === "running"}
                />
              ) : null}
              {activeTask.subagents && activeTask.subagents.length > 0 ? (
                <SubagentDirectoryView
                  entries={activeTask.subagents}
                  running={activeTask.status === "running"}
                />
              ) : null}
              {(() => {
                // 「最终总结」标题挂在本轮最后一个 assistant 消息上方（R1-1 收尾总结）
                const lastAssistantIdx = activeTask.messages.reduce(
                  (last, msg, idx) => (msg.role === "assistant" ? idx : last),
                  -1,
                );
                const showSummary =
                  activeTask.status === "completed" &&
                  Boolean(activeTask.runEndedAt) &&
                  lastAssistantIdx >= 0;
                return activeTask.messages.map((msg, i) => (
                  <div key={i} className="space-y-1">
                    {showSummary && i === lastAssistantIdx ? (
                      <div className="text-xs font-medium text-muted-foreground">
                        最终总结
                      </div>
                    ) : null}
                    {/* 每条助手消息都带上「工作了多久」（用户口径：不能只显示一部分） */}
                    {msg.role === "assistant" && msg.elapsedMs !== undefined ? (
                      <div className="text-[11px] text-muted-foreground">
                        已工作 {formatElapsedSeconds(msg.elapsedMs / 1000)}
                      </div>
                    ) : null}
                    {msg.role === "user" ? (
                      <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap">
                        {msg.text}
                      </div>
                    ) : (
                      <div className="w-fit max-w-full rounded-2xl rounded-bl-md bg-muted px-4 py-2.5">
                        <MarkdownRenderer text={msg.text} />
                      </div>
                    )}
                  </div>
                ));
              })()}
              {(activeTask.tools ?? []).map((tool) => (
                <WorkbenchToolRow key={tool.toolCallId} tool={tool} />
              ))}
              {activeTask.status === "running" ? (
                <div
                  role="status"
                  className="flex w-fit items-center gap-1.5 rounded-2xl rounded-bl-md bg-muted px-4 py-3"
                  aria-label="生成中"
                >
                  {[0, 1, 2].map((dot) => (
                    <span
                      key={dot}
                      className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70"
                      style={{ animationDelay: `${dot * 150}ms` }}
                    />
                  ))}
                  <span className="ml-1 text-xs text-muted-foreground">
                    生成中…
                  </span>
                </div>
              ) : null}
              </div>
            </div>
            {/* 底部：继续对话（完整版工具行 + 多轮，复用同一会话）。
                工作目录与分支已移到标题行右端，输入框不再背标签条。 */}

            <div className="shrink-0 pr-[var(--scrollbar-lane,0px)]">
            <form
              className="mx-auto w-full max-w-3xl px-6 pt-3 pb-4"
              onSubmit={(e) => {
                e.preventDefault();
                const value = followUp;
                setFollowUp("");
                continueTask(value);
              }}
            >
              <div className="@container/composer rounded-xl border bg-background p-3">
                <textarea
                  ref={composerRef}
                  aria-label="继续对话"
                  value={followUp}
                  onChange={(e) => {
                    setFollowUp(e.target.value);
                    // 自动长高（并隐藏滚动条：对话框右侧不出现滚动条）
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }}
                  onContextMenu={composerMenu.open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const value = followUp;
                      setFollowUp("");
                      continueTask(value);
                    }
                  }}
                  rows={2}
                  placeholder="继续追问…"
                  style={{ scrollbarWidth: "none" }}
                  className="max-h-40 min-h-[24px] w-full resize-none overflow-hidden bg-transparent text-sm outline-none placeholder:text-muted-foreground [&::-webkit-scrollbar]:hidden"
                />
                {workDirNotice ? (
                  <p className="mt-2 text-xs text-destructive">
                    {workDirNotice}
                  </p>
                ) : null}
                <div className="mt-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      title="附件（即将上线）"
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  <ComposerCompactSelect
                    ariaLabel="权限档位"
                    icon={<ShieldCheck className="h-3.5 w-3.5" />}
                    options={TIER_OPTIONS}
                    value={tier}
                    onChange={(next) => {
                      void handleTierChange(next);
                    }}
                  />
                  <Select
                    aria-label="执行模式"
                    value={executionMode}
                    onValueChange={(next) => {
                      if (typeof next === "string")
                        setExecutionMode(next as ExecutionMode);
                    }}
                    items={executionModes.map((m) => ({
                      value: m.id,
                      label: m.label,
                    }))}
                  >
                    <SelectTrigger
                      className="gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
                      aria-label="执行模式"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="min-w-28">
                      {executionModes.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    aria-label="模型"
                    value={model}
                    onValueChange={(next) => {
                      if (typeof next === "string") handleModelChange(next);
                    }}
                    items={
                      models.length === 0
                        ? [{ value: "", label: "默认模型" }]
                        : models.map((m) => ({ value: m.id, label: m.name }))
                    }
                  >
                    <SelectTrigger
                      className="max-w-[200px] gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
                      aria-label="模型"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-w-[300px]">
                      {models.length === 0 ? (
                        <SelectItem value="">默认模型</SelectItem>
                      ) : (
                        models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            <span className="flex items-center gap-1.5">
                              <span>{m.name}</span>
                              {m.vision ? (
                                <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                  视觉
                                </span>
                              ) : null}
                            </span>
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  {/* 上下文容量 / 缓存命中（R4-1）：模型旁一个圆形入口 */}
                  <ContextUsageButton
                    usage={activeTask.usage ?? null}
                    contextWindow={
                      models.find((m) => m.id === model)?.contextWindow ?? null
                    }
                  />
                  <ComposerCompactSelect
                    ariaLabel="思考强度"
                    icon={<Brain className="h-3.5 w-3.5" />}
                    options={THINKING_OPTIONS}
                    value={thinking}
                    onChange={handleThinkingChange}
                    contentClassName="min-w-24"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="语音（即将上线）"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Mic className="h-4 w-4" />
                  </button>
                  {activeTask.status === "running" && activeRunIdRef.current ? (
                    /* 停止 = 暂停图标（与发送按钮同一个图标位，不再是一枚突兀的文字按钮）；
                       与 Design 画布助手共用同一个组件，免得两处图标/文案漂移 */
                    <RunStopButton
                      onStop={() => ws.cancelRun(activeRunIdRef.current!)}
                    />
                  ) : (
                    <button
                      type="submit"
                      aria-label="发送"
                      disabled={!followUp.trim()}
                      className="rounded-lg bg-primary p-2 text-primary-foreground disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              </div>
            </form>
            </div>
          </div>
          {/* 右栏停靠面板：变更 / 文档 / 子智能体（参考图 R3-1 的多标签面板） */}
          <WorkbenchSidePanel
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            tab={panelTab}
            onTabChange={setPanelTab}
            accessToken={session?.access_token ?? null}
            canvasId={conversationProject?.primaryCanvas.id ?? null}
            subagents={activeTask.subagents ?? []}
            running={activeTask.status === "running"}
            widthLimits={panelLimits}
            /* CSS 兜底：宿主不派发 resize 事件时 JS 的 limits 会陈旧，这条由排版保证
               对话列 ≥ MIN_CONVERSATION_WIDTH（数值与 lib/panel-layout 同一口径） */
            maxWidthExpression={`calc(100vw - var(--workbench-sidebar, 256px) - ${MIN_CONVERSATION_WIDTH}px)`}
            /* 拖到上限还往里拖 → 收起左栏腾地方（用户口径：再往左边拉，侧栏自动收起来） */
            onGrowBlocked={() => setSidebarCollapsed(true)}
          />
          </div>
        ) : (
            <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6">
            <div className="mb-9 flex items-center gap-3">
              {mode === "code" ? (
                <Code2 className="h-8 w-8" />
              ) : (
                <Palette className="h-8 w-8" />
              )}
              <h1 className="text-4xl font-semibold tracking-tight">
                {meta.title}
              </h1>
            </div>

            <div className="w-full">
              {/* 工作目录 + 分支：贴住输入框上沿的标签条（文件夹标签的读法），
                  不再挤进输入框底部那排小控件 */}
              <div className="flex items-center gap-3 rounded-t-2xl border border-b-0 bg-muted/50 px-3 py-1.5">
                <WorkDirectorySelect
                  projects={codeProjects}
                  selectedProjectId={selectedProjectId}
                  busy={creatingProject}
                  onSelect={(projectId) => {
                    const project = codeProjects.find(
                      (p) => p.id === projectId,
                    );
                    setSelectedProjectId(projectId);
                    setWorkDirName(project?.name ?? null);
                    setWorkDirNotice(null);
                  }}
                  onOpenFolder={() => void pickWorkDirectory()}
                  onClear={clearWorkDirectory}
                />
                <GitBranchSelect
                  accessToken={session?.access_token ?? null}
                  canvasId={selectedProject?.primaryCanvas.id ?? null}
                />
              </div>
              <div className="@container/composer rounded-b-2xl border bg-background p-4 shadow-sm">
              <textarea
                aria-label="任务描述"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    startTask(prompt);
                  }
                }}
                rows={2}
                placeholder={
                  mode === "design"
                    ? "从想法到设计，生成可交付的页面原型。先在左侧创建一个项目。"
                    : meta.placeholder
                }
                className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {workDirNotice ? (
                <p className="mt-2 text-xs text-destructive">{workDirNotice}</p>
              ) : null}
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="附件（即将上线）"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  <ComposerCompactSelect
                    ariaLabel="权限档位"
                    icon={<ShieldCheck className="h-3.5 w-3.5" />}
                    options={TIER_OPTIONS}
                    value={tier}
                    onChange={(next) => {
                      void handleTierChange(next);
                    }}
                  />
                  <Select
                    aria-label="执行模式"
                    value={executionMode}
                    onValueChange={(next) => {
                      if (typeof next === "string")
                        setExecutionMode(next as ExecutionMode);
                    }}
                    items={executionModes.map((m) => ({
                      value: m.id,
                      label: m.label,
                    }))}
                  >
                    <SelectTrigger
                      className="gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
                      aria-label="执行模式"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="min-w-28">
                      {executionModes.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    aria-label="模型"
                    value={model}
                    onValueChange={(next) => {
                      if (typeof next === "string") handleModelChange(next);
                    }}
                    items={
                      models.length === 0
                        ? [{ value: "", label: "默认模型" }]
                        : models.map((m) => ({ value: m.id, label: m.name }))
                    }
                  >
                    <SelectTrigger
                      className="max-w-[200px] gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
                      aria-label="模型"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-w-[300px]">
                      {models.length === 0 ? (
                        <SelectItem value="">默认模型</SelectItem>
                      ) : (
                        <>
                          {(() => {
                            // BYOK（providerName 存在）分组在前，内置目录在后
                            const byok = models.filter((m) => m.providerName);
                            const builtin = models.filter(
                              (m) => !m.providerName,
                            );
                            const badge = (m: (typeof models)[number]) => (
                              <>
                                {m.vision ? (
                                  <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                    视觉
                                  </span>
                                ) : null}
                                {m.contextWindow &&
                                m.contextWindow >= 1_000_000 ? (
                                  <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                    1M
                                  </span>
                                ) : null}
                              </>
                            );
                            return (
                              <>
                                {byok.length > 0 ? (
                                  <>
                                    <SelectLabel>
                                      {byok[0]!.providerName?.trim() ??
                                        "我的供应商"}
                                    </SelectLabel>
                                    {byok.map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        <span className="flex items-center gap-1.5">
                                          <span>{m.name}</span>
                                          {badge(m)}
                                        </span>
                                      </SelectItem>
                                    ))}
                                  </>
                                ) : null}
                                {builtin.length > 0 ? (
                                  <>
                                    <SelectLabel>内置模型</SelectLabel>
                                    {builtin.map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        <span className="flex items-center gap-1.5">
                                          <span>{m.name}</span>
                                          {badge(m)}
                                        </span>
                                      </SelectItem>
                                    ))}
                                  </>
                                ) : null}
                              </>
                            );
                          })()}
                          <div className="-mx-1 my-1 border-t" />
                          <button
                            type="button"
                            onClick={() => setSettingsTab("providers")}
                            className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            管理模型…
                          </button>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  {/* 上下文容量 / 缓存命中（R4-1）：模型旁一个圆形入口 */}
                  <ContextUsageButton
                    usage={null}
                    contextWindow={
                      models.find((m) => m.id === model)?.contextWindow ?? null
                    }
                  />
                  <ComposerCompactSelect
                    ariaLabel="思考强度"
                    icon={<Brain className="h-3.5 w-3.5" />}
                    options={THINKING_OPTIONS}
                    value={thinking}
                    onChange={handleThinkingChange}
                    contentClassName="min-w-24"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="语音（即将上线）"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Mic className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="发送"
                    disabled={submitting || !prompt.trim()}
                    onClick={() => startTask(prompt)}
                    className="rounded-lg bg-primary p-2 text-primary-foreground disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </div>
              </div>
            </div>

            <div className="mt-5 flex items-center gap-3">
              {meta.chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setPrompt(chip)}
                  className="rounded-full border px-4 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      <SettingsModal
        open={settingsTab !== null}
        initialTab={settingsTab === null ? undefined : settingsTab}
        onClose={() => setSettingsTab(null)}
        accessToken={session?.access_token ?? null}
      />
      {pluginsOpen ? (
        <PluginMarketModal
          open={pluginsOpen}
          onClose={() => setPluginsOpen(false)}
          accessToken={session?.access_token ?? null}
          // 「从工作目录安装」用：服务端据此解析沙箱目录
          canvasId={selectedProject?.primaryCanvas?.id ?? null}
          isAdmin={isPlatformAdmin}
        />
      ) : null}
      {skillsOpen ? (
        <SkillsModal
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          accessToken={session?.access_token ?? null}
          // 「从工作目录导入」用：两类项目都有主画布，服务端据此解析沙箱目录
          canvasId={selectedProject?.primaryCanvas?.id ?? null}
        />
      ) : null}
      {/* MCP 管理：从「设置」挪到侧栏（与技能并列），页面带精选目录与官方注册表 */}
      {mcpOpen ? (
        <McpModal
          open={mcpOpen}
          onClose={() => setMcpOpen(false)}
          accessToken={session?.access_token ?? null}
        />
      ) : null}
      <ComposerContextMenu
        state={composerMenu.state}
        items={composerMenu.items}
        onRun={(item) => void composerMenu.run(item)}
        onClose={composerMenu.close}
      />
      <ChatContextMenu
        state={chatMenu.state}
        messages={(activeTask?.messages ?? []).map((message) => ({
          role: message.role,
          text: message.text,
        }))}
        containerRef={codeMessagesRef}
        onPasteText={(text) => setFollowUp((prev) => `${prev}${text}`)}
        onNotice={(message) => setChatNotice(message)}
        onClose={chatMenu.close}
      />
      {chatNotice ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[3000] -translate-x-1/2 rounded-xl border border-border bg-card px-4 py-2 text-xs text-foreground shadow-lg"
        >
          {chatNotice}
        </div>
      ) : null}
    </div>
  );
}
