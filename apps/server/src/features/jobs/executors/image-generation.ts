import { type ExecutorContext, registerExecutor } from "../job-executor.js";
import { resolveJobMediaInputs } from "../job-inputs.js";
import { readJobExecution } from "../job-progress.js";
import { resolveInstanceImageProviderFromPayload } from "./instance-provider.js";
import { completeMediaJob } from "./media-result.js";

registerExecutor(
  "image_generation",
  async (jobId, _message, ctx: ExecutorContext) => {
    const job = await ctx.jobService.getJobForWorker(jobId);
    await ctx.generationTargets.resolve(job);
    const execution = readJobExecution(job);
    if (execution.generated || execution.stored)
      return completeMediaJob(job, undefined, ctx);

    const payload = job.payload as {
      prompt: string;
      model?: string;
      provider_instance_id?: string;
      aspect_ratio?: string;
      quality?: "standard" | "hd" | "ultra";
      output_format?: "png" | "jpg" | "webp";
    };
    if (!payload.prompt || !payload.model || !payload.provider_instance_id)
      throw Object.assign(new Error("请先选择供应商和图片模型。"), {
        code: "invalid_input",
      });
    const provider = await resolveInstanceImageProviderFromPayload(
      payload.provider_instance_id,
      ctx,
      {
        ...(job.session_id ? { sessionId: job.session_id } : {}),
        ...(job.thread_id ? { threadId: job.thread_id } : {}),
      },
    );
    if (!provider)
      throw Object.assign(new Error("图片供应商不可用。"), {
        code: "invalid_input",
      });
    const references = await resolveJobMediaInputs(job, ctx.uploads);
    await ctx.assertExecution?.();
    await ctx.jobService.saveExecution(jobId, { phase: "submitting" });
    const generated = await provider.generate({
      prompt: payload.prompt,
      model: payload.model,
      ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
      ...(payload.quality ? { quality: payload.quality } : {}),
      ...(payload.output_format ? { outputFormat: payload.output_format } : {}),
      ...references,
    });
    return completeMediaJob(job, generated, ctx);
  },
);
