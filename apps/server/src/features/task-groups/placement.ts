import { createHash } from "node:crypto";
import {
  type CodeTaskGroupAdmission,
  type CodeTaskGroupTaskRef,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { CodeUiHostRpcError } from "../code-ui/host-rpc-handler.js";
import type { InstanceSqlClient, SqlRow } from "../persistence/types.js";
import {
  readTaskGroupMemberOrder,
  readTaskGroupRootOrder,
  type TaskGroupOrderNode,
  taskGroupOrderChanged,
  writeTaskGroupMemberOrder,
  writeTaskGroupRootOrder,
} from "./order.js";

const receiptOwner = "code-ui:task-group-placement";
type Placement = NonNullable<CodeTaskGroupAdmission["placement"]>;
export type TaskGroupPlacementIntent = {
  taskId: string;
  groupId: string | null;
  fingerprint: string;
};
type PlacementReceipt = SqlRow & {
  session_id: string;
  parameter_fingerprint: string | null;
  status: string;
  ack: unknown;
};

function conflict(message = "新建任务的分组归属已改变，请刷新任务列表。") {
  return new CodeUiHostRpcError("task_group_revision_conflict", message, 409);
}

function taskNotFound() {
  return new CodeUiHostRpcError(
    "code_ui_not_found",
    "任务已删除，请刷新任务列表。",
    404,
  );
}

async function verifyCreationAlias(
  sql: InstanceSqlClient,
  taskId: string,
  creationId: string,
) {
  const alias = creationId.toLowerCase();
  if (alias === taskId) return;
  // 只读取该 Task 保留的原 canonical 首条输入；继承历史和编辑输入不提供创建证明。
  const receipts = await sql.query<
    SqlRow & { command_id: string; status: string; ack: unknown }
  >(
    `select c.command_id,c.status,c.ack from public.code_ui_sessions s
      cross join lateral jsonb_array_elements(coalesce(s.state->'inputs','[]'::jsonb)) as original(input)
      join public.code_ui_commands c on c.instance_id=s.instance_id and c.session_id=s.id
        and c.client_id=original.input#>>'{intent,clientId}'
        and c.command_id=original.input#>>'{intent,sourceCommandId}'
      where s.instance_id=:instance and s.id=$1
        and not (original.input ? 'historyOf')
        and original.input#>'{intent,order,admissionSeq}'='1'::jsonb
        and lower(original.input#>>'{intent,sourceCommandId}')=$2`,
    [taskId, alias],
  );
  const receipt = receipts[0];
  if (receipts.length !== 1 || !receipt || receipt.status !== "accepted")
    throw conflict("任务创建来源不符，请刷新任务列表。");
  const parsed = protocol.commandAckSchema.safeParse(receipt.ack);
  if (
    !parsed.success ||
    parsed.data.status !== "accepted" ||
    parsed.data.commandId !== receipt.command_id
  )
    throw conflict("任务创建回执不完整，请刷新任务列表。");
  const result = parsed.data.result;
  const accepted =
    result?.type === "createSession"
      ? result.sessionId === taskId &&
        result.input?.inputId === receipt.command_id
      : result?.type === "inputAccepted" &&
        result.inputId === receipt.command_id;
  if (!accepted) throw conflict("任务创建回执不符，请刷新任务列表。");
}

function placementIntent(
  placement: Placement,
  references: ReadonlyMap<string, CodeTaskGroupTaskRef>,
): TaskGroupPlacementIntent {
  const taskId = placement.task.taskId.toLowerCase();
  const groupId = placement.groupId?.toLowerCase() ?? null;
  const tasks = [...references.values()]
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map((task) => ({
      hostId: task.hostId,
      taskId: task.taskId.toLowerCase(),
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    }));
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw taskNotFound();
  return {
    taskId,
    groupId,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          tasks,
          placement: { task, groupId, creationId: taskId },
        }),
      )
      .digest("hex"),
  };
}

export async function prepareTaskGroupPlacement(
  sql: InstanceSqlClient,
  placement: Placement,
  references: ReadonlyMap<string, CodeTaskGroupTaskRef>,
  lockedTasks: readonly { id: string }[],
  signal: AbortSignal,
) {
  const taskId = placement.task.taskId.toLowerCase();
  if (!lockedTasks.some((task) => task.id === taskId)) throw taskNotFound();
  await verifyCreationAlias(sql, taskId, placement.creationId);
  signal.throwIfAborted();
  const intent = placementIntent(placement, references);
  const receipt = await sql.queryOne<PlacementReceipt>(
    `select session_id,parameter_fingerprint,status,ack from public.code_ui_commands
      where instance_id=:instance and client_id=$1 and command_id=$2`,
    [receiptOwner, intent.taskId],
  );
  signal.throwIfAborted();
  if (!receipt) return { intent, replayed: false };
  if (receipt.status === "deleted") throw taskNotFound();
  if (
    receipt.session_id !== intent.taskId ||
    receipt.parameter_fingerprint !== intent.fingerprint ||
    receipt.status !== "accepted" ||
    receipt.ack === null ||
    typeof receipt.ack !== "object" ||
    Array.isArray(receipt.ack)
  )
    throw conflict();
  return { intent, replayed: true };
}

async function movePlacementToTop(
  sql: InstanceSqlClient,
  intent: TaskGroupPlacementIntent,
  previousGroupId: string | null,
  signal: AbortSignal,
) {
  const group = intent.groupId
    ? await sql.queryOne(
        "select id from public.code_task_groups where instance_id=:instance and id=$1",
        [intent.groupId],
      )
    : null;
  const groupId = group ? intent.groupId : null;
  const node: TaskGroupOrderNode = {
    type: "task",
    id: intent.taskId,
    sortOrder: 0,
  };
  const root =
    previousGroupId === null || groupId === null
      ? await readTaskGroupRootOrder(sql)
      : null;
  const members = groupId ? await readTaskGroupMemberOrder(sql, groupId) : null;
  signal.throwIfAborted();
  await sql.execute(
    `update public.code_task_group_members set group_id=$2,user_organized=true,
      creation_id=$1,updated_at=clock_timestamp()
      where instance_id=:instance and task_id=$1 and task_kind='code'`,
    [intent.taskId, groupId],
  );
  let changed = false;
  if (root) {
    const remaining = root.filter(
      (candidate) =>
        candidate.type !== "task" || candidate.id !== intent.taskId,
    );
    const next = groupId ? remaining : [node, ...remaining];
    if (taskGroupOrderChanged(root, next)) {
      await writeTaskGroupRootOrder(sql, next);
      changed = true;
    }
  }
  if (groupId && members) {
    const next = [
      node,
      ...members.filter((candidate) => candidate.id !== intent.taskId),
    ];
    if (taskGroupOrderChanged(members, next)) {
      await writeTaskGroupMemberOrder(sql, groupId, next);
      changed = true;
    }
  }
  return changed;
}

export async function applyTaskGroupPlacement(
  sql: InstanceSqlClient,
  intent: TaskGroupPlacementIntent,
  signal: AbortSignal,
) {
  const member = await sql.queryOne<
    SqlRow & {
      group_id: string | null;
      user_organized: boolean;
      creation_id: string | null;
    }
  >(
    `select group_id,user_organized,creation_id from public.code_task_group_members
      where instance_id=:instance and task_id=$1 and task_kind='code' for update`,
    [intent.taskId],
  );
  signal.throwIfAborted();
  if (!member) throw new Error("创建分组归属缺少已登记的真实 Task。");
  let changed = false;
  if (member.user_organized) {
    await sql.execute(
      `update public.code_task_group_members set creation_id=$1,updated_at=clock_timestamp()
        where instance_id=:instance and task_id=$1 and task_kind='code'`,
      [intent.taskId],
    );
  } else {
    changed = await movePlacementToTop(sql, intent, member.group_id, signal);
  }
  await sql.execute(
    `insert into public.code_ui_commands
      (instance_id,client_id,command_id,session_id,parameter_fingerprint,ack,status)
      values (:instance,$1,$2,$3,$4,'{}'::jsonb,'accepted')`,
    [receiptOwner, intent.taskId, intent.taskId, intent.fingerprint],
  );
  signal.throwIfAborted();
  return changed;
}
