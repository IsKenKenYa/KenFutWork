"use client";

import type { ExecutionMode, ProjectSummary } from "@loomic/shared";
import {
  Blocks,
  Brain,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  MessageSquare,
  Mic,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
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
import { LoomicLogo } from "@/components/icons/loomic-logo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { McpModal } from "@/components/workbench/mcp-modal";
import { PluginMarketModal } from "@/components/workbench/plugin-market-modal";
import {
  SettingsModal,
  type SettingsTab,
} from "@/components/workbench/settings-modal";
import { SidebarRow } from "@/components/workbench/sidebar-row";
import { SkillsModal } from "@/components/workbench/skills-modal";
import { UserMenu, type WorkbenchUser } from "@/components/workbench/user-menu";
import { WorkDirectorySelect } from "@/components/workbench/work-directory-select";
import { useWebSocket } from "@/hooks/use-websocket";
import { useAuth } from "@/lib/auth-context";
import { getServerBaseUrl } from "@/lib/env";
import { describeRunFailure } from "@/lib/run-failure";
import {
  createProject,
  deleteProject,
  fetchProjects,
  fetchViewer,
  updateProject,
} from "@/lib/server-api";
import {
  resolveWorkDirProject,
  workDirectoryPromptHint,
  pickWorkDirectory as workDirPick,
} from "@/lib/work-directory";
import {
  resolveWorkbenchSurface,
  type WorkbenchMode,
} from "@/lib/workbench-surface";

/**
 * Agent 工作台（产品主入口）：Code / Design 双模式（DEC-2）。
 * 模式切换、插件市场、任务列表与个人中心全部内聚在左侧栏（TRAE 式），
 * 设置与插件市场为居中模态；design 模式的画布经项目面板自动打开（Loomic
 * 仅作为 design 模式及其依赖能力的承载）。
 */

interface TaskMessage {
  role: "user" | "assistant";
  text: string;
}

type WorkbenchModelOption = {
  id: string;
  name: string;
  providerName?: string | undefined;
  vision?: boolean | undefined;
  contextWindow?: number | undefined;
};

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
}

const MODE_META: Record<
  WorkbenchMode,
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
      setThinking(
        window.localStorage.getItem("workbench:thinking") ?? "default",
      );
    } catch {
      // 存储不可用时用默认档
    }
  }, []);

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
      .then((data) => setProjects(data.projects))
      .catch(() => {});
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

  // Design 模式自动进画布：无选中项目时选第一个；列表为空则自动建「未命名画布」
  useEffect(() => {
    if (mode !== "design" || activeTaskId || creatingProject) return;
    if (selectedProjectId) return;
    if (projects.length > 0) {
      setSelectedProjectId(projects[0]!.id);
      return;
    }
    void createProjectNamed("未命名画布").then((project) => {
      if (project) setSelectedProjectId(project.id);
    });
  }, [
    mode,
    activeTaskId,
    selectedProjectId,
    projects,
    creatingProject,
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
        setModel((current) => current || data.models[0]?.id || "");
      })
      .catch(() => {});
  }, [session]);

  // 流事件 → 任务消息
  useEffect(() => {
    const off = ws.onEvent((evt) => {
      const runId = (evt as { runId?: string }).runId;
      if (!runId || runId !== activeRunIdRef.current) return;
      const type = (evt as { type?: string }).type;
      const taskId = activeTaskIdRef.current;
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
      if (type === "message.delta") {
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
            messages.push({ role: "assistant", text: delta });
          }
          return { ...task, messages };
        });
      } else if (type === "run.completed") {
        apply((task) => ({ ...task, status: "completed" }));
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
      } else if (type === "run.failed") {
        // 服务端在 error.message 里给的是可读原因（如「模型流已 180 秒没有任何
        // 输出（上游停滞）」「run 未绑定项目」）。此前一律丢弃、只显示固定文案，
        // 用户无法判断该重试、换模型还是去建项目——这里按 billing.error 的同一
        // 口径透出；确实没有原因时才回落到通用文案。
        const failureText = describeRunFailure(evt);
        apply((task) => ({
          ...task,
          status: "failed",
          messages: [
            ...task.messages,
            { role: "assistant", text: failureText },
          ],
        }));
      } else if (type === "run.canceled") {
        apply((task) => ({ ...task, status: "completed" }));
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
      const ackTimer = window.setTimeout(() => {
        if (!acked) {
          markFailed("运行请求未被服务端确认（连接可能刚重连），请重试。");
        }
      }, 12_000);

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
    <div className="flex h-screen bg-background text-foreground">
      {sidebarCollapsed ? (
        /* 收起态：图标栏（模式切换 + 插件市场 + 底部头像） */
        <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-card py-2">
          <LoomicLogo className="mb-1 size-7 shrink-0" />
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
        <aside className="flex w-64 shrink-0 flex-col border-r bg-card">
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <span className="flex items-center gap-2">
              <LoomicLogo className="size-7 text-foreground" />
              <span className="text-base font-semibold tracking-tight">
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
                  const taskRow = (t: WorkbenchTask) => (
                    <SidebarRow
                      key={t.id}
                      label={t.title}
                      active={activeTaskId === t.id}
                      icon={
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      }
                      onOpen={() => setActiveTaskId(t.id)}
                      onRename={(next) => renameTask(t.id, next)}
                      onArchive={() => setTaskArchived(t.id, true)}
                      onDelete={() => deleteTask(t.id)}
                    />
                  );
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
                            <div className="ml-4 space-y-0.5 border-l pl-1">
                              {items.length === 0 ? (
                                <p className="px-2 py-1 text-xs text-muted-foreground/70">
                                  暂无对话
                                </p>
                              ) : (
                                items.map(taskRow)
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {ungrouped.length > 0 ? (
                        <div>
                          <p className="px-2 py-1 text-xs text-muted-foreground">
                            未分组
                          </p>
                          <div className="ml-4 space-y-0.5 border-l pl-1">
                            {ungrouped.map(taskRow)}
                          </div>
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
          /* Design：选中项目后画布自动打开（原版 Loomic 画布，对话在画布内助手里） */
          <iframe
            key={`${selectedProject?.primaryCanvas.id}:${canvasPrompt ?? ""}`}
            src={`/canvas?id=${selectedProject?.primaryCanvas.id}${
              canvasPrompt ? `&prompt=${encodeURIComponent(canvasPrompt)}` : ""
            }`}
            title={`${selectedProject?.name ?? ""} 画布`}
            className="h-full w-full border-0"
          />
        ) : activeTask ? (
          <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
            <h1 className="mb-4 text-lg font-medium">{activeTask.title}</h1>
            <div
              ref={codeMessagesRef}
              className="min-h-0 flex-1 space-y-4 overflow-y-auto"
              onContextMenu={chatMenu.open}
            >
              {activeTask.messages.map((msg, i) =>
                msg.role === "user" ? (
                  <div
                    key={i}
                    className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap"
                  >
                    {msg.text}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="w-fit max-w-full rounded-2xl rounded-bl-md bg-muted px-4 py-2.5"
                  >
                    <MarkdownRenderer text={msg.text} />
                  </div>
                ),
              )}
              {activeTask.status === "running" ? (
                <div
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
            {/* 底部：继续对话（完整版工具行 + 多轮，复用同一会话） */}
            <form
              className="mt-4 rounded-xl border bg-background p-3"
              onSubmit={(e) => {
                e.preventDefault();
                const value = followUp;
                setFollowUp("");
                continueTask(value);
              }}
            >
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
                  <Select
                    aria-label="权限档位"
                    value={tier}
                    onValueChange={(next) => {
                      const tierValue = typeof next === "string" ? next : tier;
                      if (tierValue !== tier) void handleTierChange(tierValue);
                    }}
                    items={[
                      { value: "default", label: "默认" },
                      { value: "auto-approve", label: "自动放行" },
                      { value: "full-access", label: "完全访问" },
                    ]}
                  >
                    <SelectTrigger
                      className="gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
                      aria-label="权限档位"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="min-w-28">
                      <SelectItem value="default">默认</SelectItem>
                      <SelectItem value="auto-approve">自动放行</SelectItem>
                      <SelectItem value="full-access">完全访问</SelectItem>
                    </SelectContent>
                  </Select>
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
                      if (typeof next === "string") setModel(next);
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
                  <Select
                    aria-label="思考强度"
                    value={thinking}
                    onValueChange={(next) => {
                      if (typeof next === "string") handleThinkingChange(next);
                    }}
                    items={[
                      { value: "default", label: "默认" },
                      { value: "低", label: "低" },
                      { value: "中", label: "中" },
                      { value: "高", label: "高" },
                      { value: "最高", label: "最高" },
                    ]}
                  >
                    <SelectTrigger
                      className="gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
                      aria-label="思考强度"
                    >
                      <Brain className="h-3.5 w-3.5" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="min-w-24">
                      <SelectItem value="default">默认</SelectItem>
                      <SelectItem value="低">低</SelectItem>
                      <SelectItem value="中">中</SelectItem>
                      <SelectItem value="高">高</SelectItem>
                      <SelectItem value="最高">最高</SelectItem>
                    </SelectContent>
                  </Select>
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
                    <button
                      type="button"
                      className="rounded-md border px-3 py-1.5 text-sm text-destructive hover:bg-muted"
                      onClick={() => ws.cancelRun(activeRunIdRef.current!)}
                    >
                      停止
                    </button>
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
            </form>
          </div>
        ) : (
          <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6">
            <div className="mb-6 flex items-center gap-3">
              {mode === "code" ? (
                <Code2 className="h-8 w-8" />
              ) : (
                <Palette className="h-8 w-8" />
              )}
              <h1 className="text-4xl font-semibold tracking-tight">
                {meta.title}
              </h1>
            </div>

            <div className="w-full rounded-2xl border bg-background p-4 shadow-sm">
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
              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="附件（即将上线）"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
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
                  <Select
                    aria-label="权限档位"
                    value={tier}
                    onValueChange={(next) => {
                      const tierValue = typeof next === "string" ? next : tier;
                      if (tierValue !== tier) void handleTierChange(tierValue);
                    }}
                    items={[
                      { value: "default", label: "默认" },
                      { value: "auto-approve", label: "自动放行" },
                      { value: "full-access", label: "完全访问" },
                    ]}
                  >
                    <SelectTrigger
                      className="gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
                      aria-label="权限档位"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="min-w-28">
                      <SelectItem value="default">默认</SelectItem>
                      <SelectItem value="auto-approve">自动放行</SelectItem>
                      <SelectItem value="full-access">完全访问</SelectItem>
                    </SelectContent>
                  </Select>
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
                      if (typeof next === "string") setModel(next);
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
                  <Select
                    aria-label="思考强度"
                    value={thinking}
                    onValueChange={(next) => {
                      if (typeof next === "string") handleThinkingChange(next);
                    }}
                    items={[
                      { value: "default", label: "默认" },
                      { value: "低", label: "低" },
                      { value: "中", label: "中" },
                      { value: "高", label: "高" },
                      { value: "最高", label: "最高" },
                    ]}
                  >
                    <SelectTrigger
                      className="gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
                      aria-label="思考强度"
                    >
                      <Brain className="h-3.5 w-3.5" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="min-w-24">
                      <SelectItem value="default">默认</SelectItem>
                      <SelectItem value="低">低</SelectItem>
                      <SelectItem value="中">中</SelectItem>
                      <SelectItem value="高">高</SelectItem>
                      <SelectItem value="最高">最高</SelectItem>
                    </SelectContent>
                  </Select>
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
      />
      {pluginsOpen ? (
        <PluginMarketModal
          open={pluginsOpen}
          onClose={() => setPluginsOpen(false)}
          accessToken={session?.access_token ?? null}
        />
      ) : null}
      {skillsOpen ? (
        <SkillsModal
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          accessToken={session?.access_token ?? null}
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
