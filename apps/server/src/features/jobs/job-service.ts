import { createHash } from "node:crypto";
import type {
  BackgroundJob,
  BackgroundJobStatus,
  BackgroundJobType,
} from "@kenfutwork/shared";
import {
  GenerationTargetError,
  type GenerationTargets,
} from "../generation/file-targets.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { QueueClient } from "../queue/types.js";
import type { UploadService } from "../uploads/upload-service.js";
import { JobInputError, persistJobInputs } from "./job-inputs.js";
import type {
  JobExecution,
  JobExecutionWrite,
  JobRetry,
} from "./job-progress.js";
import {
  type BackgroundJobRecord,
  type JobRepository,
  JobRequestConflictError,
} from "./repository.js";

// Queue name mapping
const QUEUE_MAP: Record<BackgroundJobType, string> = {
  image_generation: "image_generation_jobs",
  video_generation: "video_generation_jobs",
};

export class JobServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "job_not_found"
    | "job_create_failed"
    | "job_query_failed"
    | "job_cancel_failed"
    | "job_request_conflict";

  constructor(
    code: JobServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "JobServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 实例归属由本地服务验证（`FORM-9`），故不由调用方传入。 */
export type CreateJobInput = {
  requestId?: string;
  requestIndex?: number;
  /** Only the authenticated HTTP consumer sets this; never a request/tool schema field. */
  interactiveRequest?: true;
  expectedScopeGeneration?: number;
  expectedBranchGeneration?: number;
  projectId?: string;
  canvasId?: string;
  sessionId?: string;
  threadId?: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
};

export type JobService = {
  retryJob(jobId: string, input: JobRetry, token: string): Promise<void>;
  markUncertain(jobId: string, message: string, token: string): Promise<void>;
  saveExecution(
    jobId: string,
    execution: JobExecution,
    options?: JobExecutionWrite,
  ): Promise<void>;
  recoverPendingJobs(
    queues: readonly string[],
    intervalSeconds: number,
  ): Promise<void>;
  scheduleJob(
    jobId: string,
    seconds: number,
    leaseToken?: string,
  ): Promise<void>;
  claimJob(
    jobId: string,
    token: string,
    seconds: number,
  ): Promise<BackgroundJob | null>;
  renewLease(jobId: string, token: string, seconds: number): Promise<boolean>;
  releaseLease(jobId: string, token: string): Promise<void>;
  createJob(actor: LocalActor, input: CreateJobInput): Promise<BackgroundJob>;
  getJob(actor: LocalActor, jobId: string): Promise<BackgroundJob>;
  listJobs(
    actor: LocalActor,
    filters?: {
      status?: BackgroundJobStatus;
      jobType?: BackgroundJobType;
      requestId?: string;
    },
  ): Promise<BackgroundJob[]>;
  cancelJob(actor: LocalActor, jobId: string): Promise<BackgroundJob>;
  getJobForWorker(jobId: string): Promise<BackgroundJob>;

  // Worker 状态迁移不依赖接入客户端。
  markRunning(jobId: string): Promise<void>;
  markSucceeded(
    jobId: string,
    result: Record<string, unknown>,
    leaseToken?: string,
  ): Promise<void>;
  markFailed(
    jobId: string,
    errorCode: string,
    errorMessage: string,
    leaseToken?: string,
  ): Promise<void>;
  markDeadLetter(
    jobId: string,
    errorCode: string,
    errorMessage: string,
    leaseToken?: string,
    partialResult?: Record<string, unknown>,
  ): Promise<void>;
  /** submit 成功后落外部厂商任务引用（崩溃恢复：重启后据此续 poll）。 */
  setProviderJobId(
    jobId: string,
    providerJobId: string,
    leaseToken?: string,
  ): Promise<void>;
  /** 任务执行上下文补充（浅合并进 payload），如 submit 时的实例修订号。 */
  appendJobPayload(
    jobId: string,
    fields: Record<string, unknown>,
    leaseToken?: string,
  ): Promise<void>;
  incrementAttempt(
    jobId: string,
    leaseToken?: string,
  ): Promise<{ attempt_count: number; max_attempts: number }>;
};

function requestFingerprint(input: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}

function mapJobRow(row: BackgroundJobRecord): BackgroundJob {
  return {
    id: row.id,
    instance_id: row.instance_id,
    file_target: row.file_target ?? null,
    project_id: row.project_id ?? null,
    canvas_id: row.canvas_id ?? null,
    session_id: row.session_id ?? null,
    thread_id: row.thread_id ?? null,
    queue_name: row.queue_name,
    job_type: row.job_type as BackgroundJob["job_type"],
    status: row.status as BackgroundJob["status"],
    payload: row.payload ?? {},
    result: row.result ?? null,
    error_code: row.error_code ?? null,
    error_message: row.error_message ?? null,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    provider_job_id: row.provider_job_id ?? null,
    created_by_client_id: row.created_by_client_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    failed_at: row.failed_at ?? null,
    canceled_at: row.canceled_at ?? null,
  };
}

function assertLeaseWrite(count: number, token?: string) {
  if (token && count === 0)
    throw Object.assign(new Error("任务执行租约已失效"), {
      code: "job_lease_lost",
    });
}

export function createJobService(options: {
  /** 队列缝（M3.2）：投递与消费，Provider 随形态替换。 */
  queue: QueueClient;
  uploads?: UploadService;
  generationTargets?: GenerationTargets;
  repository: JobRepository;
  /**
   * 接入路径（建/查/列/取消）需要它验证实例归属；worker 进程只走按 id 的
   * 状态迁移路径，可缺省。缺省时接入方法**立即 fail loud**。
   */
  localInstance?: LocalInstanceService | undefined;
}): JobService {
  const { queue, repository } = options;

  function requireLocalInstance(): LocalInstanceService {
    if (!options.localInstance) {
      throw new JobServiceError(
        "job_query_failed",
        "本机任务操作需要 LocalInstanceService（worker 进程不提供）。",
        500,
      );
    }
    return options.localInstance;
  }

  /** 实例 id 一律由服务端验证（`FORM-9`）。 */
  async function requireInstanceId(
    actor: LocalActor,
    errorCode: JobServiceError["code"],
  ): Promise<string> {
    const workspace = await requireLocalInstance()
      .resolve(actor)
      .catch(() => null);

    if (!workspace) {
      throw new JobServiceError(errorCode, "无法解析任务所属本地实例。", 500);
    }

    return workspace.instanceId;
  }

  return {
    async retryJob(jobId, input, token) {
      assertLeaseWrite(await repository.retry(jobId, input, token), token);
      const job = await repository.findById(jobId);
      if (!job) return;
      try {
        await queue.send(
          job.queue_name,
          { job_id: jobId, job_type: job.job_type },
          input.delaySeconds,
        );
      } catch (error) {
        console.error("[job-service] retry wakeup failed:", error);
      }
    },
    async markUncertain(jobId, message, token) {
      assertLeaseWrite(
        await repository.markUncertain(jobId, message, token),
        token,
      );
    },
    async saveExecution(jobId, execution, write = {}) {
      assertLeaseWrite(
        await repository.saveExecution(jobId, execution, write),
        write.leaseToken,
      );
    },
    async recoverPendingJobs(queues, intervalSeconds) {
      const ready = await repository.takeWakeups(queues, intervalSeconds);
      await Promise.all(
        ready.map(async (job) => {
          try {
            await queue.send(job.queue_name, {
              job_id: job.id,
              job_type: job.job_type,
            });
          } catch (error) {
            console.error("[job-service] recovery wakeup failed:", error);
          }
        }),
      );
    },
    async scheduleJob(jobId, seconds, leaseToken) {
      assertLeaseWrite(
        await repository.schedule(jobId, seconds, leaseToken),
        leaseToken,
      );
      const job = await repository.findById(jobId);
      if (!job) return;
      try {
        await queue.send(
          job.queue_name,
          { job_id: jobId, job_type: job.job_type },
          seconds,
        );
      } catch (error) {
        console.error("[job-service] scheduled wakeup failed:", error);
      }
    },
    async claimJob(jobId, token, seconds) {
      const row = await repository.claim(jobId, token, seconds);
      return row ? mapJobRow(row) : null;
    },
    async renewLease(jobId, token, seconds) {
      return (await repository.renewLease(jobId, token, seconds)) > 0;
    },
    async releaseLease(jobId, token) {
      await repository.releaseLease(jobId, token);
    },
    async createJob(actor, input) {
      if ("_generation_execution" in input.payload)
        throw new JobServiceError(
          "job_create_failed",
          "生成执行记录由服务端维护。",
          400,
        );
      // 新请求在HTTP准入处认领；在途Run提交的生成工作仍须正常完成。
      const instanceId = await requireInstanceId(actor, "job_create_failed");
      const queueName = QUEUE_MAP[input.jobType];
      if (!options.generationTargets)
        throw new JobServiceError(
          "job_create_failed",
          "生成文件来源服务未装配",
          500,
        );
      const fileTarget = await options.generationTargets
        .prepareOrigin({
          actor,
          ...input,
        })
        .catch((error: unknown) => {
          if (error instanceof GenerationTargetError)
            throw new JobServiceError(
              "job_create_failed",
              error.message,
              error.statusCode,
            );
          throw error;
        });

      const { requestId, requestIndex, ...request } = input;
      const fingerprint = requestId
        ? requestFingerprint({ ...request, fileTarget })
        : undefined;
      if (requestId) {
        const existing = (
          await repository.listForInstance(instanceId, { requestId })
        ).find(
          (row) =>
            Number(row.payload?.request_index ?? 0) === (requestIndex ?? 0),
        );
        if (existing) {
          if (existing.payload?.request_fingerprint !== fingerprint)
            throw new JobServiceError(
              "job_request_conflict",
              "同一请求标识已用于其他生成参数，请重新提交。",
              409,
            );
          return mapJobRow(existing);
        }
      }
      const storedInputs = await persistJobInputs(
        actor,
        input.payload,
        options.uploads,
        input.projectId,
      ).catch((error: unknown) => {
        if (error instanceof JobInputError)
          throw new JobServiceError("job_create_failed", error.message, 400);
        throw error;
      });
      const job = await repository
        .insert({
          ...(input.canvasId ? { canvasId: input.canvasId } : {}),
          fileTarget,
          jobType: input.jobType,
          payload: requestId
            ? {
                ...storedInputs.payload,
                _generation_execution: { phase: "ready" },
                request_id: requestId,
                request_index: requestIndex ?? 0,
                request_fingerprint: fingerprint,
              }
            : {
                ...storedInputs.payload,
                _generation_execution: { phase: "ready" },
              },
          ...(input.projectId ? { projectId: input.projectId } : {}),
          queueName,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          createdByClientId: actor.accessClientId,
          instanceId,
        })
        .catch(async (error: unknown) => {
          if (error instanceof JobRequestConflictError) {
            await storedInputs.discard();
            throw new JobServiceError(
              "job_request_conflict",
              error.message,
              409,
            );
          }
          if (error instanceof GenerationTargetError) {
            await storedInputs.discard();
            throw new JobServiceError(
              "job_create_failed",
              error.message,
              error.statusCode,
            );
          }
          // 回执不明时保留可能已被持久Job引用的输入，不能先删除字节。
          return null;
        });

      if (!job) {
        throw new JobServiceError(
          "job_create_failed",
          "Failed to create job record.",
          500,
        );
      }

      if (job.requestReplay) {
        await storedInputs.discard();
        return mapJobRow(job);
      }

      // Job已经持久受理。队列故障保留回执，由启动/周期扫描补投。
      try {
        await queue.send(queueName, {
          job_id: job.id,
          job_type: input.jobType,
          instance_id: instanceId,
          ...(input.canvasId ? { canvas_id: input.canvasId } : {}),
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
        });
      } catch (error) {
        console.error("[job-service] initial wakeup failed:", error);
      }

      return mapJobRow(job);
    },

    async getJob(actor, jobId) {
      const instanceId = await requireInstanceId(actor, "job_query_failed");

      const job = await repository
        .findByIdInInstance(instanceId, jobId)
        .catch(() => {
          throw new JobServiceError(
            "job_query_failed",
            "Failed to query job.",
            500,
          );
        });

      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return mapJobRow(job);
    },

    async listJobs(actor, filters) {
      const instanceId = await requireInstanceId(actor, "job_query_failed");

      const jobs = await repository
        .listForInstance(instanceId, {
          ...(filters?.jobType ? { jobType: filters.jobType } : {}),
          ...(filters?.status ? { status: filters.status } : {}),
          ...(filters?.requestId ? { requestId: filters.requestId } : {}),
        })
        .catch(() => {
          throw new JobServiceError(
            "job_query_failed",
            "Failed to list jobs.",
            500,
          );
        });

      return jobs.map(mapJobRow);
    },

    async cancelJob(actor, jobId) {
      const instanceId = await requireInstanceId(actor, "job_cancel_failed");

      const job = await repository.cancel(instanceId, jobId).catch(() => {
        throw new JobServiceError(
          "job_cancel_failed",
          "Failed to cancel job.",
          500,
        );
      });

      if (!job) {
        throw new JobServiceError(
          "job_not_found",
          "Job not found or already completed.",
          404,
        );
      }
      return mapJobRow(job);
    },

    async getJobForWorker(jobId) {
      const job = await repository.findById(jobId).catch(() => {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job.",
          500,
        );
      });

      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return mapJobRow(job);
    },

    async markRunning(jobId) {
      await repository.markRunning(jobId).catch(() => 0);
    },

    async markSucceeded(jobId, result, leaseToken) {
      assertLeaseWrite(
        await repository.markSucceeded(jobId, result, leaseToken),
        leaseToken,
      );
    },
    async markFailed(jobId, errorCode, errorMessage, leaseToken) {
      assertLeaseWrite(
        await repository.markFailed(jobId, errorCode, errorMessage, leaseToken),
        leaseToken,
      );
    },
    async markDeadLetter(
      jobId,
      errorCode,
      errorMessage,
      leaseToken,
      partialResult,
    ) {
      assertLeaseWrite(
        await repository.markDeadLetter(
          jobId,
          errorCode,
          errorMessage,
          leaseToken,
          partialResult,
        ),
        leaseToken,
      );
    },
    async setProviderJobId(jobId, providerJobId, leaseToken) {
      assertLeaseWrite(
        await repository.setProviderJobId(jobId, providerJobId, leaseToken),
        leaseToken,
      );
    },
    async appendJobPayload(jobId, fields, leaseToken) {
      assertLeaseWrite(
        await repository.appendJobPayload(jobId, fields, leaseToken),
        leaseToken,
      );
    },

    async incrementAttempt(jobId, leaseToken) {
      if (leaseToken) return repository.incrementAttempt(jobId, leaseToken);
      return repository.incrementAttempt(jobId).catch((error: unknown) => {
        console.error(
          "[job-service] increment_job_attempt failed:",
          error instanceof Error ? error.message : error,
        );
        // 累加失败返回安全默认值（与旧行为一致：不阻断任务处理）
        return { attempt_count: 1, max_attempts: 3 };
      });
    },
  };
}
