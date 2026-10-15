import { createHash } from "node:crypto";
import type { BackgroundJob } from "@kenfutwork/shared";
import type { ExecutorContext } from "../job-executor.js";
/** 首产物沿用Job身份；后续产物用Job命名空间生成稳定UUID，恢复时不创建新资产。 */
export function generatedOutputId(jobId: string, index: number): string {
  if (index === 0) return jobId;
  const bytes = createHash("sha1")
    .update(Buffer.from(jobId.replaceAll("-", ""), "hex"))
    .update(String(index))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** ProjectFile prepare owns asset registration; standalone retains its explicit blob-only path. */
export async function publishGeneratedFile(
  job: BackgroundJob,
  buffer: Buffer,
  mimeType: string,
  extension: string,
  ctx: ExecutorContext,
  outputId = job.id,
) {
  const target = await ctx.generationTargets.resolve(job);
  const bucket = ctx.blob.bucket("project-assets");
  if (target) {
    const receipt = await ctx.projectFiles.prepareWrite(
      { instanceId: job.instance_id, accessClientId: job.created_by_client_id },
      {
        target,
        assetId: outputId,
        relativePath: `${outputId}.${extension}`,
        mimeType,
        writeFingerprint: createHash("sha256").update(buffer).digest("hex"),
      },
    );
    await ctx.generationTargets.resolve(job);
    await bucket.upload(receipt.objectPath, buffer, {
      contentType: mimeType,
      upsert: true,
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
  const objectPath = `${job.instance_id}/generated/${outputId}.${extension}`;
  // 先认领稳定资产身份及内容指纹，再允许相同字节重放存储。
  const assetId = await ctx.assetWriter.recordGeneratedAsset({
    assetId: outputId,
    contentFingerprint: createHash("sha256").update(buffer).digest("hex"),
    byteSize: buffer.length,
    mimeType,
    objectPath,
    instanceId: job.instance_id,
    ...(job.created_by_client_id
      ? { createdByClientId: job.created_by_client_id }
      : {}),
  });
  await ctx.generationTargets.resolve(job);
  await bucket.upload(objectPath, buffer, {
    contentType: mimeType,
    upsert: true,
  });
  return { assetId, objectPath, url: await bucket.resolveUrl(objectPath) };
}
