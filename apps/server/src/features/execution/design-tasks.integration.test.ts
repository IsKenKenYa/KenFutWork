import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createChatRepository } from "../chat/repository.js";
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
