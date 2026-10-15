import type { BackgroundJob } from "@kenfutwork/shared";
import type {
  GeneratedImage,
  ImageGenerateParams,
} from "../../../generation/types.js";
import { type ExecutorContext, registerExecutor } from "../job-executor.js";
import { resolveJobMediaInputs } from "../job-inputs.js";
import { readJobExecution } from "../job-progress.js";
import { resolveInstanceImageProviderFromPayload } from "./instance-provider.js";
import { completeMediaJob } from "./media-result.js";

type ImageJobPayload = {
  prompt: string;
  model: string;
  provider_instance_id: string;
  provider_config_revision?: number;
  aspect_ratio?: string;
  quality?: string;
  width?: number;
  height?: number;
  output_format?: "png" | "jpg" | "webp";
};
type ImageProviderSnapshot = NonNullable<
  Awaited<ReturnType<typeof resolveInstanceImageProviderFromPayload>>
>;

function jobError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function imageParams(
  job: BackgroundJob,
  payload: ImageJobPayload,
  ctx: ExecutorContext,
): Promise<ImageGenerateParams> {
  return {
    prompt: payload.prompt,
    model: payload.model,
    ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
    ...(payload.quality ? { quality: payload.quality } : {}),
    ...(payload.width !== undefined ? { width: payload.width } : {}),
    ...(payload.height !== undefined ? { height: payload.height } : {}),
    ...(payload.output_format ? { outputFormat: payload.output_format } : {}),
    ...(await resolveJobMediaInputs(job, ctx.uploads)),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

async function generateImage(
  job: BackgroundJob,
  payload: ImageJobPayload,
  instance: ImageProviderSnapshot,
  ctx: ExecutorContext,
): Promise<GeneratedImage> {
  const provider = instance.provider;
  if (
    job.provider_job_id &&
    (payload.provider_config_revision == null ||
      payload.provider_config_revision !== instance.configRevision ||
      !provider.startAsync ||
      !provider.pollAsync)
  ) {
    throw jobError(
      "provider_config_stale",
      "图片供应商配置已变更，无法续查原任务，请核对供应商记录。",
    );
  }
  if (!provider.startAsync || !provider.pollAsync) {
    const params = await imageParams(job, payload, ctx);
    await ctx.assertExecution?.();
    await ctx.jobService.saveExecution(job.id, { phase: "submitting" });
    return provider.generate(params);
  }
  if (!Number.isInteger(instance.configRevision)) {
    throw jobError(
      "provider_config_stale",
      "图片供应商配置版本缺失，无法保存可恢复的任务。",
    );
  }
  if (job.provider_job_id) {
    await ctx.assertExecution?.();
    const result = await provider.pollAsync(job.provider_job_id);
    if (result.state === "failed")
      throw jobError("provider_task_failed", result.errorMessage);
    if (result.state === "succeeded") {
      if (result.images.length > 1) {
        throw jobError(
          "unsupported",
          `图片供应商返回${result.images.length}张图片，当前任务尚不能保存该结果，请核对供应商记录。`,
        );
      }
      const image = result.images[0];
      if (!image) throw jobError("no_output", "图片供应商未返回生成结果。");
      return image;
    }
  } else {
    const params = await imageParams(job, payload, ctx);
    await ctx.assertExecution?.();
    await ctx.jobService.saveExecution(job.id, { phase: "submitting" });
    const { providerJobId } = await provider.startAsync(params);
    await ctx.jobService.saveExecution(
      job.id,
      { phase: "polling" },
      {
        providerJobId,
        providerRevision: instance.configRevision,
      },
    );
  }
  await ctx.jobService.scheduleJob(job.id, 10);
  throw jobError("provider_poll_scheduled", "图片任务已提交，等待供应商结果。");
}

registerExecutor(
  "image_generation",
  async (jobId, _message, ctx: ExecutorContext) => {
    const job = await ctx.jobService.getJobForWorker(jobId);
    await ctx.generationTargets.resolve(job);
    const execution = readJobExecution(job);
    if (execution.generated || execution.stored)
      return completeMediaJob(job, undefined, ctx);
    const payload = job.payload as ImageJobPayload;
    if (!payload.prompt || !payload.model || !payload.provider_instance_id)
      throw jobError("invalid_input", "请先选择供应商和图片模型。");
    const instance = await resolveInstanceImageProviderFromPayload(
      payload.provider_instance_id,
      ctx,
      {
        ...(job.session_id ? { sessionId: job.session_id } : {}),
        ...(job.thread_id ? { threadId: job.thread_id } : {}),
      },
    );
    if (!instance) throw jobError("invalid_input", "图片供应商不可用。");
    return completeMediaJob(
      job,
      await generateImage(job, payload, instance, ctx),
      ctx,
    );
  },
);
