import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createAgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import { createAgentRunRepository } from "../agent-runs/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createThreadService } from "../chat/thread-service.js";
import { createGoalService } from "../goals/service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createDesignGoals } from "./design-goals.js";
import { createTestDesignModelSelection } from "./design-goals-test-fixture.js";
import { createDesignRunHost } from "./design-run-host.js";
import { createDesignHostRepository } from "./design-run-host-repository.js";
import { createDesignTasksService } from "./design-tasks.js";
import { createScopeRepository } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";

async function fixture() {
  const db = await createTaskWorkDatabase();
  let approvalWaiting = false;
  const options = {
    modelSelection: createTestDesignModelSelection(),
    persistence: db.persistence,
    goals: createGoalService(),
    localInstance: db.localInstance,
    permissions: { listPending: () => (approvalWaiting ? [{}] : []) },
  } as unknown as Parameters<typeof createDesignGoals>[0];
  const goals = createDesignGoals(options);
  await goals.initialize();
  const tasks = createDesignTasksService({
    persistence: db.persistence,
    localInstance: db.localInstance,
    goalLifecycle: goals.lifecycle,
  });
  const { project, canvas } = await createProjectRepository(
    db.persistence,
  ).createProject({
    instanceId: db.instanceId,
    createdByClientId: db.actor.accessClientId,
    kind: "design",
    name: "Design Goal",
    slug: randomUUID(),
    description: null,
    canvasName: "Canvas",
    workDir: db.context.scope.rootDirectory,
  });
  if (!canvas) throw new Error("画布缺失");
  const prepared = await tasks.prepareCreation(db.actor, canvas.id);
  if (!prepared) throw new Error("Task准备缺失");
  const chat = createChatRepository(db.persistence);
  const task = await chat.createSession(db.instanceId, {
    canvasId: canvas.id,
    threadId: randomUUID(),
    createdByClientId: db.actor.accessClientId,
    designTaskPreparation: prepared,
  });
  if (!task) throw new Error("Task缺失");
  const scopes = createExecutionScopes({
    repository: createScopeRepository(db.persistence),
    localInstance: db.localInstance,
  });
  const runs = new Map<
    string,
    NonNullable<
      Parameters<
        Parameters<typeof createDesignRunHost>[0]["agentRuns"]["createRun"]
      >[1]
    >
  >();
  let executed = 0;
  let reportUsage = true;
  let finishAfter = 2;
  const canceled = new Set<string>();
  const createRun = vi.fn(
    (
      _request: unknown,
      options: NonNullable<
        Parameters<
          Parameters<typeof createDesignRunHost>[0]["agentRuns"]["createRun"]
        >[1]
      >,
    ) => {
      runs.set(options.runId!, options);
      return { runId: options.runId };
    },
  );
  const host = createDesignRunHost({
    modelSelection: options.modelSelection,
    repository: createDesignHostRepository(db.persistence),
    designTasks: tasks,
    designGoals: goals,
    agentModes: { activate: async () => {}, hydrate: async () => "agent" },
    localInstance: db.localInstance,
    localAccess: db.localAccess,
    threads: createThreadService({
      repository: chat,
      localInstance: db.localInstance,
    }),
    executionScopes: scopes,
    metadata: createAgentRunMetadataService({
      repository: createAgentRunRepository(db.persistence),
    }),
    taskWork: {
      onReady: () => () => {},
      list: async () => [],
      closeTask: async () => {},
    },
    agentRuns: {
      createRun,
      cancelRun: (runId: string) => {
        canceled.add(runId);
        return null;
      },
      cancelRunAndWait: async () => {},
      async *streamRun(runId: string) {
        executed++;
        const current = runs.get(runId)!;
        const emit = async (event: StreamEvent) => {
          await current.eventSink?.(event);
          return event;
        };
        if (reportUsage)
          yield await emit({
            type: "run.usage",
            runId,
            inputTokens: 0,
            outputTokens: 0,
            runInputTokens: 0,
            runOutputTokens: 0,
            timestamp: new Date().toISOString(),
          });
        yield await emit({
          type: "tool.started",
          runId,
          toolCallId: "read",
          toolName: "Read",
          input: { file_path: "result.md" },
          timestamp: new Date().toISOString(),
        });
        yield await emit({
          type: "tool.completed",
          runId,
          toolCallId: "read",
          toolName: "Read",
          status: "success",
          outputText: "actual result",
          timestamp: new Date().toISOString(),
        });
        const context = {
          requestModel: async () => ({
            text: JSON.stringify({
              passed: executed >= finishAfter,
              reason: "Independent fixture evaluation of actual Read",
            }),
            hasToolCalls: false,
            usageObserved: true,
          }),
          actor: db.actor,
          runId,
          toolCallId: "verify",
          scopeHandle: current.scopeHandle,
        };
        const view = await goals.read(context);
        if (view)
          await goals.verify(context, {
            revision: view.revision,
            evidenceIds: [`tool:${runId}/read`],
            passed: executed >= finishAfter,
            reason:
              executed >= finishAfter
                ? "all requirements backed by actual Read"
                : "more work needed",
          });
        yield await emit({
          type: canceled.has(runId) ? "run.canceled" : "run.completed",
          runId,
          timestamp: new Date().toISOString(),
        });
      },
    } as unknown as Parameters<typeof createDesignRunHost>[0]["agentRuns"],
  });
  await host.initialize();
  const input = (prompt: string) => ({
    taskId: task.id,
    inputId: randomUUID(),
    scopeGeneration: 1,
    branchGeneration: 1,
    request: {
      sessionId: task.id,
      taskId: task.id,
      projectId: project.id,
      conversationId: task.id,
      prompt,
      preset: "design" as const,
      executionMode: "goal" as const,
    },
  });
  return {
    ...db,
    goals,
    tasks,
    host,
    task,
    createRun,
    options,
    input,
    approval: (value: boolean) => {
      approvalWaiting = value;
    },
    missingUsage: () => {
      reportUsage = false;
    },
    finishAfter: (count: number) => {
      finishAfter = count;
    },
    async close() {
      await host.close();
      await tasks.close();
      await goals.close();
      await db.close();
    },
  };
}
describe.skipIf(process.env.KENFUTWORK_DESIGN_TASK_TEST_PG !== "1")(
  "Design Goal PostgreSQL调度与持久状态（注入工具事件）",
  () => {
    it("跨两Task Run使用同GoalService，注入事件完成验收后不生成第三轮", async () => {
      const f = await fixture();
      try {
        await f.host.submit(f.actor, f.input("complete the deliverable"));
        await vi.waitFor(
          async () =>
            expect((await f.goals.readTask(f.actor, f.task.id))?.status).toBe(
              "complete",
            ),
          { timeout: 10000 },
        );
        await vi.waitFor(async () =>
          expect(
            (await f.tasks.readPolicy(f.actor, f.task.id)).activeRunId,
          ).toBeNull(),
        );
        expect(f.createRun).toHaveBeenCalledTimes(2);
        const goal = await f.goals.readTask(f.actor, f.task.id);
        expect(goal).toMatchObject({
          iteration: 2,
          tokenBudget: null,
          runUsageObserved: true,
          status: "complete",
        });
        const inputs = await f.persistence
          .forInstance(f.instanceId)
          .query(
            `select input_id,input_origin from public.design_task_inputs where instance_id=:instance and task_id=$1 order by admission_seq`,
            [f.task.id],
          );
        expect(inputs.map((row) => row.input_origin)).toEqual([
          "userInput",
          "goalContinuation",
        ]);
        expect(String(inputs[1]?.input_id)).toMatch(/^goal:/u);
      } finally {
        await f.close();
      }
    });
    it("显式预算缺实际usage只暂停，不假零、不以模型结束当Goal完成", async () => {
      const f = await fixture();
      try {
        const goal = await f.goals.create(f.actor, {
          taskId: f.task.id,
          objective: "budgeted goal",
          tokenBudget: 100,
        });
        f.missingUsage();
        f.finishAfter(1);
        await f.host.submit(f.actor, f.input("work"));
        await vi.waitFor(async () =>
          expect((await f.goals.readTask(f.actor, f.task.id))?.status).toBe(
            "paused",
          ),
        );
        await vi.waitFor(async () =>
          expect(
            (await f.tasks.readPolicy(f.actor, f.task.id)).activeRunId,
          ).toBeNull(),
        );
        expect((await f.goals.readTask(f.actor, f.task.id))?.reason).toBe(
          "budget.usageUnavailable",
        );
        expect(f.createRun).toHaveBeenCalledTimes(1);
        expect((await f.goals.readTask(f.actor, f.task.id))?.goalId).toBe(
          goal.goalId,
        );
      } finally {
        await f.close();
      }
    });
    it("真实双host锁拒绝误恢复；cold idle active只能paused，必须manual resume且重验budget", async () => {
      const f = await fixture();
      try {
        const original = await f.goals.create(f.actor, {
          taskId: f.task.id,
          objective: "idle goal",
          tokenBudget: 10,
        });
        const peer = createDesignGoals(f.options);
        await expect(peer.initialize()).rejects.toMatchObject({
          code: "design_goal_host_busy",
        });
        await peer.close();
        expect((await f.goals.readTask(f.actor, f.task.id))?.status).toBe(
          "active",
        );
        await f.goals.close();
        const recovered = createDesignGoals(f.options);
        try {
          await recovered.initialize();
          const paused = (await recovered.readTask(f.actor, f.task.id))!;
          expect(paused).toMatchObject({
            status: "paused",
            reason: "host.restarted",
            goalId: original.goalId,
          });
          const stopped = await recovered.setBudget(f.actor, {
            taskId: f.task.id,
            goalId: paused.goalId,
            revision: paused.revision,
            tokenBudget: 1,
          });
          const resumed = await recovered.resume(f.actor, {
            taskId: f.task.id,
            goalId: stopped.goalId,
            revision: stopped.revision,
          });
          expect(resumed.status).toBe("active");
          expect(f.createRun).not.toHaveBeenCalled();
        } finally {
          await recovered.close();
        }
      } finally {
        await f.close();
      }
    });
  },
);
