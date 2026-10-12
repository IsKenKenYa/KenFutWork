import { createHash } from "node:crypto";
import type { BackgroundJob } from "@kenfutwork/shared";
import type { ExecutorContext } from "../job-executor.js";
/** ProjectFile prepare owns asset registration; standalone retains its explicit blob-only path. */
export async function publishGeneratedFile(
  job: BackgroundJob,
  buffer: Buffer,
  mimeType: string,
  extension: string,
  ctx: ExecutorContext,
) {
  const target = await ctx.generationTargets.resolve(job);
  const bucket = ctx.blob.bucket("project-assets");
  if (target) {
    const receipt = await ctx.projectFiles.prepareWrite(
      { instanceId: job.instance_id, accessClientId: job.created_by_client_id },
      {
        target,
        assetId: job.id,
        relativePath: `${job.id}.${extension}`,
        mimeType,
        writeFingerprint: createHash("sha256").update(buffer).digest("hex"),
      },
    );
    await ctx.generationTargets.resolve(job);
    await bucket.upload(receipt.objectPath, buffer, {
      contentType: mimeType,
      upsert: false,
    });
    await ctx.generationTargets.resolve(job);
    return {
      assetId: receipt.assetId,
      objectPath: receipt.objectPath,
      url: await bucket.resolveUrl(receipt.objectPath),
    };
  }
  if (job.project_id || job.session_id || job.canvas_id)
    throw new Error("有关联的生成任务不能退回独立文件存储");
  const objectPath = `${job.instance_id}/generated/${Date.now()}-${job.id}.${extension}`;
  await bucket.upload(objectPath, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  const assetId = await ctx.assetWriter.recordGeneratedAsset({
    byteSize: buffer.length,
    mimeType,
    objectPath,
    instanceId: job.instance_id,
    ...(job.created_by_client_id
      ? { createdByClientId: job.created_by_client_id }
      : {}),
  });
  return { assetId, objectPath, url: await bucket.resolveUrl(objectPath) };
}
