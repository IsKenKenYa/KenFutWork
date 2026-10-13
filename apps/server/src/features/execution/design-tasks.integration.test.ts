import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createChatService } from "../chat/chat-service.js";
import { createChatRepository } from "../chat/repository.js";
import { createThreadService } from "../chat/thread-service.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createProjectService } from "../projects/project-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createDesignTasksService } from "./design-tasks.js";
import { createScopeRepository } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";

async function fixture() {
  const db = await createTaskWorkDatabase();
  const options = {
    persistence: db.persistence,
    localInstance: db.localInstance,
    sandboxRoot: db.directory,
  };
  const service = createDesignTasksService(options);
  const otherHost = createDesignTasksService(options);
  const { canvas, project } = await createProjectRepository(
    db.persistence,
  ).createProject({
    instanceId: db.instanceId,
    createdByClientId: db.actor.accessClientId,
    kind: "design",
    name: "Design FIFO",
    slug: `design-${randomUUID()}`,
    description: null,
    canvasName: "Design",
    workDir: db.context.scope.rootDirectory,
  });
  if (!canvas) throw new Error("Design项目缺少画布");
  const prepared = await service.prepareCreation(db.actor, canvas.id);
  if (!prepared) throw new Error("Design任务缺少执行准备");
  const task = await createChatRepository(db.persistence).createSession(
    db.instanceId,
    {
      canvasId: canvas.id,
      threadId: randomUUID(),
      createdByClientId: db.actor.accessClientId,
      designTaskPreparation: prepared,
    },
  );
  if (!task) throw new Error("Design任务创建失败");
  const input = (prompt: string) => ({
    taskId: task.id,
    inputId: randomUUID(),
    runId: randomUUID(),
    scopeGeneration: 1,
    branchGeneration: 1,
    request: {
      sessionId: task.id,
      taskId: task.id,
      projectId: project.id,
      conversationId: randomUUID(),
      prompt,
      preset: "design" as const,
    },
  });
  return {
    ...db,
    service,
    otherHost,
    task,
    canvas,
    project,
    input,
    async close() {
      await service.close();
      await otherHost.close();
      await db.close();
    },
  };
}
describe.skipIf(process.env.KENFUTWORK_DESIGN_TASK_TEST_PG !== "1")(
  "Design真实Task/FIFO/host恢复",
  () => {
    it("Chat创建并发会话回传持久Task身份，两会话工作域独立且不使用画布ID", async () => {
      const f = await fixture();
      try {
        const repository = createChatRepository(f.persistence);
        const chat = createChatService({
          repository,
          localInstance: f.localInstance,
          designTasks: f.service,
          threadService: createThreadService({
            repository,
            localInstance: f.localInstance,
          }),
        });
        const sessions = await Promise.all([
          chat.createSession(f.actor, f.canvas.id, "第一会话"),
          chat.createSession(f.actor, f.canvas.id, "第二会话"),
        ]);
        const scopes = createExecutionScopes({
          repository: createScopeRepository(f.persistence),
          localInstance: f.localInstance,
        });
        expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
        for (const session of sessions) {
          expect(session.taskId).toBe(session.id);
          expect(session.taskId).not.toBe(f.canvas.id);
          const policy = await f.service.readPolicy(f.actor, session.id);
          expect(policy).toMatchObject({
            taskId: session.id,
            canvasId: f.canvas.id,
            projectId: f.project.id,
            rootDirectory: f.project.work_dir,
            scopeGeneration: 1,
            branchGeneration: 1,
            activeRunId: null,
          });
          const handle = await scopes.openTask(f.actor, session.id);
          expect(handle.preset).toBe("design");
          expect(handle.describe()).toMatchObject({
            taskId: session.id,
            projectId: f.project.id,
            rootDirectory: f.project.work_dir,
          });
        }
      } finally {
        await f.close();
      }
    });
    it("项目关闭意图拒绝并发新Task/Run，失败保留代际，旧Run可结算并重试归档", async () => {
      const f = await fixture();
      const single = createPostgresPersistence({
        databaseUrl: f.connectionString,
        maxConnections: 1,
      });
      let closing!: () => void;
      const started = new Promise<void>((resolve) => {
        closing = resolve;
      });
      let releaseClose!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const projects = createProjectRepository(single);
      const makeService = (close: () => Promise<void>) =>
        createProjectService({
          repository: projects,
          localInstance: f.localInstance,
          blob: {} as never,
          beforeArchiveDesignProject: async (actor, projectId, taskIds) => {
            expect(taskIds).toEqual([f.task.id]);
            // Same max=1 pool: a callback DB read must complete before external resources settle.
            expect(
              await single
                .forInstance(actor.instanceId)
                .queryOne(
                  "select archive_state, archived_at from public.projects where instance_id=:instance and id=$1",
                  [projectId],
                ),
            ).toMatchObject({ archive_state: "closing", archived_at: null });
            closing();
            await close();
          },
        });
      const first = f.input("active before closing");
      const prepared = await f.service.prepareCreation(f.actor, f.canvas.id);
      if (!prepared) throw new Error("真实Task准备缺失");
      await f.service.admitInput(f.actor, first);
      const archive = makeService(async () => {
        await gate;
        throw new Error("TaskWork close failed");
      }).archiveProject(f.actor, f.project.id);
      void archive.catch(() => {});
      try {
        await Promise.race([
          started,
          archive.then(() => {
            throw new Error("资源未确认就归档");
          }),
        ]);
        await expect(
          makeService(async () => {
            throw new Error("并发关闭不应调用第二个资源关闭器");
          }).archiveProject(f.actor, f.project.id),
        ).rejects.toMatchObject({
          code: "project_delete_failed",
          statusCode: 503,
        });
        expect(
          await single
            .forInstance(f.instanceId)
            .queryOne(
              "select archive_state from public.projects where instance_id=:instance and id=$1",
              [f.project.id],
            ),
        ).toMatchObject({ archive_state: "closing" });
        const policy = await f.service.readPolicy(f.actor, f.task.id);
        expect(policy.executionState).toBe("revoking");
        expect(policy.scopeGeneration).toBeGreaterThan(first.scopeGeneration);
        const create = () =>
          createChatRepository(f.persistence).createSession(f.instanceId, {
            canvasId: f.canvas.id,
            threadId: randomUUID(),
            createdByClientId: f.actor.accessClientId,
            designTaskPreparation: prepared,
          });
        expect(
          (await Promise.allSettled([create(), create()])).map(
            (result) => result.status,
          ),
        ).toEqual(["rejected", "rejected"]);
        await expect(
          f.service.prepareCreation(f.actor, f.canvas.id),
        ).rejects.toThrow("不可用");
        await expect(
          f.service.admitInput(f.actor, {
            ...f.input("new-run-blocked"),
            scopeGeneration: policy.scopeGeneration,
            branchGeneration: policy.branchGeneration,
          }),
        ).rejects.toMatchObject({ code: "design_task_unavailable" });
        expect(
          await f.service.settleRun(f.actor, {
            taskId: f.task.id,
            runId: first.runId,
            outcome: "canceled",
          }),
        ).toBe(true);
        releaseClose();
        await expect(archive).rejects.toMatchObject({
          code: "project_delete_failed",
          statusCode: 503,
        });
        expect(
          await projects.findActiveById(f.instanceId, f.project.id),
        ).not.toBeNull();
        const failed = await f.service.readPolicy(f.actor, f.task.id);
        expect(failed.executionState).toBe("failed");
        expect(failed.scopeGeneration).toBe(policy.scopeGeneration);
        expect(failed.branchGeneration).toBe(policy.branchGeneration);
        await expect(create()).rejects.toThrow("不可用");
        const scopes = createExecutionScopes({
          repository: createScopeRepository(f.persistence),
          localInstance: f.localInstance,
        });
        const unlisten = scopes.onRevoke(async () => {});
        try {
          await expect(
            scopes.updateTask(f.actor, f.task.id, { sandboxMode: "read-only" }),
          ).rejects.toMatchObject({ code: "scope_project_closed" });
          await expect(
            f.service.beginRestore(f.actor, {
              taskId: f.task.id,
              expectedScopeGeneration: failed.scopeGeneration,
              expectedBranchGeneration: failed.branchGeneration,
            }),
          ).rejects.toMatchObject({ code: "design_task_unavailable" });
          expect(
            (await f.service.readPolicy(f.actor, f.task.id)).scopeGeneration,
          ).toBe(failed.scopeGeneration);
        } finally {
          unlisten();
        }

        await expect(
          f.service.admitInput(f.actor, {
            ...f.input("failed-run-blocked"),
            scopeGeneration: failed.scopeGeneration,
            branchGeneration: failed.branchGeneration,
          }),
        ).rejects.toMatchObject({ code: "design_task_unavailable" });
        await makeService(async () => {}).archiveProject(f.actor, f.project.id);
        expect(
          await projects.findActiveById(f.instanceId, f.project.id),
        ).toBeNull();
        const retired = await f.persistence
          .forInstance(f.instanceId)
          .queryOne<{ scope_generation: number | string }>(
            "select scope_generation from public.design_task_executions where instance_id=:instance and task_id=$1",
            [f.task.id],
          );
        expect(Number(retired?.scope_generation)).toBeGreaterThan(
          failed.scopeGeneration,
        );
      } finally {
        releaseClose();
        await archive.catch(() => {});
        await single.close();
        await f.close();
      }
    });
    it("同键并发只登记一次，FIFO跨终态推进，迟到终态不可清新Run", async () => {
      const f = await fixture();
      try {
        const first = f.input("first");
        const results = await Promise.all([
          f.service.admitInput(f.actor, first),
          f.service.admitInput(f.actor, { ...first, runId: randomUUID() }),
        ]);
        expect(results.map((x) => x.kind).sort()).toEqual([
          "duplicate",
          "running",
        ]);
        expect(new Set(results.map((receipt) => receipt.runId)).size).toBe(1);
        const second = f.input("second");
        expect((await f.service.admitInput(f.actor, second)).kind).toBe(
          "queued",
        );
        expect(await f.service.claimNextInput(f.actor, f.task.id)).toBeNull();
        expect(
          await f.service.settleRun(f.actor, {
            taskId: f.task.id,
            runId: first.runId,
            outcome: "completed",
          }),
        ).toBe(true);
        expect(
          (await f.service.claimNextInput(f.actor, f.task.id))?.runId,
        ).toBe(second.runId);
        expect(
          await f.service.settleRun(f.actor, {
            taskId: f.task.id,
            runId: first.runId,
            outcome: "completed",
          }),
        ).toBe(false);
        expect(
          (await f.service.readPolicy(f.actor, f.task.id)).activeRunId,
        ).toBe(second.runId);
      } finally {
        await f.close();
      }
    });
    it("另一个live host不可恢复；失去session锁后新host只结算旧Run而不重放", async () => {
      const f = await fixture();
      try {
        const first = f.input("first"),
          second = f.input("second");
        await f.service.admitInput(f.actor, first);
        await f.service.admitInput(f.actor, second);
        expect(await f.otherHost.recoverInterruptedTasks(f.actor)).toBe(0);
        expect(
          (await f.service.readPolicy(f.actor, f.task.id)).activeRunId,
        ).toBe(first.runId);
        await f.service.close();
        expect(await f.otherHost.recoverInterruptedTasks(f.actor)).toBe(1);
        expect(
          (await f.otherHost.readPolicy(f.actor, f.task.id)).activeRunId,
        ).toBeNull();
        expect(
          (await f.otherHost.claimNextInput(f.actor, f.task.id))?.runId,
        ).toBe(second.runId);
        expect(
          await f.service.settleRun(f.actor, {
            taskId: f.task.id,
            runId: first.runId,
            outcome: "completed",
          }),
        ).toBe(false);
      } finally {
        await f.close();
      }
    });
    it("政策CAS拒绝活动Run，idle变更同时推进授权与规划代际", async () => {
      const f = await fixture();
      try {
        const first = f.input("first");
        await f.service.admitInput(f.actor, first);
        await expect(
          f.service.updatePolicy(f.actor, {
            taskId: f.task.id,
            scopeGeneration: 1,
            planningEpoch: 0,
            mode: "edit",
          }),
        ).rejects.toThrow("先停止");
        await f.service.settleRun(f.actor, {
          taskId: f.task.id,
          runId: first.runId,
          outcome: "completed",
        });
        const updated = await f.service.updatePolicy(f.actor, {
          taskId: f.task.id,
          scopeGeneration: 1,
          planningEpoch: 0,
          mode: "edit",
          planEnabled: true,
        });
        expect([
          updated.mode,
          updated.planEnabled,
          updated.scopeGeneration,
          updated.planningEpoch,
        ]).toEqual(["edit", true, 2, 1]);
        await expect(
          f.service.admitInput(f.actor, f.input("stale")),
        ).rejects.toThrow("权限已变更");
      } finally {
        await f.close();
      }
    });
    it("settle/admit/claim并发回绕后释放idle锁，后续host可真实执行", async () => {
      const f = await fixture();
      try {
        let current = f.input("start");
        await f.service.admitInput(f.actor, current);
        for (let index = 0; index < 4; index++) {
          const next = f.input(`next-${index}`);
          const [settled, admitted] = await Promise.all([
            f.service.settleRun(f.actor, {
              taskId: f.task.id,
              runId: current.runId,
              outcome: "completed",
            }),
            f.service.admitInput(f.actor, next),
          ]);
          expect(settled).toBe(true);
          if (admitted.kind === "queued")
            expect(
              (await f.service.claimNextInput(f.actor, f.task.id))?.runId,
            ).toBe(next.runId);
          else expect(admitted.kind).toBe("running");
          expect(await f.otherHost.recoverInterruptedTasks(f.actor)).toBe(0);
          expect(
            (await f.service.readPolicy(f.actor, f.task.id)).activeRunId,
          ).toBe(next.runId);
          current = next;
        }
        await f.service.settleRun(f.actor, {
          taskId: f.task.id,
          runId: current.runId,
          outcome: "completed",
        });
        const fresh = f.input("other-host");
        expect((await f.otherHost.admitInput(f.actor, fresh)).kind).toBe(
          "running",
        );
      } finally {
        await f.close();
      }
    });
  },
);
