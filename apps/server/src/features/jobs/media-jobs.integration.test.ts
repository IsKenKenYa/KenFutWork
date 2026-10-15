import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
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
    function fixture() {
      const queue = createInProcessQueue();
      const jobs = createJobService({
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
