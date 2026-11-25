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
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function taskGroupWorkspaceKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity && workspaceIdentity.length > 0
    ? workspaceIdentity
    : workspacePath;
}

/**
 * 解析任务顺序键。
 *
 * 服务端把任务归属写成 JSON 数组（`[workspaceIdentity, workspacePath, taskId]` 形式的
 * 复合键）。这里按结构取前两个可识别字段，取不到就返回 null，由调用方跳过。
 */
export function parseTaskOrderKey(
  key: string,
): { workspaceKey: string; taskId: string } | null {
  const uuidIn = (value: unknown) =>
    typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const taskId = uuidIn(parsed.at(-1));
    if (!taskId) return null;
    const identities = parsed
      .slice(0, -1)
      .filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      );
    if (identities.length === 0) return null;
    // 复合键里 identity 与路径同时存在时，identity 是 join 键；只有路径时用路径。
    const workspaceKey =
      identities.find((part) => UUID_PATTERN.test(part)) ??
      identities.at(-1) ??
      "";
    return workspaceKey ? { workspaceKey, taskId } : null;
  } catch {
    return null;
  }
}

/** 校验宿主导入的原始读取结果；形状不符直接报错，不做兜底。 */
export function parseTaskGroupStructure(raw: unknown): CodeTaskGroupStructure {
  return codeTaskGroupStructureSchema.parse(raw);
}

/**
 * 根层顺序条目的 `key` 还原成结构引用的判定。
 *
 * 服务端 `order[].key` 的两种真实形状（实测）：
 * - 分组：**裸分组 UUID**（不是 `group:<id>`）；
 * - 任务：任务归属键的 JSON 序列化串（含 workspaceIdentity 与路径）。
 * 早期猜过 `group:` 前缀，服务端并不产出该前缀，会让分组排序恒为空。
 */
export function decodeTopLevelOrderKey(
  key: string,
): { type: "group"; groupId: string } | { type: "task"; key: string } {
  if (key.startsWith("group:")) return { type: "group", groupId: key.slice(6) };
  if (UUID_PATTERN.test(key)) return { type: "group", groupId: key };
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
    topLevelOrders: (() => {
      const orders: ZCodeGroupedTaskViewStructureTopOrder[] = [];
      for (const entry of structure.order) {
        const decoded = decodeTopLevelOrderKey(entry.key);
        if (decoded.type === "group") {
          orders.push({
            type: "group",
            groupId: decoded.groupId,
            sortOrder: entry.sortOrder,
          });
          continue;
        }
        const parsed = parseTaskOrderKey(decoded.key);
        // 解析不出的任务键说明服务端编码变了；跳过而不是编造身份。
        if (!parsed) continue;
        orders.push({
          type: "task",
          workspaceKey: parsed.workspaceKey,
          taskId: parsed.taskId,
          sortOrder: entry.sortOrder,
        });
      }
      return orders;
    })(),
    revision: structure.revision,
    taskByKey,
  };
}

/**
 * 根层分组按服务端 `order` 排序。
 *
 * 服务端 `groups` 数组本身按创建时间返回，真正的根层次序只存在 `order` 里；
 * 直接用 `groups` 会让上移/下移看起来没有生效。
 */
export function groupsInOrder(
  structure: ReturnType<typeof toGroupedTaskViewStructure>,
): ZCodeTaskGroup[] {
  const sortOrderByGroupId = new Map<string, number>();
  for (const entry of structure.topLevelOrders) {
    if (entry.type !== "group") continue;
    sortOrderByGroupId.set(entry.groupId, entry.sortOrder);
  }
  return [...structure.groups].sort((left, right) => {
    const leftOrder = sortOrderByGroupId.get(left.id);
    const rightOrder = sortOrderByGroupId.get(right.id);
    // 未出现在 order 里的分组（极少见）排在有次序的之后，保持稳定。
    if (leftOrder === undefined && rightOrder === undefined) return 0;
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    return leftOrder - rightOrder;
  });
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
    structure.members.map(
      (member) => `${member.workspaceKey}|${member.taskId}`,
    ),
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
