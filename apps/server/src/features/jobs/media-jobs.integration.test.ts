import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createUploadRepository } from "../uploads/repository.js";
import {
  createUploadService,
  type UploadService,
} from "../uploads/upload-service.js";
import { registerExecutor } from "./job-executor.js";
import { startJobLoop } from "./job-loop.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")(
  "媒体Job真实数据库生命周期",
  () => {
    let db: Awaited<ReturnType<typeof createTaskWorkDatabase>>;
    beforeAll(async () => {
      db = await createTaskWorkDatabase();
    }, 30_000);
    afterAll(async () => {
      await db?.close();
    });
    function fixture(uploads?: UploadService) {
      const queue = createInProcessQueue();
      const jobs = createJobService({
        ...(uploads ? { uploads } : {}),
        queue,
        localInstance: db.localInstance,
        repository: createJobRepository(db.persistence),
        generationTargets: createGenerationTargets({
          persistence: db.persistence,
          executionScopes: createExecutionScopes({
            repository: createScopeRepository(db.persistence),
            localInstance: db.localInstance,
          }),
        }),
      });
      return { jobs, queue };
    }

    it("重复消费只有一个worker取得执行租约，迟到token不能改写结果", async () => {
      const { jobs, queue } = fixture();
      try {
        const job = await jobs.createJob(db.actor, {
          jobType: "image_generation",
          payload: { prompt: "猫" },
        });
        const tokens = Array.from({ length: 8 }, () => randomUUID());
        const claimed = await Promise.all(
          tokens.map((token) => jobs.claimJob(job.id, token, 120)),
        );
        expect(claimed.filter(Boolean)).toHaveLength(1);
        const owner = tokens[claimed.findIndex(Boolean)];
        if (!owner) throw new Error("没有认领者");
        await expect(
          jobs.markSucceeded(job.id, { url: "stale" }, randomUUID()),
        ).rejects.toMatchObject({ code: "job_lease_lost" });
        expect((await jobs.getJob(db.actor, job.id)).status).toBe("running");
        await jobs.markSucceeded(job.id, { url: "winner" }, owner);
        expect(await jobs.getJob(db.actor, job.id)).toMatchObject({
          status: "succeeded",
          result: { url: "winner" },
        });
      } finally {
        await queue.shutdown();
      }
    });

    it("租约过期换worker后，旧执行者不能覆盖新执行者", async () => {
      const { jobs, queue } = fixture();
      try {
        const job = await jobs.createJob(db.actor, {
          jobType: "video_generation",
          payload: { prompt: "猫" },
        });
        const first = randomUUID(),
          second = randomUUID();
        expect(await jobs.claimJob(job.id, first, 0.05)).not.toBeNull();
        await jobs.setProviderJobId(job.id, "original-provider", first);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(await jobs.claimJob(job.id, second, 120)).not.toBeNull();
        expect(await jobs.renewLease(job.id, first, 120)).toBe(false);
        await expect(
          jobs.setProviderJobId(job.id, "stale-provider", first),
        ).rejects.toMatchObject({ code: "job_lease_lost" });
        await jobs.setProviderJobId(job.id, "current-provider", second);
        await expect(
          jobs.markSucceeded(job.id, { url: "stale" }, first),
        ).rejects.toMatchObject({ code: "job_lease_lost" });
        await jobs.markSucceeded(job.id, { url: "current" }, second);
        expect(await jobs.getJob(db.actor, job.id)).toMatchObject({
          status: "succeeded",
          provider_job_id: "current-provider",
          result: { url: "current" },
        });
      } finally {
        await queue.shutdown();
      }
    });

    it("两个消费循环读取重复消息，供应商只收到一次执行", async () => {
      const { jobs, queue } = fixture();
      const job = await jobs.createJob(db.actor, {
        jobType: "image_generation",
        payload: { prompt: "猫" },
      });
      for (let index = 0; index < 7; index++)
        await queue.send("image_generation_jobs", {
          job_id: job.id,
          job_type: "image_generation",
        });
      let finish: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const execute = vi.fn(async () => {
        await held;
        return { url: "done" };
      });
      registerExecutor("image_generation", execute);
      const context = {
        queue,
        jobService: jobs,
        env: {
          agentBackendMode: "state" as const,
          agentModel: "test",
          port: 0,
          version: "test",
          webOrigin: "http://127.0.0.1",
          workerImageConcurrency: 4,
        },
        blob: {} as never,
        projectFiles: {} as never,
        generationTargets: {} as never,
        assetWriter: {} as never,
      };
      const first = startJobLoop(context, {
        queues: ["image_generation_jobs"],
      });
      const second = startJobLoop(context, {
        queues: ["image_generation_jobs"],
      });
      try {
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(execute).toHaveBeenCalledOnce();
        finish();
        await vi.waitFor(async () =>
          expect((await jobs.getJob(db.actor, job.id)).status).toBe(
            "succeeded",
          ),
        );
      } finally {
        finish();
        await Promise.all([first.shutdown(), second.shutdown()]);
      }
    });

    it.each([
      ["image_generation", 8],
      ["video_generation", 5],
    ] as const)(
      "%s没有默认业务并发上限，%i个请求可同时在途",
      async (jobType, count) => {
        const { jobs, queue } = fixture();
        const accepted = await Promise.all(
          Array.from({ length: count }, () =>
            jobs.createJob(db.actor, { jobType, payload: { prompt: "猫" } }),
          ),
        );
        let finish: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const execute = vi.fn(async () => {
          await held;
          return { url: "done" };
        });
        registerExecutor(jobType, execute);
        const queueName =
          jobType === "image_generation"
            ? "image_generation_jobs"
            : "video_generation_jobs";
        const loop = startJobLoop(
          {
            queue,
            jobService: jobs,
            env: {
              agentBackendMode: "state",
              agentModel: "test",
              port: 0,
              version: "test",
              webOrigin: "http://127.0.0.1",
            },
            blob: {} as never,
            projectFiles: {} as never,
            generationTargets: {} as never,
            assetWriter: {} as never,
          },
          { queues: [queueName] },
        );
        try {
          await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(count));
          expect(loop.inFlightCount()).toBe(count);
          finish();
          await vi.waitFor(async () => {
            const states = await Promise.all(
              accepted.map((job) => jobs.getJob(db.actor, job.id)),
            );
            expect(states.every((job) => job.status === "succeeded")).toBe(
              true,
            );
          });
        } finally {
          finish();
          await loop.shutdown();
        }
      },
    );

    it("队列投递失败仍保留受理回执，重开后扫描恢复原Job", async () => {
      const initial = fixture();
      await initial.queue.shutdown();
      const accepted = await initial.jobs.createJob(db.actor, {
        requestId: randomUUID(),
        jobType: "image_generation",
        payload: { prompt: "猫" },
      });
      const resumed = fixture();
      const execute = vi.fn(async () => ({ url: "recovered" }));
      registerExecutor("image_generation", execute);
      const loop = startJobLoop(
        {
          queue: resumed.queue,
          jobService: resumed.jobs,
          env: {
            agentBackendMode: "state",
            agentModel: "test",
            port: 0,
            version: "test",
            webOrigin: "http://127.0.0.1",
          },
          blob: {} as never,
          projectFiles: {} as never,
          generationTargets: {} as never,
          assetWriter: {} as never,
        },
        { queues: ["image_generation_jobs"] },
      );
      try {
        await vi.waitFor(async () =>
          expect(
            await resumed.jobs.getJob(db.actor, accepted.id),
          ).toMatchObject({
            status: "succeeded",
            result: { url: "recovered" },
          }),
        );
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        await loop.shutdown();
      }
    });

    it("在途提交没有上游句柄时，重启只标待确认而不重发", async () => {
      const { jobs, queue } = fixture();
      try {
        const job = await jobs.createJob(db.actor, {
          jobType: "image_generation",
          payload: { prompt: "猫" },
        });
        const token = randomUUID();
        expect(await jobs.claimJob(job.id, token, 0.05)).not.toBeNull();
        await jobs.saveExecution(
          job.id,
          { phase: "submitting" },
          { leaseToken: token },
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        await jobs.recoverPendingJobs(["image_generation_jobs"], 1);
        expect(await jobs.getJob(db.actor, job.id)).toMatchObject({
          status: "failed",
          error_code: "submission_unknown",
        });
        expect(await jobs.claimJob(job.id, randomUUID(), 120)).toBeNull();
      } finally {
        await queue.shutdown();
      }
    });

    it("有上游句柄的延迟任务重开队列后仅续查，保留下一动作时间", async () => {
      const initial = fixture();
      const job = await initial.jobs.createJob(db.actor, {
        jobType: "video_generation",
        payload: { prompt: "猫" },
      });
      const token = randomUUID();
      await initial.jobs.claimJob(job.id, token, 120);
      await initial.jobs.setProviderJobId(
        job.id,
        "persisted-provider-operation",
        token,
      );
      await initial.jobs.scheduleJob(job.id, 0.1, token);
      await initial.jobs.releaseLease(job.id, token);
      await initial.queue.shutdown();
      const resumed = fixture();
      const execute = vi.fn(async () => {
        const current = await resumed.jobs.getJobForWorker(job.id);
        expect(current.provider_job_id).toBe("persisted-provider-operation");
        return { url: "resumed-video" };
      });
      registerExecutor("video_generation", execute);
      const loop = startJobLoop(
        {
          queue: resumed.queue,
          jobService: resumed.jobs,
          env: {
            agentBackendMode: "state",
            agentModel: "test",
            port: 0,
            version: "test",
            webOrigin: "http://127.0.0.1",
            workerPollIntervalMs: 1000,
          },
          blob: {} as never,
          projectFiles: {} as never,
          generationTargets: {} as never,
          assetWriter: {} as never,
        },
        { queues: ["video_generation_jobs"] },
      );
      try {
        expect(execute).not.toHaveBeenCalled();
        await vi.waitFor(
          async () =>
            expect((await resumed.jobs.getJob(db.actor, job.id)).status).toBe(
              "succeeded",
            ),
          { timeout: 3000 },
        );
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        await loop.shutdown();
      }
    });

    it("旧worker在认领检查期间释放租约，也不能重发无句柄请求", async () => {
      const { jobs, queue } = fixture();
      try {
        for (let index = 0; index < 6; index++) {
          const job = await jobs.createJob(db.actor, {
            jobType: "image_generation",
            payload: { prompt: "猫" },
          });
          const first = randomUUID();
          await jobs.claimJob(job.id, first, 120);
          await jobs.saveExecution(
            job.id,
            { phase: "submitting" },
            { leaseToken: first },
          );
          const [replacement] = await Promise.all([
            jobs.claimJob(job.id, randomUUID(), 120),
            jobs.releaseLease(job.id, first),
          ]);
          expect(replacement).toBeNull();
        }
      } finally {
        await queue.shutdown();
      }
    });

    it("参考图持久保存为素材引用，Job不保存base64", async () => {
      const uploads = createUploadService({
        blob: createLocalFsBlobStore({
          rootDir: `${db.directory}/media-inputs`,
          signingSecret: "media-input-test",
          publicBaseUrl: "http://127.0.0.1",
        }),
        repository: createUploadRepository(db.persistence),
        localInstance: db.localInstance,
      });
      const { jobs, queue } = fixture(uploads);
      try {
        const source =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=";
        const accepted = await jobs.createJob(db.actor, {
          requestId: randomUUID(),
          jobType: "image_generation",
          payload: { prompt: "猫", input_images: [source] },
        });
        const stored = await jobs.getJob(db.actor, accepted.id);
        expect(stored.payload.input_images).toEqual([
          expect.stringMatching(/^asset:\/\//),
        ]);
        expect(JSON.stringify(stored.payload)).not.toContain("base64,");
        const sources = stored.payload.input_images;
        if (!Array.isArray(sources) || typeof sources[0] !== "string")
          throw new Error("参考素材未保存");
        const reference = sources[0];
        expect(
          await uploads.getAssetUrl(
            db.actor,
            reference.slice("asset://".length),
          ),
        ).toMatch(/^http:\/\/127\.0\.0\.1/);
      } finally {
        await queue.shutdown();
      }
    });

    it("完成后重放先返回原回执，不重新读取已删除的参考素材", async () => {
      const uploads = createUploadService({
        blob: createLocalFsBlobStore({
          rootDir: `${db.directory}/deleted-inputs`,
          signingSecret: "media-input-test",
          publicBaseUrl: "http://127.0.0.1",
        }),
        repository: createUploadRepository(db.persistence),
        localInstance: db.localInstance,
      });
      const { jobs, queue } = fixture(uploads);
      try {
        const asset = await uploads.uploadFile(db.actor, {
          bucket: "project-assets",
          fileName: "reference.png",
          mimeType: "image/png",
          fileBuffer: Buffer.from("reference"),
        });
        const input = {
          requestId: randomUUID(),
          jobType: "image_generation" as const,
          payload: {
            prompt: "猫",
            input_images: [`asset://${asset.asset.id}`],
          },
        };
        const original = await jobs.createJob(db.actor, input);
        await jobs.markSucceeded(original.id, {
          signed_url: "https://assets.example/result.png",
        });
        await uploads.deleteAsset(db.actor, asset.asset.id);
        expect(await jobs.createJob(db.actor, input)).toMatchObject({
          id: original.id,
          status: "succeeded",
        });
      } finally {
        await queue.shutdown();
      }
    });

    it("同一请求并发重放只创建并投递一个Job", async () => {
      const { jobs, queue } = fixture();
      try {
        const input = {
          requestId: randomUUID(),
          jobType: "image_generation" as const,
          payload: { prompt: "一只猫" },
        };
        const accepted = await Promise.all(
          Array.from({ length: 8 }, () => jobs.createJob(db.actor, input)),
        );
        expect(new Set(accepted.map((job) => job.id)).size).toBe(1);
        expect(await queue.read("image_generation_jobs", 120, 20)).toHaveLength(
          1,
        );
      } finally {
        await queue.shutdown();
      }
    });

    it("同请求标识不能复用于不同参数", async () => {
      const { jobs, queue } = fixture();
      try {
        const input = {
          requestId: randomUUID(),
          jobType: "image_generation" as const,
          payload: { prompt: "猫" },
        };
        await jobs.createJob(db.actor, input);
        await expect(
          jobs.createJob(db.actor, { ...input, payload: { prompt: "狗" } }),
        ).rejects.toMatchObject({
          code: "job_request_conflict",
          statusCode: 409,
        });
        await expect(
          jobs.createJob(db.actor, { ...input, threadId: "another-thread" }),
        ).rejects.toMatchObject({
          code: "job_request_conflict",
          statusCode: 409,
        });
        expect(await queue.read("image_generation_jobs", 120, 20)).toHaveLength(
          1,
        );
      } finally {
        await queue.shutdown();
      }
    });

    it("已完成请求重放返回原结果，字段顺序变化不重投", async () => {
      const { jobs, queue } = fixture();
      try {
        const requestId = randomUUID();
        const original = await jobs.createJob(db.actor, {
          requestId,
          jobType: "image_generation",
          payload: { prompt: "猫", model: "image" },
        });
        const [message] = await queue.read("image_generation_jobs", 120, 1);
        if (!message) throw new Error("没有收到已接纳Job");
        await queue.deleteMessage("image_generation_jobs", message.msg_id);
        await jobs.markSucceeded(original.id, {
          signed_url: "https://assets.example/cat.png",
        });
        const replayed = await jobs.createJob(db.actor, {
          requestId,
          jobType: "image_generation",
          payload: { model: "image", prompt: "猫" },
        });
        expect(replayed).toMatchObject({
          id: original.id,
          status: "succeeded",
          result: { signed_url: "https://assets.example/cat.png" },
        });
        expect(await queue.read("image_generation_jobs", 120, 20)).toEqual([]);
      } finally {
        await queue.shutdown();
      }
    });

    it("同实例新的授权接入客户端可重放原请求", async () => {
      const { jobs, queue } = fixture();
      try {
        const request = {
          ip: "127.0.0.1",
          headers: { authorization: `Bearer ${db.desktopToken}` },
        };
        const { token } = await db.localAccess.createApiClient(request, {
          label: "媒体重连接入",
        });
        const other = await db.localAccess.authenticate({
          ip: "127.0.0.1",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!other) throw new Error("第二个接入客户端未获授权");
        const input = {
          requestId: randomUUID(),
          jobType: "image_generation" as const,
          payload: { prompt: "猫" },
        };
        const original = await jobs.createJob(db.actor, input);
        const replayed = await jobs.createJob(other, input);
        expect(replayed).toMatchObject({
          id: original.id,
          created_by_client_id: db.actor.accessClientId,
        });
        expect(await queue.read("image_generation_jobs", 120, 20)).toHaveLength(
          1,
        );
      } finally {
        await queue.shutdown();
      }
    });

    it("不同请求与同请求内不同操作索引独立接纳", async () => {
      const { jobs, queue } = fixture();
      try {
        const requestId = randomUUID();
        const accepted = await Promise.all(
          Array.from({ length: 8 }, (_, requestIndex) =>
            jobs.createJob(db.actor, {
              requestId,
              requestIndex,
              jobType: "image_generation",
              payload: { prompt: "猫" },
            }),
          ),
        );
        expect(new Set(accepted.map((job) => job.id)).size).toBe(8);
        expect(await queue.read("image_generation_jobs", 120, 20)).toHaveLength(
          8,
        );
      } finally {
        await queue.shutdown();
      }
    });
  },
);
