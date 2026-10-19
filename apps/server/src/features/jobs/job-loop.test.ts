import { describe, expect, it, vi } from "vitest";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import type { JobExecutor } from "./job-executor.js";
import { startJobLoop } from "./job-loop.js";
import { JobServiceError } from "./job-service.js";

const { execute } = vi.hoisted(() => ({
  execute: vi.fn<JobExecutor>(async () => ({ url: "done" })),
}));

type ExecutorStep = "pending" | "transient" | "success";

async function pollBudgetFixture(steps: ExecutorStep[]) {
  let clock = 0;
  let attempts = 0;
  let status = "queued";
  let finish: (status: string) => void = () => {};
  const finished = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const queue = createInProcessQueue({ now: () => clock });
  const queueName = "video_generation_jobs";
  const message = { job_id: "long-video", job_type: "video_generation" };
  const incrementAttempt = vi.fn(async () => ({
    attempt_count: ++attempts,
    max_attempts: 3,
  }));
  const markFailed = vi.fn(async () => {
    status = "failed";
    clock += 301_000;
  });
  const markDeadLetter = vi.fn(async () => {
    status = "dead_letter";
    finish(status);
  });
  execute.mockReset();
  execute.mockImplementation(async (_jobId, _payload, context) => {
    const step = steps.shift();
    if (step === "pending") {
      await context.queue.send(queueName, message);
      throw Object.assign(new Error("查询已排程"), {
        code: "provider_poll_scheduled",
      });
    }
    if (step === "transient") {
      throw Object.assign(new Error("厂商查询暂时失败"), {
        code: "network_error",
      });
    }
    if (step !== "success") throw new Error("测试执行步骤已耗尽");
    return { url: "https://assets.example/final.mp4" };
  });
  await queue.send(queueName, message);
  const loop = startJobLoop(
    {
      queue,
      env: {
        agentBackendMode: "state",
        agentModel: "test",
        port: 0,
        version: "test",
        webOrigin: "http://127.0.0.1",
        workerVideoConcurrency: 1,
      },
      jobService: {
        recoverPendingJobs: async () => {},
        claimJob: async () => ({ status: "running" }),
        renewLease: async () => true,
        releaseLease: async () => {},
        getJobForWorker: async () => ({
          status,
          payload: {},
          provider_job_id: "cloud-test",
          attempt_count: attempts,
        }),
        retryJob: async () => {
          await markFailed();
          await queue.send(queueName, message);
        },
        incrementAttempt,
        markRunning: async () => {
          status = "running";
        },
        markSucceeded: async () => {
          status = "succeeded";
          finish(status);
        },
        markFailed,
        markDeadLetter,
      } as never,
      blob: {} as never,
      projectFiles: {} as never,
      generationTargets: {} as never,
      assetWriter: {} as never,
    },
    { queues: [queueName] },
  );
  return { loop, finished, incrementAttempt, markFailed, markDeadLetter };
}
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
          recoverPendingJobs: async () => {},
          claimJob: async () => ({ status: "running" }),
          renewLease: async () => true,
          releaseLease: async () => {},
          getJobForWorker: async () => ({ status: "queued" }),
          incrementAttempt: async () => ({ attempt_count: 1, max_attempts: 3 }),
          markRunning: async () => {},
          markSucceeded: async () => {},
        } as never,
        blob: {} as never,
        projectFiles: {} as never,
        generationTargets: {} as never,
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
        jobService: {
          recoverPendingJobs: async () => {},
        } as never,
        blob: {} as never,
        projectFiles: {} as never,
        generationTargets: {} as never,
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
          recoverPendingJobs: async () => {},
          claimJob: async () => ({ status: "running" }),
          renewLease: async () => true,
          releaseLease: async () => {},
          getJobForWorker: async () => ({ status: "queued" }),
          incrementAttempt: async () => ({ attempt_count: 1, max_attempts: 3 }),
          markRunning: async () => {},
          markSucceeded: succeeded,
        } as never,
        blob: {} as never,
        projectFiles: {} as never,
        generationTargets: {} as never,
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
            recoverPendingJobs: async () => {},
            claimJob: async () => ({ status: "running" }),
            renewLease: async () => true,
            releaseLease: async () => {},
            getJobForWorker: async () => ({ status, payload: {} }),
            incrementAttempt,
          } as never,
          blob: {} as never,
          projectFiles: {} as never,
          generationTargets: {} as never,
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
          recoverPendingJobs: async () => {},
          claimJob: async () => ({ status: "running" }),
          renewLease: async () => true,
          releaseLease: async () => {},
          getJobForWorker: async () => {
            throw new JobServiceError("job_not_found", "任务已删除", 404);
          },
        } as never,
        blob: {} as never,
        projectFiles: {} as never,
        generationTargets: {} as never,
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

describe("异步生成查询与失败预算", () => {
  it("正常查询超过失败上限后，首次瞬态错误仍可重试并取得成功结果", async () => {
    const f = await pollBudgetFixture([
      "pending",
      "pending",
      "pending",
      "pending",
      "transient",
      "success",
    ]);
    try {
      expect(await f.finished).toBe("succeeded");
      expect(f.incrementAttempt).toHaveBeenCalledTimes(1);
      expect(f.markFailed).toHaveBeenCalledTimes(1);
      expect(f.markDeadLetter).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(6);
    } finally {
      await f.loop.shutdown();
    }
  });

  it("反复返回进行中只排程下一次查询，不增加失败预算", async () => {
    const f = await pollBudgetFixture([
      "pending",
      "pending",
      "pending",
      "pending",
      "success",
    ]);
    try {
      expect(await f.finished).toBe("succeeded");
      expect(f.incrementAttempt).not.toHaveBeenCalled();
      expect(f.markFailed).not.toHaveBeenCalled();
      expect(f.markDeadLetter).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(5);
    } finally {
      await f.loop.shutdown();
    }
  });

  it("真实瞬态错误累计达到上限才死信，不进行第四次请求", async () => {
    const f = await pollBudgetFixture([
      "transient",
      "transient",
      "transient",
      "success",
    ]);
    try {
      expect(await f.finished).toBe("dead_letter");
      expect(f.incrementAttempt).toHaveBeenCalledTimes(3);
      expect(f.markFailed).toHaveBeenCalledTimes(2);
      expect(f.markDeadLetter).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(3);
    } finally {
      await f.loop.shutdown();
    }
  });
});

it("租约占用时保留原队列消息，不能吞掉失败后的唯一重试唤醒", async () => {
  execute.mockReset();
  const queue = createInProcessQueue();
  const archive = vi.spyOn(queue, "archive");
  const postpone = vi.spyOn(queue, "setVisibilityTimeout");
  await queue.send("image_generation_jobs", {
    job_id: "leased",
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
        recoverPendingJobs: async () => {},
        getJobForWorker: async () => ({ status: "running" }),
        claimJob: async () => null,
      } as never,
      blob: {} as never,
      projectFiles: {} as never,
      generationTargets: {} as never,
      assetWriter: {} as never,
    },
    { queues: ["image_generation_jobs"] },
  );
  try {
    await vi.waitFor(() => expect(postpone).toHaveBeenCalled());
    expect(archive).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await loop.shutdown();
  }
});

it("失租后不再越过成果发布边界，也不消耗失败次数", async () => {
  const queue = createInProcessQueue();
  const publish = vi.fn();
  const resolve = vi.fn(async () => null);
  const incrementAttempt = vi.fn();
  execute.mockImplementationOnce(async (_id, _payload, context) => {
    await context.generationTargets.resolve({} as never);
    publish();
    return { url: "late" };
  });
  await queue.send("image_generation_jobs", {
    job_id: "lost",
    job_type: "image_generation",
  });
  const released = vi.fn(async () => {});
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
        recoverPendingJobs: async () => {},
        getJobForWorker: async () => ({ status: "running" }),
        claimJob: async () => ({ status: "running" }),
        renewLease: async () => false,
        releaseLease: released,
        incrementAttempt,
      } as never,
      blob: {} as never,
      projectFiles: {} as never,
      generationTargets: { resolve } as never,
      assetWriter: {} as never,
    },
    { queues: ["image_generation_jobs"] },
  );
  try {
    await vi.waitFor(() => expect(released).toHaveBeenCalled());
    expect(publish).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(incrementAttempt).not.toHaveBeenCalled();
  } finally {
    await loop.shutdown();
  }
});

it("空视频队列不阻塞连续图片请求同时进入执行", async () => {
  execute.mockReset();
  const queue = createInProcessQueue();
  let finish: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  execute.mockImplementation(async () => {
    await held;
    return { url: "done" };
  });
  for (let index = 0; index < 8; index++)
    await queue.send("image_generation_jobs", {
      job_id: `parallel-${index}`,
      job_type: "image_generation",
    });
  const loop = startJobLoop({
    queue,
    env: {
      agentBackendMode: "state",
      agentModel: "test",
      port: 0,
      version: "test",
      webOrigin: "http://127.0.0.1",
      workerPollIntervalMs: 1000,
    },
    jobService: {
      recoverPendingJobs: async () => {},
      claimJob: async () => ({ status: "running" }),
      renewLease: async () => true,
      releaseLease: async () => {},
      getJobForWorker: async () => ({ status: "queued" }),
      markSucceeded: async () => {},
    } as never,
    blob: {} as never,
    projectFiles: {} as never,
    generationTargets: {} as never,
    assetWriter: {} as never,
  });
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(8), {
      timeout: 1500,
    });
    expect(loop.inFlightCount()).toBe(8);
  } finally {
    finish();
    await loop.shutdown();
  }
});
