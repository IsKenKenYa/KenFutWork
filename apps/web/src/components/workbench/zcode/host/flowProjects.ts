import type { ProjectSummary } from "@kenfutwork/shared";
import { useEffect, useSyncExternalStore } from "react";
import { pickCanvasProjectDirectory } from "./canvasProjectDirectories.js";
import { surfaceJson } from "./surfaceApi.js";

/** 未选项目时自动绑定的默认工作流项目名（同一实例只建一个）。 */
const DEFAULT_FLOW_PROJECT_NAME = "默认工作流";
const PROJECT_KINDS = ["flow", "code", "design", "work"] as const;
const EMPTY_PROJECTS: ProjectSummary[] = [];
let state = {
  projects: EMPTY_PROJECTS,
  selectedProjectId: null as string | null,
  notice: null as string | null,
  creating: false,
};
const listeners = new Set<() => void>();
function update(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
export function useFlowProjectsSnapshot() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}
export function selectFlowProject(projectId: string | null) {
  update({ selectedProjectId: projectId });
}
let readGeneration = 0;
/** 默认项目创建在途；refresh 与用户点「新建」可能并发。 */
let ensuringDefault = false;

async function listProjects() {
  const lists = await Promise.all(
    PROJECT_KINDS.map((kind) =>
      surfaceJson<{ projects: ProjectSummary[] }>(`/api/projects?kind=${kind}`),
    ),
  );
  const seen = new Set<string>();
  return lists
    .flatMap((list) => list.projects)
    .filter((project) => {
      if (seen.has(project.id)) return false;
      seen.add(project.id);
      return true;
    });
}

/**
 * 未选项目时自动绑定默认工作流项目（用户 2026-10-27 口径「没绑定项目的情况下
 * 自动绑定 flow 默认项目」）：优先复用已有 flow 项目，没有才建「默认工作流」。
 * 用户显式选了 Code/Design/Work 项目时不会走到这里——绑定已有项目是显式动作。
 */
async function ensureDefaultProject() {
  if (ensuringDefault || state.selectedProjectId) return;
  ensuringDefault = true;
  update({ creating: true, notice: null });
  try {
    const existing = state.projects.find((project) => project.kind === "flow");
    if (existing) {
      update({ selectedProjectId: existing.id, creating: false });
      return;
    }
    const result = await surfaceJson<{ project: ProjectSummary }>(
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "flow",
          name: DEFAULT_FLOW_PROJECT_NAME,
        }),
      },
    );
    if (result.project.kind !== "flow") throw new Error("项目类型不匹配。");
    update({
      projects: [result.project, ...state.projects],
      selectedProjectId: result.project.id,
      creating: false,
    });
  } catch (failure) {
    update({
      creating: false,
      notice:
        failure instanceof Error ? failure.message : "默认工作流项目创建失败。",
    });
  } finally {
    ensuringDefault = false;
  }
}

export async function refreshFlowProjects() {
  const generation = ++readGeneration;
  try {
    const projects = await listProjects();
    if (generation !== readGeneration) return;
    const selectedProjectId = projects.some(
      (project) => project.id === state.selectedProjectId,
    )
      ? state.selectedProjectId
      : null;
    update({ projects, selectedProjectId, notice: null });
    if (!selectedProjectId) await ensureDefaultProject();
  } catch (failure) {
    if (generation === readGeneration)
      update({
        notice: failure instanceof Error ? failure.message : "项目读取失败。",
      });
  }
}
export function useFlowProjectsController() {
  useEffect(() => {
    void refreshFlowProjects();
  }, []);
}
export async function createFlowProject(fromDirectory = false) {
  if (state.creating) return;
  update({ creating: true, notice: null });
  try {
    const workDir = fromDirectory
      ? await pickCanvasProjectDirectory()
      : undefined;
    if (workDir === null) return;
    const result = await surfaceJson<{ project: ProjectSummary }>(
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "flow",
          name: "未命名工作流",
          ...(workDir !== undefined ? { work_dir: workDir } : {}),
        }),
      },
    );
    if (result.project.kind !== "flow") throw new Error("项目类型不匹配。");
    ++readGeneration;
    update({
      projects: [result.project, ...state.projects],
      selectedProjectId: result.project.id,
    });
  } catch (failure) {
    update({
      notice: failure instanceof Error ? failure.message : "创建项目失败。",
    });
  } finally {
    update({ creating: false });
  }
}
