import type { BackgroundJob } from "@kenfutwork/shared";
import { type ExecutorContext, registerExecutor } from "../job-executor.js";
import { resolveJobMediaInputs } from "../job-inputs.js";
import { readJobExecution } from "../job-progress.js";
import { resolveInstanceVideoProviderFromPayload } from "./instance-provider.js";
import { completeMediaJob } from "./media-result.js";

/**
 * 视频任务执行器（S6 状态机）。
 *
 * 两种执行面：
 * - **异步任务面**（replicate / metaso / volces——provider 实现
 *   `startAsync`/`pollAsync`）：首次 submit → `provider_job_id` + 修订号落库 →
 *   投一条延迟 poll 消息（队列承载轮询节奏，默认 10s）；后续每次 poll 消息
 *   消费时单次查询，未终态则再投下一条。worker 崩溃重启后消息重投/恢复，
 *   见 `provider_job_id` 即直接续 poll（不重复提交，云端不会重复计费）。
 * - **阻塞面**（google 系等未实现异步面的 provider，行为不变）：既有
 *   `generate()` 全程 + VT 心跳，外包**绝对超时**（默认 30 分钟，env 可调）。
 *
 * 编排纪律：executor 是引擎层——轮询节奏（延迟消息间隔）与超时熔断在这里；
 * 适配器内不做 while 轮询。
 */

/** 特殊信号：poll 消息已投递、本次执行到此为止（job-loop 据此只 archive 不落失败）。 */
export const PROVIDER_POLL_SCHEDULED = "provider_poll_scheduled";
/** 厂商明确失败：同输入重试必然再失败 → 死信（job-loop 的不可重试集合）。 */
export const PROVIDER_TASK_FAILED = "provider_task_failed";
/** 跨修订拒绝：实例配置在任务落盘后已变更，旧句柄不得复用。 */
export const PROVIDER_CONFIG_STALE = "provider_config_stale";
/** 绝对超时：厂商假死/永久 in_progress，强制 failed 释放并发位。 */
export const VIDEO_JOB_TIMEOUT = "video_job_timeout";

const DEFAULT_VIDEO_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_DELAY_SECONDS = 10;

function fatal(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}

registerExecutor(
  "video_generation",
  async (jobId, _rawPayload, ctx: ExecutorContext) => {
    const t0 = Date.now();

    // 经 jobService 取（按 id 的系统级读，与 worker 其它状态迁移同一入口）。
    let jobRow: BackgroundJob;
    try {
      jobRow = await ctx.jobService.getJobForWorker(jobId);
    } catch {
      throw new Error(`Job ${jobId} not found in database`);
    }

    // Build log tag with traceability context: jobId + sessionId (if available)
    const sessionShort = jobRow.session_id?.slice(0, 8) ?? "no-session";
    const tag = `[video-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
    const lap = (label: string) =>
      console.log(`${tag} ${label} +${Date.now() - t0}ms`);

    await ctx.generationTargets.resolve(jobRow);
    const execution = readJobExecution(jobRow);
    if (execution.outputs?.length || execution.generated || execution.stored)
      return completeMediaJob(jobRow, undefined, ctx);

    const payload = (jobRow.payload ?? {}) as {
      prompt: string;
      model?: string;
      duration?: number;
      resolution?: string;
      aspect_ratio?: string;
      input_images?: string[];
      input_video?: string;
      enable_audio?: boolean;
      provider_instance_id?: string;
      provider_config_revision?: number;
    };

    if (!payload.prompt)
      throw new Error(`Job ${jobId} has no prompt in payload`);

    // BYOK-only：生成任务必须携带供应商实例（内置目录/遗留 env 注册已退役）。
    if (!payload.provider_instance_id || !payload.model) {
      throw fatal(
        "invalid_input",
        "生成任务缺少 provider_instance_id 或 model（请先在设置 → 供应商添加实例后再发起生成）",
      );
    }
    const model = payload.model;
    const instance = await resolveInstanceVideoProviderFromPayload(
      payload.provider_instance_id,
      ctx,
      // 自定义头（§4.8）的会话占位符按本条 job 的会话取值
      {
        ...(jobRow.session_id ? { sessionId: jobRow.session_id } : {}),
        ...(jobRow.thread_id ? { threadId: jobRow.thread_id } : {}),
      },
    );
    if (!instance) {
      throw fatal(
        "invalid_input",
        `供应商实例 ${payload.provider_instance_id} 无法解析为视频适配器`,
      );
    }
    const providerName = instance.provider.name;
    const references = jobRow.provider_job_id
      ? {}
      : await resolveJobMediaInputs(jobRow, ctx.uploads);

    const startAsync = instance.provider.startAsync;
    const pollAsync = instance.provider.pollAsync;
    const _canPollAsync = startAsync != null && pollAsync != null;

    // ── 跨修订防护：实例配置在任务落盘后变更过 → 旧句柄不得复用 ──
    if (instance && jobRow.provider_job_id) {
      const submittedRevision = payload.provider_config_revision;
      if (
        submittedRevision == null ||
        Number(submittedRevision) !== instance.configRevision ||
        !startAsync ||
        !pollAsync
      ) {
        throw fatal(
          PROVIDER_CONFIG_STALE,
          `实例配置已变更（任务落盘修订 ${submittedRevision} ≠ 当前 ${instance.configRevision}），不跨修订续查旧任务；请重新发起生成`,
        );
      }
    }

    // ── 异步任务面：恢复续查 / 首次提交 ──
    if (instance && startAsync && pollAsync) {
      const _provider = instance.provider;
      const pollDelaySeconds =
        ctx.env.videoPollDelaySeconds ?? DEFAULT_POLL_DELAY_SECONDS;
      const timeoutMs =
        ctx.env.videoJobTimeoutMs ?? DEFAULT_VIDEO_JOB_TIMEOUT_MS;

      const scheduleNextPoll = () =>
        ctx.jobService.scheduleJob(jobId, pollDelaySeconds);

      if (jobRow.provider_job_id) {
        // ── poll 分支（含崩溃恢复：重启后消息重投，见 provider_job_id 即续查）──
        const startedAt = jobRow.started_at
          ? Date.parse(jobRow.started_at)
          : Date.parse(jobRow.created_at);
        if (Number.isFinite(startedAt) && Date.now() - startedAt > timeoutMs) {
          throw fatal(
            VIDEO_JOB_TIMEOUT,
            `视频任务超过绝对时限（${Math.round(timeoutMs / 60000)} 分钟）仍未终态，强制失败以释放并发位`,
          );
        }

        await ctx.assertExecution?.();
        const pollResult = await pollAsync(jobRow.provider_job_id);
        if (pollResult.state === "in_progress") {
          await scheduleNextPoll();
          throw fatal(PROVIDER_POLL_SCHEDULED, "轮询已排程");
        }
        if (pollResult.state === "failed") {
          throw fatal(PROVIDER_TASK_FAILED, pollResult.errorMessage);
        }
        lap("provider_poll_succeeded");
        return completeMediaJob(
          jobRow,
          { url: pollResult.videoUrl, mimeType: "video/mp4" },
          ctx,
        );
      }

      // ── submit 分支：提交即落引用，投首条延迟 poll 消息，本次执行结束 ──
      lap(`${providerName}_submit_start`);
      await ctx.assertExecution?.();
      await ctx.jobService.saveExecution(jobId, { phase: "submitting" });
      const { providerJobId } = await startAsync({
        prompt: payload.prompt,
        model,
        ...(payload.duration != null ? { duration: payload.duration } : {}),
        ...(payload.resolution
          ? { resolution: payload.resolution as "480p" | "720p" | "1080p" }
          : {}),
        ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
        ...references,
        ...(payload.enable_audio != null
          ? { enableAudio: payload.enable_audio }
          : {}),
      });
      await ctx.jobService.saveExecution(
        jobId,
        { phase: "polling" },
        {
          providerJobId,
          providerRevision: instance.configRevision,
        },
      );
      await scheduleNextPoll();
      lap(`${providerName}_submitted`);
      throw fatal(PROVIDER_POLL_SCHEDULED, "提交完成，轮询已排程");
    }

    // ── 阻塞面（google 系 / 遗留注册路径，行为不变 + 绝对超时兜底）──
    const timeoutMs = ctx.env.videoJobTimeoutMs ?? DEFAULT_VIDEO_JOB_TIMEOUT_MS;

    // Renew VT every 120s (roughly half of the 300s video queue VT) to prevent
    // the message from becoming visible during long video generation.
    const VIDEO_VT_SECONDS = 300;
    const heartbeatTimer = setInterval(() => {
      ctx.renewVt(VIDEO_VT_SECONDS);
    }, 120_000);

    let timeoutTimer: NodeJS.Timeout | undefined;
    const generatePromise = (async () => {
      const generateParams = {
        prompt: payload.prompt,
        model,
        ...(payload.duration != null ? { duration: payload.duration } : {}),
        ...(payload.resolution
          ? { resolution: payload.resolution as "480p" | "720p" | "1080p" }
          : {}),
        ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
        ...references,
        ...(payload.enable_audio != null
          ? { enableAudio: payload.enable_audio }
          : {}),
      };
      lap(`${providerName}_call_start`);
      await ctx.assertExecution?.();
      await ctx.jobService.saveExecution(jobId, { phase: "submitting" });
      return instance.provider.generate(generateParams);
    })();

    try {
      const generated = await Promise.race([
        generatePromise,
        new Promise<never>((_resolve, reject) => {
          timeoutTimer = setTimeout(() => {
            reject(
              fatal(
                VIDEO_JOB_TIMEOUT,
                `视频任务超过绝对时限（${Math.round(timeoutMs / 60000)} 分钟），强制失败以释放并发位`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      lap(`${providerName}_call_done`);

      return completeMediaJob(jobRow, generated, ctx);
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const detail = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(
        `Video generation failed for model ${model}: ${detail}`,
        { cause: err },
      );
      // Preserve the original error code so the worker can distinguish
      // non-retryable errors (e.g. invalid_input) from transient failures.
      (wrapped as Error & { code?: string }).code =
        (err as { code?: string })?.code ?? "executor_error";
      throw wrapped;
    } finally {
      clearInterval(heartbeatTimer);
    }
  },
);
