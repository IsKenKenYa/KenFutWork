import { expect, it, vi } from "vitest";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createUsageRepository } from "../usage/repository.js";
import { createUsageService } from "../usage/usage-service.js";
import { registerExecutor } from "./job-executor.js";
import { startJobLoop } from "./job-loop.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";

it.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")(
  "真实Job消费并发重放8条usage只累计一次",
  async () => {
    const db = await createTaskWorkDatabase({
      stopAtMigration: "20261015130000",
    });
    const queue = createInProcessQueue();
    const generationTargets = createGenerationTargets({
      persistence: db.persistence,
      executionScopes: createExecutionScopes({
        repository: createScopeRepository(db.persistence),
        localInstance: db.localInstance,
      }),
    });
    const jobs = createJobService({
      queue,
      generationTargets,
      repository: createJobRepository(db.persistence),
      localInstance: db.localInstance,
    });
    const usage = createUsageService({
      repository: createUsageRepository(db.persistence),
      localInstance: db.localInstance,
    });
    const job = await jobs.createJob(db.actor, {
      jobType: "image_generation",
      payload: { prompt: "模拟图片" },
    });
    registerExecutor("image_generation", async (jobId) => {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          usage.record({
            instanceId: db.actor.instanceId,
            provider: "controlled-test",
            model: "image",
            capability: "image",
            jobId,
            costUsd: 0.125,
          }),
        ),
      );
      return { usage_recorded: true };
    });
    const loop = startJobLoop(
      {
        queue,
        jobService: jobs,
        generationTargets,
        usageService: usage,
        blob: {} as never,
        assetWriter: {} as never,
        projectFiles: {} as never,
        env: {
          agentBackendMode: "state",
          agentModel: "test",
          port: 0,
          version: "test",
          webOrigin: "http://127.0.0.1",
          workerPollIntervalMs: 1000,
        },
      },
      { queues: ["image_generation_jobs"] },
    );
    try {
      await vi.waitFor(async () =>
        expect((await jobs.getJob(db.actor, job.id)).status).toBe("succeeded"),
      );
      expect((await usage.summarize(db.actor)).totals.costUsd).toBe(0.125);
    } finally {
      await loop.shutdown();
      await db.close();
    }
  },
  30_000,
);
