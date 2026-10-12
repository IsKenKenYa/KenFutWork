import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import type { DesignGoalsService } from "../features/execution/design-goals-types.js";
import { DesignTaskError } from "../features/execution/design-task-errors.js";
import { createGoalService } from "../features/goals/service.js";
import { registerDesignGoalRoutes } from "./design-goals.js";

async function fixture() {
  const actor = { instanceId: randomUUID(), accessClientId: randomUUID() };
  const taskId = randomUUID();
  let goal = createGoalService().create(null, {
    goalId: randomUUID(),
    objective: "验收真实文件",
    branchGeneration: 3,
    at: 1,
  });
  const task = {
    taskId,
    projectId: randomUUID(),
    canvasId: randomUUID(),
    rootDirectory: "/owned",
    additionalDirectories: [],
    sandboxMode: "workspace-write" as const,
    scopeGeneration: 2,
    branchGeneration: 3,
    mode: "build" as const,
    planEnabled: false,
    planningEpoch: 1,
    activeRunId: null as string | null,
    executionState: "ready" as const,
  };
  const pure = createGoalService();
  const create = vi.fn(
    async (...[_actor, input]: Parameters<DesignGoalsService["create"]>) => {
      goal = pure.create(null, {
        ...input,
        goalId: randomUUID(),
        branchGeneration: 3,
        at: 1,
      });
      return goal;
    },
  );
  const pause = vi.fn(
    async (...[_actor, input]: Parameters<DesignGoalsService["pause"]>) => {
      goal = pure.pause(goal, { ...input, reason: "user.pause", at: 2 });
      return goal;
    },
  );
  const resume = vi.fn(
    async (...[_actor, input]: Parameters<DesignGoalsService["resume"]>) => {
      goal = pure.resume(goal, {
        ...input,
        branchGeneration: input.branchGeneration ?? 3,
      });
      return goal;
    },
  );
  const setBudget = vi.fn(
    async (...[_actor, input]: Parameters<DesignGoalsService["setBudget"]>) => {
      goal = pure.setBudget(goal, input);
      return goal;
    },
  );
  const dispatchGoal = vi.fn(async (_instanceId: string, _taskId: string) => {
    const runId = randomUUID();
    task.activeRunId = runId;
    goal.claimedRunId = runId;
    return true;
  });
  const stop = vi.fn(async () => ({
    kind: "stopping" as const,
    runId: task.activeRunId!,
  }));
  let authenticated = true;
  const app = Fastify();
  await registerDesignGoalRoutes(app, {
    localAccess: { authenticate: async () => (authenticated ? actor : null) },
    designGoals: {
      readTask: async () => goal,
      create,
      pause,
      resume,
      setBudget,
    },
    designTasks: {
      readPolicy: async (actual, id) => {
        expect(actual).toEqual(actor);
        expect(id).toBe(taskId);
        return task;
      },
    },
    designRunHost: { dispatchGoal, stop },
  });
  return {
    app,
    actor,
    task,
    goal: () => goal,
    create,
    pause,
    resume,
    setBudget,
    dispatchGoal,
    stop,
    url: `/api/design-tasks/${taskId}/goal`,
    unauthenticate: () => {
      authenticated = false;
    },
    fence: () => ({
      goalId: goal.goalId,
      revision: goal.revision,
      branchGeneration: goal.branchGeneration,
    }),
  };
}

it.each([undefined, null, 100])(
  "Goal create preserves budget %s and dispatches once with actual actor",
  async (budget) => {
    const f = await fixture();
    try {
      const body = {
        objective: "完成文件",
        expectedBranchGeneration: 3,
        expectedGoal: null,
        ...(budget !== undefined ? { tokenBudget: budget } : {}),
      };
      const result = await f.app.inject({
        method: "POST",
        url: f.url,
        payload: body,
      });
      expect(result.statusCode).toBe(200);
      expect(f.create).toHaveBeenCalledWith(f.actor, {
        taskId: f.task.taskId,
        ...body,
      });
      expect(f.dispatchGoal).toHaveBeenCalledExactlyOnceWith(
        f.actor.instanceId,
        f.task.taskId,
      );
      expect(result.json().acceptedRunId).toBe(f.goal().claimedRunId);
    } finally {
      await f.app.close();
    }
  },
);
it("strict Goal fence rejects scope injection without mutation", async () => {
  const f = await fixture();
  try {
    const result = await f.app.inject({
      method: "POST",
      url: `${f.url}/pause`,
      payload: { ...f.fence(), scopeGeneration: 999 },
    });
    expect(result.statusCode).toBe(400);
    expect(f.pause).not.toHaveBeenCalled();
    f.unauthenticate();
    expect((await f.app.inject({ method: "GET", url: f.url })).statusCode).toBe(
      401,
    );
  } finally {
    await f.app.close();
  }
});
it("pause stops only claimed Goal Run; budget changes never dispatch", async () => {
  const f = await fixture();
  try {
    await f.dispatchGoal(f.actor.instanceId, f.task.taskId);
    const runId = f.goal().claimedRunId;
    const paused = await f.app.inject({
      method: "POST",
      url: `${f.url}/pause`,
      payload: f.fence(),
    });
    expect(paused.statusCode).toBe(200);
    expect(f.stop).toHaveBeenCalledWith(f.actor, {
      taskId: f.task.taskId,
      expectedRunId: runId,
    });
    f.dispatchGoal.mockClear();
    const changed = await f.app.inject({
      method: "PATCH",
      url: `${f.url}/budget`,
      payload: { ...f.fence(), tokenBudget: null },
    });
    expect(changed.statusCode).toBe(200);
    expect(f.goal().status).toBe("paused");
    expect(f.dispatchGoal).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});
it("ordinary active Run is not reported as accepted Goal Run; mutation conflicts stay explicit", async () => {
  const f = await fixture();
  try {
    f.task.activeRunId = randomUUID();
    const read = await f.app.inject({ method: "GET", url: f.url });
    expect(read.json().acceptedRunId).toBeNull();
    expect(read.json().task.activeRunId).toBe(f.task.activeRunId);
    f.resume.mockRejectedValueOnce(
      new DesignTaskError(
        "design_goal_budget_exhausted",
        "目标预算已用尽，请调整预算后恢复",
      ),
    );
    const resumed = await f.app.inject({
      method: "POST",
      url: `${f.url}/resume`,
      payload: f.fence(),
    });
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json().error.message).toContain("预算");
    expect(f.dispatchGoal).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});
