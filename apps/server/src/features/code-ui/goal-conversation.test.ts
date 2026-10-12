import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { createGoalService } from "../goals/service.js";
import { createCodeUiConversation } from "./conversation.js";
import { pauseTaskGoal } from "./goals.js";

const config = {
  provider: "zcode",
  model: "test",
  thought: "",
  followupMode: "queue" as const,
};
function host() {
  return createCodeUiConversation({
    sessionId: "task",
    workspacePath: "/project",
    config,
  });
}
it("恢复先按持久Goal重建按钮投影，不信任过期可用性", () => {
  const current = host();
  const goals = createGoalService();
  const active = goals.create(null, {
    goalId: "g",
    objective: "验收",
    branchGeneration: 1,
    at: 0,
  });
  current.setGoal(
    goals.pause(active, {
      goalId: "g",
      revision: active.revision,
      reason: "user.pause",
      at: 1,
    }),
  );
  const persisted = JSON.parse(JSON.stringify(current.exportState()));
  persisted.snapshots[0].availability.pauseGoal = { allowed: false };
  persisted.snapshots[0].availability.resumeGoal = { allowed: false };
  const restored = createCodeUiConversation({
    sessionId: "task",
    workspacePath: "/project",
    config,
    state: persisted,
  });
  expect(restored.getGoal()?.status).toBe("paused");
  expect(restored.getSnapshot().availability.pauseGoal).toEqual({
    allowed: false,
    reasonCode: "guard.capabilityUnavailable",
  });
  expect(restored.getSnapshot().availability.resumeGoal).toEqual({
    allowed: true,
  });
  expect(persisted.snapshots[0].availability.resumeGoal).toEqual({
    allowed: false,
  });
});
it("Goal唯一事实跨export/hydrate，原wire派生且普通done不完成", () => {
  const current = host();
  current.setGoal(
    createGoalService().create(null, {
      goalId: "g",
      objective: "验收",
      branchGeneration: 1,
      at: 0,
    }),
  );
  current.startTurn({ runId: "r", commandId: "send", text: "验收" });
  current.recordEvent({
    type: "run.completed",
    runId: "r",
    timestamp: new Date(3000).toISOString(),
  });
  const restored = createCodeUiConversation({
    sessionId: "task",
    workspacePath: "/project",
    config,
    state: current.exportState(),
  });
  expect(restored.getGoal()?.status).toBe("active");
  expect(restored.getSnapshot().goal?.status).toBe("active");
  expect(restored.getGoal()?.claimedRunId).toBeNull();
});
it("Stop admission pause在取消前持久化，不靠随后run终态", () => {
  const current = host();
  current.setGoal(
    createGoalService().create(null, {
      goalId: "g",
      objective: "验收",
      branchGeneration: 1,
      at: 0,
    }),
  );
  current.startTurn({ runId: "r", commandId: "send", text: "验收" });
  const state = current.exportState();
  pauseTaskGoal(state, "task", "user.stop", 1000, createGoalService());
  expect(state.goalRecord?.status).toBe("paused");
  expect(state.snapshots[0]?.goal?.status).toBe("paused");
  expect(state.goalRecord?.claimedRunId).toBe("r");
  expect(current.getGoal()?.status).toBe("active");
});

it("公开conversation消费缝使用替换的Goal Provider处理claim/usage/terminal", () => {
  const base = createGoalService();
  const calls: string[] = [];
  const goals = {
    ...base,
    claimRun: (...args: Parameters<typeof base.claimRun>) => {
      calls.push("claim");
      return base.claimRun(...args);
    },
    observeUsage: (...args: Parameters<typeof base.observeUsage>) => {
      calls.push("usage");
      return base.observeUsage(...args);
    },
    observeTerminal: (...args: Parameters<typeof base.observeTerminal>) => {
      calls.push("terminal");
      return base.observeTerminal(...args);
    },
  };
  const current = createCodeUiConversation({
    sessionId: "task",
    workspacePath: "/project",
    config,
    goals,
  });
  current.setGoal(
    base.create(null, {
      goalId: "g",
      objective: "验收",
      branchGeneration: 1,
      at: 0,
    }),
  );
  current.startTurn({ runId: "r", commandId: "send", text: "验收" });
  current.recordEvent({
    type: "run.usage",
    runId: "r",
    inputTokens: 1,
    outputTokens: 1,
    runInputTokens: 1,
    runOutputTokens: 1,
    timestamp: new Date(2000).toISOString(),
  });
  current.recordEvent({
    type: "run.completed",
    runId: "r",
    timestamp: new Date(3000).toISOString(),
  });
  expect(calls).toEqual(["claim", "usage", "terminal"]);
});

it("Stop公开消费缝委托注入Provider，不另建实现", () => {
  const base = createGoalService();
  const current = host();
  current.setGoal(
    base.create(null, {
      goalId: "g",
      objective: "验收",
      branchGeneration: 1,
      at: 0,
    }),
  );
  const state = current.exportState();
  let called = false;
  pauseTaskGoal(state, "task", "user.stop", 1000, {
    ...base,
    pause: (...args) => {
      called = true;
      return base.pause(...args);
    },
  });
  expect(called).toBe(true);
});

function budgetHost() {
  const current = host();
  current.setGoal(
    createGoalService().create(null, {
      goalId: "budget-goal",
      objective: "目标",
      branchGeneration: 1,
      tokenBudget: 2,
      at: 0,
    }),
  );
  current.startTurn({
    runId: "budget-run",
    commandId: "send-budget",
    text: "目标",
  });
  return current;
}
it.each(["run.completed", "run.canceled"] as const)(
  "预算已尽经%s仍透可读暂停原因，不伪造Goal完成",
  (type) => {
    const current = budgetHost();
    current.recordEvent({
      type: "run.usage",
      runId: "budget-run",
      inputTokens: 1,
      outputTokens: 1,
      runInputTokens: 1,
      runOutputTokens: 1,
      timestamp: new Date(2000).toISOString(),
    });
    current.recordEvent({
      type,
      runId: "budget-run",
      timestamp: new Date(3000).toISOString(),
    });
    expect(current.getSnapshot().control.lastError).toMatchObject({
      code: "budget.stop",
      message: "目标预算已用尽，请提高或取消预算后恢复目标。",
      source: "runtime",
      recoverable: true,
    });
    expect(() =>
      protocol.conversationSnapshotSchema.parse(current.getSnapshot()),
    ).not.toThrow();
    expect(current.getSnapshot().goal?.status).toBe("paused");
    expect(current.getGoal()?.verification).toBeNull();
    expect(current.getSnapshot().control.phase).toBe(
      type === "run.completed" ? "completedSuccess" : "completedInterrupted",
    );
  },
);
it("预算缺真实usage的正常Run终态显示暂停原因，恢复后仍可见", () => {
  const current = budgetHost();
  current.recordEvent({
    type: "run.completed",
    runId: "budget-run",
    timestamp: new Date(3000).toISOString(),
  });
  const restored = createCodeUiConversation({
    sessionId: "task",
    workspacePath: "/project",
    config,
    state: current.exportState(),
  });
  expect(restored.getSnapshot().control.lastError).toMatchObject({
    code: "budget.usageUnavailable",
    message: "本轮用量不可用，目标已暂停，请取消预算后恢复目标。",
  });
  expect(restored.getSnapshot().goal?.status).toBe("paused");
  expect(restored.getGoal()?.verification).toBeNull();
});
it.each(["user.stop", "user.pause"])("用户%s正常取消不伪造错误", (reason) => {
  const current = budgetHost();
  const goal = current.getGoal()!;
  current.setGoal(
    createGoalService().pause(goal, {
      goalId: goal.goalId,
      revision: goal.revision,
      reason,
      at: 2000,
    }),
  );
  current.recordEvent({
    type: "run.canceled",
    runId: "budget-run",
    timestamp: new Date(3000).toISOString(),
  });
  expect(current.getSnapshot().control.lastError).toBeNull();
  expect(current.getSnapshot().goal?.status).toBe("paused");
});
it("真实Run失败原因优先于预算暂停原因", () => {
  const current = budgetHost();
  current.recordEvent({
    type: "run.usage",
    runId: "budget-run",
    inputTokens: 1,
    outputTokens: 1,
    runInputTokens: 1,
    runOutputTokens: 1,
    timestamp: new Date(2000).toISOString(),
  });
  current.recordEvent({
    type: "run.failed",
    runId: "budget-run",
    timestamp: new Date(3000).toISOString(),
    error: { code: "run_failed", message: "供应商拒绝当前请求" },
  });
  expect(current.getSnapshot().control.lastError).toMatchObject({
    code: "run_failed",
    message: "供应商拒绝当前请求",
  });
  expect(current.getSnapshot().control.phase).toBe("error");
});

it("缺usage已暂停的Goal经取消仍显示原因，不伪造验收记录", () => {
  const current = budgetHost();
  const goal = current.getGoal()!;
  current.setGoal(
    createGoalService().pause(goal, {
      goalId: goal.goalId,
      revision: goal.revision,
      reason: "budget.usageUnavailable",
      at: 2000,
    }),
  );
  current.recordEvent({
    type: "run.canceled",
    runId: "budget-run",
    timestamp: new Date(3000).toISOString(),
  });
  expect(
    protocol.conversationSnapshotSchema.parse(current.getSnapshot()).control
      .lastError,
  ).toMatchObject({ code: "budget.usageUnavailable", source: "runtime" });
  expect(current.getGoal()?.verification).toBeNull();
  expect(current.getSnapshot().goal?.status).toBe("paused");
});

it("过去的Goal预算暂停不冒充后来独立Run的错误", () => {
  const current = budgetHost();
  current.recordEvent({
    type: "run.completed",
    runId: "budget-run",
    timestamp: new Date(3000).toISOString(),
  });
  expect(current.getSnapshot().control.lastError?.code).toBe(
    "budget.usageUnavailable",
  );
  current.startTurn({
    runId: "manual-run",
    commandId: "manual",
    text: "独立提问",
  });
  current.recordEvent({
    type: "run.canceled",
    runId: "manual-run",
    timestamp: new Date(4000).toISOString(),
  });
  expect(current.getSnapshot().control.lastError).toBeNull();
  expect(current.getSnapshot().goal?.status).toBe("paused");
});
