import type { CodeTaskGroupMove } from "@kenfutwork/shared";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import {
  type TaskGroupMoveIntent,
  type TaskGroupMoveNode,
  taskGroupMoveIntent,
} from "./move-intent.js";
import {
  replayTaskGroupMove,
  writeTaskGroupMoveReceipt,
} from "./move-receipts.js";
import {
  readTaskGroupMemberOrder,
  readTaskGroupRootOrder,
  writeTaskGroupMemberOrder,
  writeTaskGroupRootOrder,
} from "./order.js";
import {
  lockTaskGroupTasks,
  type TaskGroupTaskRecord,
  verifyTaskGroupTaskReferences,
} from "./references.js";

export interface TaskGroupMover {
  move(
    actor: LocalActor,
    input: CodeTaskGroupMove,
    signal: AbortSignal,
  ): Promise<void>;
}

function conflict(message = "分组顺序已改变，请刷新后重新操作。") {
  return new CodeUiHostRpcError("task_group_revision_conflict", message, 409);
}

function notFound() {
  return new CodeUiHostRpcError(
    "code_ui_not_found",
    "移动目标已不可用，请刷新列表。",
    404,
  );
}

function verifyMovingTasks(
  tasks: readonly TaskGroupTaskRecord[],
  intent: TaskGroupMoveIntent,
) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const id of intent.references.keys()) {
    const task = byId.get(id);
    if (!task || task.archived) throw notFound();
  }
  verifyTaskGroupTaskReferences(tasks, intent.references);
}

async function verifyGroups(
  sql: InstanceSqlClient,
  intent: TaskGroupMoveIntent,
) {
  const required = new Set<string>();
  if (intent.node.type === "group") required.add(intent.node.id);
  if (intent.groupId) required.add(intent.groupId);
  if (!required.size) return;
  const groups = await sql.query<SqlRow & { id: string }>(
    "select id from public.code_task_groups where instance_id=:instance and id=any($1::uuid[])",
    [[...required]],
  );
  const existing = new Set(groups.map((group) => group.id));
  if ([...required].some((id) => !existing.has(id))) throw notFound();
}

async function actualParent(sql: InstanceSqlClient, node: TaskGroupMoveNode) {
  if (node.type === "group") return null;
  const member = await sql.queryOne<SqlRow & { group_id: string | null }>(
    `select group_id from public.code_task_group_members
      where instance_id=:instance and task_id=$1 and task_kind='code' for update`,
    [node.id],
  );
  return member?.group_id ?? null;
}

function readOrder(sql: InstanceSqlClient, groupId: string | null) {
  return groupId
    ? readTaskGroupMemberOrder(sql, groupId)
    : readTaskGroupRootOrder(sql);
}

function writeOrder(
  sql: InstanceSqlClient,
  groupId: string | null,
  nodes: readonly TaskGroupMoveNode[],
) {
  return groupId
    ? writeTaskGroupMemberOrder(sql, groupId, nodes)
    : writeTaskGroupRootOrder(sql, nodes);
}

function sameNode(a: TaskGroupMoveNode, b: TaskGroupMoveNode) {
  return a.type === b.type && a.id === b.id;
}

function destinationOrder(
  nodes: readonly TaskGroupMoveNode[],
  intent: TaskGroupMoveIntent,
) {
  const destination = nodes.filter((node) => !sameNode(node, intent.node));
  const anchor = intent.anchor;
  const index = anchor
    ? destination.findIndex((node) => sameNode(node, anchor.node))
    : 0;
  if (index < 0) throw conflict("目标位置已改变，请刷新分组列表。");
  destination.splice(
    index + (intent.anchor?.side === "after" ? 1 : 0),
    0,
    intent.node,
  );
  return destination;
}

async function applyMove(
  sql: InstanceSqlClient,
  intent: TaskGroupMoveIntent,
  signal: AbortSignal,
) {
  await verifyGroups(sql, intent);
  const parent = await actualParent(sql, intent.node);
  if (
    parent !== intent.sourceGroupId ||
    (intent.node.type === "group" && intent.groupId !== null)
  )
    throw conflict("分组来源已改变，请刷新后重新操作。");
  const destination = destinationOrder(
    await readOrder(sql, intent.groupId),
    intent,
  );
  const source =
    parent !== intent.groupId ? await readOrder(sql, parent) : null;
  signal.throwIfAborted();
  if (intent.node.type === "task")
    await sql.execute(
      `insert into public.code_task_group_members
        (instance_id,task_id,task_kind,group_id,sort_order,user_organized)
        values (:instance,$1,'code',$2,0,true)
        on conflict(instance_id,task_id,task_kind) do update set
          group_id=excluded.group_id,user_organized=true,updated_at=clock_timestamp()`,
      [intent.node.id, intent.groupId],
    );
  if (source)
    await writeOrder(
      sql,
      parent,
      source.filter((node) => !sameNode(node, intent.node)),
    );
  await writeOrder(sql, intent.groupId, destination);
  signal.throwIfAborted();
}

export function createTaskGroupMover(deps: {
  persistence: PersistenceService;
  localInstance: LocalInstanceService;
}): TaskGroupMover {
  return {
    async move(actor, input, signal) {
      signal.throwIfAborted();
      const owner = await deps.localInstance.resolve(actor);
      const intent = taskGroupMoveIntent(input);
      signal.throwIfAborted();
      await deps.persistence.transaction(async (tx) => {
        const sql = tx.forInstance(owner.instanceId);
        const tasks = intent.references.size
          ? await lockTaskGroupTasks(sql, intent.references, signal)
          : [];
        const state = await sql.queryOne<
          SqlRow & { revision: string | number }
        >(
          "select revision from public.code_task_group_state where instance_id=:instance for update",
        );
        signal.throwIfAborted();
        if (!state)
          throw new CodeUiHostRpcError(
            "task_groups_not_initialized",
            "分组数据尚未初始化，请重启应用。",
            503,
          );
        if (await replayTaskGroupMove(sql, intent)) {
          signal.throwIfAborted();
          return;
        }
        signal.throwIfAborted();
        verifyMovingTasks(tasks, intent);
        if (Number(state.revision) !== intent.expectedRevision)
          throw conflict();
        await applyMove(sql, intent, signal);
        await sql.execute(
          "update public.code_task_group_state set revision=revision+1 where instance_id=:instance",
        );
        await writeTaskGroupMoveReceipt(sql, intent);
        signal.throwIfAborted();
      });
    },
  };
}
