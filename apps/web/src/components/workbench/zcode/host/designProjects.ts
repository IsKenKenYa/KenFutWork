import type { ProjectSummary } from "@kenfutwork/shared";
import { useEffect, useSyncExternalStore } from "react";
import { pickCanvasProjectDirectory } from "./canvasProjectDirectories.js";
import { resolveDesignAutoCanvas } from "./designAutoCanvas.js";
import { surfaceFetch, surfaceJson } from "./surfaceApi.js";

/** 项目可启用多种工作方式；画布只是可选文档。 */
export type CanvasProject = ProjectSummary;

/**
 * Design 模式的项目状态（壳侧栏与主区画布共享）。
 *
 * 为什么是外部存储而不是组件 state：融合后**侧边栏内容随模式变化**——项目列表
 * 在壳侧栏（design 模式替换任务列表），画布 iframe 在主区 DesignSurface；两处
 * 都要读同一份「列表 + 选中」，且跨 design→code→design 切换不能丢选中。
 * code-ui 是单例应用，模块级存储即真相源（与 workbenchNavigation 同一路数）。
 */
type DesignProjectsState = {
  projects: CanvasProject[];
  projectsLoaded: boolean;
  selectedProjectId: string | null;
  creating: boolean;
  notice: string | null;
};

const EMPTY: DesignProjectsState = {
  projects: [],
  projectsLoaded: false,
  selectedProjectId: null,
  creating: false,
  notice: null,
};

let state: DesignProjectsState = EMPTY;
const listeners = new Set<() => void>();
/** 主区画布 iframe（DesignSurface 注册）：项目增删消息只认它。 */
export const canvasFrameRef = { current: null as HTMLIFrameElement | null };

function setSnapshot(patch: Partial<DesignProjectsState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeDesignProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDesignProjectsSnapshot(): DesignProjectsState {
  return state;
}

export function useDesignProjectsSnapshot(): DesignProjectsState {
  return useSyncExternalStore(
    subscribeDesignProjects,
    getDesignProjectsSnapshot,
  );
}

export function selectDesignProject(projectId: string | null): void {
  if (state.selectedProjectId !== projectId) {
    setSnapshot({ selectedProjectId: projectId });
  }
}

async function createProjectNamed(
  name: string,
  fromDirectory = false,
): Promise<CanvasProject | null> {
  if (state.creating) return null;
  setSnapshot({ creating: true });
  try {
    const workDir = fromDirectory
      ? await pickCanvasProjectDirectory()
      : undefined;
    if (workDir === null) return null;
    const result = await surfaceJson<{ project: ProjectSummary }>(
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "design",
          name,
          ...(workDir !== undefined ? { work_dir: workDir } : {}),
        }),
      },
    );
    if (result.project.kind !== "design") {
      throw new Error("画布项目类型不匹配。");
    }
    const project = result.project as CanvasProject;
    ++readGeneration;
    setSnapshot({
      projects: [project, ...state.projects],
      notice: null,
    });
    return project;
  } catch (error) {
    setSnapshot({
      notice: error instanceof Error ? error.message : "创建画布失败。",
    });
    return null;
  } finally {
    setSnapshot({ creating: false });
  }
}

export async function renameDesignProject(
  projectId: string,
  name: string,
): Promise<void> {
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
    setSnapshot({
      projects: state.projects.map((project) =>
        project.id === projectId ? { ...project, name } : project,
      ),
    });
  } catch (error) {
    setSnapshot({
      notice: error instanceof Error ? error.message : "重命名失败。",
    });
  }
}

export async function removeDesignProject(projectId: string): Promise<void> {
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
    setSnapshot({
      selectedProjectId:
        state.selectedProjectId === projectId ? null : state.selectedProjectId,
    });
    void refreshDesignProjects();
  } catch (error) {
    setSnapshot({
      notice: error instanceof Error ? error.message : "删除画布失败。",
    });
  }
}

export function createDesignProject(
  fromDirectory = false,
): Promise<CanvasProject | null> {
  return createProjectNamed("未命名项目", fromDirectory).then((project) => {
    if (project) selectDesignProject(project.id);
    return project;
  });
}

let readGeneration = 0;
export async function refreshDesignProjects(selectId?: string): Promise<void> {
  const generation = ++readGeneration;
  try {
    const data = await surfaceJson<{ projects: ProjectSummary[] }>(
      "/api/projects?kind=design",
    );
    if (generation !== readGeneration) return;
    const visible = data.projects.filter((project): project is CanvasProject =>
      project.enabledModes.includes("design"),
    );
    setSnapshot({
      projects: visible,
      ...(selectId && visible.some((project) => project.id === selectId)
        ? { selectedProjectId: selectId }
        : {}),
    });
  } catch (error) {
    if (generation !== readGeneration) return;
    setSnapshot({
      notice: error instanceof Error ? error.message : "画布项目读取失败。",
    });
  } finally {
    if (generation === readGeneration) setSnapshot({ projectsLoaded: true });
  }
}

/**
 * Design 模式的数据控制器（由壳侧栏挂载，design 模式激活时才取数）。
 * 画布 iframe 的项目增删回报也在这里收（只认 canvasFrameRef 注册的那只 iframe）。
 */
export function useDesignProjectsController(enabled: boolean): void {
  const { creating, projectsLoaded, projects, selectedProjectId } =
    useDesignProjectsSnapshot();
  useEffect(() => {
    if (!enabled) return;
    void refreshDesignProjects();
  }, [enabled]);

  // 自动进画布（判定唯一处 designAutoCanvas.ts；跨模式残留的选中按本列表过滤）。
  useEffect(() => {
    if (!enabled) return;
    const decision = resolveDesignAutoCanvas({
      creatingProject: creating,
      projectsLoaded: projectsLoaded,
      projectIds: projects.map((project) => project.id),
      selectedProjectId: selectedProjectId,
    });
    if (decision.kind === "select") selectDesignProject(decision.projectId);
  }, [enabled, creating, projectsLoaded, projects, selectedProjectId]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const frame = canvasFrameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const data = event.data as { type?: string; projectId?: string } | null;
      if (typeof data?.projectId !== "string" || !data.projectId) return;
      if (data.type === "workbench:project-created") {
        void refreshDesignProjects(data.projectId);
      }
      if (data.type === "workbench:project-deleted") {
        if (state.selectedProjectId === data.projectId) {
          selectDesignProject(null);
        }
        void refreshDesignProjects();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [enabled]);
}
