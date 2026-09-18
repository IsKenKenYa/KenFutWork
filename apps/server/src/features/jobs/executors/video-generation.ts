import type { BackgroundJob } from "@kenfutwork/shared";

import { type ExecutorContext, registerExecutor } from "../job-executor.js";
import { resolveInstanceVideoProviderFromPayload } from "./instance-provider.js";

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
/** 厂商明确失败：同输入重试必然再失败 → 死信退款（job-loop 的不可重试集合）。 */
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
      jobRow = await ctx.jobService.getJobAdmin(jobId);
    } catch {
      throw new Error(`Job ${jobId} not found in database`);
    }

    // Build log tag with traceability context: jobId + sessionId (if available)
    const sessionShort = jobRow.session_id?.slice(0, 8) ?? "no-session";
    const tag = `[video-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
    const lap = (label: string) =>
      console.log(`${tag} ${label} +${Date.now() - t0}ms`);

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

    const createdBy: string | null = jobRow.created_by ?? null;
    const workspaceId: string = jobRow.workspace_id ?? jobId;

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

    const startAsync = instance.provider.startAsync;
    const pollAsync = instance.provider.pollAsync;
    const canPollAsync = startAsync != null && pollAsync != null;

    // ── 跨修订防护：实例配置在任务落盘后变更过 → 旧句柄不得复用 ──
    if (instance && jobRow.provider_job_id) {
      const submittedRevision = payload.provider_config_revision;
      if (
        submittedRevision != null &&
        Number(submittedRevision) !== instance.configRevision
      ) {
        throw fatal(
          PROVIDER_CONFIG_STALE,
          `实例配置已变更（任务落盘修订 ${submittedRevision} ≠ 当前 ${instance.configRevision}），不跨修订续查旧任务；请重新发起生成`,
        );
      }
    }

    // ── 异步任务面：恢复续查 / 首次提交 ──
    if (instance && startAsync && pollAsync) {
      const provider = instance.provider;
      const pollDelaySeconds =
        ctx.env.videoPollDelaySeconds ?? DEFAULT_POLL_DELAY_SECONDS;
      const timeoutMs =
        ctx.env.videoJobTimeoutMs ?? DEFAULT_VIDEO_JOB_TIMEOUT_MS;

      const scheduleNextPoll = () =>
        ctx.queue.send(
          ctx.queueName,
          { job_id: jobId, job_type: "video_generation" },
          pollDelaySeconds,
        );

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

        const pollResult = await pollAsync(jobRow.provider_job_id);
        if (pollResult.state === "in_progress") {
          await scheduleNextPoll();
          throw fatal(PROVIDER_POLL_SCHEDULED, "轮询已排程");
        }
        if (pollResult.state === "failed") {
          throw fatal(PROVIDER_TASK_FAILED, pollResult.errorMessage);
        }
        lap("provider_poll_succeeded");
        return await finishVideoJob(
          { url: pollResult.videoUrl, mimeType: "video/mp4" },
          {
            jobId,
            workspaceId,
            createdBy,
            providerLabel: instance.provider.name,
            model,
            providerInstanceId: payload.provider_instance_id,
            durationSeconds: payload.duration ?? 5,
          },
          ctx,
          lap,
        );
      }

      // ── submit 分支：提交即落引用，投首条延迟 poll 消息，本次执行结束 ──
      lap(`${providerName}_submit_start`);
      const { providerJobId } = await startAsync({
        prompt: payload.prompt,
        model,
        ...(payload.duration != null ? { duration: payload.duration } : {}),
        ...(payload.resolution
          ? { resolution: payload.resolution as "480p" | "720p" | "1080p" }
          : {}),
        ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
        ...(payload.input_images?.length
          ? { inputImages: payload.input_images }
          : {}),
        ...(payload.input_video ? { inputVideo: payload.input_video } : {}),
        ...(payload.enable_audio != null
          ? { enableAudio: payload.enable_audio }
          : {}),
      });
      await ctx.jobService.setProviderJobId(jobId, providerJobId);
      // 修订号落 payload（跨修订防护的比对基准；列不加第二个，payload 即执行上下文）
      await ctx.jobService.appendJobPayload(jobId, {
        provider_config_revision: instance.configRevision,
      });
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
        ...(payload.input_images?.length
          ? { inputImages: payload.input_images }
          : {}),
        ...(payload.input_video ? { inputVideo: payload.input_video } : {}),
        ...(payload.enable_audio != null
          ? { enableAudio: payload.enable_audio }
          : {}),
      };
      lap(`${providerName}_call_start`);
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

      // 用量落账（DEC-6 直连生成链路）：视频 provider 不报 token，记 0 留痕不留盲区
      if (workspaceId) {
        ctx.usageService
          ?.record({
            workspaceId,
            provider: providerName,
            model,
            capability: "video",
            ...(payload.provider_instance_id
              ? { providerInstanceId: payload.provider_instance_id }
              : {}),
            jobId,
          })
          .catch(() => {});
      }

      return await finishVideoJob(
        generated,
        {
          jobId,
          workspaceId,
          createdBy,
          providerLabel: providerName,
          model,
          providerInstanceId: payload.provider_instance_id,
          durationSeconds: generated.durationSeconds,
        },
        ctx,
        lap,
      );
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const detail = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(
        `Video generation failed for model ${model}: ${detail}`,
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

interface FinishContext {
  jobId: string;
  workspaceId: string;
  createdBy: string | null;
  providerLabel: string;
  model: string;
  providerInstanceId: string | undefined;
  durationSeconds: number;
}

/** 终态收尾：下载产物 → blob 落盘 → 资产登记 → 组装 job result（两条执行面共用）。 */
async function finishVideoJob(
  generated: { url: string; mimeType: string },
  meta: FinishContext,
  ctx: ExecutorContext,
  lap: (label: string) => void,
): Promise<Record<string, unknown>> {
  const { jobId, workspaceId, createdBy } = meta;

  // 用量落账（DEC-6 直连生成链路）：视频 provider 不报 token，记 0 留痕不留盲区
  if (workspaceId) {
    ctx.usageService
      ?.record({
        workspaceId,
        provider: meta.providerInstanceId ? "instance" : meta.providerLabel,
        model: meta.model,
        capability: "video",
        ...(meta.providerInstanceId
          ? { providerInstanceId: meta.providerInstanceId }
          : {}),
        jobId,
      })
      .catch(() => {});
  }

  // Vertex AI returns inline base64 data URIs; Developer API returns HTTP URLs.
  let buffer: Buffer;
  if (generated.url.startsWith("data:")) {
    const commaIdx = generated.url.indexOf(",");
    if (commaIdx === -1)
      throw new Error("Invalid data URI: no comma separator");
    buffer = Buffer.from(generated.url.slice(commaIdx + 1), "base64");
  } else {
    const response = await fetch(generated.url);
    if (!response.ok) {
      throw new Error(
        `Failed to download video: ${response.status} ${response.statusText}`,
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  }
  lap("video_download_done");

  const ext = generated.mimeType === "video/webm" ? "webm" : "mp4";
  const timestamp = Date.now();
  const objectPath = `${workspaceId}/generated/${timestamp}-${jobId}.${ext}`;

  const bucket = ctx.blob.bucket("project-assets");
  await bucket.upload(objectPath, buffer, {
    contentType: generated.mimeType ?? "video/mp4",
    upsert: false,
  });
  lap("storage_upload_done");

  // 经 assetWriter 缝：executor 无用户身份，按任务记录的工作区写入
  const assetId = await ctx.assetWriter.recordGeneratedAsset({
    byteSize: buffer.length,
    mimeType: generated.mimeType ?? "video/mp4",
    objectPath,
    ...(createdBy ? { userId: createdBy } : {}),
    workspaceId,
  });
  lap("asset_record_done");

  // 公开性由存储侧回答（实测 project-assets 可能非公开）
  const resultUrl = await bucket.resolveUrl(objectPath);

  lap("total");
  return {
    asset_id: assetId,
    signed_url: resultUrl,
    object_path: objectPath,
    duration_seconds: meta.durationSeconds,
    mime_type: generated.mimeType ?? "video/mp4",
  };
}
