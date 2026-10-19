import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerGenerateRoutes } from "../../http/generate.js";
import {
  canvasContentPath,
  createCanvasFileStore,
} from "../canvas/file-store.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createModelProviderService } from "../model-providers/model-provider-service.js";
import { createModelProviderRepository } from "../model-providers/repository.js";
import { createProjectRepository } from "../projects/repository.js";
import { createInProcessQueue } from "../queue/providers/in-process.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";

type SubmissionDatabase = Awaited<ReturnType<typeof createTaskWorkDatabase>>;

async function createSubmissionFixture(
  db: SubmissionDatabase,
  maxOutputs?: number,
) {
  const queue = createInProcessQueue();
  const jobs = createJobService({
    queue,
    repository: createJobRepository(db.persistence),
    localInstance: db.localInstance,
    generationTargets: createGenerationTargets({
      persistence: db.persistence,
      executionScopes: createExecutionScopes({
        repository: createScopeRepository(db.persistence),
        localInstance: db.localInstance,
      }),
    }),
  });
  const models = createModelProviderService({
    repository: createModelProviderRepository(db.persistence),
    localInstance: db.localInstance,
  });
  const model = {
    id: "custom-image",
    name: "自定义图片",
    capability: "image" as const,
    ...(maxOutputs ? { imageGeneration: { maxOutputs } } : {}),
  };
  const provider = await models.createInstance(db.actor, {
    name: "多图受理测试",
    protocol: "openai-compatible",
    apiKey: "test-only",
    models: [model],
  });
  const app = Fastify();
  await registerGenerateRoutes(app, {
    localAccess: db.localAccess,
    localInstance: db.localInstance,
    jobService: jobs,
    modelProviders: models,
  });
  return {
    jobs,
    models,
    model,
    provider,
    submit: (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/agent/generate-image",
        headers: { authorization: `Bearer ${db.desktopToken}` },
        payload: {
          providerInstanceId: provider.id,
          model: model.id,
          prompt: "猫",
          ...payload,
        },
      }),
    async close() {
      await app.close();
      await queue.shutdown();
    },
  };
}

async function createGeneratorCanvasFixture(db: SubmissionDatabase) {
  const { project } = await createProjectRepository(
    db.persistence,
  ).createProject({
    instanceId: db.instanceId,
    createdByClientId: db.actor.accessClientId,
    kind: "design",
    name: "生成器绑定",
    slug: randomUUID(),
    canvasName: "生成器绑定",
    description: null,
    workDir: db.context.scope.rootDirectory,
    directoryChoice: "independent",
  });
  const repository = createCanvasRepository(db.persistence);
  const canvas = await repository.create({
    instanceId: db.instanceId,
    projectId: project.id,
    canvasId: randomUUID(),
    name: "生成器绑定",
  });
  if (!canvas) throw new Error("未创建测试画布");
  const generatorId = "image-generator-present";
  const deletedId = "image-generator-deleted";
  const videoId = "video-generator-present";
  const content = {
    elements: [
      {
        id: generatorId,
        type: "rectangle",
        isDeleted: false,
        customData: { type: "image-generator" },
      },
      {
        id: deletedId,
        type: "rectangle",
        isDeleted: true,
        customData: { type: "image-generator" },
      },
      {
        id: videoId,
        type: "rectangle",
        isDeleted: false,
        customData: { type: "video-generator" },
      },
    ],
    appState: {},
    files: {},
  };
  await db.persistence.forInstance(db.instanceId).execute(
    `update public.canvases c set content=$2::jsonb from public.projects p
     where c.id=$1 and p.id=c.project_id and p.instance_id=:instance`,
    [canvas.id, JSON.stringify(content)],
  );
  return {
    project,
    canvas,
    repository,
    content,
    generatorId,
    deletedId,
    videoId,
    binding: { projectId: project.id, canvasId: canvas.id },
  };
}

describe.skipIf(process.env.KENFUTWORK_MEDIA_JOBS_TEST_PG !== "1")(
  "生成请求的原子多任务接纳",
  () => {
    let db: SubmissionDatabase;
    beforeAll(async () => {
      db = await createTaskWorkDatabase();
    }, 30_000);
    afterAll(async () => {
      await db?.close();
    });

    it("未知原生多图能力拆单，并发同键HTTP重放返回同一完整任务组", async () => {
      const fixture = await createSubmissionFixture(db);
      const requestId = randomUUID();
      const payload = { requestId, count: 3 };
      try {
        const responses = await Promise.all(
          Array.from({ length: 8 }, () => fixture.submit(payload)),
        );
        const first = responses[0]?.json();
        for (const response of responses) {
          expect(response.statusCode).toBe(202);
          expect(response.json()).toEqual(first);
        }
        expect(first.jobs).toHaveLength(3);
        expect(
          new Set(first.jobs.map((job: { job_id: string }) => job.job_id)).size,
        ).toBe(3);
        const accepted = await fixture.jobs.listJobs(db.actor, { requestId });
        expect(accepted).toHaveLength(3);
        expect(accepted.map((job) => job.payload.count)).toEqual([1, 1, 1]);
        const conflict = await fixture.submit({ ...payload, count: 4 });
        expect(conflict.statusCode).toBe(409);
        expect(
          await fixture.jobs.listJobs(db.actor, { requestId }),
        ).toHaveLength(3);
      } finally {
        await fixture.close();
      }
    });

    it("单Job与多Job并发复用请求标识返回参数冲突，不暴露内部错误或留下部分组", async () => {
      const fixture = await createSubmissionFixture(db);
      const requestId = randomUUID();
      const gate = await db.persistence.acquireSessionLock(
        `media-submission:${requestId}`,
      );
      const submissions: Promise<unknown>[] = [];
      async function waitForBlockedRequests(count: number) {
        await vi.waitFor(
          async () => {
            const waiting = await db.persistence.queryOne<{ count: number }>(
              `select count(*)::int as count from pg_locks l
               join pg_stat_activity a on a.pid=l.pid
               where l.locktype='advisory' and not l.granted
                 and a.datname=current_database()`,
            );
            expect(waiting?.count).toBeGreaterThanOrEqual(count);
          },
          { timeout: 5000 },
        );
      }
      try {
        if (!gate) throw new Error("未获得测试请求门闩");
        await db.persistence.execute(`create function public.hold_media_request_for_race() returns trigger language plpgsql as $$
          begin
            if new.payload->>'request_id'='${requestId}' then
              perform pg_advisory_xact_lock(hashtextextended('media-submission:' || (new.payload->>'request_id'),0));
            end if;
            return new;
          end;
        $$`);
        await db.persistence.execute(`create trigger hold_media_request_for_race before insert on public.background_jobs
          for each row execute function public.hold_media_request_for_race()`);
        const single = fixture.jobs.createJob(db.actor, {
          requestId,
          interactiveRequest: true,
          jobType: "image_generation",
          payload: {
            prompt: "先受理的猫",
            model: fixture.model.id,
            provider_instance_id: fixture.provider.id,
          },
        });
        submissions.push(single);
        await waitForBlockedRequests(1);
        const grouped = Promise.resolve(
          fixture.submit({ requestId, count: 3 }),
        );
        submissions.push(grouped);
        // 第一请求停在写入前，第二请求必须同时处于真实数据库等待中。
        await waitForBlockedRequests(2);
        await gate.release();
        const accepted = await single;
        const conflict = await grouped;
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json().error.code).toBe("job_request_conflict");
        const jobs = await fixture.jobs.listJobs(db.actor, { requestId });
        expect(jobs.map((job) => job.id)).toEqual([accepted.id]);
        expect(jobs[0]?.payload.prompt).toBe("先受理的猫");
      } finally {
        await gate?.release();
        await Promise.allSettled(submissions);
        await db.persistence.execute(
          "drop trigger if exists hold_media_request_for_race on public.background_jobs",
        );
        await db.persistence.execute(
          "drop function if exists public.hold_media_request_for_race()",
        );
        await fixture.close();
      }
    });

    it("原生多图按单次上限分组，修改模型能力后重放仍返回已冻结的任务组", async () => {
      const fixture = await createSubmissionFixture(db, 2);
      const requestId = randomUUID();
      try {
        const response = await fixture.submit({ requestId, count: 5 });
        expect(response.statusCode).toBe(202);
        expect(response.json().jobs).toHaveLength(3);
        const accepted = await fixture.jobs.listJobs(db.actor, { requestId });
        accepted.sort(
          (a, b) =>
            Number(a.payload.request_index) - Number(b.payload.request_index),
        );
        expect(accepted.map((job) => job.payload.count)).toEqual([2, 2, 1]);
        expect(accepted.map((job) => job.payload.requested_count)).toEqual([
          5, 5, 5,
        ]);
        await fixture.models.updateInstance(db.actor, fixture.provider.id, {
          expectedRevision: fixture.provider.configRevision,
          models: [{ ...fixture.model, imageGeneration: { maxOutputs: 3 } }],
        });
        const replay = await fixture.submit({ requestId, count: 5 });
        expect(replay.statusCode).toBe(202);
        expect(replay.json()).toEqual(response.json());
        expect(
          await fixture.jobs.listJobs(db.actor, { requestId }),
        ).toHaveLength(3);
      } finally {
        await fixture.close();
      }
    });

    it("任务组中途写入失败不会留下半组，原请求可重新完整受理", async () => {
      const fixture = await createSubmissionFixture(db);
      const requestId = randomUUID();
      let triggerInstalled = false;
      try {
        await db.persistence.execute(`create function public.reject_second_media_job() returns trigger language plpgsql as $$
          begin
            if new.payload->>'request_index'='1' then raise exception 'fixture rejects second job'; end if;
            return new;
          end;
        $$`);
        await db.persistence.execute(`create trigger reject_second_media_job before insert on public.background_jobs
          for each row execute function public.reject_second_media_job()`);
        triggerInstalled = true;
        const rejected = await fixture.submit({ requestId, count: 3 });
        expect(rejected.statusCode).toBe(500);
        expect(
          await fixture.jobs.listJobs(db.actor, { requestId }),
        ).toHaveLength(0);
        await db.persistence.execute(
          "drop trigger reject_second_media_job on public.background_jobs",
        );
        triggerInstalled = false;
        const accepted = await fixture.submit({ requestId, count: 3 });
        expect(accepted.statusCode).toBe(202);
        expect(accepted.json().jobs).toHaveLength(3);
        expect(
          await fixture.jobs.listJobs(db.actor, { requestId }),
        ).toHaveLength(3);
      } finally {
        if (triggerInstalled)
          await db.persistence.execute(
            "drop trigger reject_second_media_job on public.background_jobs",
          );
        await db.persistence.execute(
          "drop function if exists public.reject_second_media_job()",
        );
        await fixture.close();
      }
    });

    it("只接纳当前画布中存在且类型匹配的生成器，伪造和已删除生成器均不创建Job", async () => {
      const fixture = await createSubmissionFixture(db);
      try {
        const { project, canvas, binding, generatorId, deletedId, videoId } =
          await createGeneratorCanvasFixture(db);
        for (const invalidId of ["forged-generator", deletedId, videoId]) {
          const requestId = randomUUID();
          const rejected = await fixture.submit({
            ...binding,
            requestId,
            generatorId: invalidId,
          });
          expect(rejected.statusCode, invalidId).toBe(409);
          expect(
            await fixture.jobs.listJobs(db.actor, { requestId }),
          ).toHaveLength(0);
        }
        const requestId = randomUUID();
        const accepted = await fixture.submit({
          ...binding,
          requestId,
          generatorId,
        });
        expect(accepted.statusCode).toBe(202);
        expect(
          await fixture.jobs.listJobs(db.actor, { requestId }),
        ).toMatchObject([
          {
            project_id: project.id,
            canvas_id: canvas.id,
            payload: { generator_id: generatorId },
          },
        ]);
        const chatRequestId = randomUUID();
        const chat = await fixture.submit({
          ...binding,
          requestId: chatRequestId,
        });
        expect(chat.statusCode).toBe(202);
        expect(
          await fixture.jobs.listJobs(db.actor, { requestId: chatRequestId }),
        ).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    });

    it("文件型画布读取服务端固定目录中的生成器，文件删除后拒绝新任务", async () => {
      const fixture = await createSubmissionFixture(db);
      try {
        const { canvas, repository, content, binding, generatorId } =
          await createGeneratorCanvasFixture(db);
        const root = await repository.claimRoot(
          db.instanceId,
          canvas.id,
          async () => db.context.scope.rootDirectory,
        );
        const store = createCanvasFileStore({ projectRoot: root });
        let snapshot = await store.save(
          canvas.id,
          { ...content, elements: [] },
          null,
        );
        const unindexedRequestId = randomUUID();
        const unindexed = await fixture.submit({
          ...binding,
          requestId: unindexedRequestId,
          generatorId,
        });
        expect(unindexed.statusCode).toBe(409);
        expect(
          await fixture.jobs.listJobs(db.actor, {
            requestId: unindexedRequestId,
          }),
        ).toHaveLength(0);
        snapshot = await store.save(canvas.id, content, snapshot.revision);
        await repository.recordFileIndex(db.instanceId, canvas.id);
        const requestId = randomUUID();
        const accepted = await fixture.submit({
          ...binding,
          requestId,
          generatorId,
        });
        expect(accepted.statusCode).toBe(202);
        expect(
          await fixture.jobs.listJobs(db.actor, { requestId }),
        ).toHaveLength(1);
        await store.save(
          canvas.id,
          {
            ...content,
            elements: content.elements.map((element) => ({
              ...element,
              isDeleted: true,
            })),
          },
          snapshot.revision,
        );
        const deletedRequestId = randomUUID();
        const deleted = await fixture.submit({
          ...binding,
          requestId: deletedRequestId,
          generatorId,
        });
        expect(deleted.statusCode).toBe(409);
        expect(
          await fixture.jobs.listJobs(db.actor, {
            requestId: deletedRequestId,
          }),
        ).toHaveLength(0);
        await unlink(canvasContentPath(root, canvas.id));
        const missingRequestId = randomUUID();
        const missing = await fixture.submit({
          ...binding,
          requestId: missingRequestId,
          generatorId,
        });
        expect(missing.statusCode).toBe(409);
        expect(
          await fixture.jobs.listJobs(db.actor, {
            requestId: missingRequestId,
          }),
        ).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    });
  },
);
