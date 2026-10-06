import type {
  InstanceSqlClient,
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
const TOMBSTONE_RECORD = `jsonb_build_object('status', 'aborted', 'key', upload_key, 'instanceId', instance_id,
  'projectId', project_id, 'taskId', task_id, 'sessionId', session_id, 'createdByClientId', created_by_client_id)`;

async function writeAttachment(
  scoped: InstanceSqlClient,
  record: CodeAttachmentRecord,
  executionHostId: string,
  requireSameCommittedRecord = false,
) {
  return scoped.execute(
    `insert into public.code_attachments
    (instance_id, project_id, task_id, session_id, created_by_client_id, upload_key, status, execution_host_id, connection_id, runtime_id, record)
    values (:instance, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    on conflict (instance_id, upload_key) do update set status = excluded.status,
      connection_id = excluded.connection_id, runtime_id = excluded.runtime_id, record = excluded.record
    where not $11::boolean or (
      code_attachments.status = 'committed'
      and code_attachments.project_id = excluded.project_id
      and code_attachments.task_id = excluded.task_id
      and code_attachments.session_id = excluded.session_id
      and code_attachments.created_by_client_id is not distinct from excluded.created_by_client_id
      and code_attachments.connection_id is null and code_attachments.runtime_id is null
      and code_attachments.record = excluded.record
    )`,
    [
      record.projectId,
      record.taskId,
      record.sessionId,
      record.createdByClientId,
      record.key,
      record.status,
      executionHostId,
      record.status === "staging" ? record.connectionId : null,
      record.status === "staging" ? record.runtimeId : null,
      JSON.stringify(record),
      requireSameCommittedRecord,
    ],
  );
}

function assertHistoryCopyIdentity(
  target: CodeAttachmentSession,
  record: Extract<CodeAttachmentRecord, { status: "committed" }>,
) {
  if (
    record.status !== "committed" ||
    record.instanceId !== target.instanceId ||
    record.projectId !== target.projectId ||
    record.taskId !== target.taskId ||
    record.sessionId !== target.sessionId ||
    record.createdByClientId !== target.createdByClientId ||
    record.scopeGeneration !== target.scopeGeneration ||
    record.branchGeneration !== target.branchGeneration ||
    record.revision !== target.revision ||
    record.canUpload !== target.canUpload ||
    !/^[0-9a-f]{64}$/.test(record.key) ||
    record.ref !== `code-attachment:${record.key}` ||
    record.objectPath !==
      `${target.instanceId}/${target.projectId}/${target.taskId}/${record.key}`
  )
    throw new CodeAttachmentError(
      "fault.attachment.notAuthorized",
      "历史附件副本的身份、授权代际或私有对象路径不匹配目标 Task。",
      404,
    );
}

export function abortedAttachment(
  record: CodeAttachmentRecord,
): Extract<CodeAttachmentRecord, { status: "aborted" }> {
  return {
    status: "aborted",
    key: record.key,
    instanceId: record.instanceId,
    projectId: record.projectId,
    taskId: record.taskId,
    sessionId: record.sessionId,
    createdByClientId: record.createdByClientId,
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
  async function assertHistoryTarget(
    scoped: InstanceSqlClient,
    target: CodeAttachmentSession,
  ) {
    requireHostLease();
    if (
      scoped.instanceId !== target.instanceId ||
      target.sessionId !== target.taskId
    )
      throw new CodeAttachmentError(
        "fault.attachment.notAuthorized",
        "历史附件只能关联当前实例内的目标根 Task。",
        404,
      );
    const task = await scoped.queryOne(
      `select t.id from public.code_ui_sessions t
      join public.projects p on p.id = t.project_id and p.instance_id = t.instance_id
      join public.chat_sessions c on c.id = t.chat_session_id and c.instance_id = t.instance_id and c.project_id = t.project_id
      where t.instance_id = :instance and p.instance_id = :instance and c.instance_id = :instance
        and t.id = $1 and t.project_id = $2 and t.root_session_id = t.id and t.chat_session_id = t.id
        and t.parent_session_id is null and t.deleted_at is null and t.archived = false and t.state is not null
        and t.execution_state = 'ready' and t.scope_generation = $3 and t.branch_generation = $4
        and p.kind = 'code' and p.archived_at is null and c.mode = 'code'
        and c.created_by_client_id is not distinct from $5::uuid for update of t, p, c`,
      [
        target.taskId,
        target.projectId,
        target.scopeGeneration,
        target.branchGeneration,
        target.createdByClientId,
      ],
    );
    requireHostLease();
    if (!target.canUpload || !task)
      throw new CodeAttachmentError(
        "fault.attachment.staleTask",
        "目标 Task 已关闭、归档或授权代际改变，历史附件未发表。",
      );
  }
  return {
    async publishHistoryCopies(scoped, target, records) {
      await assertHistoryTarget(scoped, target);
      for (const record of records) {
        requireHostLease();
        assertHistoryCopyIdentity(target, record);
        // 与普通上传使用同一锁键；复用原创建事务，不另开事务或读取父附件。
        await scoped.query(
          "select pg_advisory_xact_lock(hashtextextended(:instance::text || '/code-attachment/' || $1, 0))",
          [record.key],
        );
        requireHostLease();
        const saved = await writeAttachment(
          scoped,
          record,
          executionHostId,
          true,
        );
        requireHostLease();
        if (saved !== 1)
          throw new CodeAttachmentError(
            "fault.attachment.uploadConflict",
            "历史附件键已存在不同事实或中断墓碑，拒绝覆盖。",
          );
      }
      requireHostLease();
    },
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
        record = jsonb_build_object('status', 'aborted', 'key', upload_key, 'instanceId', instance_id,
          'projectId', project_id, 'taskId', task_id, 'sessionId', session_id, 'createdByClientId', created_by_client_id)
        where execution_host_id = $1 and status = 'staging' and runtime_id <> $2`,
        [executionHostId, runtimeId],
      );
    },
    async transact(session, key, operation) {
      requireHostLease();
      return persistence.transaction(async (tx) => {
        const scoped = tx.forInstance(session.instanceId);
        // 固定散列种子属于 SQL 锁算法，不是运行时限额。
        await scoped.query(
          "select pg_advisory_xact_lock(hashtextextended(:instance::text || '/code-attachment/' || $1, 0))",
          [key],
        );
        const row = await scoped.queryOne<AttachmentRow>(
          "select record from public.code_attachments where instance_id = :instance and upload_key = $1 for update",
          [key],
        );
        if (
          row &&
          (row.record.projectId !== session.projectId ||
            row.record.taskId !== session.taskId ||
            row.record.sessionId !== session.sessionId)
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
              join public.code_ui_sessions s on s.root_session_id = t.id and s.instance_id = t.instance_id
              join public.projects p on p.id = t.project_id and p.instance_id = t.instance_id
              where t.instance_id = :instance and s.instance_id = :instance and p.instance_id = :instance
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
              record.instanceId !== session.instanceId ||
              record.projectId !== session.projectId ||
              record.taskId !== session.taskId ||
              record.sessionId !== session.sessionId
            )
              throw new CodeAttachmentError(
                "fault.attachment.notAuthorized",
                "附件持久身份不匹配。",
                404,
              );
            await writeAttachment(scoped, record, executionHostId);
            if (record.status !== "aborted") requireHostLease();
          },
        });
      });
    },
    async findCommitted(session, ref) {
      const row = await persistence
        .forInstance(session.instanceId)
        .queryOne<AttachmentRow>(
          `select record from public.code_attachments where instance_id = :instance
          and project_id = $1 and task_id = $2 and session_id = $3 and status = 'committed' and record->>'ref' = $4`,
          [session.projectId, session.taskId, session.sessionId, ref],
        );
      return row?.record.status === "committed" ? row.record : null;
    },
    async abortConnection(instanceId, connectionId, runtimeId) {
      await persistence.forInstance(instanceId).execute(
        `update public.code_attachments set status = 'aborted', connection_id = null, runtime_id = null,
        record = jsonb_build_object('status', 'aborted', 'key', upload_key, 'instanceId', instance_id,
          'projectId', project_id, 'taskId', task_id, 'sessionId', session_id, 'createdByClientId', created_by_client_id)
        where instance_id = :instance and execution_host_id = $1 and connection_id = $2 and runtime_id = $3 and status = 'staging'`,
        [executionHostId, connectionId, runtimeId],
      );
    },
    async close() {
      const lease = hostLease;
      hostLease = null;
      await lease?.release();
    },
    async releaseTask(instanceId, taskId, runtimeId) {
      await persistence.forInstance(instanceId).execute(
        `update public.code_attachments set status = 'aborted', connection_id = null, runtime_id = null,
        record = ${TOMBSTONE_RECORD} where instance_id = :instance and task_id = $1 and execution_host_id = $2 and runtime_id = $3 and status = 'staging'`,
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
        const scoped = tx.forInstance(session.instanceId);
        const task = await scoped.queryOne(
          `select t.id from public.code_ui_sessions t
          join public.projects p on p.id = t.project_id and p.instance_id = t.instance_id
          where t.instance_id = :instance and p.instance_id = :instance and t.id = $1 and t.project_id = $2
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
            where instance_id = :instance and project_id = $1 and task_id = $2 and status = 'committed'
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
            record = ${TOMBSTONE_RECORD} where instance_id = :instance and task_id = $1 and upload_key = any($2::text[])`,
            [session.taskId, records.map((record) => record.key)],
          );
        }
        await scoped.execute(
          `update public.code_attachments set status = 'aborted', connection_id = null, runtime_id = null,
          record = ${TOMBSTONE_RECORD} where instance_id = :instance and task_id = $1 and status = 'staging'`,
          [session.taskId],
        );
        requireHostLease();
      });
    },
  };
}
