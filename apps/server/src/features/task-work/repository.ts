import { codeExecutionScopeSchema } from "@kenfutwork/shared";
import type { PersistenceService, SqlRow } from "../persistence/types.js";
import { TaskWorkError } from "./service.js";
import type {
  TaskWorkContext,
  TaskWorkHostLease,
  TaskWorkRecord,
  TaskWorkStore,
} from "./types.js";

type WorkRow = SqlRow & {
  id: string;
  scope: unknown;
  agent_id: string;
  kind: TaskWorkRecord["kind"];
  detached: boolean;
  label: string;
  origin_run_id: string;
  tool_call_id: string;
  child_session_id: string | null;
  branch_generation: string | number;
  status: TaskWorkRecord["status"];
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  output_ref: string | null;
  consumed_at: string | null;
  owner_id: string;
  execution_host_id: string;
  output_stats: TaskWorkRecord["outputStats"] | null;
  parameter_fingerprint: string;
};
function fromRow(row: WorkRow): TaskWorkRecord {
  return {
    id: row.id,
    scope: codeExecutionScopeSchema.parse(row.scope),
    agentId: row.agent_id,
    kind: row.kind,
    detached: row.detached,
    label: row.label,
    originRunId: row.origin_run_id,
    toolCallId: row.tool_call_id,
    ...(row.child_session_id ? { childSessionId: row.child_session_id } : {}),
    branchGeneration: Number(row.branch_generation),
    status: row.status,
    startedAt: row.started_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    ...(row.summary !== null ? { summary: row.summary } : {}),
    ...(row.output_ref !== null ? { outputRef: row.output_ref } : {}),
    consumed: row.consumed_at !== null,
    ...(row.output_stats ? { outputStats: row.output_stats } : {}),
    ownerId: row.owner_id,
    executionHostId: row.execution_host_id,
    parameterFingerprint: row.parameter_fingerprint,
  };
}

/** 此谓词也用于通知 admission，删除/归档/分支重绕的迟到工作不得唤醒模型。 */
const CURRENT_TASK = `select s.id from public.code_ui_sessions s
  join public.projects p on p.id = s.project_id and p.workspace_id = s.workspace_id
  where s.workspace_id = :workspace and p.workspace_id = :workspace
    and s.id = $1 and s.project_id = $2 and s.branch_generation = $3
    and ($5::boolean or s.scope_generation = $4) and s.execution_state = 'ready'
    and s.parent_session_id is null and s.deleted_at is null and s.archived = false
    and p.archived_at is null and p.kind = 'code'`;
const contextParams = (context: TaskWorkContext, notification = false) => [
  context.scope.taskId,
  context.scope.projectId,
  context.branchGeneration,
  context.scope.generation,
  notification,
];

export function createTaskWorkStore(
  persistence: PersistenceService,
): TaskWorkStore {
  const hosts = new Map<
    string,
    { ownerId: string; lease: TaskWorkHostLease }
  >();
  return {
    async acquireHost(executionHostId, ownerId) {
      const lock = await persistence.acquireSessionLock(
        `task-work:host:${executionHostId}`,
      );
      if (!lock) return null;
      const lease: TaskWorkHostLease = {
        signal: lock.signal,
        async release() {
          try {
            await lock.release();
          } finally {
            if (hosts.get(executionHostId)?.lease === lease)
              hosts.delete(executionHostId);
          }
        },
      };
      hosts.set(executionHostId, { ownerId, lease });
      return lease;
    },
    async closeFence(workspaceId, taskId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<
          SqlRow & {
            scope_generation: number | string;
            branch_generation: number | string;
            execution_state: "ready" | "revoking" | "failed";
          }
        >(
          "select scope_generation, branch_generation, execution_state from public.code_ui_sessions where workspace_id = :workspace and id = $1 and parent_session_id is null",
          [taskId],
        );
      return row
        ? {
            scopeGeneration: Number(row.scope_generation),
            branchGeneration: Number(row.branch_generation),
            state: row.execution_state,
          }
        : null;
    },
    async isCurrent(context, purpose) {
      return (
        (await persistence
          .forWorkspace(context.scope.workspaceId)
          .queryOne(
            CURRENT_TASK,
            contextParams(context, purpose === "notification"),
          )) !== null
      );
    },
    async create(record) {
      return persistence.transaction(async (transaction) => {
        const scoped = transaction.forWorkspace(record.scope.workspaceId);
        const context: TaskWorkContext = {
          scope: record.scope,
          agentId: record.agentId,
          runId: record.originRunId,
          branchGeneration: record.branchGeneration,
        };
        if (
          !(await scoped.queryOne(
            `${CURRENT_TASK} for update of s`,
            contextParams(context),
          ))
        )
          throw new TaskWorkError(
            "task_closed",
            "Task 的派发授权或分支代际已改变。",
          );
        const existing = await scoped.queryOne<WorkRow>(
          "select * from public.task_works where workspace_id = :workspace and task_id = $1 and branch_generation = $2 and origin_run_id = $3 and tool_call_id = $4",
          [
            record.scope.taskId,
            record.branchGeneration,
            record.originRunId,
            record.toolCallId,
          ],
        );
        if (existing) return { record: fromRow(existing), created: false };
        await scoped.execute(
          `insert into public.task_works
          (id, workspace_id, project_id, task_id, scope, agent_id, kind, label, origin_run_id, tool_call_id, child_session_id, branch_generation, status, started_at, owner_id, execution_host_id, parameter_fingerprint, detached, consumed_at)
          values ($1, :workspace, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, 'running', $12, $13, $14, $15, $16, $17)`,
          [
            record.id,
            record.scope.projectId,
            record.scope.taskId,
            JSON.stringify(record.scope),
            record.agentId,
            record.kind,
            record.label,
            record.originRunId,
            record.toolCallId,
            record.childSessionId ?? null,
            record.branchGeneration,
            record.startedAt,
            record.ownerId,
            record.executionHostId,
            record.parameterFingerprint,
            record.detached,
            record.consumed ? record.startedAt : null,
          ],
        );
        return { record, created: true };
      });
    },
    async find(workspaceId, taskId, workId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<WorkRow>(
          "select * from public.task_works where workspace_id = :workspace and task_id = $1 and id = $2",
          [taskId, workId],
        );
      return row ? fromRow(row) : null;
    },
    async list(workspaceId, taskId) {
      return (
        await persistence
          .forWorkspace(workspaceId)
          .query<WorkRow>(
            "select * from public.task_works where workspace_id = :workspace and task_id = $1 order by started_at, id",
            [taskId],
          )
      ).map(fromRow);
    },
    async settle(workspaceId, taskId, workId, outcome, at) {
      const row = await persistence.forWorkspace(workspaceId).queryOne<WorkRow>(
        `update public.task_works set status = $3, summary = $4, output_ref = coalesce($5, output_ref), ended_at = $6, output_stats = coalesce($7::jsonb, output_stats)
        where workspace_id = :workspace and task_id = $1 and id = $2 and status = 'running' returning *`,
        [
          taskId,
          workId,
          outcome.status,
          outcome.summary,
          outcome.outputRef ?? null,
          at,
          outcome.outputStats ? JSON.stringify(outcome.outputStats) : null,
        ],
      );
      return row ? fromRow(row) : null;
    },
    async consume(context) {
      return persistence.transaction(async (transaction) => {
        const scoped = transaction.forWorkspace(context.scope.workspaceId);
        if (
          !(await scoped.queryOne(
            `${CURRENT_TASK} for update of s`,
            contextParams(context),
          ))
        )
          return [];
        const rows = await scoped.query<WorkRow>(
          `update public.task_works set consumed_at = now(), consumed_by_run_id = $3
          where workspace_id = :workspace and task_id = $1 and branch_generation = $2
            and detached = true and status <> 'running' and consumed_at is null returning *`,
          [context.scope.taskId, context.branchGeneration, context.runId],
        );
        return rows
          .map(fromRow)
          .sort(
            (left, right) =>
              (left.endedAt ?? "").localeCompare(right.endedAt ?? "") ||
              left.id.localeCompare(right.id),
          );
      });
    },
    async interruptHost(executionHostId, ownerId, at) {
      // 启动期执行宿主的跨租户恢复；仅该宿主的旧 owner 记录，无任意 Task 输入。
      const host = hosts.get(executionHostId);
      if (!host || host.ownerId !== ownerId || host.lease.signal.aborted)
        throw new TaskWorkError(
          "execution_host_lost",
          "未持有执行宿主的独占会话，拒绝恢复旧 owner。",
        );
      const rows = await persistence.query<WorkRow>(
        `update public.task_works set
        status = case when status = 'running' then 'interrupted' else status end,
        ended_at = case when status = 'running' then $3 else ended_at end,
        consumed_at = coalesce(consumed_at, $3),
        summary = case when status = 'running' then '执行宿主重启，后台工作已中断；保留输出，不自动重放。' else summary end
        where execution_host_id = $1 and owner_id <> $2 and (status = 'running' or consumed_at is null) returning *`,
        [executionHostId, ownerId, at],
      );
      return rows.map(fromRow);
    },
    async updateOutput(workspaceId, taskId, workId, ownerId, outputRef, stats) {
      await persistence.forWorkspace(workspaceId).execute(
        `update public.task_works set output_ref = $4, output_stats = $5::jsonb
        where workspace_id = :workspace and task_id = $1 and id = $2 and owner_id = $3 and status = 'running'`,
        [taskId, workId, ownerId, outputRef, JSON.stringify(stats)],
      );
    },
  };
}
