import { expect, it } from "vitest";
import { createGoalService, type GoalRecord } from "../goals/service.js";
import { createDesignGoals } from "./design-goals.js";
import { createTestDesignModelSelection } from "./design-goals-test-fixture.js";
import type { DesignTaskRow } from "./design-task-metadata.js";

function fixture() {
  const actor = { instanceId: "instance", accessClientId: "client" };
  const goals = createGoalService();
  let state: GoalRecord | null = null;
  const evidence = new Map<string, Record<string, unknown>>();
  let pending = false;
  const task: DesignTaskRow = {
    task_id: "task",
    canvas_id: "canvas",
    project_id: "project",
    root_directory: "/project",
    additional_directories: [],
    sandbox_mode: "workspace-write",
    scope_generation: 1,
    branch_generation: 1,
    permission_mode: "build",
    plan_enabled: false,
    planning_epoch: 0,
    active_run_id: null,
    execution_state: "ready",
    run_state: "idle",
    next_input_seq: 1,
  };
  const sql = {
    instanceId: actor.instanceId,
    async queryOne(statement: string) {
      if (statement.includes("select d.*")) return task;
      if (statement.includes("select state,model_invocation,owner_client_id"))
        return state
          ? {
              model_invocation:
                await createTestDesignModelSelection().capture(),
              state: structuredClone(state),
              owner_client_id: "client",
              observed_at: new Date(),
            }
          : null;
      if (statement.includes("status='queued'"))
        return pending ? { input_id: "user" } : null;
      return null;
    },
    async query(statement: string) {
      if (statement.includes("select source_id")) return [...evidence.values()];
      return [];
    },
    async execute(statement: string, params: unknown[]) {
      if (statement.includes("insert into public.design_task_goals"))
        state = JSON.parse(String(params[2]));
      else if (statement.includes("set state=$2"))
        state = JSON.parse(String(params[1]));
      else if (statement.includes("delete from public.design_goal_evidence"))
        evidence.clear();
      else if (statement.includes("'toolCall'"))
        evidence.set(String(params[2]), {
          source_id: params[2],
          kind: "toolCall",
          tool_name: params[3],
          input: JSON.parse(String(params[4])),
          detail: "",
          status: "pending",
        });
      else if (statement.includes("set detail=$4")) {
        const row = evidence.get(String(params[2]));
        if (row) {
          row.detail = params[3];
          row.status = params[4];
        }
      } else if (statement.includes("'assistantText'"))
        evidence.set(String(params[2]), {
          source_id: params[2],
          kind: "assistantText",
          tool_name: null,
          input: null,
          detail: params[3],
          status: "success",
        });
      return 1;
    },
  };
  const controller = new AbortController();
  const persistence = {
    forInstance: () => sql,
    transaction: async (fn: (tx: { forInstance(): typeof sql }) => unknown) =>
      fn({ forInstance: () => sql }),
    acquireSessionLock: async () => ({
      signal: controller.signal,
      release: async () => {},
    }),
  };
  const service = createDesignGoals({
    modelSelection: createTestDesignModelSelection(),
    persistence,
    goals,
    localInstance: {
      resolve: async () => ({ instanceId: actor.instanceId }),
      getContext: async () => ({ instanceId: actor.instanceId }),
    },
    permissions: { listPending: () => (pending ? [{}] : []) },
  } as unknown as Parameters<typeof createDesignGoals>[0]);
  const context = {
    actor,
    runId: "run",
    toolCallId: "verify",
    scopeHandle: {
      preset: "design",
      role: "main",
      agentId: "main",
      branchGeneration: 1,
      describe: () => ({
        instanceId: actor.instanceId,
        taskId: "task",
        generation: 1,
      }),
    },
  };
  return {
    actor,
    goals,
    service,
    task,
    context: context as unknown as Parameters<typeof service.verify>[0],
    sql: sql as unknown as Parameters<typeof service.lifecycle.claim>[0],
    state: () => state,
    pending: (value: boolean) => {
      pending = value;
    },
  };
}
it("HTTP expectations are fenced inside the actual Task transaction", async () => {
  const f = fixture();
  try {
    await expect(
      f.service.create(f.actor, {
        taskId: "task",
        objective: "验证",
        expectedBranchGeneration: 2,
        expectedGoal: null,
      }),
    ).rejects.toMatchObject({ code: "design_goal_conflict" });
    expect(f.state()).toBeNull();
    const goal = await f.service.create(f.actor, {
      taskId: "task",
      objective: "验证",
      expectedBranchGeneration: 1,
      expectedGoal: null,
    });
    const fence = {
      taskId: "task",
      goalId: goal.goalId,
      revision: goal.revision,
      branchGeneration: 2,
    };
    await expect(f.service.pause(f.actor, fence)).rejects.toMatchObject({
      code: "design_goal_conflict",
    });
    await expect(
      f.service.setBudget(f.actor, { ...fence, tokenBudget: 5 }),
    ).rejects.toMatchObject({ code: "design_goal_conflict" });
    expect(f.state()).toEqual(goal);
    const paused = await f.service.pause(f.actor, {
      ...fence,
      branchGeneration: 1,
    });
    f.task.branch_generation = 2;
    await expect(
      f.service.resume(f.actor, {
        ...fence,
        revision: paused.revision,
        branchGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "design_goal_conflict" });
    expect(f.state()?.status).toBe("paused");
  } finally {
    await f.service.close();
  }
});
it("same pure GoalService owns default unbudgeted claim and explicit missing usage pause", async () => {
  const f = fixture();
  await f.service.initialize();
  const created = await f.service.create(f.actor, {
    taskId: "task",
    objective: "write and validate",
  });
  expect(created.tokenBudget).toBeNull();
  await f.service.lifecycle.claim(f.sql, f.task, {
    actor: f.actor,
    runId: "run",
    inputId: "user",
    origin: "userInput",
  });
  f.task.active_run_id = "run";
  await f.service.observe(f.actor, "task", {
    type: "run.usage",
    runId: "run",
    inputTokens: 0,
    outputTokens: 0,
    runInputTokens: 0,
    runOutputTokens: 0,
    timestamp: new Date().toISOString(),
  });
  expect(f.state()?.runUsageObserved).toBe(true);
  await f.service.setBudget(f.actor, {
    taskId: "task",
    goalId: created.goalId,
    revision: f.state()!.revision,
    tokenBudget: 100,
  });
  await f.service.lifecycle.settle(f.sql, f.task, {
    runId: "run",
    outcome: "completed",
    at: Date.now(),
  });
  expect(f.state()?.status).toBe("active");
  f.task.active_run_id = null;
  await f.service.lifecycle.claim(f.sql, f.task, {
    actor: f.actor,
    runId: "missing",
    inputId: "next",
    origin: "goalContinuation",
    goalFence: { goalId: created.goalId, revision: f.state()!.revision },
  });
  await f.service.lifecycle.settle(f.sql, f.task, {
    runId: "missing",
    outcome: "completed",
    at: Date.now(),
  });
  expect(f.state()).toMatchObject({
    status: "paused",
    reason: "budget.usageUnavailable",
  });
  await f.service.close();
});
it("tool verification needs actual started+successful completed evidence; model text cannot replace a tool receipt", async () => {
  const f = fixture();
  await f.service.initialize();
  await f.service.create(f.actor, { taskId: "task", objective: "real result" });
  await f.service.lifecycle.claim(f.sql, f.task, {
    actor: f.actor,
    runId: "run",
    inputId: "user",
    origin: "userInput",
  });
  f.task.active_run_id = "run";
  await f.service.observe(f.actor, "task", {
    type: "message.delta",
    runId: "run",
    messageId: "m",
    delta: "I am done",
    timestamp: new Date().toISOString(),
  });
  await expect(
    f.service.verify(f.context, {
      revision: f.state()!.revision,
      evidenceIds: ["tool:run/m"],
      passed: true,
      reason: "asserted done",
    }),
  ).rejects.toMatchObject({ code: "design_goal_evidence_invalid" });
  await f.service.observe(f.actor, "task", {
    type: "tool.started",
    runId: "run",
    toolCallId: "bash",
    toolName: "Bash",
    input: { command: "true" },
    timestamp: new Date().toISOString(),
  });
  await f.service.observe(f.actor, "task", {
    type: "tool.completed",
    runId: "run",
    toolCallId: "bash",
    toolName: "Bash",
    status: "success",
    outputText: '{"state":"exited","exitCode":0}',
    timestamp: new Date().toISOString(),
  });
  await expect(
    f.service.verify(f.context, {
      revision: f.state()!.revision,
      evidenceIds: ["tool:run/bash"],
      passed: true,
      reason: "trivial",
    }),
  ).rejects.toMatchObject({ code: "design_goal_evidence_invalid" });
  await f.service.observe(f.actor, "task", {
    type: "tool.started",
    runId: "run",
    toolCallId: "read",
    toolName: "Read",
    input: { file_path: "result.md" },
    timestamp: new Date().toISOString(),
  });
  await f.service.observe(f.actor, "task", {
    type: "tool.completed",
    runId: "run",
    toolCallId: "read",
    toolName: "Read",
    status: "success",
    outputText: "validated content",
    timestamp: new Date().toISOString(),
  });
  const verified = await f.service.verify(f.context, {
    revision: f.state()!.revision,
    evidenceIds: ["tool:run/read"],
    passed: true,
    reason: "read actual result",
  });
  expect(verified.status).toBe("complete");
  await f.service.close();
});
it("persisted current Run text can verify a text result with revision and ownership fences", async () => {
  const f = fixture();
  await f.service.initialize();
  await f.service.create(f.actor, {
    taskId: "task",
    objective: "Explain the tradeoffs in a written answer",
  });
  await f.service.lifecycle.claim(f.sql, f.task, {
    actor: f.actor,
    runId: "run",
    inputId: "user",
    origin: "userInput",
  });
  f.task.active_run_id = "run";
  await f.service.observe(f.actor, "task", {
    type: "message.delta",
    runId: "run",
    messageId: "answer",
    delta:
      "A local service retains files on this machine; remote execution requires an explicit connection.",
    timestamp: new Date().toISOString(),
  });
  await f.service.observe(f.actor, "task", {
    type: "message.delta",
    runId: "run",
    messageId: "empty",
    delta: " ",
    timestamp: new Date().toISOString(),
  });
  const view = await f.service.read(f.context);
  expect(view?.evidenceCandidates).toEqual([
    {
      id: "assistant:run/answer",
      kind: "assistantText",
      revision: f.state()!.revision,
    },
  ]);
  const input = {
    revision: f.state()!.revision,
    evidenceIds: ["assistant:run/answer"],
    passed: true,
    reason: "The delivered answer states the requested tradeoffs",
  };
  for (const evidenceIds of [
    [],
    ["assistant:run/empty"],
    ["assistant:old/answer"],
    ["tool:run/answer"],
  ])
    await expect(
      f.service.verify(f.context, { ...input, evidenceIds }),
    ).rejects.toMatchObject({ code: "design_goal_evidence_invalid" });
  await expect(
    f.service.verify(f.context, { ...input, revision: input.revision + 1 }),
  ).rejects.toThrow("revision");
  await expect(
    f.service.verify({ ...f.context, runId: "old" }, input),
  ).rejects.toMatchObject({ code: "design_goal_conflict" });
  await expect(
    f.service.verify(
      { ...f.context, actor: { ...f.actor, instanceId: "other" } },
      input,
    ),
  ).rejects.toMatchObject({ code: "design_goal_conflict" });
  expect(f.state()?.status).toBe("active");
  const verified = await f.service.verify(f.context, input);
  expect(verified.status).toBe("complete");
  expect(verified.verification?.evidence).toEqual([
    {
      sourceId: "assistant:run/answer",
      passed: true,
      detail:
        "A local service retains files on this machine; remote execution requires an explicit connection.",
    },
  ]);
  await f.service.close();
});

it.each(["TaskOutput", "task_output"])(
  "%s failures remain invalid even when assistant text claims success",
  async (toolName) => {
    const f = fixture();
    await f.service.initialize();
    await f.service.create(f.actor, {
      taskId: "task",
      objective: "Validate a command result",
    });
    await f.service.lifecycle.claim(f.sql, f.task, {
      actor: f.actor,
      runId: "run",
      inputId: "user",
      origin: "userInput",
    });
    f.task.active_run_id = "run";
    await f.service.observe(f.actor, "task", {
      type: "message.delta",
      runId: "run",
      messageId: "claim",
      delta: "The command passed",
      timestamp: new Date().toISOString(),
    });
    const summaries = [
      { state: "exited", exitCode: 1, output: "tests passed" },
      JSON.stringify({ state: "exited", exitCode: 1 }),
      { state: "running", exitCode: null },
    ];
    for (const [index, summary] of summaries.entries()) {
      const toolCallId = `failed-${index}`;
      await f.service.observe(f.actor, "task", {
        type: "tool.started",
        runId: "run",
        toolCallId,
        toolName,
        input: {},
        timestamp: new Date().toISOString(),
      });
      await f.service.observe(f.actor, "task", {
        type: "tool.completed",
        runId: "run",
        toolCallId,
        toolName,
        status: "success",
        outputText: JSON.stringify({ status: "completed", summary }),
        timestamp: new Date().toISOString(),
      });
      await expect(
        f.service.verify(f.context, {
          revision: f.state()!.revision,
          evidenceIds: ["assistant:run/claim", `tool:run/${toolCallId}`],
          passed: true,
          reason: "Claimed success",
        }),
      ).rejects.toMatchObject({ code: "design_goal_evidence_invalid" });
    }
    expect(
      (await f.service.read(f.context))?.evidenceCandidates.map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["assistant:run/claim"]);
    expect(f.state()?.status).toBe("active");
    await f.service.observe(f.actor, "task", {
      type: "tool.started",
      runId: "run",
      toolCallId: "actual",
      toolName,
      input: {},
      timestamp: new Date().toISOString(),
    });
    await f.service.observe(f.actor, "task", {
      type: "tool.completed",
      runId: "run",
      toolCallId: "actual",
      toolName,
      status: "success",
      outputText: JSON.stringify({
        status: "completed",
        summary: { state: "exited", exitCode: 0 },
      }),
      timestamp: new Date().toISOString(),
    });
    expect(
      (
        await f.service.verify(f.context, {
          revision: f.state()!.revision,
          evidenceIds: ["tool:run/actual"],
          passed: true,
          reason: "Actual successful exit",
        })
      ).status,
    ).toBe("complete");
    await f.service.close();
  },
);
it("user queue and approval block continuation; Stop preserves pause; rebranch and recover require manual resume", async () => {
  const f = fixture();
  await f.service.initialize();
  const goal = await f.service.create(f.actor, {
    taskId: "task",
    objective: "target",
  });
  f.pending(true);
  await expect(
    f.service.lifecycle.claim(f.sql, f.task, {
      actor: f.actor,
      runId: "goal",
      inputId: "goal-step",
      origin: "goalContinuation",
      goalFence: { goalId: goal.goalId, revision: goal.revision },
    }),
  ).rejects.toMatchObject({ code: "design_goal_conflict" });
  f.pending(false);
  await f.service.lifecycle.pause(f.sql, f.task, "user.stop", Date.now());
  expect(f.state()).toMatchObject({ status: "paused", reason: "user.stop" });
  await f.service.lifecycle.rebranch(f.sql, f.task, 2, Date.now());
  expect(f.state()).toMatchObject({
    status: "paused",
    reason: "task.branchChanged",
    branchGeneration: 2,
  });
  f.task.branch_generation = 2;
  await f.service.resume(f.actor, {
    taskId: "task",
    goalId: goal.goalId,
    revision: f.state()!.revision,
  });
  await f.service.lifecycle.recover(f.sql, f.task, Date.now());
  expect(f.state()).toMatchObject({
    status: "paused",
    reason: "host.restarted",
  });
  await f.service.close();
});
