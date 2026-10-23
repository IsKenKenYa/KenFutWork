import { createHash } from "node:crypto";
import type { CodeTaskOrganizationTarget } from "@kenfutwork/shared";
import { canonicalLocalWorkspaceIdentity } from "@zcode/shared";
import { jsonbSafeStringify } from "../../utils/text-sanitize.js";
import type {
  InstanceSqlClient,
  PersistenceService,
  SqlRow,
} from "../persistence/types.js";
import { syncGoal } from "./goals.js";
import { CodeUiHostRpcError } from "./host-rpc-handler.js";
import type { CodeUiSessionRecord } from "./repository.js";
import { codeUiTaskMeta } from "./task-index.js";

type TaskMeta = NonNullable<ReturnType<typeof codeUiTaskMeta>>;
type ArchiveOperation = {
  target: CodeTaskOrganizationTarget;
  archived: boolean;
  key: string;
  fingerprint: string;
};
type Preparation =
  | { kind: "complete"; result: TaskMeta }
  | { kind: "closing"; generation: number };
type ArchiveReceipt =
  | { status: "pending" }
  | { status: "accepted"; result: TaskMeta };
const receiptOwner = "code-ui:task-archive";

function withArchiveLock<T>(
  persistence: PersistenceService,
  instanceId: string,
  taskId: string,
  run: (signal: AbortSignal) => Promise<T>,
) {
  return persistence.withSessionTransaction(async (holder, signal) => {
    // 专用连接只持有业务锁；资源关闭期间不持有 Task 行锁或普通查询池连接。
    await holder.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([receiptOwner, instanceId, taskId]),
    ]);
    signal.throwIfAborted();
    return run(signal);
  });
}

function conflict(message = "任务已改变，请刷新后重试。") {
  return new CodeUiHostRpcError("task_archive_conflict", message, 409);
}

function operationFor(target: CodeTaskOrganizationTarget, archived: boolean) {
  const control = target.taskControl;
  return {
    target,
    archived,
    key: JSON.stringify([
      target.taskId,
      control.projectId,
      control.branchGeneration,
      archived,
    ]),
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          target.taskId,
          target.workspacePath,
          target.workspaceIdentity,
          control.projectId,
          control.branchGeneration,
          archived,
        ]),
      )
      .digest("hex"),
  };
}

async function readReceipt(
  sql: InstanceSqlClient,
  operation: ArchiveOperation,
): Promise<ArchiveReceipt | null> {
  const receipt = await sql.queryOne<
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
  if (!receipt) return null;
  if (receipt.status === "deleted")
    throw new CodeUiHostRpcError("code_ui_not_found", "任务已删除。", 404);
  if (receipt.parameter_fingerprint !== operation.fingerprint)
    throw conflict("同一次操作的参数已改变，请刷新任务。");
  if (receipt.status === "pending") return { status: "pending" };
  if (receipt.status !== "accepted" || !receipt.ack)
    throw conflict("任务操作尚未完成，请刷新后重试。");
  return { status: "accepted", result: receipt.ack };
}

function taskMeta(root: CodeUiSessionRecord): TaskMeta {
  const meta = root.root_directory
    ? codeUiTaskMeta(root, root.root_directory)
    : null;
  if (!meta)
    throw new CodeUiHostRpcError("code_ui_not_found", "任务已不可用。", 404);
  return meta;
}

async function lockTask(sql: InstanceSqlClient, operation: ArchiveOperation) {
  const { target } = operation;
  const project = await sql.queryOne(
    `select id from public.projects where instance_id=:instance and id=$1
      and archived_at is null and archive_state='open'
      and enabled_modes && array['code','design']::text[] for share`,
    [target.taskControl.projectId],
  );
  if (!project)
    throw new CodeUiHostRpcError("code_ui_not_found", "项目已不可用。", 404);
  const root = await sql.queryOne<CodeUiSessionRecord>(
    `select * from public.code_ui_sessions where instance_id=:instance and id=$1
      and parent_session_id is null and deleted_at is null for update`,
    [target.taskId],
  );
  if (!root?.state)
    throw new CodeUiHostRpcError("code_ui_not_found", "任务已删除。", 404);
  if (
    root.project_id !== target.taskControl.projectId ||
    root.root_directory !== target.workspacePath ||
    target.workspaceIdentity !==
      canonicalLocalWorkspaceIdentity(root.project_id, root.root_directory)
  )
    throw conflict();
  return root;
}

async function acceptReceipt(
  sql: InstanceSqlClient,
  operation: ArchiveOperation,
  result: TaskMeta,
) {
  await sql.execute(
    `update public.code_ui_commands set status='accepted',ack=$3::jsonb
      where instance_id=:instance and client_id=$1 and command_id=$2 and status='pending'`,
    [receiptOwner, operation.key, jsonbSafeStringify(result)],
  );
  return result;
}

async function prepare(
  sql: InstanceSqlClient,
  operation: ArchiveOperation,
  signal: AbortSignal,
): Promise<Preparation> {
  signal.throwIfAborted();
  const replay = await readReceipt(sql, operation);
  if (replay?.status === "accepted")
    return { kind: "complete", result: replay.result };
  const root = await lockTask(sql, operation);
  signal.throwIfAborted();
  const result = taskMeta(root);
  if (replay?.status === "pending") {
    if (
      operation.archived &&
      !root.archived &&
      root.execution_state === "revoking" &&
      Number(root.branch_generation) ===
        operation.target.taskControl.branchGeneration + 1
    )
      return { kind: "closing", generation: Number(root.scope_generation) };
    throw conflict();
  }
  if (
    Number(root.branch_generation) !==
      operation.target.taskControl.branchGeneration ||
    root.execution_state === "revoking"
  )
    throw conflict();
  await sql.execute(
    `insert into public.code_ui_commands
      (instance_id,client_id,command_id,session_id,parameter_fingerprint,status)
      values (:instance,$1,$2,$3,$4,'pending')`,
    [receiptOwner, operation.key, root.id, operation.fingerprint],
  );
  if (root.archived === operation.archived) {
    if (!root.archived && root.execution_state !== "ready") throw conflict();
    return {
      kind: "complete",
      result: await acceptReceipt(sql, operation, result),
    };
  }
  if (!operation.archived && root.execution_state !== "failed")
    throw conflict("任务尚未关闭，请刷新后重试。");
  const state = structuredClone(root.state!);
  if (!operation.archived && state.goalRecord) {
    state.goalRecord.branchGeneration = Number(root.branch_generation) + 1;
    state.goalRecord.revision += 1;
    syncGoal(state, root.id);
  }
  const changed = await sql.query<CodeUiSessionRecord>(
    `update public.code_ui_sessions set scope_generation=scope_generation+1,
      branch_generation=branch_generation+1,revision=revision+1,updated_at=now(),
      execution_state=$2,archived=$3,state=case when id=$1 then $4::jsonb else state end
      where instance_id=:instance and root_session_id=$1 and deleted_at is null returning *`,
    [
      root.id,
      operation.archived ? "revoking" : "ready",
      operation.archived ? root.archived : false,
      jsonbSafeStringify(state),
    ],
  );
  const updated = changed.find((record) => record.id === root.id);
  if (!updated) throw new Error("任务组织操作没有更新根任务。");
  if (!operation.archived)
    return {
      kind: "complete",
      result: await acceptReceipt(sql, operation, taskMeta(updated)),
    };
  return { kind: "closing", generation: Number(updated.scope_generation) };
}

async function finish(
  sql: InstanceSqlClient,
  operation: ArchiveOperation,
  generation: number,
) {
  const root = await lockTask(sql, operation);
  if (
    root.execution_state !== "revoking" ||
    Number(root.scope_generation) !== generation ||
    Number(root.branch_generation) !==
      operation.target.taskControl.branchGeneration + 1
  )
    throw conflict();
  const updated = await sql.queryOne<CodeUiSessionRecord>(
    `update public.code_ui_sessions set archived=true,execution_state='failed',
      revision=revision+1,updated_at=now() where instance_id=:instance and id=$1 returning *`,
    [root.id],
  );
  if (!updated) throw new Error("归档完成没有更新根任务。");
  return acceptReceipt(sql, operation, taskMeta(updated));
}

async function canDeleteArchived(
  sql: InstanceSqlClient,
  target: CodeTaskOrganizationTarget,
) {
  const root = await sql.queryOne<CodeUiSessionRecord>(
    `select * from public.code_ui_sessions where instance_id=:instance and id=$1
      and parent_session_id is null and deleted_at is null for update`,
    [target.taskId],
  );
  if (!root) return false;
  if (
    root.project_id !== target.taskControl.projectId ||
    root.root_directory !== target.workspacePath ||
    target.workspaceIdentity !==
      canonicalLocalWorkspaceIdentity(root.project_id, root.root_directory)
  )
    throw conflict();
  return (
    root.archived &&
    root.execution_state === "failed" &&
    Number(root.branch_generation) === target.taskControl.branchGeneration
  );
}

/** 业务键为实例、Task、项目、观察分支与目标归档值；删除沿原命令墓碑清除内容。 */
export function createTaskArchiveOperations(persistence: PersistenceService) {
  return {
    async change(
      instanceId: string,
      target: CodeTaskOrganizationTarget,
      archived: boolean,
      close: () => Promise<void>,
      signal: AbortSignal,
    ): Promise<TaskMeta> {
      const operation = operationFor(target, archived);
      return withArchiveLock(
        persistence,
        instanceId,
        target.taskId,
        async (holderSignal) => {
          signal.throwIfAborted();
          const prepared = await persistence.transaction(async (tx) => {
            const result = await prepare(
              tx.forInstance(instanceId),
              operation,
              signal,
            );
            signal.throwIfAborted();
            return result;
          });
          if (prepared.kind === "complete") return prepared.result;
          try {
            await close();
            holderSignal.throwIfAborted();
            return await persistence.transaction((tx) =>
              finish(
                tx.forInstance(instanceId),
                operation,
                prepared.generation,
              ),
            );
          } catch (error) {
            await persistence.transaction(async (tx) => {
              const sql = tx.forInstance(instanceId);
              await sql.execute(
                `update public.code_ui_sessions set execution_state='failed'
                where instance_id=:instance and root_session_id=$1
                and scope_generation=$2 and execution_state='revoking' and deleted_at is null`,
                [target.taskId, prepared.generation],
              );
              await sql.execute(
                `update public.code_ui_commands set status='failed',ack=null
                where instance_id=:instance and client_id=$1 and command_id=$2 and status='pending'`,
                [receiptOwner, operation.key],
              );
            });
            throw error;
          }
        },
      );
    },
    async deleteArchived(
      instanceId: string,
      target: CodeTaskOrganizationTarget,
      remove: () => Promise<void>,
      signal: AbortSignal,
    ): Promise<boolean> {
      return withArchiveLock(
        persistence,
        instanceId,
        target.taskId,
        async (holderSignal) => {
          signal.throwIfAborted();
          const allowed = await persistence.transaction((tx) =>
            canDeleteArchived(tx.forInstance(instanceId), target),
          );
          if (!allowed) return false;
          signal.throwIfAborted();
          await remove();
          holderSignal.throwIfAborted();
          return true;
        },
      );
    },
  };
}
