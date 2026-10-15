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
