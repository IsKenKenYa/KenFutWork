import type { BackgroundJob } from "@kenfutwork/shared";
import type { GeneratedImage } from "../../../generation/types.js";
import { type ExecutorContext, registerExecutor } from "../job-executor.js";
import { publishGeneratedFile } from "./generated-file.js";
import { resolveInstanceImageProviderFromPayload } from "./instance-provider.js";

registerExecutor(
  "image_generation",
  async (jobId, _rawPayload, ctx: ExecutorContext) => {
    const t0 = Date.now();

    // Read the full job row including payload from the database.
    // The PGMQ message only contains { job_id, job_type, instance_id },
    // so we must fetch prompt/model/aspect_ratio from background_jobs.payload.
    // 经 jobService 取（按 id 的系统级读，与 worker 其它状态迁移同一入口）。
    let jobRow: BackgroundJob;
    try {
      jobRow = await ctx.jobService.getJobForWorker(jobId);
    } catch {
      throw new Error(`Job ${jobId} not found in database`);
    }

    // Build log tag with traceability context: jobId + sessionId (if available)
    const sessionShort = jobRow.session_id?.slice(0, 8) ?? "no-session";
    const tag = `[image-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
    const lap = (label: string) =>
      console.log(`${tag} ${label} +${Date.now() - t0}ms`);
    lap("db_fetch");

    await ctx.generationTargets.resolve(jobRow);

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

    const createdBy: string | null = jobRow.created_by_client_id ?? null;
    const instanceId: string = jobRow.instance_id;

    // BYOK-only：生成任务必须携带供应商实例（内置目录/遗留 env 注册已退役）。
    const model = payload.model;
    if (!payload.provider_instance_id || !model) {
      const wrapped = new Error(
        "生成任务缺少 provider_instance_id 或 model（请先在设置 → 供应商添加实例后再发起生成）",
      );
      (wrapped as Error & { code?: string }).code = "invalid_input";
      throw wrapped;
    }
    const instanceProvider = await resolveInstanceImageProviderFromPayload(
      payload.provider_instance_id,
      ctx,
      // 自定义头（§4.8）的会话占位符按本条 job 的会话取值
      {
        ...(jobRow.session_id ? { sessionId: jobRow.session_id } : {}),
        ...(jobRow.thread_id ? { threadId: jobRow.thread_id } : {}),
      },
    );
    if (!instanceProvider) {
      const wrapped = new Error(
        `供应商实例 ${payload.provider_instance_id} 无法解析为图像适配器`,
      );
      (wrapped as Error & { code?: string }).code = "invalid_input";
      throw wrapped;
    }
    const providerName = instanceProvider.name;

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
      if (instanceId) {
        ctx.usageService
          ?.record({
            instanceId,
            ...(createdBy ? { accessClientId: createdBy } : {}),
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
      const buffer: Buffer = Buffer.from(arrayBuffer);
      lap("image_download_done");

      const mimeType = generated.mimeType ?? "image/png";
      const extension =
        mimeType === "image/jpeg"
          ? "jpg"
          : mimeType === "image/webp"
            ? "webp"
            : "png";
      const stored = await publishGeneratedFile(
        jobRow,
        buffer,
        mimeType,
        extension,
        ctx,
      );
      const assetId = stored.assetId;
      const objectPath = stored.objectPath;
      const resultUrl = stored.url;
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
