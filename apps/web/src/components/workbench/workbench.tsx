"use client";

import type { ExecutionMode, ProjectSummary } from "@loomic/shared";
import {
  Brain,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Mic,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { PluginMarketModal } from "@/components/workbench/plugin-market-modal";
import {
  SettingsModal,
  type SettingsTab,
} from "@/components/workbench/settings-modal";
import { SidebarRow } from "@/components/workbench/sidebar-row";
import { UserMenu, type WorkbenchUser } from "@/components/workbench/user-menu";
import { useWebSocket } from "@/hooks/use-websocket";
import { useAuth } from "@/lib/auth-context";
import { getServerBaseUrl } from "@/lib/env";
import {
  createProject,
  deleteProject,
  fetchProjects,
  fetchViewer,
  updateProject,
} from "@/lib/server-api";
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
/** Code 模式项目（本地文件夹，与 Design 的 projects 实体隔离）。 */
const CODE_PROJECTS_KEY = "workbench:code-projects";

interface CodeProject {
  id: string;
  name: string;
  createdAt: number;
}

function loadCodeProjects(): CodeProject[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CODE_PROJECTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (p): p is CodeProject =>
            typeof p?.id === "string" && typeof p?.name === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function saveCodeProjects(list: CodeProject[]) {
  try {
    window.localStorage.setItem(CODE_PROJECTS_KEY, JSON.stringify(list));
  } catch {
    // 存储失败不阻塞
  }
}

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
  const [tier, setTier] = useState("default");
  const [codeProjects, setCodeProjects] = useState<CodeProject[]>([]);
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
  const [creatingProject, setCreatingProject] = useState(false);
  // 侧栏底部个人中心 + 模态（设置 / 插件市场）
  const [workbenchUser, setWorkbenchUser] = useState<WorkbenchUser | null>(
    null,
  );
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  /** 平台管理员标记：仅用于「显示后台入口」，鉴权在服务端（/api/admin/*）。 */
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  const activeRunIdRef = useRef<string | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  activeTaskIdRef.current = activeTaskId;

  const tasks = tasksByMode[mode];
  const selectedProject =
    projects.find((p) => p.id === selectedProjectId) ?? null;

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
    setCodeProjects(loadCodeProjects());
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
    fetchProjects(token)
      .then((data) => setProjects(data.projects))
      .catch(() => {});
  }, [session]);

  // Design 模式项目列表（复用 Loomic 项目/画布）
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

  // ── Code 项目（本地文件夹）动作 ──
  const createCodeProject = useCallback((name: string) => {
    const project: CodeProject = {
      id: `code-${crypto.randomUUID()}`,
      name,
      createdAt: Date.now(),
    };
    setCodeProjects((prev) => {
      const next = [project, ...prev];
      saveCodeProjects(next);
      return next;
    });
    return project;
  }, []);

  const renameCodeProject = useCallback((id: string, name: string) => {
    setCodeProjects((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, name } : p));
      saveCodeProjects(next);
      return next;
    });
  }, []);

  const removeCodeProject = useCallback((id: string) => {
    setCodeProjects((prev) => {
      const next = prev.filter((p) => p.id !== id);
      saveCodeProjects(next);
      return next;
    });
    setSelectedProjectId((current) => (current === id ? null : current));
    // 其下对话转为未分组
    setTasksByMode((prev) => {
      const list = prev.code.map((t) =>
        t.projectId === id ? { ...t, projectId: null } : t,
      );
      saveTasks("code", list);
      return { ...prev, code: list };
    });
  }, []);

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
        apply((task) => ({
          ...task,
          status: "failed",
          messages: [
            ...task.messages,
            { role: "assistant", text: "运行失败，请重试。" },
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
    try {
      const picker = (
        window as unknown as {
          showDirectoryPicker?: () => Promise<{ name: string }>;
        }
      ).showDirectoryPicker;
      if (!picker) {
        return;
      }
      const dir = await picker();
      setWorkDirName(dir.name);
    } catch {
      // 用户取消或浏览器不支持
    }
  }, []);

  const switchMode = useCallback((next: WorkbenchMode) => {
    setMode(next);
    setActiveTaskId(null);
  }, []);

  const startTask = useCallback(
    (text: string) => {
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
      const title = text.trim().slice(0, 24) || "新任务";
      const task: WorkbenchTask = {
        id: conversationId,
        sessionId,
        title,
        mode,
        createdAt: Date.now(),
        messages: [{ role: "user", text: text.trim() }],
        status: "running",
        projectId: mode === "code" ? (selectedProjectId ?? null) : null,
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
          // state 后端要求 run 挂 canvas；workbench 任务以 conversationId 作为
          // 独立标识（事件按它路由，与 handler 的绑定逻辑一致）
          canvasId: conversationId,
          // 模式指令（inputDirective）由服务端 pre-step 事件缝注入，客户端不再拼接
          prompt: `${
            mode === "code" && workDirName
              ? `【工作目录】${workDirName}

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
      selectedProjectId,
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
      ws.startRun(
        {
          sessionId: task.sessionId,
          conversationId: task.id,
          canvasId: task.id,
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
    [activeTaskId, tasks, mode, model, thinking, executionMode, session, ws],
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
            /* Code：项目列表（文件夹=项目，下面挂对话；右键重命名/归档/删除） */
            <div className="flex min-h-0 flex-1 flex-col px-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-xs text-muted-foreground">项目列表</span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="新建项目"
                    title="新建项目"
                    onClick={() => {
                      const project = createCodeProject("未命名项目");
                      setSelectedProjectId(project.id);
                    }}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="新建对话"
                    title="新建对话"
                    onClick={() => setActiveTaskId(null)}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-1">
                {(() => {
                  const ungrouped = tasks.filter(
                    (t) => !t.archived && t.projectId == null,
                  );
                  const archived = tasks.filter((t) => t.archived);
                  const taskRow = (t: WorkbenchTask) => (
                    <SidebarRow
                      key={t.id}
                      label={t.title}
                      active={activeTaskId === t.id}
                      icon={
                        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
                              onOpen={() => setSelectedProjectId(p.id)}
                              onRename={(next) => renameCodeProject(p.id, next)}
                              onDelete={() => removeCodeProject(p.id)}
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
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
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
                aria-label="继续对话"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
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
                className="max-h-32 min-h-[24px] w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="附件（即将上线）"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="选择工作目录"
                    onClick={() => void pickWorkDirectory()}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {workDirName ?? "选择文件夹"}
                  </button>
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
              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="附件（即将上线）"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="选择工作目录"
                    onClick={() => void pickWorkDirectory()}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {workDirName ?? "选择文件夹"}
                  </button>
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
    </div>
  );
}
