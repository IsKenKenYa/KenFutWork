import type { GenerationFileTarget } from "@kenfutwork/shared";
import { assertGenerationOriginForInsert } from "../generation/file-target-lock.js";
import type { PersistenceService } from "../persistence/types.js";

export class JobRequestConflictError extends Error {
  constructor() {
    super("同一请求标识已用于其他生成参数，请重新提交。");
    this.name = "JobRequestConflictError";
  }
}

export type BackgroundJobRecord = {
  requestReplay?: boolean;
  id: string;
  instance_id: string;
  file_target?: GenerationFileTarget | null;
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
  created_by_client_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  canceled_at: string | null;
};

export type NewJobInput = {
  fileTarget: GenerationFileTarget;
  canvasId?: string | undefined;
  jobType: string;
  payload: Record<string, unknown>;
  projectId?: string | undefined;
  queueName: string;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  createdByClientId: string | null;
  instanceId: string;
};

export type JobListFilters = {
  requestId?: string;
  jobType?: string | undefined;
  status?: string | undefined;
};

/**
 * jobs 聚合的数据访问（`background_jobs`，带 `instance_id`）。
 *
 * 两种口径：
 * - **本机路径**（create/get/list/cancel）：经 `forInstance` 施加谓词。
 * - **worker/executor 路径**（按 id 改状态、累加尝试次数）：任务由 PGMQ 消息驱动，
 *   消息里只有 job id，没有接入客户端身份，故按 id 走根客户端——这是系统级取数，
 *   与「实例隔离」不冲突（拿不到实例就无法用实例谓词）。
 */
export interface JobRepository {
  takeWakeups(
    queues: readonly string[],
    seconds: number,
  ): Promise<BackgroundJobRecord[]>;
  schedule(
    jobId: string,
    seconds: number,
    leaseToken?: string,
  ): Promise<number>;
  claim(
    jobId: string,
    token: string,
    seconds: number,
  ): Promise<BackgroundJobRecord | null>;
  renewLease(jobId: string, token: string, seconds: number): Promise<number>;
  releaseLease(jobId: string, token: string): Promise<number>;
  cancel(
    instanceId: string,
    jobId: string,
  ): Promise<BackgroundJobRecord | null>;
  /** 进行中任务数（queued/running）——本机资源治理与停机等待可消费。 */
  countActive(instanceId: string): Promise<number>;
  delete(instanceId: string, jobId: string): Promise<number>;
  findById(jobId: string): Promise<BackgroundJobRecord | null>;
  findByIdInInstance(
    instanceId: string,
    jobId: string,
  ): Promise<BackgroundJobRecord | null>;
  incrementAttempt(
    jobId: string,
    leaseToken?: string,
  ): Promise<{ attempt_count: number; max_attempts: number }>;
  insert(input: NewJobInput): Promise<BackgroundJobRecord | null>;
  listForInstance(
    instanceId: string,
    filters: JobListFilters,
  ): Promise<BackgroundJobRecord[]>;
  markDeadLetter(
    jobId: string,
    errorCode: string,
    errorMessage: string,
    leaseToken?: string,
  ): Promise<number>;
  markFailed(
    jobId: string,
    errorCode: string,
    errorMessage: string,
    leaseToken?: string,
  ): Promise<number>;
  markRunning(jobId: string): Promise<number>;
  markSucceeded(
    jobId: string,
    result: Record<string, unknown>,
    leaseToken?: string,
  ): Promise<number>;
  /** submit 成功后落外部厂商任务引用（崩溃恢复：重启后据此续 poll）。 */
  setProviderJobId(
    jobId: string,
    providerJobId: string,
    leaseToken?: string,
  ): Promise<number>;
  /** 任务执行上下文补充（如 provider_config_revision）：浅合并进 payload。 */
  appendJobPayload(
    jobId: string,
    fields: Record<string, unknown>,
    leaseToken?: string,
  ): Promise<number>;
}

const JOB_COLUMNS =
  "id, instance_id, project_id, canvas_id, session_id, thread_id, file_target, queue_name, job_type, status, payload, result, error_code, error_message, attempt_count, max_attempts, provider_job_id, created_by_client_id, created_at, updated_at, started_at, completed_at, failed_at, canceled_at";

// 未认领的系统操作仅能写未持租约行；持租约消费方必须同时匹配token及有效期。
function leaseGuard(parameter: number) {
  return `and ((lease_token is null and $${parameter}::uuid is null)
    or (lease_token=$${parameter}::uuid and lease_until>now()))`;
}

const LIST_LIMIT = 50;

type AttemptRow = { attempt_count: number; max_attempts: number | null };

export function createJobRepository(
  persistence: PersistenceService,
): JobRepository {
  return {
    async takeWakeups(queues, seconds) {
      // 无上游句柄的在途提交无法判断是否已受理，不能靠补投重发付费请求。
      await persistence.execute(
        `update public.background_jobs set status='failed',error_code='submission_unknown',
          error_message='提交结果待确认，请核对供应商记录。'
         where queue_name=any($1::text[]) and status in ('running','failed')
           and provider_job_id is null and started_at is not null
           and (lease_until is null or lease_until<=now())
           and error_code is distinct from 'submission_unknown'`,
        [queues],
      );
      return persistence.query<BackgroundJobRecord>(
        `with ready as (
          select id from public.background_jobs
           where queue_name=any($1::text[]) and status in ('queued','running','failed')
             and error_code is distinct from 'submission_unknown'
             and (status='queued' or provider_job_id is not null)
             and next_action_at<=now() and wakeup_at<=now()
             and (lease_until is null or lease_until<=now())
           for update skip locked)
         update public.background_jobs j set wakeup_at=now()+$2*interval '1 second'
         from ready where j.id=ready.id returning j.*`,
        [queues, seconds],
      );
    },
    async schedule(jobId, seconds, leaseToken) {
      return persistence.execute(
        `update public.background_jobs
         set next_action_at=now()+$2*interval '1 second', wakeup_at=now()+$2*interval '1 second'
         where id=$1 and status in ('queued','running','failed') ${leaseGuard(3)}`,
        [jobId, seconds, leaseToken ?? null],
      );
    },
    async claim(jobId, token, seconds) {
      await persistence.execute(
        `update public.background_jobs set status='failed', error_code='submission_unknown',
          error_message='提交结果待确认，请核对供应商记录。'
         where id=$1 and status in ('running','failed') and provider_job_id is null
           and started_at is not null and (lease_until is null or lease_until<=now())`,
        [jobId],
      );
      return persistence.queryOne<BackgroundJobRecord>(
        `update public.background_jobs set lease_token=$2, lease_until=now()+$3*interval '1 second',
          status='running', started_at=coalesce(started_at,now())
         where id=$1 and status in ('queued','running','failed')
           and (lease_until is null or lease_until<=now())
           and next_action_at<=now() and error_code is distinct from 'submission_unknown'
           and (started_at is null or provider_job_id is not null) returning ${JOB_COLUMNS}`,
        [jobId, token, seconds],
      );
    },
    async renewLease(jobId, token, seconds) {
      return persistence.execute(
        `update public.background_jobs set lease_until=now()+$3*interval '1 second'
         where id=$1 and lease_token=$2 and lease_until>now() and status='running'`,
        [jobId, token, seconds],
      );
    },
    async releaseLease(jobId, token) {
      return persistence.execute(
        `update public.background_jobs set lease_token=null, lease_until=null where id=$1 and lease_token=$2`,
        [jobId, token],
      );
    },

    async insert(input) {
      return persistence.transaction(async (transaction) => {
        const scoped = transaction.forInstance(input.instanceId);
        if (typeof input.payload.request_id === "string") {
          await transaction.query(
            "select pg_advisory_xact_lock(hashtextextended($1,0))",
            [
              `${input.instanceId}:${input.payload.request_id}:${input.payload.request_index ?? 0}`,
            ],
          );
          const existing = await scoped.queryOne<BackgroundJobRecord>(
            `select ${JOB_COLUMNS} from public.background_jobs where instance_id=:instance
             and payload->>'request_id'=$1 and coalesce(payload->>'request_index','0')=$2`,
            [
              input.payload.request_id,
              String(input.payload.request_index ?? 0),
            ],
          );
          if (existing) {
            if (
              existing.payload?.request_fingerprint !==
              input.payload.request_fingerprint
            )
              throw new JobRequestConflictError();
            return { ...existing, requestReplay: true };
          }
        }
        await assertGenerationOriginForInsert(scoped, input.fileTarget, input);
        return scoped.queryOne<BackgroundJobRecord>(
          `insert into public.background_jobs
                (instance_id, project_id, canvas_id, session_id, thread_id,
                 queue_name, job_type, payload, created_by_client_id, file_target)
         values (:instance, $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
         returning ${JOB_COLUMNS}`,
          [
            input.projectId ?? null,
            input.canvasId ?? null,
            input.sessionId ?? null,
            input.threadId ?? null,
            input.queueName,
            input.jobType,
            JSON.stringify(input.payload),
            input.createdByClientId,
            JSON.stringify(input.fileTarget),
          ],
        );
      });
    },

    async findByIdInInstance(instanceId, jobId) {
      return persistence.forInstance(instanceId).queryOne<BackgroundJobRecord>(
        `select ${JOB_COLUMNS}
             from public.background_jobs
            where instance_id = :instance
              and id = $1`,
        [jobId],
      );
    },

    async listForInstance(instanceId, filters) {
      const params: unknown[] = [];
      let sql = `select ${JOB_COLUMNS}
                   from public.background_jobs
                  where instance_id = :instance`;

      if (filters.status) {
        params.push(filters.status);
        sql += ` and status = $${params.length}`;
      }
      if (filters.jobType) {
        params.push(filters.jobType);
        sql += ` and job_type = $${params.length}`;
      }

      if (filters.requestId) {
        params.push(filters.requestId);
        sql += ` and payload->>'request_id'=$${params.length}`;
      }
      sql += ` order by created_at desc${filters.requestId ? "" : ` limit ${LIST_LIMIT}`}`;

      return persistence
        .forInstance(instanceId)
        .query<BackgroundJobRecord>(sql, params);
    },

    async cancel(instanceId, jobId) {
      return persistence.forInstance(instanceId).queryOne<BackgroundJobRecord>(
        `update public.background_jobs
              set status = 'canceled',
                  canceled_at = now()
            where instance_id = :instance
              and id = $1
              and status in ('queued', 'running')
          returning ${JOB_COLUMNS}`,
        [jobId],
      );
    },

    async delete(instanceId, jobId) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.background_jobs
          where instance_id = :instance
            and id = $1`,
        [jobId],
      );
    },

    async countActive(instanceId) {
      // count(*) 是 bigint，显式转 int 避免驱动回字符串。
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ active: number }>(
          `select count(*)::int as active
             from public.background_jobs
            where instance_id = :instance
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

    async setProviderJobId(jobId, providerJobId, leaseToken) {
      return persistence.execute(
        `update public.background_jobs
            set provider_job_id = $2
          where id = $1 and status in ('queued','running') ${leaseGuard(3)}`,
        [jobId, providerJobId, leaseToken ?? null],
      );
    },

    async appendJobPayload(jobId, fields, leaseToken) {
      // jsonb || 浅合并：与既有 payload 字段并存，不整体替换
      return persistence.execute(
        `update public.background_jobs
            set payload = payload || $2::jsonb
          where id = $1 and status in ('queued','running') ${leaseGuard(3)}`,
        [jobId, JSON.stringify(fields), leaseToken ?? null],
      );
    },

    async markRunning(jobId) {
      return persistence.execute(
        `update public.background_jobs
            set status = 'running',
                started_at = now()
          where id = $1
            and status in ('queued', 'failed')`,
        [jobId],
      );
    },

    async markSucceeded(jobId, result, leaseToken) {
      return persistence.execute(
        `update public.background_jobs
            set status = 'succeeded',
                result = $2::jsonb,
                completed_at = now()
          where id = $1
            and status in ('queued', 'running', 'failed') ${leaseGuard(3)}`,
        [jobId, JSON.stringify(result), leaseToken ?? null],
      );
    },

    async markFailed(jobId, errorCode, errorMessage, leaseToken) {
      return persistence.execute(
        `update public.background_jobs
            set status = 'failed',
                error_code = $2,
                error_message = $3,
                failed_at = now()
          where id = $1
            and status in ('queued', 'running', 'failed') ${leaseGuard(4)}`,
        [jobId, errorCode, errorMessage, leaseToken ?? null],
      );
    },

    async markDeadLetter(jobId, errorCode, errorMessage, leaseToken) {
      return persistence.execute(
        `update public.background_jobs
            set status = 'dead_letter',
                error_code = $2,
                error_message = $3,
                failed_at = now()
          where id = $1
            and status in ('queued', 'running', 'failed') ${leaseGuard(4)}`,
        [jobId, errorCode, errorMessage, leaseToken ?? null],
      );
    },

    async incrementAttempt(jobId, leaseToken) {
      if (leaseToken) {
        const row = await persistence.queryOne<AttemptRow>(
          `update public.background_jobs set attempt_count=attempt_count+1
           where id=$1 and status='running' ${leaseGuard(2)} returning attempt_count,max_attempts`,
          [jobId, leaseToken],
        );
        if (!row)
          throw Object.assign(new Error("任务执行租约已失效"), {
            code: "job_lease_lost",
          });
        return {
          attempt_count: row.attempt_count,
          max_attempts: row.max_attempts ?? 3,
        };
      }
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
