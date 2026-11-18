import type { BackgroundJob } from "@kenfutwork/shared";
import {
  resolveInstanceImageProviderFromPayload,
  resolveInstanceVideoProviderFromPayload,
} from "./executors/instance-provider.js";
import type { ExecutorContext } from "./job-executor.js";
import { classifyJobFailure } from "./job-failure.js";
import { readJobCancellation, readJobExecution } from "./job-progress.js";

/** 取消只解析原供应商，不读取素材或目标文档；删除文档仍可清理云端任务。 */
export async function executeJobCancellation(
  job: BackgroundJob,
  ctx: ExecutorContext,
  token: string,
) {
  const progress = readJobCancellation(job);
  if (progress?.state !== "pending") return;
  const execution = readJobExecution(job);
  if (!job.provider_job_id) {
    await ctx.jobService.saveCancellation(
      job.id,
      {
        state: execution.phase === "submitting" ? "unknown" : "local_only",
        attempts: progress.attempts,
        ...(execution.phase === "submitting"
          ? {
              errorCode: "submission_unknown",
              errorMessage: "提交结果待确认，请核对供应商记录。",
            }
          : {}),
      },
      0,
      token,
    );
    return;
  }

  const attempts = progress.attempts + 1;
  try {
    const instanceId =
      typeof job.payload.provider_instance_id === "string"
        ? job.payload.provider_instance_id
        : undefined;
    const headers = {
      ...(job.session_id ? { sessionId: job.session_id } : {}),
      ...(job.thread_id ? { threadId: job.thread_id } : {}),
    };
    const instance =
      job.job_type === "image_generation"
        ? await resolveInstanceImageProviderFromPayload(
            instanceId,
            ctx,
            headers,
          )
        : await resolveInstanceVideoProviderFromPayload(
            instanceId,
            ctx,
            headers,
          );
    if (
      !instance ||
      instance.configRevision !== job.payload.provider_config_revision
    )
      throw Object.assign(
        new Error("供应商配置已变更，请在供应商处确认任务是否停止。"),
        { code: "provider_config_stale" },
      );
    if (!instance.provider.cancelAsync) {
      await ctx.jobService.saveCancellation(
        job.id,
        { state: "local_only", attempts },
        0,
        token,
      );
      return;
    }
    await ctx.assertExecution?.();
    await instance.provider.cancelAsync(job.provider_job_id);
    await ctx.jobService.saveCancellation(
      job.id,
      { state: "requested", attempts },
      0,
      token,
    );
  } catch (error) {
    if ((error as { code?: string })?.code === "job_lease_lost") throw error;
    // 取消请求可安全重复发送，复用引擎退避与Retry-After，不另建轮询器。
    const policy = classifyJobFailure(
      {
        ...job,
        payload: {
          ...job.payload,
          _generation_execution: { ...execution, phase: "polling" },
        },
      },
      error,
      attempts,
      ctx.retryBaseDelayMs,
    );
    const retry = policy.kind === "retry" && attempts < job.max_attempts;
    await ctx.jobService.saveCancellation(
      job.id,
      {
        state: retry ? "pending" : "unknown",
        attempts,
        errorCode: policy.code,
        errorMessage: policy.message,
      },
      retry && policy.kind === "retry" ? policy.delaySeconds : 0,
      token,
    );
  }
}
