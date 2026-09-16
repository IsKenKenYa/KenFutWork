// @credits-system — Image generation executor: applies watermark for free-tier users

import type { BackgroundJob, SubscriptionPlan } from "@loomic/shared";
import { generateImage } from "../../../generation/image-generation.js";
import { resolveImageProviderName } from "../../../generation/providers/registry.js";
import type { GeneratedImage } from "../../../generation/types.js";
import { applyWatermark } from "../../credits/watermark.js";
import { type ExecutorContext, registerExecutor } from "../job-executor.js";
import { resolveInstanceImageProviderFromPayload } from "./instance-provider.js";

registerExecutor(
  "image_generation",
  async (jobId, _rawPayload, ctx: ExecutorContext) => {
    const t0 = Date.now();

    // Read the full job row including payload from the database.
    // The PGMQ message only contains { job_id, job_type, workspace_id },
    // so we must fetch prompt/model/aspect_ratio from background_jobs.payload.
    // 经 jobService 取（按 id 的系统级读，与 worker 其它状态迁移同一入口）。
    let jobRow: BackgroundJob;
    try {
      jobRow = await ctx.jobService.getJobAdmin(jobId);
    } catch {
      throw new Error(`Job ${jobId} not found in database`);
    }

    // Build log tag with traceability context: jobId + sessionId (if available)
    const sessionShort = jobRow.session_id?.slice(0, 8) ?? "no-session";
    const tag = `[image-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
    const lap = (label: string) =>
      console.log(`${tag} ${label} +${Date.now() - t0}ms`);
    lap("db_fetch");

    const payload = (jobRow.payload ?? {}) as {
      prompt: string;
      model?: string;
      provider_instance_id?: string;
      aspect_ratio?: string;
      title?: string;
      input_images?: string[];
    };

    if (!payload.prompt)
      throw new Error(`Job ${jobId} has no prompt in payload`);

    const createdBy: string | null = jobRow.created_by ?? null;
    const workspaceId: string = jobRow.workspace_id ?? jobId;

    // Resolve provider dynamically from model ID via registry
    const model = payload.model ?? "black-forest-labs/flux-kontext-pro";
    // BYOK：任务携带 provider_instance_id 时按用户实例实例化协议适配器（P4）
    const instanceProvider = await resolveInstanceImageProviderFromPayload(
      payload.provider_instance_id,
      ctx,
      // 自定义头（§4.8）的会话占位符按本条 job 的会话取值
      {
        ...(jobRow.session_id ? { sessionId: jobRow.session_id } : {}),
        ...(jobRow.thread_id ? { threadId: jobRow.thread_id } : {}),
      },
    );
    const providerName = instanceProvider
      ? instanceProvider.name
      : resolveImageProviderName(model);

    // Renew VT every 60s (half of the 120s image queue VT) to prevent
    // the message from becoming visible while we are still processing.
    const IMAGE_VT_SECONDS = 120;
    const heartbeatTimer = setInterval(() => {
      ctx.renewVt(IMAGE_VT_SECONDS);
    }, 60_000);

    // Log input image format for debugging the data-URI-passthrough pipeline
    if (payload.input_images?.length) {
      const formats = payload.input_images.map((img) =>
        img.startsWith("data:") ? "data-uri" : "url",
      );
      console.log(
        `${tag} input_images formats: [${formats.join(", ")}] (${formats.length} total)`,
      );
    }

    try {
      // Generate image via the registered provider
      lap(`${providerName}_call_start`);
      let generated: GeneratedImage;
      try {
        if (instanceProvider) {
          lap("instance_provider_call");
          generated = await instanceProvider.generate({
            prompt: payload.prompt,
            model,
            ...(payload.aspect_ratio !== undefined
              ? { aspectRatio: payload.aspect_ratio }
              : {}),
            ...(payload.input_images?.length
              ? { inputImages: payload.input_images }
              : {}),
          });
        } else {
          generated = await generateImage(providerName, {
            prompt: payload.prompt,
            model,
            ...(payload.aspect_ratio !== undefined
              ? { aspectRatio: payload.aspect_ratio }
              : {}),
            ...(payload.input_images?.length
              ? { inputImages: payload.input_images }
              : {}),
          });
        }
      } catch (genError) {
        const detail =
          genError instanceof Error ? genError.message : String(genError);
        const wrapped = new Error(
          `Image generation failed for model ${model}: ${detail}`,
        );
        (wrapped as Error & { code?: string }).code =
          (genError as { code?: string })?.code ?? "executor_error";
        throw wrapped;
      }
      lap(`${providerName}_call_done`);

      // 用量落账（DEC-6 直连生成链路）：图像 provider 不报 token，记 0 留痕不留盲区
      if (workspaceId) {
        ctx.usageService
          ?.record({
            workspaceId,
            provider: instanceProvider ? "instance" : providerName,
            model,
            capability: "image",
            ...(payload.provider_instance_id
              ? { providerInstanceId: payload.provider_instance_id }
              : {}),
            jobId,
          })
          .catch(() => {});
      }

      // Download the generated image from the provider CDN
      const response = await fetch(generated.url);
      if (!response.ok) {
        throw new Error(
          `Failed to download generated image from ${model}: ${response.status} ${response.statusText}`,
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      let buffer: Buffer = Buffer.from(arrayBuffer);
      lap("image_download_done");

      // Apply watermark for free-plan users
      if (workspaceId) {
        try {
          const subscription =
            await ctx.creditService.getSubscription(workspaceId);
          const plan: SubscriptionPlan = subscription.plan;
          if (plan === "free") {
            buffer = await applyWatermark(
              buffer,
              generated.mimeType ?? "image/png",
            );
            lap("watermark_applied");
          }
        } catch (wmErr) {
          // Non-fatal: log and continue without watermark rather than failing the job
          console.warn(`${tag} Watermark failed, continuing without:`, wmErr);
        }
      }

      // Upload to object storage under the project-assets bucket（经 blob 缝）
      const timestamp = Date.now();
      const objectPath = `${workspaceId}/generated/${timestamp}-${jobId}.png`;

      const bucket = ctx.blob.bucket("project-assets");
      await bucket.upload(objectPath, buffer, {
        contentType: generated.mimeType ?? "image/png",
        upsert: false,
      });
      lap("storage_upload_done");

      // Insert asset_objects record（经 assetWriter 缝：executor 无用户身份，
      // 按任务记录的工作区写入；`created_by` 可空）
      const assetId = await ctx.assetWriter.recordGeneratedAsset({
        byteSize: buffer.length,
        mimeType: generated.mimeType ?? "image/png",
        objectPath,
        ...(createdBy ? { userId: createdBy } : {}),
        workspaceId,
      });

      lap("asset_record_done");

      // Generate a public URL for the result consumer
      // 公开性由存储侧回答（实测 project-assets 可能非公开）
      const resultUrl = await bucket.resolveUrl(objectPath);

      lap("total");
      return {
        asset_id: assetId,
        signed_url: resultUrl,
        object_path: objectPath,
        width: generated.width,
        height: generated.height,
        mime_type: generated.mimeType ?? "image/png",
      };
    } finally {
      clearInterval(heartbeatTimer);
    }
  },
);
