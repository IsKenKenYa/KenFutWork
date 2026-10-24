import {
  type CodeUiWorkspace,
  type ProjectDirectoryRelinkResponse,
  type ProjectDirectoryRelinkSnapshot,
  projectDirectoryRelinkResponseSchema,
} from "@kenfutwork/shared";

export function projectSupportsMode(
  project: CodeUiWorkspace,
  preset: "code" | "design",
) {
  return (project.enabledModes ?? [project.kind ?? "code"]).includes(preset);
}

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
  projectCatalog() {
    return [...this.projects.values()];
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
  applyDirectoryRelink(
    snapshot: ProjectDirectoryRelinkSnapshot,
    value: ProjectDirectoryRelinkResponse,
  ): () => void {
    const receipt = projectDirectoryRelinkResponseSchema.parse(value);
    const project = this.projects.get(snapshot.projectId);
    const expected = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
    if (
      !project ||
      project.path !== snapshot.workDir ||
      receipt.projectId !== snapshot.projectId ||
      expected.size !== snapshot.tasks.length ||
      receipt.tasks.length !== expected.size
    )
      throw new Error("目录关联回执与项目不一致。");
    const observed = new Set<string>();
    for (const task of receipt.tasks) {
      const previous = expected.get(task.taskId),
        known = this.tasks.get(task.taskId);
      if (
        observed.has(task.taskId) ||
        !previous ||
        task.scopeGeneration !== previous.scopeGeneration + 1 ||
        task.branchGeneration !== previous.branchGeneration + 1 ||
        (known &&
          (known.projectId !== snapshot.projectId ||
            known.rootDirectory !== snapshot.workDir))
      )
        throw new Error("目录关联回执与Task不一致。");
      observed.add(task.taskId);
    }
    const affected = new Set(receipt.affectedTaskIds);
    if (
      affected.size !== receipt.affectedTaskIds.length ||
      [...observed].some((id) => !affected.has(id))
    )
      throw new Error("目录关联回执缺少受影响Task。");
    for (const taskId of affected) {
      const task = this.tasks.get(taskId);
      if (
        task &&
        (task.projectId !== snapshot.projectId ||
          task.rootDirectory !== snapshot.workDir)
      )
        throw new Error("目录关联回执包含其它项目Task。");
    }
    const old = {
      projects: new Map(this.projects),
      paths: new Map(
        [...this.projectIdsByPath].map(([path, ids]) => [path, new Set(ids)]),
      ),
      identities: new Map(this.workspaceByIdentity),
      selected: new Map(this.selectedProjectByPath),
      tasks: new Map(this.tasks),
    };
    const restore = () => {
      this.projects.clear();
      for (const item of old.projects) this.projects.set(...item);
      this.projectIdsByPath.clear();
      for (const item of old.paths) this.projectIdsByPath.set(...item);
      this.workspaceByIdentity.clear();
      for (const item of old.identities) this.workspaceByIdentity.set(...item);
      this.selectedProjectByPath.clear();
      for (const item of old.selected) this.selectedProjectByPath.set(...item);
      this.tasks.clear();
      for (const item of old.tasks) this.tasks.set(...item);
      this.notify();
    };
    for (const taskId of affected) this.tasks.delete(taskId);
    const oldIdentity = JSON.stringify([snapshot.projectId, snapshot.workDir]);
    this.workspaceByIdentity.delete(oldIdentity);
    const ids = this.projectIdsByPath.get(snapshot.workDir);
    ids?.delete(snapshot.projectId);
    if (!ids?.size) this.projectIdsByPath.delete(snapshot.workDir);
    if (this.selectedProjectByPath.get(snapshot.workDir) === snapshot.projectId)
      this.selectedProjectByPath.delete(snapshot.workDir);
    this.projects.set(project.projectId, { ...project, path: receipt.workDir });
    this.recordWorkspace(project.projectId, receipt.workDir);
    this.selectedProjectByPath.set(receipt.workDir, project.projectId);
    try {
      this.notify();
    } catch (error) {
      restore();
      throw error;
    }
    return restore;
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
