import { createHash } from "node:crypto";
import type { CodeTaskUnreadInput } from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { jsonbSafeStringify } from "../../utils/text-sanitize.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import { CodeUiHostRpcError } from "./host-rpc-handler.js";
import type { CodeUiSessionRecord } from "./repository.js";
import { codeUiTaskMeta } from "./task-index.js";

type TaskMeta = NonNullable<ReturnType<typeof codeUiTaskMeta>>;
type UnreadOperation = {
  input: CodeTaskUnreadInput;
  key: string;
  fingerprint: string;
};
const receiptOwner = "code-ui:task-unread";

function conflict(message = "任务已改变，请刷新后重试。") {
  return new CodeUiHostRpcError("task_unread_conflict", message, 409);
}

function notFound() {
  return new CodeUiHostRpcError("code_ui_not_found", "任务已不可用。", 404);
}

function operationFor(instanceId: string, input: CodeTaskUnreadInput) {
  const control = input.taskControl;
  return {
    input,
    key: JSON.stringify([
      instanceId,
      input.taskId,
      control.projectId,
      control.branchGeneration,
      input.observedLastUnreadAt,
      input.unread,
    ]),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          input.taskId,
          input.workspacePath,
          input.workspaceIdentity,
          control.projectId,
          control.branchGeneration,
          input.observedLastUnreadAt,
          input.unread,
          input.expectedUnreadAt ?? null,
        ]),
      )
      .digest("hex"),
  };
}

function rejectLockContention(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "55P03"
  )
    throw conflict("任务状态正在改变，请刷新后重试。");
  throw error;
}

function lockProject(sql: InstanceSqlClient, projectId: string) {
  // 项目关闭先持有 Project 再更新 Task；此处不能持有 Task 后等待该 Project。
  return sql
    .queryOne(
      `select id from public.projects where instance_id=:instance and id=$1
        and archived_at is null and archive_state='open'
        and enabled_modes && array['code','design']::text[] for share nowait`,
      [projectId],
    )
    .catch(rejectLockContention);
}

async function lockTask(sql: InstanceSqlClient, input: CodeTaskUnreadInput) {
  const root = await sql.queryOne<CodeUiSessionRecord>(
    `select * from public.code_ui_sessions where instance_id=:instance and id=$1
      and parent_session_id is null and deleted_at is null for update`,
    [input.taskId],
  );
  if (!root?.state || root.root_session_id !== root.id || !root.root_directory)
    throw notFound();
  if (
    root.project_id !== input.taskControl.projectId ||
    Number(root.branch_generation) !== input.taskControl.branchGeneration ||
    root.root_directory !== input.workspacePath ||
    input.workspaceIdentity !==
      canonicalLocalWorkspaceIdentity(root.project_id, root.root_directory)
  )
    throw conflict();
  const owner = await sql
    .queryOne(
      `select task_id from public.execution_task_owners where instance_id=:instance
        and task_id=$1 and task_kind='code' and code_task_id=$1 and project_id=$2 for share nowait`,
      [root.id, root.project_id],
    )
    .catch(rejectLockContention);
  if (!owner) throw notFound();
  const project = await lockProject(sql, root.project_id);
  if (!project) throw notFound();
  if (root.execution_state === "revoking") throw conflict();
  return root;
}

function taskMeta(root: CodeUiSessionRecord): TaskMeta {
  const meta = root.root_directory
    ? codeUiTaskMeta(root, root.root_directory)
    : null;
  if (!meta) throw notFound();
  return meta;
}

async function readReceipt(sql: InstanceSqlClient, operation: UnreadOperation) {
  const previous = await sql.queryOne<
    SqlRow & {
      parameter_fingerprint: string | null;
      status: string;
      ack: TaskMeta | null;
    }
  >(
    `select parameter_fingerprint,status,ack from public.code_ui_commands
      where instance_id=:instance and client_id=$1 and command_id=$2`,
    [receiptOwner, operation.key],
  );
  if (!previous) return null;
  if (previous.status === "deleted") throw notFound();
  if (previous.parameter_fingerprint !== operation.fingerprint)
    throw conflict("同一次操作的参数已改变，请刷新任务。");
  if (previous.status !== "accepted" || !previous.ack)
    throw conflict("未读操作尚未完成，请刷新后重试。");
  return previous.ack;
}

async function applyUnread(
  sql: InstanceSqlClient,
  root: CodeUiSessionRecord,
  input: CodeTaskUnreadInput,
) {
  const unreadAt = root.unread_at === null ? null : Number(root.unread_at);
  const lastUnreadAt = Number(root.last_unread_at);
  if (
    !input.unread &&
    input.expectedUnreadAt !== undefined &&
    unreadAt !== input.expectedUnreadAt
  )
    return taskMeta(root);
  if (lastUnreadAt !== input.observedLastUnreadAt) throw conflict();
  if (!input.unread && unreadAt === null) return taskMeta(root);
  const marker = input.unread ? Math.max(Date.now(), lastUnreadAt + 1) : null;
  if (marker !== null && !Number.isSafeInteger(marker))
    throw conflict("未读标记无效，请重新加载任务。");
  const updated = await sql.queryOne<CodeUiSessionRecord>(
    `update public.code_ui_sessions set unread_at=$2,
      last_unread_at=case when $2::bigint is null then last_unread_at else $2::bigint end
      where instance_id=:instance and id=$1 returning *`,
    [root.id, marker],
  );
  if (!updated) throw notFound();
  return taskMeta(updated);
}

/** 未读标记与回执共用根 Task 行锁；清除后保留水位，旧 marker 不会再次分配。 */
export function createTaskUnreadOperations(persistence: PersistenceService) {
  return {
    change(
      instanceId: string,
      input: CodeTaskUnreadInput,
      signal: AbortSignal,
    ): Promise<TaskMeta> {
      const operation = operationFor(instanceId, input);
      return persistence.transaction(async (transaction) => {
        signal.throwIfAborted();
        const sql = transaction.forInstance(instanceId);
        const root = await lockTask(sql, input);
        signal.throwIfAborted();
        const previous = await readReceipt(sql, operation);
        signal.throwIfAborted();
        if (previous) return previous;
        const result = await applyUnread(sql, root, input);
        signal.throwIfAborted();
        await sql.execute(
          `insert into public.code_ui_commands
            (instance_id,client_id,command_id,session_id,parameter_fingerprint,status,ack)
            values (:instance,$1,$2,$3,$4,'accepted',$5::jsonb)`,
          [
            receiptOwner,
            operation.key,
            root.id,
            operation.fingerprint,
            jsonbSafeStringify(result),
          ],
        );
        signal.throwIfAborted();
        return result;
      });
    },
  };
}
