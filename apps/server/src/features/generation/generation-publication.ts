import {
  type BackgroundJob,
  generationFileTargetSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { ExecutorContext } from "../jobs/job-executor.js";

const placementSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
});

/** 后台结果在原冻结文档发布，与会话轮询或当前界面无关。 */
export async function publishGeneratedCanvas(
  job: BackgroundJob,
  result: Record<string, unknown>,
  ctx: Pick<ExecutorContext, "canvas" | "generationTargets" | "jobService">,
  publicationId: string = job.id,
): Promise<{ element_id?: string }> {
  const target = generationFileTargetSchema.parse(job.file_target);
  if (target.kind === "standalone" || !target.canvasId) return {};
  const canvas = ctx.canvas,
    canvasId = target.canvasId;
  if (!canvas) throw new Error("画布成果发布服务未接通，请检查工作节点配置。 ");
  return ctx.generationTargets.withOriginLock(job, async (signal) => {
    const guard = async () => {
      signal.throwIfAborted();
      const current = await ctx.jobService.getJobForWorker(job.id);
      if (current.status === "canceled" || current.status === "failed")
        throw new Error("生成任务已停止，结果不会发布到画布。 ");
      await ctx.generationTargets.resolve(current);
      const original = generationFileTargetSchema.parse(current.file_target);
      if (JSON.stringify(original) !== JSON.stringify(target))
        throw new Error("生成任务的冻结来源已改变。 ");
      signal.throwIfAborted();
    };
    await guard();
    const actor = {
      instanceId: job.instance_id,
      accessClientId: job.created_by_client_id,
    };
    const payload = job.payload as Record<string, unknown>;
    const placement =
      payload.placement === undefined
        ? undefined
        : placementSchema.parse(payload.placement);
    const mimeType =
      typeof result.mime_type === "string"
        ? result.mime_type
        : job.job_type === "image_generation"
          ? "image/png"
          : "video/mp4";
    const title = typeof payload.title === "string" ? payload.title : undefined;
    if (job.job_type === "image_generation") {
      if (
        typeof result.object_path !== "string" ||
        typeof result.width !== "number" ||
        typeof result.height !== "number"
      )
        throw new Error("生成图片缺少文件或尺寸，无法放入画布。 ");
      const inserted = await canvas.insertImageElement(
        actor,
        {
          canvasId,
          insertionId: publicationId,
          objectPath: result.object_path,
          width: result.width,
          height: result.height,
          mimeType,
          ...(title ? { title } : {}),
          ...(placement ? { placement } : {}),
        },
        guard,
      );
      return { element_id: inserted.elementId };
    }
    if (
      typeof result.signed_url !== "string" ||
      typeof result.asset_id !== "string"
    )
      throw new Error("生成视频缺少文件引用，无法放入画布。 ");
    const inserted = await canvas.insertVideoElement(
      actor,
      {
        canvasId,
        insertionId: publicationId,
        assetId: result.asset_id,
        signedUrl: result.signed_url,
        width: typeof result.width === "number" ? result.width : 640,
        height: typeof result.height === "number" ? result.height : 360,
        mimeType,
        ...(title ? { title } : {}),
        ...(placement ? { placement } : {}),
        ...(typeof payload.prompt === "string"
          ? { prompt: payload.prompt }
          : {}),
        ...(typeof result.duration_seconds === "number"
          ? { durationSeconds: result.duration_seconds }
          : {}),
      },
      guard,
    );
    return { element_id: inserted.elementId };
  });
}
