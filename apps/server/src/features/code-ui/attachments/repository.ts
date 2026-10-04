import type {
  PersistenceService,
  PersistenceSessionLock,
  SqlRow,
} from "../../persistence/types.js";
import {
  CodeAttachmentError,
  type CodeAttachmentRecord,
  type CodeAttachmentRepository,
  type CodeAttachmentSession,
} from "./types.js";

type AttachmentRow = SqlRow & { record: CodeAttachmentRecord };
const TOMBSTONE_RECORD = `jsonb_build_object('status', 'aborted', 'key', upload_key, 'workspaceId', workspace_id,
  'projectId', project_id, 'taskId', task_id, 'sessionId', session_id, 'userId', user_id)`;

export function abortedAttachment(
  record: CodeAttachmentRecord,
): Extract<CodeAttachmentRecord, { status: "aborted" }> {
  return {
    status: "aborted",
    key: record.key,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    taskId: record.taskId,
    sessionId: record.sessionId,
    userId: record.userId,
  };
}

/** One execution host owns staging; a replacement takes its lease before marking old work interrupted. */
export function createCodeAttachmentRepository(
  persistence: PersistenceService,
  executionHostId: string,
): CodeAttachmentRepository {
  let hostLease: PersistenceSessionLock | null = null;
  function requireHostLease() {
    if (!hostLease || hostLease.signal.aborted)
      throw new CodeAttachmentError(
        "fault.attachment.hostUnavailable",
        "Code 附件宿主租约已失效。",
        503,
      );
  }
  return {
    async interruptStaging(runtimeId) {
      if (!hostLease)
        hostLease = await persistence.acquireSessionLock(
          `code-attachments:${executionHostId}`,
        );
      if (!hostLease || hostLease.signal.aborted)
        throw new CodeAttachmentError(
          "fault.attachment.hostUnavailable",
          "Code 附件宿主尚未获得独占运行租约。",
          503,
        );
      await persistence.execute(
        `update public.code_attachments set status = 'aborted', connection_id = null, runtime_id = null,
        record = jsonb_build_object('status', 'aborted', 'key', upload_key, 'workspaceId', workspace_id,
          'projectId', project_id, 'taskId', task_id, 'sessionId', session_id, 'userId', user_id)
        where execution_host_id = $1 and status = 'staging' and runtime_id <> $2`,
        [executionHostId, runtimeId],
      );
    },
    async transact(session, key, operation) {
      requireHostLease();
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(session.workspaceId);
        // 固定散列种子属于 SQL 锁算法，不是运行时限额。
        await scoped.query(
          "select pg_advisory_xact_lock(hashtextextended(:workspace::text || '/code-attachment/' || $1, 0))",
          [key],
        );
        const row = await scoped.queryOne<AttachmentRow>(
          "select record from public.code_attachments where workspace_id = :workspace and upload_key = $1 for update",
          [key],
        );
        if (
          row &&
          (row.record.projectId !== session.projectId ||
            row.record.taskId !== session.taskId ||
            row.record.sessionId !== session.sessionId ||
            row.record.userId !== session.userId)
        )
          throw new CodeAttachmentError(
            "fault.attachment.notAuthorized",
            "上传身份不属于当前 Code Task。",
            404,
          );
        return operation({
          record: row?.record ?? null,
          async assertWritable(expected: CodeAttachmentSession) {
            requireHostLease();
            const task = await scoped.queryOne(
              `select t.id from public.code_ui_sessions t
              join public.code_ui_sessions s on s.root_session_id = t.id and s.workspace_id = t.workspace_id
              join public.projects p on p.id = t.project_id and p.workspace_id = t.workspace_id
              where t.workspace_id = :workspace and s.workspace_id = :workspace and p.workspace_id = :workspace
                and t.id = $1 and t.project_id = $2 and s.id = $3 and s.deleted_at is null and s.archived = false
                and t.parent_session_id is null and t.deleted_at is null and t.archived = false
                and t.execution_state = 'ready' and t.scope_generation = $4 and t.branch_generation = $5
                and p.kind = 'code' and p.archived_at is null for update of t`,
              [
                expected.taskId,
                expected.projectId,
                expected.sessionId,
                expected.scopeGeneration,
                expected.branchGeneration,
              ],
            );
            requireHostLease();
            if (!expected.canUpload || !task)
              throw new CodeAttachmentError(
                "fault.attachment.staleTask",
                "Task 已关闭或分支授权改变，附件提交已中断。",
              );
          },
          async save(record) {
            // Interrupted owners may only sanitize their already claimed lifecycle fact.
            if (record.status !== "aborted") requireHostLease();
            if (
              record.key !== key ||
              record.workspaceId !== session.workspaceId ||
              record.projectId !== session.projectId ||
              record.taskId !== session.taskId ||
              record.sessionId !== session.sessionId ||
              record.userId !== session.userId
            )
              throw new CodeAttachmentError(
                "fault.attachment.notAuthorized",
                "附件持久身份不匹配。",
                404,
              );
            await scoped.execute(
              `insert into public.code_attachments
              (workspace_id, project_id, task_id, session_id, user_id, upload_key, status, execution_host_id, connection_id, runtime_id, record)
              values (:workspace, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
              on conflict (workspace_id, upload_key) do update set status = excluded.status,
                connection_id = excluded.connection_id, runtime_id = excluded.runtime_id, record = excluded.record`,
              [
                record.projectId,
                record.taskId,
                record.sessionId,
                record.userId,
                key,
                record.status,
                executionHostId,
                record.status === "staging" ? record.connectionId : null,
                record.status === "staging" ? record.runtimeId : null,
                JSON.stringify(record),
              ],
            );
            if (record.status !== "aborted") requireHostLease();
          },
        });
      });
    },
    async findCommitted(session, ref) {
      const row = await persistence
        .forWorkspace(session.workspaceId)
        .queryOne<AttachmentRow>(
          `select record from public.code_attachments where workspace_id = :workspace
          and project_id = $1 and task_id = $2 and session_id = $3 and status = 'committed' and record->>'ref' = $4`,
          [session.projectId, session.taskId, session.sessionId, ref],
        );
      return row?.record.status === "committed" ? row.record : null;
    },
    async abortConnection(workspaceId, connectionId, runtimeId) {
      await persistence.forWorkspace(workspaceId).execute(
        `update public.code_attachments set status = 'aborted', connection_id = null, runtime_id = null,
        record = jsonb_build_object('status', 'aborted', 'key', upload_key, 'workspaceId', workspace_id,
          'projectId', project_id, 'taskId', task_id, 'sessionId', session_id, 'userId', user_id)
        where workspace_id = :workspace and execution_host_id = $1 and connection_id = $2 and runtime_id = $3 and status = 'staging'`,
        [executionHostId, connectionId, runtimeId],
      );
    },
    async close() {
      const lease = hostLease;
      hostLease = null;
      await lease?.release();
    },
    async releaseTask(workspaceId, taskId, runtimeId) {
      await persistence.forWorkspace(workspaceId).execute(
        `update public.code_attachments set status = 'aborted', connection_id = null, runtime_id = null,
        record = ${TOMBSTONE_RECORD} where workspace_id = :workspace and task_id = $1 and execution_host_id = $2 and runtime_id = $3 and status = 'staging'`,
        [taskId, executionHostId, runtimeId],
      );
    },
    async purgeTask(session, expectedScopeGeneration, batchSize, remove) {
      requireHostLease();
      if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
        throw new CodeAttachmentError(
          "fault.attachment.invalidBudget",
          "附件清理并发预算无效。",
          400,
        );
      await persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(session.workspaceId);
        const task = await scoped.queryOne(
          `select t.id from public.code_ui_sessions t
          join public.projects p on p.id = t.project_id and p.workspace_id = t.workspace_id
          where t.workspace_id = :workspace and p.workspace_id = :workspace and t.id = $1 and t.project_id = $2
            and t.parent_session_id is null and t.scope_generation = $3 and t.execution_state = 'revoking'
            and t.deleted_at is null and p.kind = 'code' for update of t`,
          [session.taskId, session.projectId, expectedScopeGeneration],
        );
        if (!task)
          throw new CodeAttachmentError(
            "fault.attachment.staleTask",
            "Task 未关闭执行资源或清理代际已改变。",
          );
        for (;;) {
          requireHostLease();
          const rows = await scoped.query<AttachmentRow>(
            `select record from public.code_attachments
            where workspace_id = :workspace and project_id = $1 and task_id = $2 and status = 'committed'
            order by upload_key limit $3 for update`,
            [session.projectId, session.taskId, batchSize],
          );
          if (!rows.length) break;
          const records = rows.flatMap((row) =>
            row.record.status === "committed" ? [row.record] : [],
          );
          if (records.length !== rows.length)
            throw new CodeAttachmentError(
              "fault.attachment.corruptMetadata",
              "附件事实状态不一致，拒绝清理。",
            );
          await remove(records);
          requireHostLease();
          await scoped.execute(
            `update public.code_attachments set status = 'aborted', connection_id = null, runtime_id = null,
            record = ${TOMBSTONE_RECORD} where workspace_id = :workspace and task_id = $1 and upload_key = any($2::text[])`,
            [session.taskId, records.map((record) => record.key)],
          );
        }
        await scoped.execute(
          `update public.code_attachments set status = 'aborted', connection_id = null, runtime_id = null,
          record = ${TOMBSTONE_RECORD} where workspace_id = :workspace and task_id = $1 and status = 'staging'`,
          [session.taskId],
        );
        requireHostLease();
      });
    },
  };
}
