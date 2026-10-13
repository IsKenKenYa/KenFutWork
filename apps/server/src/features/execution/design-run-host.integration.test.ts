import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createAgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import { createAgentRunRepository } from "../agent-runs/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createThreadService } from "../chat/thread-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createTestDesignModelSelection } from "./design-goals-test-fixture.js";
import { createDesignRunHost } from "./design-run-host.js";
import { createDesignHostRepository } from "./design-run-host-repository.js";
import { createDesignTasksService } from "./design-tasks.js";
import { createScopeRepository } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";

async function fixture() {
  const db = await createTaskWorkDatabase();
  const tasks = createDesignTasksService({
    persistence: db.persistence,
    localInstance: db.localInstance,
    sandboxRoot: db.directory,
  });
  const { project, canvas } = await createProjectRepository(
    db.persistence,
  ).createProject({
    instanceId: db.instanceId,
    createdByClientId: db.actor.accessClientId,
    kind: "design",
    name: "Design Host",
    slug: `host-${randomUUID()}`,
    canvasName: "Design",
    description: null,
    workDir: db.context.scope.rootDirectory,
  });
  if (!canvas) throw new Error("Design画布缺失");
  const preparation = await tasks.prepareCreation(db.actor, canvas.id);
  if (!preparation) throw new Error("Design准备缺失");
  const chat = createChatRepository(db.persistence);
  const task = await chat.createSession(db.instanceId, {
    canvasId: canvas.id,
    threadId: randomUUID(),
    createdByClientId: db.actor.accessClientId,
    designTaskPreparation: preparation,
  });
  if (!task) throw new Error("Design任务缺失");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const canceled = new Set<string>();
  const executions = new Map<
    string,
    Parameters<
      Parameters<typeof createDesignRunHost>[0]["agentRuns"]["createRun"]
    >[1]
  >();
  const createRun = vi.fn((request: unknown, options: { runId: string }) => {
    executions.set(options.runId, options);
    return { runId: options.runId };
  });
  const agentRuns = {
    createRun,
    cancelRun: (runId: string) => {
      canceled.add(runId);
      release();
    },
    cancelRunAndWait: async () => {},
    async *streamRun(runId: string) {
      await gate;
      const sink = executions.get(runId)?.eventSink;
      if (!canceled.has(runId)) {
        const delta: StreamEvent = {
          type: "message.delta",
          runId,
          messageId: `message-${runId}`,
          delta: "persistent answer",
          timestamp: new Date().toISOString(),
        };
        await sink?.(delta);
        yield delta;
      }
      const event: StreamEvent = {
        type: canceled.has(runId) ? "run.canceled" : "run.completed",
        runId,
        timestamp: new Date().toISOString(),
      };
      await sink?.(event);
      yield event;
    },
  } as unknown as Parameters<typeof createDesignRunHost>[0]["agentRuns"];
  const threads = createThreadService({
    repository: chat,
    localInstance: db.localInstance,
  });
  const host = createDesignRunHost({
    modelSelection: createTestDesignModelSelection(),
    agentModes: { activate: async () => {}, hydrate: async () => "agent" },
    designGoals: {
      initialize: async () => {},
      readTask: async () => null,
      observe: async () => ({ stop: false }),
      continuation: async () => null,
      onLost: () => () => {},
    },
    repository: createDesignHostRepository(db.persistence),
    designTasks: tasks,
    agentRuns,
    metadata: createAgentRunMetadataService({
      repository: createAgentRunRepository(db.persistence),
    }),
    threads,
    executionScopes: createExecutionScopes({
      repository: createScopeRepository(db.persistence),
      localInstance: db.localInstance,
    }),
    localInstance: db.localInstance,
    localAccess: db.localAccess,
    taskWork: {
      onReady: () => () => {},
      list: async () => [],
      closeTask: async () => {},
    },
  });
  const input = (id: string) => ({
    taskId: task.id,
    inputId: id,
    scopeGeneration: 1,
    branchGeneration: 1,
    request: {
      sessionId: task.id,
      taskId: task.id,
      projectId: project.id,
      conversationId: task.id,
      prompt: id,
      preset: "design" as const,
      accessToken: "not-for-persistence",
    },
  });
  return {
    ...db,
    tasks,
    task,
    canvas,
    host,
    input,
    release,
    createRun,
    executions,
    async close() {
      await host.close();
      await tasks.close();
      await db.close();
    },
  };
}
describe.skipIf(process.env.KENFUTWORK_DESIGN_TASK_TEST_PG !== "1")(
  "Design真实Host/终态原子性",
  () => {
    it("原Task真实scope运行一次，同input重连不重放，FIFO与元数据/消息原子收尾", async () => {
      const f = await fixture();
      try {
        const first = await f.host.submit(f.actor, f.input("first"));
        const duplicate = await f.host.submit(f.actor, f.input("first"));
        const second = await f.host.submit(f.actor, f.input("second"));
        expect([first.kind, duplicate.kind, second.kind]).toEqual([
          "running",
          "duplicate",
          "queued",
        ]);
        expect(duplicate.runId).toBe(first.runId);
        f.release();
        await vi.waitFor(
          async () =>
            expect(
              (await f.tasks.readPolicy(f.actor, f.task.id)).activeRunId,
            ).toBeNull(),
          { timeout: 10000 },
        );
        expect(f.createRun).toHaveBeenCalledTimes(2);
        expect(f.createRun.mock.calls[0]?.[0]).toMatchObject({
          canvasId: f.canvas.id,
          taskId: f.task.id,
          preset: "design",
        });
        const scoped = f.persistence.forInstance(f.instanceId);
        const runs = await scoped.query(
          `select r.status from public.agent_runs r join public.chat_sessions c on c.id=r.session_id where c.instance_id=:instance and c.id=$1`,
          [f.task.id],
        );
        expect(runs.map((run) => run.status)).toEqual([
          "completed",
          "completed",
        ]);
        const messages = await scoped.query(
          `select m.role,m.content from public.chat_messages m join public.chat_sessions c on c.id=m.session_id where c.instance_id=:instance and c.id=$1`,
          [f.task.id],
        );
        expect(
          messages.filter((message) => message.role === "user"),
        ).toHaveLength(2);
        expect(
          messages.filter((message) => message.role === "assistant"),
        ).toHaveLength(2);
        expect(
          JSON.stringify(
            await scoped.query(
              `select request from public.design_task_inputs where instance_id=:instance and task_id=$1`,
              [f.task.id],
            ),
          ),
        ).not.toContain("not-for-persistence");
      } finally {
        await f.close();
      }
    });
    it("已失败ledger不被迟到success覆盖，错误终态不广播、不自动派发下一轮", async () => {
      const f = await fixture();
      try {
        const events: StreamEvent[] = [];
        f.host.onEvent(({ event }) => {
          events.push(event);
        });
        const first = await f.host.submit(f.actor, f.input("first"));
        await f.host.submit(f.actor, f.input("queued"));
        await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(1));
        await f.persistence.forInstance(f.instanceId).execute(
          `update public.agent_runs r set status='failed',completed_at=now(),error_code='run_failed',error_message='已确认失败'
    from public.chat_sessions c where c.instance_id=:instance and r.session_id=c.id and c.id=$1 and r.id=$2`,
          [f.task.id, first.runId],
        );
        f.release();
        await vi.waitFor(async () =>
          expect(
            (await f.tasks.readPolicy(f.actor, f.task.id)).activeRunId,
          ).toBeNull(),
        );
        expect(f.createRun).toHaveBeenCalledTimes(1);
        expect(
          events.filter((event) => event.type === "run.completed"),
        ).toHaveLength(0);
        const run = await f.persistence
          .forInstance(f.instanceId)
          .queryOne(
            `select r.status,r.error_message from public.agent_runs r join public.chat_sessions c on c.id=r.session_id where c.instance_id=:instance and r.id=$1`,
            [first.runId],
          );
        expect(run).toMatchObject({
          status: "failed",
          error_message: "已确认失败",
        });
      } finally {
        await f.close();
      }
    });
    it("restore holds actual host lease, advances both epochs, closes old queue and only explicit finish resumes admission", async () => {
      const f = await fixture();
      try {
        await f.host.submit(f.actor, f.input("running"));
        await vi.waitFor(() => expect(f.createRun).toHaveBeenCalledTimes(1));
        await f.host.submit(f.actor, f.input("old-queue"));
        const lease = await f.host.beginRestore(f.actor, {
          taskId: f.task.id,
          expectedScopeGeneration: 1,
          expectedBranchGeneration: 1,
        });
        expect([
          lease.scopeGeneration,
          lease.branchGeneration,
          lease.scope.generation,
        ]).toEqual([2, 2, 2]);
        expect(
          (await f.tasks.readPolicy(f.actor, f.task.id)).executionState,
        ).toBe("revoking");
        await expect(
          f.host.submit(f.actor, {
            ...f.input("during"),
            scopeGeneration: 2,
            branchGeneration: 2,
          }),
        ).rejects.toThrow("权限已变更");
        expect(
          await f.host.finishRestore(f.actor, {
            taskId: f.task.id,
            operationId: randomUUID(),
            scopeGeneration: 2,
            branchGeneration: 2,
            state: "ready",
          }),
        ).toBe(false);
        expect(
          await f.host.finishRestore(f.actor, {
            taskId: f.task.id,
            operationId: lease.operationId,
            scopeGeneration: 2,
            branchGeneration: 2,
            state: "ready",
          }),
        ).toBe(true);
        expect(f.createRun).toHaveBeenCalledTimes(1);
        const rows = await f.persistence
          .forInstance(f.instanceId)
          .query(
            `select status from public.design_task_inputs where instance_id=:instance and task_id=$1 order by admission_seq`,
            [f.task.id],
          );
        expect(rows.map((row) => row.status)).toEqual(["settled", "canceled"]);
      } finally {
        await f.close();
      }
    });
    it("dead restore host is reconciled failed by real lock proof, with no success guessing or model replay", async () => {
      const f = await fixture();
      try {
        const lease = await f.tasks.beginRestore(f.actor, {
          taskId: f.task.id,
          expectedScopeGeneration: 1,
          expectedBranchGeneration: 1,
        });
        const other = createDesignTasksService({
          persistence: f.persistence,
          localInstance: f.localInstance,
          sandboxRoot: f.directory,
        });
        try {
          expect(await other.recoverInterruptedTasks(f.actor)).toBe(0);
          await f.tasks.close();
          expect(await other.recoverInterruptedTasks(f.actor)).toBe(1);
          expect(
            (await other.readPolicy(f.actor, f.task.id)).executionState,
          ).toBe("failed");
          expect(
            await other.finishRestore(f.actor, {
              taskId: f.task.id,
              operationId: lease.operationId,
              scopeGeneration: 2,
              branchGeneration: 2,
              state: "ready",
            }),
          ).toBe(false);
          expect(f.createRun).not.toHaveBeenCalled();
        } finally {
          await other.close();
        }
      } finally {
        await f.close();
      }
    });
  },
);
