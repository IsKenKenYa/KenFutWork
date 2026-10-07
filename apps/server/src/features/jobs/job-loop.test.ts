import { describe, expect, it, vi } from "vitest";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import { startJobLoop } from "./job-loop.js";
import { JobServiceError } from "./job-service.js";

const { execute } = vi.hoisted(() => ({
  execute: vi.fn(async () => ({ url: "done" })),
}));
vi.mock("./job-executor.js", () => ({
  getExecutor: () => execute,
  registerExecutor() {},
}));

describe("本地任务消费终态", () => {
  it.each(["canceled", "succeeded", "dead_letter"])(
    "迟到消息不会重新执行%s任务",
    async (status) => {
      execute.mockClear();
      const queue = createInProcessQueue();
      const archive = vi.spyOn(queue, "archive");
      const incrementAttempt = vi.fn();
      await queue.send("image_generation_jobs", {
        job_id: "job-1",
        job_type: "image_generation",
      });
      const loop = startJobLoop(
        {
          queue,
          env: {
            agentBackendMode: "state",
            agentModel: "test",
            port: 0,
            version: "test",
            webOrigin: "http://127.0.0.1",
          },
          jobService: {
            getJobForWorker: async () => ({ status }),
            incrementAttempt,
          } as never,
          blob: {} as never,
          assetWriter: {} as never,
        },
        { queues: ["image_generation_jobs"] },
      );
      try {
        await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());
        expect(execute).not.toHaveBeenCalled();
        expect(incrementAttempt).not.toHaveBeenCalled();
      } finally {
        await loop.shutdown();
      }
    },
  );

  it("任务删除后的迟到消息被归档，供应商不接到第二次提交", async () => {
    execute.mockClear();
    const queue = createInProcessQueue();
    const archive = vi.spyOn(queue, "archive");
    await queue.send("video_generation_jobs", {
      job_id: "deleted-job",
      job_type: "video_generation",
    });
    const loop = startJobLoop(
      {
        queue,
        env: {
          agentBackendMode: "state",
          agentModel: "test",
          port: 0,
          version: "test",
          webOrigin: "http://127.0.0.1",
        },
        jobService: {
          getJobForWorker: async () => {
            throw new JobServiceError("job_not_found", "任务已删除", 404);
          },
        } as never,
        blob: {} as never,
        assetWriter: {} as never,
      },
      { queues: ["video_generation_jobs"] },
    );
    try {
      await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await loop.shutdown();
    }
  });
});
