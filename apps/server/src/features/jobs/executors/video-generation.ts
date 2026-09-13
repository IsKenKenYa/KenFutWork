import type { BackgroundJob } from "@loomic/shared";

import { resolveVideoProviderName } from "../../../generation/providers/registry.js";
import { generateVideo } from "../../../generation/video-generation.js";
import { type ExecutorContext, registerExecutor } from "../job-executor.js";
import { resolveInstanceVideoProviderFromPayload } from "./instance-provider.js";

registerExecutor(
  "video_generation",
  async (jobId, _rawPayload, ctx: ExecutorContext) => {
    const t0 = Date.now();

    const admin = ctx.getAdminClient();
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
    lap("db_fetch");

    const payload = (jobRow.payload ?? {}) as {
      prompt: string;
      model?: string;
      duration?: number;
      resolution?: string;
      aspect_ratio?: string;
      input_images?: string[];
      input_video?: string;
      enable_audio?: boolean;
    };

    if (!payload.prompt)
      throw new Error(`Job ${jobId} has no prompt in payload`);

    const createdBy: string | null = jobRow.created_by ?? null;
    const workspaceId: string = jobRow.workspace_id ?? jobId;

    const model = payload.model ?? "wan-video/wan-2.6";
    // BYOK：任务携带 provider_instance_id 时按用户供应商实例实例化协议适配器（P4）
    const instanceProvider = await resolveInstanceVideoProviderFromPayload(
      (payload as { provider_instance_id?: string }).provider_instance_id,
      ctx,
    );
    const providerName = instanceProvider
      ? instanceProvider.name
      : resolveVideoProviderName(model);

    // Renew VT every 120s (roughly half of the 300s video queue VT) to prevent
    // the message from becoming visible during long video generation.
    const VIDEO_VT_SECONDS = 300;
    const heartbeatTimer = setInterval(() => {
      ctx.renewVt(VIDEO_VT_SECONDS);
    }, 120_000);

    try {
      lap(`${providerName}_call_start`);
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
      const generated = instanceProvider
        ? await instanceProvider.generate(generateParams)
        : await generateVideo(providerName, generateParams);
      lap(`${providerName}_call_done`);

      // 用量落账（DEC-6 直连生成链路）：视频 provider 不报 token，记 0 留痕不留盲区
      if (workspaceId) {
        ctx.usageService
          ?.record({
            workspaceId,
            provider: instanceProvider ? "instance" : providerName,
            model,
            capability: "video",
            ...((payload as { provider_instance_id?: string })
              .provider_instance_id
              ? {
                  providerInstanceId: (
                    payload as { provider_instance_id?: string }
                  ).provider_instance_id,
                }
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
        width: generated.width,
        height: generated.height,
        duration_seconds: generated.durationSeconds,
        mime_type: generated.mimeType ?? "video/mp4",
      };
    } catch (err) {
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
