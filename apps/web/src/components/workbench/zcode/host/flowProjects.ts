import type { ProjectSummary } from "@kenfutwork/shared";
import { useEffect, useSyncExternalStore } from "react";
import { pickCanvasProjectDirectory } from "./canvasProjectDirectories.js";
import { surfaceJson } from "./surfaceApi.js";

type FlowProject = Extract<ProjectSummary, { kind: "flow" }>;
let state = {
  projects: [] as FlowProject[],
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
export async function refreshFlowProjects() {
  const generation = ++readGeneration;
  try {
    const data = await surfaceJson<{ projects: ProjectSummary[] }>(
      "/api/projects?kind=flow",
    );
    if (generation !== readGeneration) return;
    const projects = data.projects.filter(
      (project): project is FlowProject => project.kind === "flow",
    );
    update({
      projects,
      selectedProjectId: projects.some(
        (project) => project.id === state.selectedProjectId,
      )
        ? state.selectedProjectId
        : null,
      notice: null,
    });
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
