import type {
  ProjectTask,
  ProjectTree,
  VirtualProject,
} from "@zui/project-sidebar/contract.js";
import type { WindowHostControllerTaskListItem } from "@zcode/services";
import { attachTaskListRowActivity } from "@zui/v4/taskListRowActivity.js";
import { compareTaskListItemsByTime, compareZCodeTaskListItems } from "@zui/lib/taskListOrdering.js";
import { buildTaskEntityKey } from "@zui/lib/taskQueryCache.js";
import {
  areStabilizedValuesEquivalent,
  stabilizeTaskListItems,
} from "@zui/v4/taskListItemStabilization.js";

/** 活动态只覆盖已有行的 UI sidecar；Controller 快照不能替代项目树的行集合和事实。 */
export function applyProjectTaskActivities(
  tree: ProjectTree,
  activities: readonly WindowHostControllerTaskListItem[],
): ProjectTree {
  const byKey = new Map(
    activities
      .filter((item) => !item.remoteSessionId)
      .map((item) => [buildTaskEntityKey(item), item]),
  );
  return {
    ...tree,
    tasks: tree.tasks.map((task) => {
      const item = byKey.get(buildTaskEntityKey(task));
      if (!item) return task;
      const displayed = { ...task };
      if (item.unreadAt === undefined) delete displayed.unreadAt;
      else displayed.unreadAt = item.unreadAt;
      if (item.pendingInteraction === undefined) delete displayed.pendingInteraction;
      else displayed.pendingInteraction = item.pendingInteraction;
      if (!item.activity) return displayed;
      displayed.updatedAt = item.activity.lastActivityAt;
      return attachTaskListRowActivity(displayed, item.activity);
    }),
  };
}

/** 复用等价对象以保留行 memo；组织变化和 activity 都参加比较，不把旧项目归属粘在行上。 */
export function stabilizeProjectTree(previous: ProjectTree, next: ProjectTree): ProjectTree {
  const previousProjects = new Map(
    previous.projects.map((project) => [projectKey(project), project]),
  );
  let sameProjects = previous.projects.length === next.projects.length;
  const projects = next.projects.map((project, index) => {
    const old = previousProjects.get(projectKey(project));
    const stable = old && areStabilizedValuesEquivalent(old, project) ? old : project;
    if (previous.projects[index] !== stable) sameProjects = false;
    return stable;
  });
  const tasks = stabilizeTaskListItems(previous.tasks, next.tasks);
  return sameProjects &&
    tasks === previous.tasks &&
    areStabilizedValuesEquivalent(previous.deletedTasks, next.deletedTasks)
    ? previous
    : { ...next, projects: sameProjects ? previous.projects : projects, tasks };
}

export type ProjectRowSelection =
  | { kind: "project"; projectId: string | null; hostId?: string }
  | { kind: "timeline" }
  | { kind: "pinned" };

/** 选择器和行列表共用同一比较器，避免时间线在渲染时又被运行优先覆盖。 */
export function compareProjectTaskRows(
  left: ProjectTask,
  right: ProjectTask,
  kind: "project" | "pinned" | "timeline",
): number {
  return (
    (kind === "timeline"
      ? compareTaskListItemsByTime(left, right, "updated")
      : compareZCodeTaskListItems(left, right, "updated")) ||
    JSON.stringify([right.hostId, buildTaskEntityKey(right)]).localeCompare(
      JSON.stringify([left.hostId, buildTaskEntityKey(left)]),
    )
  );
}
/** 只从 Host 已提交的行派生显示；相同 cwd 不代表相同项目。 */
export function selectProjectRows(
  tree: ProjectTree,
  selection: ProjectRowSelection,
): ProjectTask[] {
  return tree.tasks
    .filter((task) => {
      if (selection.kind === "pinned") return task.pinned && !task.archived;
      if (selection.kind === "timeline") return !task.archived;
      return (
        task.projectId === selection.projectId &&
        (!selection.hostId || task.hostId === selection.hostId) &&
        !task.archived &&
        !task.pinned
      );
    })
    .sort((left, right) => compareProjectTaskRows(left, right, selection.kind));
}

export function projectHasUnread(
  tree: ProjectTree,
  project: Pick<VirtualProject, "id" | "hostId">,
): boolean {
  return tree.tasks.some(
    (task) =>
      task.projectId === project.id &&
      task.hostId === project.hostId &&
      !task.archived &&
      Boolean(task.unreadAt),
  );
}

export function countProjectTreeUnreadTasks(tree: ProjectTree): number {
  const renderedProjectKeys = new Set(
    tree.projects
      .filter((project) => !project.deleted)
      .map((project) => `${project.hostId}::${project.id}`),
  );
  const seen = new Set<string>();
  for (const task of tree.tasks) {
    if (task.archived || !task.unreadAt) continue;
    if (
      task.pinned ||
      (task.projectId == null && task.hostId === "local") ||
      renderedProjectKeys.has(`${task.hostId}::${task.projectId}`)
    )
      seen.add(JSON.stringify([task.hostId, task.workspaceIdentity?.trim() || task.workspacePath, task.taskId]));
  }
  return seen.size;
}

export function projectKey(project: Pick<VirtualProject, "id" | "hostId">): string {
  return JSON.stringify([project.hostId, project.id]);
}

/** 服务端返回顺序用于首次显示；之后由同一原侧栏偏好持有人工顺序。 */
export function selectSortedProjects(tree: ProjectTree): VirtualProject[] {
  return tree.projects.filter((project) => !project.deleted);
}

export function formatProjectError(
  cause: unknown,
  _formatMessage: (descriptor: { id: string }) => string,
): string {
  return String(cause);
}
