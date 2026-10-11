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
  it("并发达到上限时等待任务收尾，让任务异步工作获得事件循环", async () => {
    execute.mockClear();
    const queue = createInProcessQueue();
    let firstFinished = false;
    execute.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      firstFinished = true;
      return { url: "first" };
    });
    await queue.send("image_generation_jobs", {
      job_id: "first-job",
      job_type: "image_generation",
    });
    await queue.send("image_generation_jobs", {
      job_id: "second-job",
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
          workerImageConcurrency: 1,
        },
        jobService: {
          getJobForWorker: async () => ({ status: "queued" }),
          incrementAttempt: async () => ({ attempt_count: 1, max_attempts: 3 }),
          markRunning: async () => {},
          markSucceeded: async () => {},
        } as never,
        blob: {} as never,
        assetWriter: {} as never,
      },
      { queues: ["image_generation_jobs"] },
    );
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      expect(firstFinished).toBe(true);
    } finally {
      await loop.shutdown();
    }
  });

  it("外部关闭队列后停止读取，不会对已关闭的空队列自旋", async () => {
    execute.mockClear();
    const queue = createInProcessQueue();
    const readWithPoll = vi.spyOn(queue, "readWithPoll");
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
        jobService: {} as never,
        blob: {} as never,
        assetWriter: {} as never,
      },
      { queues: ["image_generation_jobs"] },
    );
    try {
      expect(readWithPoll).toHaveBeenCalledOnce();
      await queue.shutdown();
      await Promise.resolve();
      await Promise.resolve();
      expect(readWithPoll).toHaveBeenCalledTimes(2);
    } finally {
      await loop.shutdown();
    }
  });

  it("并发与重复shutdown共享同一Promise，等待实际inflight收尾后只关闭队列一次", async () => {
    execute.mockClear();
    const queue = createInProcessQueue();
    const shutdown = vi.spyOn(queue, "shutdown");
    const deleted = vi.spyOn(queue, "deleteMessage");
    const succeeded = vi.fn(async () => {});
    let finish: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    execute.mockImplementationOnce(async () => {
      await held;
      return { url: "done" };
    });
    await queue.send("image_generation_jobs", {
      job_id: "held-job",
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
          getJobForWorker: async () => ({ status: "queued" }),
          incrementAttempt: async () => ({ attempt_count: 1, max_attempts: 3 }),
          markRunning: async () => {},
          markSucceeded: succeeded,
        } as never,
        blob: {} as never,
        assetWriter: {} as never,
      },
      { queues: ["image_generation_jobs"] },
    );
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(loop.inFlightCount()).toBe(1);
      const first = loop.shutdown();
      expect(loop.shutdown()).toBe(first);
      expect(shutdown).not.toHaveBeenCalled();
      finish();
      await first;
      expect(succeeded).toHaveBeenCalledOnce();
      expect(deleted).toHaveBeenCalledOnce();
      expect(loop.inFlightCount()).toBe(0);
      expect(loop.shutdown()).toBe(first);
      await loop.shutdown();
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      finish();
      await loop.shutdown();
    }
  });
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
