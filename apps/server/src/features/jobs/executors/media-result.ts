import type { BackgroundJob } from "@kenfutwork/shared";
import type { ExecutorContext } from "../job-executor.js";
import { type GeneratedMedia, readJobExecution } from "../job-progress.js";
import { publishGeneratedFile } from "./generated-file.js";
import {
  loadMediaSource,
  mediaSourcePath,
  storeInlineSource,
} from "./media-source.js";

/** 产物回执先落盘，再下载、保存与发布；重入不调用付费生成接口。 */
export async function completeMediaJob(
  job: BackgroundJob,
  media: GeneratedMedia | undefined,
  ctx: ExecutorContext,
) {
  let execution = readJobExecution(job);
  let inline: Buffer | undefined;
  const sourcePath = mediaSourcePath(job);
  const bucket = ctx.blob.bucket("project-assets");
  if (media) {
    if (media.url.startsWith("data:")) {
      inline = Buffer.from(await (await fetch(media.url)).arrayBuffer());
      await ctx.assertExecution?.();
      // 字节先可靠落盘，后续检查点及usage故障才能从引用恢复。
      await storeInlineSource(job, inline, media.mimeType, ctx);
      media = { ...media, url: `blob://${sourcePath}` };
    }
    execution = {
      ...execution,
      phase: "saving",
      generated: media,
      ...(inline ? { sourceObjectPath: sourcePath } : {}),
    };
    await ctx.jobService.saveExecution(job.id, execution);
  }
  // 上游已经生成即有用量；下载或保存失败不能抹去这次请求。
  if (!execution.usageRecorded && ctx.usageService) {
    await ctx.usageService.record({
      instanceId: job.instance_id,
      accessClientId: job.created_by_client_id,
      provider: "instance",
      model: String(job.payload.model),
      capability: job.job_type === "image_generation" ? "image" : "video",
      providerInstanceId: String(job.payload.provider_instance_id),
      jobId: job.id,
    });
    execution = { ...execution, usageRecorded: true };
    await ctx.jobService.saveExecution(job.id, execution);
  }
  if (!execution.stored) {
    const generated = execution.generated;
    if (!generated) throw new Error("生成产物回执缺失。");
    const buffer = await loadMediaSource(job, execution, ctx);
    execution = { ...execution, sourceObjectPath: sourcePath };
    await ctx.jobService.saveExecution(job.id, execution);
    const mime = generated.mimeType;
    const extension =
      mime === "image/jpeg" ? "jpg" : (mime.split("/")[1] ?? "bin");
    const stored = await publishGeneratedFile(
      job,
      buffer,
      mime,
      extension,
      ctx,
    );
    execution = {
      phase: "publishing",
      usageRecorded: execution.usageRecorded,
      stored: {
        asset_id: stored.assetId,
        object_path: stored.objectPath,
        signed_url: stored.url,
        mime_type: mime,
        ...(generated.width !== undefined ? { width: generated.width } : {}),
        ...(generated.height !== undefined ? { height: generated.height } : {}),
        ...(generated.durationSeconds !== undefined
          ? { duration_seconds: generated.durationSeconds }
          : {}),
      },
    };
    await ctx.jobService.saveExecution(job.id, execution);
    await bucket
      .remove([sourcePath])
      .catch((error) => console.warn("[media-job] 临时产物清理失败:", error));
  }
  const result = execution.stored;
  if (!result) throw new Error("生成文件保存回执缺失。");
  await ctx.assertExecution?.();
  const freshResult = {
    ...result,
    signed_url: await bucket.resolveUrl(result.object_path),
  };
  return {
    ...freshResult,
  };
}
