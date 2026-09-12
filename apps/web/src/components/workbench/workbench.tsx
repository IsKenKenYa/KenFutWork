"use client";

import type { ProjectSummary } from "@loomic/shared";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Folder,
  FolderOpen,
  Layers,
  Mic,
  Palette,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  User,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWebSocket } from "@/hooks/use-websocket";
import { useAuth } from "@/lib/auth-context";
import { getServerBaseUrl } from "@/lib/env";
import { createProject, fetchProjects } from "@/lib/server-api";

/**
 * Agent 工作台（产品主入口）：Code / Design 双模式（DEC-2）。
 * 顶部模式切换 + 任务侧栏 + 居中任务编排器。
 * design 模式的画布（Loomic 能力面）经「打开画布」进入，Loomic 仅作为
 * design 模式及其依赖能力的承载。
 */

type WorkbenchMode = "code" | "design";

interface TaskMessage {
  role: "user" | "assistant";
  text: string;
}

interface WorkbenchTask {
  id: string; // conversationId
  sessionId: string;
  title: string;
  mode: WorkbenchMode;
  createdAt: number;
  messages: TaskMessage[];
  status: "running" | "completed" | "failed";
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
    return raw ? (JSON.parse(raw) as WorkbenchTask[]) : [];
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
  const { user, session, loading } = useAuth();
  const getToken = useCallback(() => session?.access_token ?? null, [session]);
  const ws = useWebSocket(getToken);

  const [mode, setMode] = useState<WorkbenchMode>("code");
  const [tasksByMode, setTasksByMode] = useState<
    Record<WorkbenchMode, WorkbenchTask[]>
  >({ code: [], design: [] });
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [tier, setTier] = useState("default");
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Design 模式：项目面板（创建/列表，可收缩）+ 原版画布内嵌
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Code 模式：本地工作目录（File System Access API，浏览器支持时可用）
  const [workDirName, setWorkDirName] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

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

  // 鉴权守卫
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // 任务列表载入
  useEffect(() => {
    setTasksByMode({
      code: loadTasks("code"),
      design: loadTasks("design"),
    });
  }, []);

  // Design 模式项目列表（复用 Loomic 项目/画布）
  useEffect(() => {
    if (!session?.access_token) return;
    fetchProjects(session.access_token)
      .then((data) => setProjects(data.projects))
      .catch(() => {});
  }, [session]);

  const handleCreateProject = useCallback(async () => {
    const token = session?.access_token;
    if (!token || !newProjectName.trim()) return;
    setCreatingProject(true);
    try {
      const result = await createProject(token, {
        name: newProjectName.trim(),
      });
      setProjects((prev) => [result.project, ...prev]);
      setSelectedProjectId(result.project.id);
      setNewProjectName("");
    } catch {
      // 创建失败保留在创建视图
    } finally {
      setCreatingProject(false);
    }
  }, [session, newProjectName]);

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
      .then((data: { models: Array<{ id: string; name: string }> }) => {
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

  const updateTask = useCallback(
    (taskId: string, mutate: (task: WorkbenchTask) => WorkbenchTask) => {
      setTasksByMode((prev) => {
        const list = prev[mode].map((t) => (t.id === taskId ? mutate(t) : t));
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
    },
    [mode],
  );

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

  const startTask = useCallback(
    (text: string) => {
      if (!text.trim() || !session?.access_token) return;
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
      };
      setTasksByMode((prev) => {
        const list = [task, ...prev[mode]];
        saveTasks(mode, list);
        return { ...prev, [mode]: list };
      });
      setActiveTaskId(task.id);
      setPrompt("");
      setSubmitting(true);

      ws.startRun(
        {
          sessionId,
          conversationId,
          prompt:
            mode === "code" && workDirName
              ? `【工作目录】${workDirName}\n\n${text.trim()}`
              : text.trim(),
          ...(model ? { model } : {}),
          ...(mode === "design" ? { preset: "design" as const } : {}),
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
    [mode, model, workDirName, session, ws],
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

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* 顶部：模式切换（Code / Design 双模式，DEC-2）+ 侧栏收缩 */}
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="rounded-md p-2 hover:bg-muted"
          >
            {sidebarCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            {(["code", "design"] as const).map((m) => (
              <button
                key={m}
                type="button"
                data-active={mode === m}
                onClick={() => {
                  setMode(m);
                  setActiveTaskId(null);
                }}
                className="flex min-h-[32px] items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:shadow-sm"
              >
                {m === "code" ? <Code2 className="h-4 w-4" /> : null}
                {m === "design" ? <Palette className="h-4 w-4" /> : null}
                {MODE_META[m].label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          aria-label="设置"
          onClick={() => router.push("/settings")}
          className="rounded-md p-2 hover:bg-muted"
        >
          <Settings className="h-4 w-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左侧栏（可收缩）：新建任务 / 项目(design) / 任务列表 —— 二合一 */}
        {sidebarCollapsed ? (
          <aside className="flex w-12 shrink-0 flex-col items-center gap-2 border-r bg-card py-2">
            <button
              type="button"
              title="新建任务"
              onClick={() => setActiveTaskId(null)}
              className="rounded-md p-2 hover:bg-muted"
            >
              <Plus className="h-4 w-4" />
            </button>
            {mode === "design" ? (
              <button
                type="button"
                title="项目"
                onClick={() => setActiveTaskId(null)}
                className="rounded-md p-2 hover:bg-muted"
              >
                <Palette className="h-4 w-4" />
              </button>
            ) : null}
            <button
              type="button"
              title="插件市场"
              onClick={() => router.push("/plugins")}
              className="rounded-md p-2 hover:bg-muted"
            >
              <Layers className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="任务列表"
              onClick={() => setActiveTaskId(null)}
              className="rounded-md p-2 hover:bg-muted"
            >
              <Folder className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="个人中心"
              onClick={() => router.push("/profile")}
              className="rounded-md p-2 hover:bg-muted"
            >
              <User className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="设置"
              onClick={() => router.push("/settings")}
              className="mt-auto rounded-md p-2 hover:bg-muted"
            >
              <Settings className="h-4 w-4" />
            </button>
          </aside>
        ) : (
          <aside className="flex w-64 shrink-0 flex-col border-r bg-card p-2">
            <button
              type="button"
              onClick={() => setActiveTaskId(null)}
              className="mb-2 flex min-h-[40px] items-center gap-2 rounded-lg bg-muted px-3 text-sm font-medium hover:bg-muted/70"
            >
              <Plus className="h-4 w-4" /> 新建任务
            </button>

            {mode === "design" ? (
              <div className="mb-2">
                <div className="px-3 pb-1 text-xs text-muted-foreground">
                  项目
                </div>
                <div className="space-y-1.5 px-1 pb-2">
                  <input
                    aria-label="项目名称"
                    placeholder="新项目名称"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCreateProject();
                    }}
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    aria-label="创建项目"
                    disabled={creatingProject || !newProjectName.trim()}
                    onClick={() => void handleCreateProject()}
                    className="w-full rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    {creatingProject ? "创建中…" : "创建项目"}
                  </button>
                </div>
                <div className="max-h-48 overflow-y-auto px-1">
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      data-active={selectedProjectId === p.id}
                      onClick={() => {
                        setSelectedProjectId(p.id);
                        setActiveTaskId(null);
                      }}
                      className="flex w-full items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted data-[active=true]:bg-muted"
                    >
                      <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <nav className="mb-2 space-y-0.5">
              <button
                type="button"
                onClick={() => router.push("/plugins")}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
              >
                <Layers className="h-4 w-4" /> 插件市场
              </button>
              <button
                type="button"
                onClick={() => router.push("/profile")}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
              >
                <User className="h-4 w-4" /> 个人中心
              </button>
            </nav>
            <div className="px-3 text-xs text-muted-foreground">任务列表</div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tasks.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  暂无任务
                </p>
              ) : (
                <ul className="space-y-0.5 px-1">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        data-active={activeTaskId === task.id}
                        onClick={() => setActiveTaskId(task.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted data-[active=true]:bg-muted"
                      >
                        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{task.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}

        {/* 主区：任务视图 / 画布（选中项目自动打开）/ 居中编排器 */}
        <main className="min-w-0 flex-1 overflow-hidden bg-card">
          {activeTask ? (
            <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
              <h1 className="mb-4 text-lg font-medium">{activeTask.title}</h1>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
                {activeTask.messages.map((msg, i) => (
                  <div
                    key={i}
                    className={
                      msg.role === "user"
                        ? "ml-auto max-w-[80%] rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground whitespace-pre-wrap"
                        : "max-w-[90%] rounded-xl bg-muted px-4 py-2 text-sm whitespace-pre-wrap"
                    }
                  >
                    {msg.text}
                  </div>
                ))}
                {activeTask.status === "running" ? (
                  <p className="text-xs text-muted-foreground">生成中…</p>
                ) : null}
              </div>
              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                  onClick={() => setActiveTaskId(null)}
                >
                  返回
                </button>
                {activeTask.status === "running" && activeRunIdRef.current ? (
                  <button
                    type="button"
                    className="rounded-md border px-3 py-1.5 text-sm text-destructive hover:bg-muted"
                    onClick={() => ws.cancelRun(activeRunIdRef.current!)}
                  >
                    停止
                  </button>
                ) : null}
              </div>
            </div>
          ) : mode === "design" && selectedProject ? (
            /* Design：选中项目后画布自动打开（原版 Loomic 画布，无额外按钮） */
            <iframe
              key={selectedProject.primaryCanvas.id}
              src={`/canvas?id=${selectedProject.primaryCanvas.id}`}
              title={`${selectedProject.name} 画布`}
              className="h-full w-full border-0"
            />
          ) : (
            <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6">
              <div className="mb-6 flex items-center gap-3">
                <Code2 className="h-8 w-8" />
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
                    <label className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <select
                        aria-label="权限档位"
                        value={tier}
                        onChange={(e) => void handleTierChange(e.target.value)}
                        className="bg-transparent text-xs outline-none"
                      >
                        <option value="default">默认</option>
                        <option value="auto-approve">自动放行</option>
                        <option value="full-access">完全访问</option>
                      </select>
                      <ChevronDown className="h-3 w-3" />
                    </label>
                    <label className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground">
                      <select
                        aria-label="模型"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="max-w-[180px] bg-transparent text-xs outline-none"
                      >
                        {models.length === 0 ? (
                          <option value="">默认模型</option>
                        ) : (
                          models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))
                        )}
                      </select>
                      <ChevronDown className="h-3 w-3" />
                    </label>
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
      </div>
    </div>
  );
}
