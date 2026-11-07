import type { ProjectSummary } from "@kenfutwork/shared";
import { useSyncExternalStore } from "react";
import { listAllProjects } from "./projects.js";
import { surfaceJson } from "./surfaceApi.js";

/**
 * Work 面的目录绑定，与 Flow 同款「模式自带项目存储」：走 `/api/projects`，
 * 不占 Code/Design 的工作区标签。work 项目必须有主目录，所以这里的项目就是目录本身。
 * 没显式选过时自动绑到最近更新的一份，刷新后不必重选；保存落点（#5）读的就是这里。
 */
type WorkDirectoryState = {
  project: ProjectSummary | null;
  loading: boolean;
  choosing: boolean;
  error: string | null;
};

let state: WorkDirectoryState = {
  project: null,
  loading: true,
  choosing: false,
  error: null,
};
const listeners = new Set<() => void>();
function update(patch: Partial<WorkDirectoryState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
function reason(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback;
}

export function getWorkDirectory(): ProjectSummary | null {
  return state.project;
}
export function subscribeWorkDirectory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useWorkDirectory(): WorkDirectoryState {
  return useSyncExternalStore(
    subscribeWorkDirectory,
    () => state,
    () => state,
  );
}

let readGeneration = 0;

function newestWorkProject(projects: ProjectSummary[]): ProjectSummary | null {
  let newest: ProjectSummary | null = null;
  for (const project of projects) {
    if (project.kind !== "work") continue;
    if (!newest || Date.parse(project.updatedAt) > Date.parse(newest.updatedAt))
      newest = project;
  }
  return newest;
}

export async function refreshWorkDirectory(): Promise<void> {
  const generation = ++readGeneration;
  try {
    const { projects } = await surfaceJson<{ projects: ProjectSummary[] }>(
      "/api/projects?kind=work",
    );
    if (generation !== readGeneration) return;
    const keep = projects.find((project) => project.id === state.project?.id);
    update({
      project: keep ?? newestWorkProject(projects),
      loading: false,
      error: null,
    });
  } catch (failure) {
    if (generation !== readGeneration) return;
    update({ loading: false, error: reason(failure, "工作目录读取失败") });
  }
}

/** 去掉选择器带回的尾分隔符；盘根（`D:/`）要留着斜杠，`D:` 在 Windows 是相对路径。 */
function normalizePickedPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return !trimmed || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed;
}

function directoryName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop() || path
  );
}

async function createWorkProject(path: string): Promise<ProjectSummary> {
  const { project } = await surfaceJson<{ project: ProjectSummary }>(
    "/api/projects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "work",
        name: directoryName(path),
        work_dir: path,
      }),
    },
  );
  return project;
}

/**
 * 用系统文件夹选择器换工作目录；取消不改状态。目录上已有项目时**复用那一份**
 * （同目录不另起项目），没有才建 work 项目。
 */
export async function chooseWorkDirectory(
  selectDirectory: () => Promise<string | null>,
): Promise<void> {
  if (state.choosing) return;
  update({ choosing: true, error: null });
  try {
    const picked = await selectDirectory();
    if (!picked) return;
    const path = normalizePickedPath(picked);
    const existing = (await listAllProjects()).find(
      (project) => project.workDir === path,
    );
    const project = existing ?? (await createWorkProject(path));
    ++readGeneration;
    update({ project, loading: false });
  } catch (failure) {
    update({ error: reason(failure, "工作目录绑定失败") });
  } finally {
    update({ choosing: false });
  }
}
