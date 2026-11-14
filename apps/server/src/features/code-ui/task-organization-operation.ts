import type { CodeTaskOrganizationTarget } from "@kenfutwork/shared";
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

export type TaskOrganizationMeta = NonNullable<
  ReturnType<typeof codeUiTaskMeta>
>;
type ConflictCode = "task_unread_conflict" | "task_pin_conflict";
export interface TaskOrganizationOperation {
  owner: "code-ui:task-unread" | "code-ui:task-pin";
  key: string;
  fingerprint: string;
  conflictCode: ConflictCode;
}

export function taskOrganizationConflict(
  code: ConflictCode,
  message = "任务已改变，请刷新后重试。",
) {
  return new CodeUiHostRpcError(code, message, 409);
}

export function taskOrganizationNotFound() {
  return new CodeUiHostRpcError("code_ui_not_found", "任务已不可用。", 404);
}

function rejectLockContention(error: unknown, code: ConflictCode): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "55P03"
  )
    throw taskOrganizationConflict(code, "任务状态正在改变，请刷新后重试。");
  throw error;
}

async function lockTask(
  sql: InstanceSqlClient,
  input: CodeTaskOrganizationTarget,
  code: ConflictCode,
) {
  const root = await sql.queryOne<CodeUiSessionRecord>(
    `select * from public.code_ui_sessions where instance_id=:instance and id=$1
      and parent_session_id is null and deleted_at is null for update`,
    [input.taskId],
  );
  if (!root?.state || root.root_session_id !== root.id || !root.root_directory)
    throw taskOrganizationNotFound();
  if (
    root.project_id !== input.taskControl.projectId ||
    Number(root.branch_generation) !== input.taskControl.branchGeneration ||
    root.root_directory !== input.workspacePath ||
    input.workspaceIdentity !==
      canonicalLocalWorkspaceIdentity(root.project_id, root.root_directory)
  )
    throw taskOrganizationConflict(code);
  const owner = await sql
    .queryOne(
      `select task_id from public.execution_task_owners where instance_id=:instance
      and task_id=$1 and task_kind='code' and code_task_id=$1 and project_id=$2 for share nowait`,
      [root.id, root.project_id],
    )
    .catch((error: unknown) => rejectLockContention(error, code));
  if (!owner) throw taskOrganizationNotFound();
  // 项目关闭先持有 Project 再更新 Task；此处不能持有 Task 后等待 Project。
  const project = await sql
    .queryOne(
      `select id from public.projects where instance_id=:instance and id=$1
      and archived_at is null and archive_state='open'
      and enabled_modes && array['code','design']::text[] for share nowait`,
      [root.project_id],
    )
    .catch((error: unknown) => rejectLockContention(error, code));
  if (!project) throw taskOrganizationNotFound();
  if (root.execution_state === "revoking") throw taskOrganizationConflict(code);
  return root;
}

export function taskOrganizationMeta(
  root: CodeUiSessionRecord,
): TaskOrganizationMeta {
  const meta = root.root_directory
    ? codeUiTaskMeta(root, root.root_directory)
    : null;
  if (!meta) throw taskOrganizationNotFound();
  return meta;
}

async function readReceipt(
  sql: InstanceSqlClient,
  operation: TaskOrganizationOperation,
) {
  const previous = await sql.queryOne<
    SqlRow & {
      parameter_fingerprint: string | null;
      status: string;
      ack: TaskOrganizationMeta | null;
    }
  >(
    `select parameter_fingerprint,status,ack from public.code_ui_commands
      where instance_id=:instance and client_id=$1 and command_id=$2`,
    [operation.owner, operation.key],
  );
  if (!previous) return null;
  if (previous.status === "deleted") throw taskOrganizationNotFound();
  if (previous.parameter_fingerprint !== operation.fingerprint)
    throw taskOrganizationConflict(
      operation.conflictCode,
      "同一次操作的参数已改变，请刷新任务。",
    );
  if (previous.status !== "accepted" || !previous.ack)
    throw taskOrganizationConflict(
      operation.conflictCode,
      "任务操作尚未完成，请刷新后重试。",
    );
  return previous.ack;
}

/** 两类明确组织变更共用身份、回执与关闭检查，字段更新在同一事务内分别执行。 */
export function changeTaskOrganization(
  persistence: PersistenceService,
  instanceId: string,
  input: CodeTaskOrganizationTarget,
  operation: TaskOrganizationOperation,
  signal: AbortSignal,
  apply: (
    sql: InstanceSqlClient,
    root: CodeUiSessionRecord,
  ) => Promise<TaskOrganizationMeta>,
): Promise<TaskOrganizationMeta> {
  return persistence.transaction(async (transaction) => {
    signal.throwIfAborted();
    const sql = transaction.forInstance(instanceId);
    const root = await lockTask(sql, input, operation.conflictCode);
    signal.throwIfAborted();
    const previous = await readReceipt(sql, operation);
    signal.throwIfAborted();
    if (previous) return previous;
    const result = await apply(sql, root);
    signal.throwIfAborted();
    await sql.execute(
      `insert into public.code_ui_commands
        (instance_id,client_id,command_id,session_id,parameter_fingerprint,status,ack)
        values (:instance,$1,$2,$3,$4,'accepted',$5::jsonb)`,
      [
        operation.owner,
        operation.key,
        root.id,
        operation.fingerprint,
        jsonbSafeStringify(result),
      ],
    );
    signal.throwIfAborted();
    return result;
  });
}
