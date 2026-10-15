import type { BackgroundJob } from "@kenfutwork/shared";
import { publishGeneratedCanvas } from "../../generation/generation-publication.js";
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

function rethrowControlFailure(error: unknown, ctx: ExecutorContext) {
  ctx.signal?.throwIfAborted();
  if ((error as { code?: string })?.code === "job_lease_lost") throw error;
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
  const outputs: JobMediaOutput[] = media.map((generated) => {
    if (!generated.url.startsWith("data:")) return { generated };
    const { url: _url, ...pendingInline } = generated;
    return { pendingInline };
  });
  let checkpoint = withOutputs({ ...execution, phase: "saving" }, outputs);
  // 先固定输出顺序。inline槽只有元数据，未落盘的字节没有伪造的Blob引用。
  await ctx.jobService.saveExecution(job.id, checkpoint);
  for (const [index, generated] of media.entries()) {
    if (!generated.url.startsWith("data:")) continue;
    const outputId = generatedOutputId(job.id, index);
    try {
      const bytes = Buffer.from(
        await (await fetch(generated.url)).arrayBuffer(),
      );
      await ctx.assertExecution?.();
      await storeInlineSource(job, bytes, generated.mimeType, ctx, outputId);
    } catch (error) {
      rethrowControlFailure(error, ctx);
      if ((error as { code?: string })?.code === "media_output_conflict")
        throw error;
      // 中间暂存失败仍处理后续产物；恢复时仅探测已固定的暂存路径，绝不重新生成。
      continue;
    }
    const sourceObjectPath = mediaSourcePath(job, outputId);
    outputs[index] = {
      generated: { ...generated, url: `blob://${sourceObjectPath}` },
      sourceObjectPath,
    };
    checkpoint = withOutputs(checkpoint, outputs);
    await ctx.jobService.saveExecution(job.id, checkpoint);
  }
  return checkpoint;
}

async function saveOutput(
  job: BackgroundJob,
  output: JobMediaOutput,
  index: number,
  ctx: ExecutorContext,
): Promise<JobMediaOutput> {
  if (output.stored) return output;
  const outputId = generatedOutputId(job.id, index);
  const sourceObjectPath = mediaSourcePath(job, outputId);
  const sourceOutput =
    output.generated || !output.pendingInline
      ? output
      : {
          generated: {
            ...output.pendingInline,
            url: `blob://${sourceObjectPath}`,
          },
          sourceObjectPath,
        };
  const generated = sourceOutput.generated;
  if (!generated)
    throw Object.assign(new Error("生成产物回执缺失，请核对供应商结果。"), {
      code: "media_output_missing",
    });
  const buffer = await loadMediaSource(job, sourceOutput, ctx, outputId);
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
    ...sourceOutput,
    sourceObjectPath,
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

async function recordUsage(
  job: BackgroundJob,
  execution: JobExecution,
  ctx: ExecutorContext,
): Promise<JobExecution> {
  if (execution.usageRecorded || !ctx.usageService) return execution;
  await ctx.usageService.record({
    instanceId: job.instance_id,
    accessClientId: job.created_by_client_id,
    provider: "instance",
    model: String(job.payload.model),
    capability: job.job_type === "image_generation" ? "image" : "video",
    providerInstanceId: String(job.payload.provider_instance_id),
    jobId: job.id,
  });
  const checkpoint = { ...execution, usageRecorded: true };
  await ctx.jobService.saveExecution(job.id, checkpoint);
  return checkpoint;
}

async function publishOutput(
  job: BackgroundJob,
  output: JobMediaOutput,
  index: number,
  ctx: ExecutorContext,
): Promise<JobMediaOutput> {
  const result = output.stored;
  if (!result) throw new Error("生成文件保存回执缺失。");
  await ctx.assertExecution?.();
  const freshResult = {
    ...result,
    signed_url: await ctx.blob
      .bucket("project-assets")
      .resolveUrl(result.object_path),
  };
  return {
    ...output,
    published: true,
    stored: {
      ...freshResult,
      ...(output.published
        ? {}
        : await publishGeneratedCanvas(
            job,
            freshResult,
            ctx,
            generatedOutputId(job.id, index),
          )),
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
  // 用量对应上游请求；一次原生多图仍只记录一条Job用量。
  execution = await recordUsage(job, withOutputs(execution, outputs), ctx);
  const bucket = ctx.blob.bucket("project-assets");
  let failure: unknown;
  for (const [index, prior] of outputs.entries()) {
    let output: JobMediaOutput;
    try {
      output = await saveOutput(job, prior, index, ctx);
    } catch (error) {
      rethrowControlFailure(error, ctx);
      failure ??= error;
      continue;
    }
    outputs[index] = output;
    execution = withOutputs({ ...execution, phase: "publishing" }, outputs);
    await ctx.jobService.saveExecution(job.id, execution);
    try {
      outputs[index] = await publishOutput(job, output, index, ctx);
    } catch (error) {
      rethrowControlFailure(error, ctx);
      failure ??= error;
      continue;
    }
    execution = withOutputs(execution, outputs);
    await ctx.jobService.saveExecution(job.id, execution);
    await bucket
      .remove([mediaSourcePath(job, generatedOutputId(job.id, index))])
      .catch((error) => console.warn("[media-job] 临时产物清理失败:", error));
  }
  if (failure !== undefined) throw failure;
  const results = outputs.map((output) => output.stored!);
  return { ...results[0]!, outputs: results };
}
