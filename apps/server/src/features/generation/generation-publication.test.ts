import { randomUUID } from "node:crypto";
import { backgroundJobSchema } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import type { ExecutorContext } from "../jobs/job-executor.js";
import { publishGeneratedCanvas } from "./generation-publication.js";

function fixture() {
  const canvasId = randomUUID(),
    projectId = randomUUID(),
    sessionId = randomUUID(),
    taskId = randomUUID();
  const target = {
    kind: "task",
    canvasId,
    projectId,
    sessionId,
    taskId,
    scopeGeneration: 3,
    branchGeneration: 4,
  };
  const job = backgroundJobSchema.parse({
    id: randomUUID(),
    instance_id: randomUUID(),
    project_id: projectId,
    session_id: sessionId,
    canvas_id: canvasId,
    thread_id: null,
    file_target: target,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "running",
    payload: {
      title: "实际成果",
      placement: { x: 3, y: 4, width: 20, height: 30 },
    },
    result: null,
    error_code: null,
    error_message: null,
    provider_job_id: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by_client_id: null,
    created_at: "now",
    updated_at: "now",
    started_at: "now",
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  });
  const result = {
    object_path: "verified-project-file",
    width: 100,
    height: 200,
    mime_type: "image/png",
  };
  const origin = new AbortController();
  const insertImageElement = vi.fn(
    async (_actor: unknown, _request: unknown, guard?: () => Promise<void>) => {
      await guard?.();
      return { elementId: "published-element" };
    },
  );
  const ctx = {
    canvas: { insertImageElement, insertVideoElement: vi.fn() },
    generationTargets: {
      withOriginLock: async (
        _job: unknown,
        operation: (signal: AbortSignal) => Promise<unknown>,
      ) => operation(origin.signal),
    },
  } as unknown as Pick<ExecutorContext, "canvas" | "generationTargets">;
  return {
    job,
    result,
    ctx,
    insertImageElement,
    abortOrigin: () => origin.abort(new Error("来源事务已中断")),
  };
}

it("后台结果按冻结Task和画布发布，带原Job幂等身份与placement，不依赖当前界面", async () => {
  const f = fixture();
  expect(await publishGeneratedCanvas(f.job, f.result, f.ctx)).toEqual({
    element_id: "published-element",
  });
  expect(f.insertImageElement).toHaveBeenCalledWith(
    { instanceId: f.job.instance_id, accessClientId: null },
    expect.objectContaining({
      canvasId:
        f.job.file_target?.kind === "task"
          ? f.job.file_target.canvasId
          : undefined,
      insertionId: f.job.id,
      title: "实际成果",
      placement: { x: 3, y: 4, width: 20, height: 30 },
      objectPath: "verified-project-file",
    }),
    expect.any(Function),
  );
});

it("来源事务中断后，最终写入guard阻止发布", async () => {
  const f = fixture();
  f.insertImageElement.mockImplementationOnce(
    async (_actor, _request, guard) => {
      f.abortOrigin();
      await guard?.();
      return { elementId: "must-not-publish" };
    },
  );
  await expect(publishGeneratedCanvas(f.job, f.result, f.ctx)).rejects.toThrow(
    "来源事务已中断",
  );
});

it("没有冻结画布只保存文件；有画布缺发布Provider明确失败", async () => {
  const f = fixture();
  const target = f.job.file_target;
  if (target?.kind !== "task") throw new Error("夹具目标不匹配");
  const { canvasId: _id, ...fileTarget } = target;
  expect(
    await publishGeneratedCanvas(
      { ...f.job, canvas_id: null, file_target: fileTarget },
      f.result,
      f.ctx,
    ),
  ).toEqual({});
  expect(f.insertImageElement).not.toHaveBeenCalled();
  const ctx = { ...f.ctx };
  delete ctx.canvas;
  await expect(publishGeneratedCanvas(f.job, f.result, ctx)).rejects.toThrow(
    "未接通",
  );
});
