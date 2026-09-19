import type { PersistenceService } from "../persistence/types.js";

export type BackgroundJobRecord = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  canvas_id: string | null;
  session_id: string | null;
  thread_id: string | null;
  queue_name: string;
  job_type: string;
  status: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  max_attempts: number;
  provider_job_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  canceled_at: string | null;
};

export type NewJobInput = {
  canvasId?: string | undefined;
  jobType: string;
  payload: Record<string, unknown>;
  projectId?: string | undefined;
  queueName: string;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  userId: string;
  workspaceId: string;
};

export type JobListFilters = {
  jobType?: string | undefined;
  status?: string | undefined;
};

/** 死信退款所需的最小字段（`credits_cost` 不在对外契约里，故单独取）。 */
export type JobCreditsInfo = {
  creditsCost: number;
  createdBy: string | null;
  workspaceId: string | null;
};

/**
 * jobs 聚合的数据访问（`background_jobs`，带 `workspace_id`）。
 *
 * 两种口径：
 * - **用户路径**（create/get/list/cancel）：经 `forWorkspace` 施加谓词。
 * - **worker/executor 路径**（按 id 改状态、累加尝试次数）：任务由 PGMQ 消息驱动，
 *   消息里只有 job id，没有用户身份，故按 id 走根客户端——这是系统级取数，
 *   与「工作区隔离」不冲突（拿不到工作区就无法用工作区谓词）。
 */
export interface JobRepository {
  cancel(
    workspaceId: string,
    jobId: string,
  ): Promise<BackgroundJobRecord | null>;
  /** 进行中任务数（queued/running）——套餐并发上限检查用（tierGuard 只读消费）。 */
  countActive(workspaceId: string): Promise<number>;
  delete(workspaceId: string, jobId: string): Promise<number>;
  findById(jobId: string): Promise<BackgroundJobRecord | null>;
  /**
   * 扣费信息（`credits_cost`/`workspace_id`/`created_by`）——死信自动退款用。
   * `credits_cost` 不在对外 job 契约里，故单独取最小字段而不是复用 `findById`。
   */
  findCreditsInfo(jobId: string): Promise<JobCreditsInfo | null>;
  findByIdInWorkspace(
    workspaceId: string,
    jobId: string,
  ): Promise<BackgroundJobRecord | null>;
  incrementAttempt(
    jobId: string,
  ): Promise<{ attempt_count: number; max_attempts: number }>;
  insert(input: NewJobInput): Promise<BackgroundJobRecord | null>;
  listByCreator(
    workspaceId: string,
    userId: string,
    filters: JobListFilters,
  ): Promise<BackgroundJobRecord[]>;
  markDeadLetter(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<number>;
  markFailed(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<number>;
  markRunning(jobId: string): Promise<number>;
  markSucceeded(
    jobId: string,
    result: Record<string, unknown>,
  ): Promise<number>;
  setCreditsInfo(
    jobId: string,
    creditsCost: number,
    transactionId: string,
  ): Promise<number>;
  /** submit 成功后落外部厂商任务引用（崩溃恢复：重启后据此续 poll）。 */
  setProviderJobId(jobId: string, providerJobId: string): Promise<number>;
  /** 任务执行上下文补充（如 provider_config_revision）：浅合并进 payload。 */
  appendJobPayload(
    jobId: string,
    fields: Record<string, unknown>,
  ): Promise<number>;
}

const JOB_COLUMNS =
  "id, workspace_id, project_id, canvas_id, session_id, thread_id, queue_name, job_type, status, payload, result, error_code, error_message, attempt_count, max_attempts, provider_job_id, created_by, created_at, updated_at, started_at, completed_at, failed_at, canceled_at";

const LIST_LIMIT = 50;

type AttemptRow = { attempt_count: number; max_attempts: number | null };

export function createJobRepository(
  persistence: PersistenceService,
): JobRepository {
  return {
    async insert(input) {
      return persistence
        .forWorkspace(input.workspaceId)
        .queryOne<BackgroundJobRecord>(
          `insert into public.background_jobs
                (workspace_id, project_id, canvas_id, session_id, thread_id,
                 queue_name, job_type, payload, created_by)
         values (:workspace, $1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         returning ${JOB_COLUMNS}`,
          [
            input.projectId ?? null,
            input.canvasId ?? null,
            input.sessionId ?? null,
            input.threadId ?? null,
            input.queueName,
            input.jobType,
            JSON.stringify(input.payload),
            input.userId,
          ],
        );
    },

    async findByIdInWorkspace(workspaceId, jobId) {
      return persistence
        .forWorkspace(workspaceId)
        .queryOne<BackgroundJobRecord>(
          `select ${JOB_COLUMNS}
             from public.background_jobs
            where workspace_id = :workspace
              and id = $1`,
          [jobId],
        );
    },

    async listByCreator(workspaceId, userId, filters) {
      const params: unknown[] = [userId];
      let sql = `select ${JOB_COLUMNS}
                   from public.background_jobs
                  where workspace_id = :workspace
                    and created_by = $1`;

      if (filters.status) {
        params.push(filters.status);
        sql += ` and status = $${params.length}`;
      }
      if (filters.jobType) {
        params.push(filters.jobType);
        sql += ` and job_type = $${params.length}`;
      }

      sql += ` order by created_at desc limit ${LIST_LIMIT}`;

      return persistence
        .forWorkspace(workspaceId)
        .query<BackgroundJobRecord>(sql, params);
    },

    async cancel(workspaceId, jobId) {
      return persistence
        .forWorkspace(workspaceId)
        .queryOne<BackgroundJobRecord>(
          `update public.background_jobs
              set status = 'canceled',
                  canceled_at = now()
            where workspace_id = :workspace
              and id = $1
              and status in ('queued', 'running')
          returning ${JOB_COLUMNS}`,
          [jobId],
        );
    },

    async delete(workspaceId, jobId) {
      return persistence.forWorkspace(workspaceId).execute(
        `delete from public.background_jobs
          where workspace_id = :workspace
            and id = $1`,
        [jobId],
      );
    },

    async countActive(workspaceId) {
      // count(*) 是 bigint，显式转 int 避免驱动回字符串。
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<{ active: number }>(
          `select count(*)::int as active
             from public.background_jobs
            where workspace_id = :workspace
              and status in ('queued', 'running')`,
        );
      return row?.active ?? 0;
    },

    async findById(jobId) {
      return persistence.queryOne<BackgroundJobRecord>(
        `select ${JOB_COLUMNS} from public.background_jobs where id = $1`,
        [jobId],
      );
    },

    async findCreditsInfo(jobId) {
      // worker 路径：消息里只有 job id，故按 id 走根客户端（同 findById 口径）
      const row = await persistence.queryOne<{
        created_by: string | null;
        credits_cost: number | null;
        workspace_id: string | null;
      }>(
        `select credits_cost, workspace_id, created_by
           from public.background_jobs
          where id = $1`,
        [jobId],
      );

      if (!row) {
        return null;
      }

      return {
        createdBy: row.created_by,
        creditsCost: row.credits_cost ?? 0,
        workspaceId: row.workspace_id,
      };
    },

    async setProviderJobId(jobId, providerJobId) {
      return persistence.execute(
        `update public.background_jobs
            set provider_job_id = $2
          where id = $1`,
        [jobId, providerJobId],
      );
    },

    async appendJobPayload(jobId, fields) {
      // jsonb || 浅合并：与既有 payload 字段并存，不整体替换
      return persistence.execute(
        `update public.background_jobs
            set payload = payload || $2::jsonb
          where id = $1`,
        [jobId, JSON.stringify(fields)],
      );
    },

    async setCreditsInfo(jobId, creditsCost, transactionId) {
      return persistence.execute(
        `update public.background_jobs
            set credits_cost = $2,
                credits_transaction_id = $3
          where id = $1`,
        [jobId, creditsCost, transactionId],
      );
    },

    async markRunning(jobId) {
      return persistence.execute(
        `update public.background_jobs
            set status = 'running',
                started_at = now()
          where id = $1
            and status = 'queued'`,
        [jobId],
      );
    },

    async markSucceeded(jobId, result) {
      return persistence.execute(
        `update public.background_jobs
            set status = 'succeeded',
                result = $2::jsonb,
                completed_at = now()
          where id = $1`,
        [jobId, JSON.stringify(result)],
      );
    },

    async markFailed(jobId, errorCode, errorMessage) {
      return persistence.execute(
        `update public.background_jobs
            set status = 'failed',
                error_code = $2,
                error_message = $3,
                failed_at = now()
          where id = $1`,
        [jobId, errorCode, errorMessage],
      );
    },

    async markDeadLetter(jobId, errorCode, errorMessage) {
      return persistence.execute(
        `update public.background_jobs
            set status = 'dead_letter',
                error_code = $2,
                error_message = $3,
                failed_at = now()
          where id = $1`,
        [jobId, errorCode, errorMessage],
      );
    },

    async incrementAttempt(jobId) {
      // 原子累加走库函数：并发重投不会丢计数（此前经 RPC，函数本身与身份无关）。
      const row = await persistence.queryOne<AttemptRow>(
        "select attempt_count, max_attempts from public.increment_job_attempt($1)",
        [jobId],
      );

      if (!row) {
        return { attempt_count: 1, max_attempts: 3 };
      }

      return {
        attempt_count: Number(row.attempt_count) || 1,
        max_attempts: Number(row.max_attempts ?? 3) || 3,
      };
    },
  };
}
