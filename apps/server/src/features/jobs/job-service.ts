import type {
  BackgroundJob,
  BackgroundJobStatus,
  BackgroundJobType,
} from "@kenfutwork/shared";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { QueueClient } from "../queue/types.js";
import type {
  BackgroundJobRecord,
  JobCreditsInfo,
  JobRepository,
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
    | "job_cancel_failed";

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

/** 工作区由服务端从鉴权用户解析（`FORM-9`），故不由调用方传入。 */
export type CreateJobInput = {
  projectId?: string;
  canvasId?: string;
  sessionId?: string;
  threadId?: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
};

export type JobService = {
  createJob(
    user: AuthenticatedUser,
    input: CreateJobInput,
  ): Promise<BackgroundJob>;
  getJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  listJobs(
    user: AuthenticatedUser,
    filters?: { status?: BackgroundJobStatus; jobType?: BackgroundJobType },
  ): Promise<BackgroundJob[]>;
  cancelJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  getJobAdmin(jobId: string): Promise<BackgroundJob>;

  // Admin-only methods (worker/executor 路径，无用户身份，按 id 取数)
  setCreditsInfo(
    jobId: string,
    creditsCost: number,
    transactionId: string,
  ): Promise<void>;
  markRunning(jobId: string): Promise<void>;
  markSucceeded(jobId: string, result: Record<string, unknown>): Promise<void>;
  markFailed(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
  markDeadLetter(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
  /** submit 成功后落外部厂商任务引用（崩溃恢复：重启后据此续 poll）。 */
  setProviderJobId(jobId: string, providerJobId: string): Promise<void>;
  /** 任务执行上下文补充（浅合并进 payload），如 submit 时的实例修订号。 */
  appendJobPayload(
    jobId: string,
    fields: Record<string, unknown>,
  ): Promise<void>;
  incrementAttempt(
    jobId: string,
  ): Promise<{ attempt_count: number; max_attempts: number }>;
  /**
   * 死信退款所需的扣费信息（worker 路径，按 id 取数）。
   * 不存在返回 null；查询失败抛 `job_query_failed`。
   */
  getCreditsInfo(jobId: string): Promise<JobCreditsInfo | null>;
};

function mapJobRow(row: BackgroundJobRecord): BackgroundJob {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
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
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    failed_at: row.failed_at ?? null,
    canceled_at: row.canceled_at ?? null,
  };
}

export function createJobService(options: {
  /** 队列缝（M3.2）：投递与消费，Provider 随形态替换。 */
  queue: QueueClient;
  repository: JobRepository;
  /**
   * 用户路径（建/查/列/取消）需要它解析工作区；worker 进程只走按 id 的
   * 状态迁移路径，可缺省。缺省时用户方法**立即 fail loud**。
   */
  viewerService?: ViewerService | undefined;
}): JobService {
  const { queue, repository } = options;

  function requireViewer(): ViewerService {
    if (!options.viewerService) {
      throw new JobServiceError(
        "job_query_failed",
        "用户级任务操作需要 ViewerService（worker 进程不提供）。",
        500,
      );
    }
    return options.viewerService;
  }

  /** 工作区 id 一律由服务端从鉴权用户解析（`FORM-9`）。 */
  async function requireWorkspaceId(
    user: AuthenticatedUser,
    errorCode: JobServiceError["code"],
  ): Promise<string> {
    const workspace = await requireViewer()
      .resolveWorkspace(user)
      .catch(() => null);

    if (!workspace) {
      throw new JobServiceError(
        errorCode,
        "Unable to resolve workspace for job.",
        500,
      );
    }

    return workspace.id;
  }

  return {
    async createJob(user, input) {
      const workspaceId = await requireWorkspaceId(user, "job_create_failed");
      const queueName = QUEUE_MAP[input.jobType];

      const job = await repository
        .insert({
          ...(input.canvasId ? { canvasId: input.canvasId } : {}),
          jobType: input.jobType,
          payload: input.payload,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          queueName,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          userId: user.id,
          workspaceId,
        })
        .catch(() => null);

      if (!job) {
        throw new JobServiceError(
          "job_create_failed",
          "Failed to create job record.",
          500,
        );
      }

      // 投递到队列缝 — 失败即回滚（不留孤儿 job 行）
      try {
        await queue.send(queueName, {
          job_id: job.id,
          job_type: input.jobType,
          workspace_id: workspaceId,
          ...(input.canvasId ? { canvas_id: input.canvasId } : {}),
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
        });
      } catch (enqueueErr) {
        console.error("[job-service] queue.send failed:", enqueueErr);
        await repository.delete(workspaceId, job.id).catch(() => 0);
        throw new JobServiceError(
          "job_create_failed",
          "Failed to enqueue job.",
          500,
        );
      }

      return mapJobRow(job);
    },

    async getJob(user, jobId) {
      const workspaceId = await requireWorkspaceId(user, "job_query_failed");

      const job = await repository
        .findByIdInWorkspace(workspaceId, jobId)
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

    async listJobs(user, filters) {
      const workspaceId = await requireWorkspaceId(user, "job_query_failed");

      const jobs = await repository
        .listByCreator(workspaceId, user.id, {
          ...(filters?.jobType ? { jobType: filters.jobType } : {}),
          ...(filters?.status ? { status: filters.status } : {}),
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

    async cancelJob(user, jobId) {
      const workspaceId = await requireWorkspaceId(user, "job_cancel_failed");

      const job = await repository.cancel(workspaceId, jobId).catch(() => {
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

    async getJobAdmin(jobId) {
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

    async getCreditsInfo(jobId) {
      return repository.findCreditsInfo(jobId).catch(() => {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job credits.",
          500,
        );
      });
    },

    // --- worker/executor 路径：按 id 改状态（无用户身份） ---

    async setCreditsInfo(jobId, creditsCost, transactionId) {
      await repository
        .setCreditsInfo(jobId, creditsCost, transactionId)
        .catch(() => 0);
    },

    async markRunning(jobId) {
      await repository.markRunning(jobId).catch(() => 0);
    },

    async markSucceeded(jobId, result) {
      await repository.markSucceeded(jobId, result).catch(() => 0);
    },

    async markFailed(jobId, errorCode, errorMessage) {
      await repository
        .markFailed(jobId, errorCode, errorMessage)
        .catch(() => 0);
    },

    async markDeadLetter(jobId, errorCode, errorMessage) {
      await repository
        .markDeadLetter(jobId, errorCode, errorMessage)
        .catch(() => 0);
    },

    async setProviderJobId(jobId, providerJobId) {
      await repository.setProviderJobId(jobId, providerJobId);
    },

    async appendJobPayload(jobId, fields) {
      await repository.appendJobPayload(jobId, fields);
    },

    async incrementAttempt(jobId) {
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
