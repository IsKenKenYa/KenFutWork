import type { CodeUiWorkspace } from "@kenfutwork/shared";

export interface TaskWorkspaceIdentity {
  taskId: string;
  projectId: string;
  rootDirectory: string;
}

/** Project 默认与 Task 固定目录分别记录；目录更新不能改写既有 Task 的身份。 */
export class TaskWorkspaceRegistry {
  private readonly projects = new Map<string, CodeUiWorkspace>();
  private readonly projectIdsByPath = new Map<string, Set<string>>();
  private readonly workspaceByIdentity = new Map<
    string,
    { projectId: string; rootDirectory: string }
  >();
  private readonly selectedProjectByPath = new Map<string, string>();
  private readonly tasks = new Map<string, TaskWorkspaceIdentity>();
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify() {
    for (const listener of this.listeners) listener();
  }

  registerProjects(workspaces: CodeUiWorkspace[]) {
    for (const workspace of workspaces) {
      this.projects.set(workspace.projectId, workspace);
      // 旧路径只作为已知项目定位，不成为新 Task 的目录默认。
      this.recordWorkspace(workspace.projectId, workspace.path);
    }
    this.notify();
  }
  replaceProjects(workspaces: CodeUiWorkspace[]) {
    this.projects.clear();
    this.registerProjects(workspaces);
  }

  private recordWorkspace(projectId: string, rootDirectory: string) {
    const identities =
      this.projectIdsByPath.get(rootDirectory) ?? new Set<string>();
    identities.add(projectId);
    this.projectIdsByPath.set(rootDirectory, identities);
    // 只根据真实 Project DTO / Task meta 建立关联，不把调用方字符串解码成权限。
    const identity = JSON.stringify([projectId, rootDirectory]);
    this.workspaceByIdentity.set(identity, { projectId, rootDirectory });
    return identity;
  }

  identityFor(projectId: string, rootDirectory: string) {
    const identity = JSON.stringify([projectId, rootDirectory]);
    return this.workspaceByIdentity.has(identity) ? identity : null;
  }

  knownWorkspaces() {
    return [...this.workspaceByIdentity].flatMap(
      ([workspaceIdentity, source]) =>
        this.projects.has(source.projectId)
          ? [{ workspaceIdentity, ...source }]
          : [],
    );
  }
  selectProject(projectId: string, selectedPath?: string) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("Code 项目已经不可用，请重新选择。");
    this.selectedProjectByPath.set(project.path, projectId);
    if (selectedPath) this.selectedProjectByPath.set(selectedPath, projectId);
  }
  registerTask(value: unknown) {
    if (!value || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.taskId !== "string" ||
      typeof entry.projectId !== "string" ||
      typeof entry.workspacePath !== "string"
    )
      return;
    const previous = this.tasks.get(entry.taskId);
    if (
      previous &&
      (previous.projectId !== entry.projectId ||
        previous.rootDirectory !== entry.workspacePath)
    )
      throw new Error("Task 的工作目录身份发生了不合法变化。");
    if (previous) return;
    this.tasks.set(entry.taskId, {
      taskId: entry.taskId,
      projectId: entry.projectId,
      rootDirectory: entry.workspacePath,
    });
    this.recordWorkspace(entry.projectId, entry.workspacePath);
    this.notify();
  }
  projectForPath(path: string, workspaceIdentity?: string | null) {
    if (workspaceIdentity) {
      const workspace = this.workspaceByIdentity.get(workspaceIdentity);
      return workspace?.rootDirectory === path
        ? (this.projects.get(workspace.projectId) ?? null)
        : null;
    }
    const selectedId = this.selectedProjectByPath.get(path);
    if (selectedId) {
      const selected = this.projects.get(selectedId);
      if (selected) return selected;
    }
    const ids = [...(this.projectIdsByPath.get(path) ?? [])].filter((id) =>
      this.projects.has(id),
    );
    return ids.length === 1 ? (this.projects.get(ids[0]!) ?? null) : null;
  }
  task(taskId: string) {
    return this.tasks.get(taskId) ?? null;
  }
  defaultFor(
    path: string,
    taskId?: string | null,
    workspaceIdentity?: string | null,
  ) {
    const task = taskId ? this.tasks.get(taskId) : null;
    return task
      ? (this.projects.get(task.projectId) ?? null)
      : this.projectForPath(path, workspaceIdentity);
  }
}
