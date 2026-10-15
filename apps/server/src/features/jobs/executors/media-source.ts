import type { BackgroundJob } from "@kenfutwork/shared";
import type { ExecutorContext } from "../job-executor.js";
import type { JobExecution } from "../job-progress.js";

export const mediaSourcePath = (job: BackgroundJob) =>
  `${job.instance_id}/job-checkpoints/${job.id}.bin`;

export async function storeInlineSource(
  job: BackgroundJob,
  bytes: Buffer,
  mime: string,
  ctx: ExecutorContext,
) {
  const path = mediaSourcePath(job);
  const bucket = ctx.blob.bucket("project-assets");
  try {
    const existing = await bucket.download(path);
    if (Buffer.compare(bytes, existing) !== 0)
      throw Object.assign(
        new Error("同一任务返回了不同的生成文件，请核对供应商结果。"),
        { code: "media_output_conflict" },
      );
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await ctx.assertExecution?.();
  await bucket.upload(path, bytes, { contentType: mime, upsert: false });
}

function missing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as {
    code?: string;
    status?: number;
    statusCode?: string | number;
    cause?: unknown;
  };
  return (
    details.code === "ENOENT" ||
    details.status === 404 ||
    Number(details.statusCode) === 404 ||
    (details.cause !== undefined && missing(details.cause))
  );
}

/** 已保存的暂存字节优先于短期上游URL；未知存储错误不能被当成文件不存在。 */
export async function loadMediaSource(
  job: BackgroundJob,
  execution: JobExecution,
  ctx: ExecutorContext,
) {
  const path = execution.sourceObjectPath ?? mediaSourcePath(job);
  const bucket = ctx.blob.bucket("project-assets");
  try {
    return Buffer.from(await bucket.download(path));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const generated = execution.generated;
  if (!generated || generated.url.startsWith("blob://"))
    throw Object.assign(new Error("生成文件尚未保存，请核对供应商结果。"), {
      code: "media_output_missing",
    });
  const response = await fetch(
    generated.url,
    ctx.signal ? { signal: ctx.signal } : {},
  );
  if (!response.ok)
    throw Object.assign(new Error("生成文件下载失败，请稍后重试。"), {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
    });
  const buffer = Buffer.from(await response.arrayBuffer());
  await ctx.assertExecution?.();
  await bucket.upload(path, buffer, {
    contentType: generated.mimeType,
    upsert: false,
  });
  return buffer;
}
