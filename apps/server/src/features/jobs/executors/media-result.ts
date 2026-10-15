import type { BackgroundJob } from "@kenfutwork/shared";
import type { ExecutorContext } from "../job-executor.js";
import {
  type GeneratedMedia,
  type JobExecution,
  type JobMediaOutput,
  readJobExecution,
} from "../job-progress.js";
import { generatedOutputId, publishGeneratedFile } from "./generated-file.js";
import {
  loadMediaSource,
  mediaSourcePath,
  storeInlineSource,
} from "./media-source.js";

function withOutputs(
  execution: JobExecution,
  outputs: JobMediaOutput[],
): JobExecution {
  const first = outputs[0];
  return {
    ...execution,
    outputs,
    // 既有单产物任务与视频恢复仍可读取首产物检查点。
    ...(first?.generated ? { generated: first.generated } : {}),
    ...(first?.sourceObjectPath
      ? { sourceObjectPath: first.sourceObjectPath }
      : {}),
    ...(first?.stored ? { stored: first.stored } : {}),
  };
}

async function checkpointGenerated(
  job: BackgroundJob,
  media: GeneratedMedia[],
  execution: JobExecution,
  ctx: ExecutorContext,
): Promise<JobExecution> {
  if (!media.length)
    throw Object.assign(new Error("供应商未返回生成结果。"), {
      code: "no_output",
    });
  const outputs: JobMediaOutput[] = [];
  for (const [index, generated] of media.entries()) {
    if (!generated.url.startsWith("data:")) {
      outputs.push({ generated });
      continue;
    }
    const outputId = generatedOutputId(job.id, index);
    const bytes = Buffer.from(await (await fetch(generated.url)).arrayBuffer());
    await ctx.assertExecution?.();
    // 字节先可靠落盘；Job仅保存引用，不持久化base64。
    await storeInlineSource(job, bytes, generated.mimeType, ctx, outputId);
    const sourceObjectPath = mediaSourcePath(job, outputId);
    outputs.push({
      generated: { ...generated, url: `blob://${sourceObjectPath}` },
      sourceObjectPath,
    });
  }
  const checkpoint = withOutputs({ ...execution, phase: "saving" }, outputs);
  await ctx.jobService.saveExecution(job.id, checkpoint);
  return checkpoint;
}

async function saveOutput(
  job: BackgroundJob,
  output: JobMediaOutput,
  index: number,
  ctx: ExecutorContext,
): Promise<JobMediaOutput> {
  if (output.stored) return output;
  const generated = output.generated;
  if (!generated) throw new Error("生成产物回执缺失。");
  const outputId = generatedOutputId(job.id, index);
  const buffer = await loadMediaSource(job, output, ctx, outputId);
  const mime = generated.mimeType;
  const extension =
    mime === "image/jpeg" ? "jpg" : (mime.split("/")[1] ?? "bin");
  const stored = await publishGeneratedFile(
    job,
    buffer,
    mime,
    extension,
    ctx,
    outputId,
  );
  return {
    ...output,
    sourceObjectPath: mediaSourcePath(job, outputId),
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
}

/** 产物回执先落盘，再逐项下载、保存与发布；重入不调用付费生成接口。 */
export async function completeMediaJob(
  job: BackgroundJob,
  media: GeneratedMedia | GeneratedMedia[] | undefined,
  ctx: ExecutorContext,
) {
  let execution = readJobExecution(job);
  if (media)
    execution = await checkpointGenerated(
      job,
      Array.isArray(media) ? media : [media],
      execution,
      ctx,
    );
  const outputs = execution.outputs ?? [
    {
      ...(execution.generated ? { generated: execution.generated } : {}),
      ...(execution.sourceObjectPath
        ? { sourceObjectPath: execution.sourceObjectPath }
        : {}),
      ...(execution.stored ? { stored: execution.stored } : {}),
    },
  ];
  execution = withOutputs(execution, outputs);
  // 用量对应上游请求；一次原生多图仍只记录一条Job用量。
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
  const bucket = ctx.blob.bucket("project-assets");
  for (const [index, prior] of outputs.entries()) {
    const output = await saveOutput(job, prior, index, ctx);
    outputs[index] = output;
    execution = withOutputs({ ...execution, phase: "publishing" }, outputs);
    await ctx.jobService.saveExecution(job.id, execution);
    const result = output.stored;
    if (!result) throw new Error("生成文件保存回执缺失。");
    await ctx.assertExecution?.();
    const freshResult = {
      ...result,
      signed_url: await bucket.resolveUrl(result.object_path),
    };
    outputs[index] = {
      ...output,
      published: true,
      stored: {
        ...freshResult,
      },
    };
    execution = withOutputs(execution, outputs);
    await ctx.jobService.saveExecution(job.id, execution);
    await bucket
      .remove([mediaSourcePath(job, generatedOutputId(job.id, index))])
      .catch((error) => console.warn("[media-job] 临时产物清理失败:", error));
  }
  const results = outputs.map((output) => output.stored!);
  return { ...results[0]!, outputs: results };
}
