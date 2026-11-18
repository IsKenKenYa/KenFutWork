import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiConversation } from "../code-ui/conversation.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createGenerationTargets } from "../generation/file-targets.js";
import { createJobService } from "../jobs/job-service.js";
import { createJobRepository } from "../jobs/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import type { PersistenceService } from "../persistence/types.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCanvasService } from "./canvas-service.js";
import { createCanvasRepository } from "./repository.js";

function canvasServiceFor(
  db: Awaited<ReturnType<typeof createTaskWorkDatabase>>,
  persistence: PersistenceService,
) {
  return createCanvasService({
    repository: createCanvasRepository(persistence),
    localInstance: db.localInstance,
    projects: {
      getProject: async (actor, id) => {
        const project = await createProjectRepository(
          persistence,
        ).findActiveById(actor.instanceId, id);
        if (!project) throw new Error("项目不存在");
        return project;
      },
    },
    blob: {} as never,
    projectFiles: {} as never,
  });
}

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "跨进程画布文档发布与删除屏障",
  () => {
    it("不同连接的删除等待发布锁，旧revision拒绝且源文件保留", async () => {
      const db = await createTaskWorkDatabase();
      const other = createPostgresPersistence({
        databaseUrl: db.connectionString,
      });
      let release = () => {};
      try {
        await db.persistence
          .forInstance(db.instanceId)
          .execute(
            `update public.projects set enabled_modes=array['code','design']::text[] where id=$1 and instance_id=:instance`,
            [db.context.scope.projectId],
          );
        const server = canvasServiceFor(db, db.persistence),
          worker = canvasServiceFor(db, other);
        const first = await server.createCanvas(
          db.actor,
          db.context.scope.projectId,
          { name: "文档" },
        );
        let enter = () => {};
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const published = worker.saveCanvasContent(
          db.actor,
          first.id,
          { elements: [{ id: "actual-result" }], appState: {}, files: {} },
          first.revision,
          async () => {
            enter();
            await held;
          },
        );
        await entered;
        const deleted = server
          .deleteCanvas(db.actor, first.id, first.revision)
          .catch((error: unknown) => error);
        await vi.waitFor(
          async () => {
            const locks = await db.persistence.queryOne<{ count: number }>(
              `select count(*)::int as count from pg_locks where locktype='advisory' and not granted`,
            );
            expect(locks?.count).toBeGreaterThan(0);
          },
          { timeout: 5000 },
        );
        release();
        const latest = await published;
        expect(await deleted).toBeInstanceOf(Error);
        const current = await server.getCanvas(db.actor, first.id);
        expect(current.revision).toBe(latest.revision);
        expect(current.content.elements).toEqual([{ id: "actual-result" }]);
        const path = join(
          db.context.scope.rootDirectory,
          ".kenfutwork",
          "canvases",
          `${first.id}.json`,
        );
        const bytes = await readFile(path);
        await server.deleteCanvas(db.actor, first.id, latest.revision);
        expect(await readFile(path)).toEqual(bytes);
        await expect(
          worker.saveCanvasContent(
            db.actor,
            first.id,
            first.content,
            latest.revision,
          ),
        ).rejects.toThrow("已删除");
        expect(
          await server.listCanvases(db.actor, db.context.scope.projectId),
        ).toEqual([]);
        expect(
          await db.persistence
            .forInstance(db.instanceId)
            .queryOne(
              `select id from public.code_ui_sessions where id=$1 and instance_id=:instance`,
              [db.context.scope.taskId],
            ),
        ).not.toBeNull();
      } finally {
        release();
        await other.close();
        await db.close();
      }
    }, 60_000);

    it("并发文档请求数量等于普通连接池大小仍可查询和完成，不等待第二连接形成死锁", async () => {
      const db = await createTaskWorkDatabase();
      const workerDb = createPostgresPersistence({
        databaseUrl: db.connectionString,
        maxConnections: 2,
      });
      let release = () => {};
      try {
        await db.persistence
          .forInstance(db.instanceId)
          .execute(
            `update public.projects set enabled_modes=array['code','design']::text[] where id=$1 and instance_id=:instance`,
            [db.context.scope.projectId],
          );
        const worker = canvasServiceFor(db, workerDb);
        const canvases = await Promise.all(
          ["一", "二"].map((name) =>
            worker.createCanvas(db.actor, db.context.scope.projectId, { name }),
          ),
        );
        let entered = 0;
        let enterBoth = () => {};
        const started = new Promise<void>((resolve) => {
          enterBoth = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const work = canvases.map((canvas, index) =>
          worker.saveCanvasContent(
            db.actor,
            canvas.id,
            { elements: [{ id: `actual-${index}` }], files: {}, appState: {} },
            canvas.revision,
            async () => {
              entered++;
              if (entered === 2) enterBoth();
              await held;
            },
          ),
        );
        await started;
        await workerDb.ping();
        release();
        await Promise.all(work);
        expect(
          (await worker.getCanvas(db.actor, canvases[0]!.id)).content.elements,
        ).toEqual([{ id: "actual-0" }]);
        expect(
          (await worker.getCanvas(db.actor, canvases[1]!.id)).content.elements,
        ).toEqual([{ id: "actual-1" }]);
      } finally {
        release();
        await workerDb.close();
        await db.close();
      }
    }, 60_000);

    it.each(["cancel", "revoke"] as const)(
      "%s与最终发布按原Task屏障排序，停止后迟到发布拒绝",
      async (change) => {
        const db = await createTaskWorkDatabase();
        let release = () => {};
        try {
          const scope = db.context.scope;
          const sql = db.persistence.forInstance(db.instanceId);
          await sql.execute(
            `update public.projects set enabled_modes=array['code','design']::text[] where id=$1 and instance_id=:instance`,
            [scope.projectId],
          );
          const canvasService = canvasServiceFor(db, db.persistence);
          const canvas = await canvasService.createCanvas(
            db.actor,
            scope.projectId,
            { name: "原Run文档" },
          );
          const sessionId = randomUUID(),
            runId = randomUUID();
          const host = createCodeUiConversation({
            sessionId,
            workspacePath: scope.rootDirectory,
            config: {
              provider: "zcode",
              model: "test",
              thought: "",
              followupMode: "queue",
            },
            workContext: { preset: "design", canvasId: canvas.id },
          });
          host.startTurn({
            runId,
            commandId: randomUUID(),
            text: "生成",
            workContext: { preset: "design", canvasId: canvas.id },
          });
          await createCodeUiRepository(db.persistence).createRoot(
            db.instanceId,
            {
              sessionId,
              projectId: scope.projectId,
              scope: { ...scope, taskId: sessionId },
              createdByClientId: db.actor.accessClientId,
              threadId: randomUUID(),
              state: host.exportState(),
              command: {
                clientId: "fixture",
                commandId: randomUUID(),
                fingerprint: randomUUID(),
              },
            },
          );
          const targets = createGenerationTargets({
            persistence: db.persistence,
            executionScopes: createExecutionScopes({
              repository: createScopeRepository(db.persistence),
              localInstance: db.localInstance,
            }),
          });
          const fileTarget = await targets.prepareOrigin({
            actor: db.actor,
            projectId: scope.projectId,
            sessionId,
            canvasId: canvas.id,
            runId,
            expectedScopeGeneration: 1,
            expectedBranchGeneration: 1,
          });
          const jobs = createJobRepository(db.persistence);
          const row = await jobs.insert({
            instanceId: db.instanceId,
            projectId: scope.projectId,
            sessionId,
            canvasId: canvas.id,
            jobType: "image_generation",
            queueName: "image_generation_jobs",
            createdByClientId: db.actor.accessClientId,
            payload: {},
            fileTarget,
          });
          if (!row) throw new Error("生成任务未创建");
          await jobs.markRunning(row.id);
          const job = await createJobService({
            repository: jobs,
            queue: {} as never,
          }).getJobForWorker(row.id);
          let enter = () => {};
          const entered = new Promise<void>((resolve) => {
            enter = resolve;
          });
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const publication = targets.withOriginLock(job, async (signal) => {
            enter();
            await held;
            return canvasService.saveCanvasContent(
              db.actor,
              canvas.id,
              {
                elements: [{ id: "published-before-stop" }],
                files: {},
                appState: {},
              },
              canvas.revision,
              async () => {
                signal.throwIfAborted();
              },
            );
          });
          await entered;
          let stop: Promise<number>;
          if (change === "cancel") {
            host.recordEvent({
              type: "run.canceled",
              runId,
              timestamp: new Date().toISOString(),
            });
            stop = sql.execute(
              `update public.code_ui_sessions set state=$2::jsonb,active_run_id=null where id=$1 and instance_id=:instance`,
              [sessionId, JSON.stringify(host.exportState())],
            );
          } else
            stop = sql.execute(
              `update public.code_ui_sessions set scope_generation=scope_generation+1 where id=$1 and instance_id=:instance`,
              [sessionId],
            );
          await vi.waitFor(
            async () => {
              const waiting = await db.persistence.queryOne<{ count: number }>(
                `select count(*)::int as count from pg_stat_activity where wait_event_type='Lock' and query like 'update public.code_ui_sessions%'`,
              );
              expect(waiting?.count).toBeGreaterThan(0);
            },
            { timeout: 5000 },
          );
          release();
          await publication;
          await stop;
          await expect(
            targets.withOriginLock(job, async () => {
              throw new Error("迟到回调不应执行");
            }),
          ).rejects.toThrow();
          expect(
            (await canvasService.getCanvas(db.actor, canvas.id)).content
              .elements,
          ).toEqual([{ id: "published-before-stop" }]);
        } finally {
          release();
          await db.close();
        }
      },
      60_000,
    );
  },
);

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "独立进程文档变更通知",
  () => {
    it("双连接真实CRUD与Agent内容修改均通知，幂等请求不回环且跨实例不推送", async () => {
      const db = await createTaskWorkDatabase();
      const workerDb = createPostgresPersistence({
        databaseUrl: db.connectionString,
      });
      const received: string[] = [];
      let closeNotification = async () => {};
      try {
        await db.persistence
          .forInstance(db.instanceId)
          .execute(
            `update public.projects set enabled_modes=array['code','design']::text[] where id=$1 and instance_id=:instance`,
            [db.context.scope.projectId],
          );
        const subscription = await db.persistence.subscribeNotifications(
          "kenfutwork_canvas_changed",
          (id) => received.push(id),
        );
        closeNotification = subscription.release;
        const worker = canvasServiceFor(db, workerDb);
        const input = { name: "文档", requestId: randomUUID() };
        const first = await worker.createCanvas(
          db.actor,
          db.context.scope.projectId,
          input,
        );
        await vi.waitFor(() => expect(received).toEqual([first.id]));
        await worker.createCanvas(db.actor, db.context.scope.projectId, input);
        await worker.getCanvas(db.actor, first.id);
        await worker.saveCanvasContent(
          db.actor,
          first.id,
          first.content,
          first.revision,
        );
        await worker.renameCanvas(db.actor, first.id, {
          expectedName: "文档",
          name: "新名",
          expectedRevision: first.revision,
        });
        const saved = await worker.saveCanvasContent(
          db.actor,
          first.id,
          { elements: [{ id: "real-agent-result" }], files: {}, appState: {} },
          first.revision,
        );
        await createCanvasRepository(workerDb).notifyChanged(
          randomUUID(),
          first.id,
        );
        await worker.deleteCanvas(db.actor, first.id, saved.revision);
        await vi.waitFor(() =>
          expect(received).toEqual([first.id, first.id, first.id, first.id]),
        );
        expect(
          await createCanvasRepository(workerDb).notificationTarget(first.id),
        ).toMatchObject({
          instance_id: db.instanceId,
          project_id: db.context.scope.projectId,
          deleted_at: expect.anything(),
        });
      } finally {
        await closeNotification();
        await workerDb.close();
        await db.close();
      }
    }, 60_000);
  },
);
