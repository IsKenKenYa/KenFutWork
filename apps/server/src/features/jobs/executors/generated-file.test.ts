import { createHash, randomUUID } from "node:crypto";
import { backgroundJobSchema } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import type { ProjectFileTarget } from "../../project-files/types.js";
import type { ExecutorContext } from "../job-executor.js";
import { publishGeneratedFile } from "./generated-file.js";

function fixture(project: boolean) {
  const projectId = randomUUID();
  const job = backgroundJobSchema.parse({
    id: randomUUID(),
    instance_id: randomUUID(),
    project_id: null,
    session_id: null,
    canvas_id: null,
    thread_id: null,
    file_target: project
      ? { kind: "project", projectId, sessionId: null, canvasId: null }
      : { kind: "standalone" },
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "running",
    payload: {},
    result: null,
    error_code: null,
    error_message: null,
    provider_job_id: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by_client_id: null,
    created_at: "now",
    updated_at: "now",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  });
  const prepareWrite = vi.fn(async () => ({
    assetId: job.id,
    objectPath: `project-files/${job.id}`,
    relativePath: `${job.id}.png`,
    bucket: "project-assets",
  }));
  const upload = vi.fn(async () => {}),
    record = vi.fn(async () => "standalone-asset");
  const resolve = vi.fn(
    async (): Promise<ProjectFileTarget | null> =>
      project ? { kind: "project", projectId } : null,
  );
  const ctx = {
    generationTargets: { resolve },
    projectFiles: { prepareWrite },
    assetWriter: { recordGeneratedAsset: record },
    blob: {
      bucket: () => ({
        upload,
        resolveUrl: async (path: string) => `url:${path}`,
      }),
    },
  } as unknown as ExecutorContext;
  return { job, ctx, prepareWrite, upload, record, resolve };
}
it("项目生成消费receipt落普通根目录文件，资产只由prepare登记", async () => {
  const { job, ctx, prepareWrite, upload, record, resolve } = fixture(true);
  const bytes = Buffer.from("actual image bytes");
  const result = await publishGeneratedFile(
    job,
    bytes,
    "image/png",
    "png",
    ctx,
  );
  expect(prepareWrite).toHaveBeenCalledWith(
    { instanceId: job.instance_id, accessClientId: null },
    expect.objectContaining({
      assetId: job.id,
      relativePath: `${job.id}.png`,
      writeFingerprint: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  expect(upload).toHaveBeenCalledWith(result.objectPath, bytes, {
    contentType: "image/png",
    upsert: false,
  });
  expect(record).not.toHaveBeenCalled();
  expect(resolve).toHaveBeenCalledTimes(3);
});
it("真正独立来源保持blob支路，有关联的无目标结果不可回退", async () => {
  const { job, ctx, prepareWrite, record } = fixture(false);
  expect(
    (
      await publishGeneratedFile(
        job,
        Buffer.from("image"),
        "image/png",
        "png",
        ctx,
      )
    ).assetId,
  ).toBe("standalone-asset");
  expect(record).toHaveBeenCalledTimes(1);
  expect(prepareWrite).not.toHaveBeenCalled();
  await expect(
    publishGeneratedFile(
      { ...job, project_id: randomUUID() },
      Buffer.from("image"),
      "image/png",
      "png",
      ctx,
    ),
  ).rejects.toThrow("不能退回");
});

it("prepare后来源失效，upload前再验证拒绝发布，不走standalone", async () => {
  const { job, ctx, resolve, upload, record } = fixture(true);
  resolve.mockResolvedValueOnce({
    kind: "project",
    projectId:
      job.file_target!.kind === "project"
        ? job.file_target!.projectId
        : randomUUID(),
  });
  resolve.mockRejectedValueOnce(new Error("原Run授权已撤销"));
  await expect(
    publishGeneratedFile(job, Buffer.from("image"), "image/png", "png", ctx),
  ).rejects.toThrow("撤销");
  expect(upload).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

it("文件写入期间撤权，保留原文件但不发布成功结果或自动重放", async () => {
  const { job, ctx, resolve, upload, record } = fixture(true);
  upload.mockImplementationOnce(async () => {
    resolve.mockRejectedValueOnce(new Error("原Run授权已撤销"));
  });
  await expect(
    publishGeneratedFile(job, Buffer.from("video"), "video/mp4", "mp4", ctx),
  ).rejects.toThrow("撤销");
  expect(upload).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
});
