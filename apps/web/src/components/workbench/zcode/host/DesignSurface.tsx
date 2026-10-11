import type { ProjectSummary } from "@kenfutwork/shared";
import { Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveDesignAutoCanvas } from "./designAutoCanvas.js";
import { surfaceFetch, surfaceJson } from "./surfaceApi.js";

/** design 与 flow 共用「画布项目」形状（contract 里是同一个 schema 成员，kind 二选一）。 */
type CanvasProject = Extract<ProjectSummary, { kind: "design" | "flow" }>;

/**
 * 跨视图切换的选中记忆：design → code → design 不丢当前画布
 * （等价旧壳「已访问文档持续挂载」的语义；模块级即可——code-ui 是单例应用）。
 */
let rememberedProjectId: string | null = null;

/**
 * Design 主区视图（融合进 Code 壳后的承载面）。
 *
 * 布局沿袭原画布工作台（用户口径「侧边栏和右边面板的元素要参考原来的」）：
 * 左侧项目侧栏（列表 / 新建 / 行内改名 / 删除——原 CanvasSidebar 的项目区同款元素）
 * + 右侧整幅画布 iframe；画布页自带的右侧面板（会话/图层/文件）经 `?panel=chat`
 * 在嵌入态默认打开。不变量沿袭：主区恒为画布，不被对话框顶掉。
 * 自动进画布判定唯一处 designAutoCanvas.ts（按本列表过滤选中态）。
 */
export function HostDesignSurface({ active = true }: { active?: boolean }) {
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    rememberedProjectId,
  );
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const autoCreateTried = useRef(Boolean(rememberedProjectId));
  const readGeneration = useRef(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    rememberedProjectId = selectedProjectId;
  }, [selectedProjectId]);

  const refreshProjects = useCallback((selectId?: string) => {
    const generation = ++readGeneration.current;
    surfaceJson<{ projects: ProjectSummary[] }>("/api/projects?kind=design")
      .then((data) => {
        if (generation !== readGeneration.current) return;
        const visible = data.projects.filter(
          (project): project is CanvasProject => project.kind === "design",
        );
        setProjects(visible);
        if (selectId && visible.some((project) => project.id === selectId)) {
          setSelectedProjectId(selectId);
        }
      })
      .catch((error: unknown) => {
        if (generation !== readGeneration.current) return;
        setNotice(
          error instanceof Error ? error.message : "画布项目读取失败。",
        );
      })
      .finally(() => {
        if (generation === readGeneration.current) setProjectsLoaded(true);
      });
  }, []);

  useEffect(() => {
    refreshProjects();
    return () => {
      readGeneration.current++;
    };
  }, [refreshProjects]);

  // 画布 iframe 的项目增删回报（创建 / 删除画布后列表与选中态跟着走）。
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const data = event.data as { type?: string; projectId?: string } | null;
      if (typeof data?.projectId !== "string" || !data.projectId) return;
      if (data.type === "workbench:project-created") {
        refreshProjects(data.projectId);
      }
      if (data.type === "workbench:project-deleted") {
        setSelectedProjectId((current) =>
          current === data.projectId ? null : current,
        );
        refreshProjects();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [refreshProjects]);

  const createProjectNamed = useCallback(
    async (name: string): Promise<CanvasProject | null> => {
      setCreating(true);
      try {
        const result = await surfaceJson<{ project: ProjectSummary }>(
          "/api/projects",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "design", name }),
          },
        );
        if (result.project.kind !== "design") {
          throw new Error("画布项目类型不匹配。");
        }
        setProjects((prev) => [result.project as CanvasProject, ...prev]);
        setNotice(null);
        return result.project as CanvasProject;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "创建画布失败。");
        return null;
      } finally {
        setCreating(false);
      }
    },
    [],
  );

  const renameProject = useCallback(async (projectId: string, name: string) => {
    try {
      const response = await surfaceFetch(`/api/projects/${projectId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      }
      setProjects((prev) =>
        prev.map((project) =>
          project.id === projectId ? { ...project, name } : project,
        ),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重命名失败。");
    }
  }, []);

  const removeProject = useCallback(
    async (projectId: string) => {
      try {
        const response = await surfaceFetch(`/api/projects/${projectId}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        }
        setSelectedProjectId((current) =>
          current === projectId ? null : current,
        );
        refreshProjects();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "删除画布失败。");
      }
    },
    [refreshProjects],
  );

  // 自动进画布（判定唯一处见 designAutoCanvas.ts 的注释纪律）。
  useEffect(() => {
    const decision = resolveDesignAutoCanvas({
      creatingProject: creating,
      projectsLoaded,
      projectIds: projects.map((project) => project.id),
      selectedProjectId,
      autoCreateTried: autoCreateTried.current,
    });
    if (decision.kind === "select") setSelectedProjectId(decision.projectId);
    if (decision.kind === "create") {
      autoCreateTried.current = true;
      void createProjectNamed("未命名画布").then((project) => {
        if (project) setSelectedProjectId(project.id);
      });
    }
  }, [
    creating,
    projectsLoaded,
    projects,
    selectedProjectId,
    createProjectNamed,
  ]);

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;
  // 画布页是 web 应用路由（与 code-ui 同源）；panel=chat 让画布右侧面板
  // （会话/图层/文件）在嵌入态默认打开——iframe 宽度通常低于 1024，
  // 画布页自己的宽度阈值会把面板收起来（用户口径：右边面板要参考原来的）。
  const canvasSrc = selectedProject
    ? `/canvas?id=${encodeURIComponent(selectedProject.primaryCanvas.id)}&panel=chat`
    : null;

  return (
    <div className="flex h-full min-h-0 bg-background">
      {/* 项目侧栏：原 CanvasSidebar 项目区的同款元素（列表/新建/改名/删除）。 */}
      <aside className="flex w-56 shrink-0 flex-col border-r bg-card">
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <span className="text-xs text-muted-foreground">项目</span>
          <button
            type="button"
            aria-label="创建项目"
            title="创建项目"
            disabled={creating}
            onClick={() => {
              void createProjectNamed("未命名画布").then((project) => {
                if (project) setSelectedProjectId(project.id);
              });
            }}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {projects.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {creating ? "创建中…" : "暂无项目"}
            </p>
          ) : (
            projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                active={selectedProjectId === project.id}
                onOpen={() => setSelectedProjectId(project.id)}
                onRename={(next) => void renameProject(project.id, next)}
                onDelete={() => void removeProject(project.id)}
              />
            ))
          )}
        </div>
        {notice ? (
          <p
            role="alert"
            className="border-t px-3 py-2 text-xs text-destructive"
          >
            {notice}
          </p>
        ) : null}
      </aside>
      <div className="min-w-0 flex-1">
        {canvasSrc ? (
          <iframe
            ref={frameRef}
            src={canvasSrc}
            title={`${selectedProject?.name ?? ""} 画布`}
            inert={!active}
            tabIndex={active ? 0 : -1}
            className="h-full w-full border-0"
          />
        ) : (
          <div
            role="status"
            className="flex h-full items-center justify-center text-sm text-muted-foreground"
          >
            {projectsLoaded ? "准备画布…" : "读取画布项目…"}
          </div>
        )}
      </div>
    </div>
  );
}

/** 项目行：点击选中；hover 出「重命名 / 删除」；重命名走行内输入（原 SidebarRow 行为）。 */
function ProjectRow({
  project,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  project: CanvasProject;
  active: boolean;
  onOpen: () => void;
  onRename: (next: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(project.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, project.name]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== project.name) onRename(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label="重命名"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setEditing(false);
        }}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none"
      />
    );
  }
  return (
    <div
      className="group/row relative flex items-center rounded-md hover:bg-muted data-[active=true]:bg-muted"
      data-active={active ? "true" : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
      >
        <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{project.name}</span>
      </button>
      <div className="absolute right-1 hidden items-center group-hover/row:flex">
        <button
          type="button"
          aria-label={`重命名 ${project.name}`}
          onClick={() => setEditing(true)}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={`删除 ${project.name}`}
          onClick={onDelete}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
