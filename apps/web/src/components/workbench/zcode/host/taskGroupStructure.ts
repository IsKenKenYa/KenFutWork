import {
  type CodeTaskGroupStructure,
  codeTaskGroupStructureSchema,
} from "@kenfutwork/shared";
import type {
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeTaskGroup,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";

/**
 * 服务端 `task-groups.read` 的原始结构 → 侧栏「分组」视图所需的形状。
 *
 * 服务端只保存组织本身（分组、成员、根层顺序），任务正文由任务列表提供，
 * 所以这里只做结构与键的翻译，不拼接任务内容。
 */

/** 与 `buildTaskWorkspaceKey` 同口径：identity 优先，缺省回落到路径。 */
export function taskGroupWorkspaceKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity && workspaceIdentity.length > 0
    ? workspaceIdentity
    : workspacePath;
}

/** 校验宿主导入的原始读取结果；形状不符直接报错，不做兜底。 */
export function parseTaskGroupStructure(raw: unknown): CodeTaskGroupStructure {
  return codeTaskGroupStructureSchema.parse(raw);
}

/**
 * 根层顺序键的编码方式与服务端一致：`group:<id>` / `task:<workspaceKey>|<taskId>`。
 * 服务端 `order[].key` 是拆解过的稳定键，这里按同样规则还原成结构引用。
 */
export function decodeTopLevelOrderKey(
  key: string,
): ZCodeGroupedTaskViewStructureTopOrder["type"] extends never
  ? never
  : { type: "group"; groupId: string } | { type: "task"; key: string } {
  if (key.startsWith("group:")) return { type: "group", groupId: key.slice(6) };
  return { type: "task", key };
}

export function toGroupedTaskViewStructure(
  structure: CodeTaskGroupStructure,
  tasks: readonly ZCodeTaskMeta[],
): ZCodeGroupedTaskViewStructure & {
  /** 服务端组织修订；用于判断是否需要重读。 */
  revision: number;
  /** 任务索引：分组视图按成员引用取任务行，缺行说明任务已不在列表。 */
  taskByKey: ReadonlyMap<string, ZCodeTaskMeta>;
} {
  const groups: ZCodeTaskGroup[] = structure.groups.map((group) => ({
    id: group.id,
    title: group.title,
    color: group.color,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  }));
  const taskByKey = new Map<string, ZCodeTaskMeta>();
  for (const task of tasks) {
    // 上游任务列表按仓库分组拼装，未加载的分组可能传入空洞；跳过而不是崩溃。
    if (!task?.workspacePath || !task.taskId) continue;
    taskByKey.set(
      `${taskGroupWorkspaceKey(task.workspacePath, task.workspaceIdentity)}|${task.taskId}`,
      task,
    );
  }
  return {
    groups,
    members: structure.members.map((member) => ({
      groupId: member.groupId,
      workspaceKey: member.workspaceKey,
      workspacePath: member.workspaceKey,
      taskId: member.taskId,
      sortOrder: member.sortOrder,
      addedAt: 0,
    })),
    topLevelOrders: structure.order.map((entry) => {
      const decoded = decodeTopLevelOrderKey(entry.key);
      if (decoded.type === "group")
        return {
          type: "group" as const,
          groupId: decoded.groupId,
          sortOrder: entry.sortOrder,
        };
      const [workspaceKey = "", taskId = ""] = decoded.key.split("|");
      return {
        type: "task" as const,
        workspaceKey,
        taskId,
        sortOrder: entry.sortOrder,
      };
    }),
    revision: structure.revision,
    taskByKey,
  };
}

/** 组内成员按服务端 sortOrder 升序；缺序（null）排在同序之后，保证稳定。 */
export function groupMembersInOrder(
  structure: ReturnType<typeof toGroupedTaskViewStructure>,
  groupId: string,
): ZCodeTaskMeta[] {
  const orderOf = (value: number | null) => value ?? Number.MAX_SAFE_INTEGER;
  const members = structure.members
    .filter((member) => member.groupId === groupId)
    .sort((left, right) => orderOf(left.sortOrder) - orderOf(right.sortOrder));
  const tasks: ZCodeTaskMeta[] = [];
  for (const member of members) {
    const task = structure.taskByKey.get(
      `${member.workspaceKey}|${member.taskId}`,
    );
    // 成员指向的任务已不在可见列表（归档/删除）时跳过：不造占位行。
    if (task) tasks.push(task);
  }
  return tasks;
}

/** 根层未被任何分组收纳的任务，按服务端根层顺序排列。 */
export function rootTasksInOrder(
  structure: ReturnType<typeof toGroupedTaskViewStructure>,
  tasks: readonly ZCodeTaskMeta[],
): ZCodeTaskMeta[] {
  const grouped = new Set(
    structure.members.map((member) => `${member.workspaceKey}|${member.taskId}`),
  );
  const rootOrder = new Map<string, number>();
  for (const entry of structure.topLevelOrders) {
    if (entry.type !== "task") continue;
    rootOrder.set(`${entry.workspaceKey}|${entry.taskId}`, entry.sortOrder);
  }
  return tasks
    .filter(
      (task) =>
        Boolean(task?.workspacePath && task.taskId) &&
        !grouped.has(
          `${taskGroupWorkspaceKey(task.workspacePath, task.workspaceIdentity)}|${task.taskId}`,
        ),
    )
    .map((task, index) => ({
      task,
      order:
        rootOrder.get(
          `${taskGroupWorkspaceKey(task.workspacePath, task.workspaceIdentity)}|${task.taskId}`,
        ) ?? Number.MAX_SAFE_INTEGER - tasks.length + index,
    }))
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.task);
}
