import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { expect, it } from "vitest";
import { createGoalService } from "../goals/service.js";
import { createCodeUiConversation } from "./conversation.js";
import { pauseTaskGoal, projectGoal } from "./goals.js";

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

it("Goal公共投影区分已claim工作轮与原协议验收轮，不提前显示下一次迭代", () => {
  const goals = createGoalService();
  let record = goals.create(null, {
    goalId: "projection-goal",
    objective: "创建文件并验收",
    branchGeneration: 1,
    at: 0,
  });
  const claim = (runId: string, at: number) => {
    record = goals.claimRun(record, {
      goalId: record.goalId,
      revision: record.revision,
      runId,
      at,
      foreground: {
        branchGeneration: 1,
        taskReady: true,
        activeRunId: null,
        userReserved: false,
        userQueued: false,
        approvalWaiting: false,
      },
    });
  };
  const projected = () => protocol.goalStateSchema.parse(projectGoal(record));
  const legacyProjected = () => {
    const legacy = structuredClone(record);
    if (legacy.verification) delete legacy.verification.iteration;
    return projectGoal(legacy);
  };
  expect(projected()).toMatchObject({ status: "active", iteration: 0 });
  claim("first-run", 1000);
  expect(record.iteration).toBe(1);
  expect(projected()).toMatchObject({ status: "active", iteration: 0 });

  const paused = goals.pause(record, {
    goalId: record.goalId,
    revision: record.revision,
    reason: "user.pause",
    at: 2000,
  });
  expect(projectGoal(paused)).toMatchObject({ status: "paused", iteration: 1 });
  const canceled = goals.observeTerminal(paused, {
    runId: "first-run",
    outcome: "canceled",
    at: 3000,
  });
  expect(projectGoal(canceled)).toMatchObject({
    status: "paused",
    iteration: 1,
    verifications: [],
  });

  record = goals.beginVerification(record, {
    goalId: record.goalId,
    revision: record.revision,
    runId: "first-run",
  });
  expect(projected()).toMatchObject({ status: "verifying", iteration: 1 });
  record = goals.verify(record, {
    goalId: record.goalId,
    revision: record.revision,
    runId: "first-run",
    evidence: [{ sourceId: "row:1", passed: true }],
    verdict: { passed: false, reason: "缺少第二份文件" },
    at: 4000,
  });
  expect(projected()).toMatchObject({
    status: "notSatisfied",
    iteration: 1,
    verifications: [{ iteration: 1, outcome: "notSatisfied" }],
  });
  expect(legacyProjected()?.verifications).toMatchObject([{ iteration: 1 }]);
  record = goals.observeTerminal(record, {
    runId: "first-run",
    outcome: "completed",
    at: 5000,
  });
  expect(projected()).toMatchObject({
    status: "notSatisfied",
    iteration: 1,
    verifications: [{ iteration: 1, outcome: "notSatisfied" }],
  });
  expect(legacyProjected()?.verifications).toMatchObject([{ iteration: 1 }]);
  claim("second-run", 6000);
  expect(record.iteration).toBe(2);
  expect(projected()).toMatchObject({
    status: "active",
    iteration: 1,
    verifications: [{ iteration: 1, outcome: "notSatisfied" }],
  });
  expect(legacyProjected()?.verifications).toMatchObject([{ iteration: 1 }]);
  record = goals.beginVerification(record, {
    goalId: record.goalId,
    revision: record.revision,
    runId: "second-run",
  });
  expect(projected()).toMatchObject({
    status: "verifying",
    iteration: 2,
    verifications: [{ iteration: 1, outcome: "notSatisfied" }],
  });
  record = goals.verify(record, {
    goalId: record.goalId,
    revision: record.revision,
    runId: "second-run",
    evidence: [{ sourceId: "row:2", passed: true }],
    verdict: { passed: true, reason: "文件已验收" },
    at: 7000,
  });
  record = goals.observeTerminal(record, {
    runId: "second-run",
    outcome: "completed",
    at: 8000,
  });
  expect(projected()).toMatchObject({
    status: "verified",
    iteration: 2,
    verifications: [{ iteration: 2, outcome: "pass" }],
  });
  expect(record.iteration).toBe(2);
});

it("Goal验收轮次跨连续取消恢复和冷恢复保持原归属，旧记录不猜无法确定的轮次", () => {
  const goals = createGoalService();
  let current = host();
  current.setGoal(
    goals.create(null, {
      goalId: "verification-goal",
      objective: "验收文件",
      branchGeneration: 1,
      at: 0,
    }),
  );
  current.startTurn({ runId: "first-run", commandId: "first", text: "验收" });
  const claimed = current.getGoal()!;
  current.setGoal(
    goals.verify(claimed, {
      goalId: claimed.goalId,
      revision: claimed.revision,
      runId: "first-run",
      evidence: [{ sourceId: "row:1", passed: true }],
      verdict: { passed: false, reason: "文件未齐" },
      at: 1000,
    }),
  );
  current.recordEvent({
    type: "run.completed",
    runId: "first-run",
    timestamp: new Date(2000).toISOString(),
  });
  for (let iteration = 2; iteration <= 4; iteration += 1) {
    const runId = `run-${iteration}`;
    current.startTurn({ runId, commandId: runId, text: "继续" });
    expect(current.getGoal()?.iteration).toBe(iteration);
    expect(current.getSnapshot().goal).toMatchObject({
      status: "active",
      iteration: iteration - 1,
      verifications: [{ iteration: 1, outcome: "notSatisfied" }],
    });
    const goal = current.getGoal()!;
    current.setGoal(
      goals.pause(goal, {
        goalId: goal.goalId,
        revision: goal.revision,
        reason: "user.stop",
        at: iteration * 1000,
      }),
    );
    current.recordEvent({
      type: "run.canceled",
      runId,
      timestamp: new Date(iteration * 1000 + 1000).toISOString(),
    });
    current = createCodeUiConversation({
      sessionId: "task",
      workspacePath: "/project",
      config,
      state: JSON.parse(JSON.stringify(current.exportState())),
    });
    const settled = current.getGoal()!;
    expect(settled.verification).toMatchObject({
      runId: "first-run",
      iteration: 1,
    });
    expect(current.getSnapshot().goal).toMatchObject({
      status: "paused",
      iteration,
      verifications: [{ iteration: 1, outcome: "notSatisfied" }],
    });
    const legacy = structuredClone(settled);
    if (legacy.verification) delete legacy.verification.iteration;
    const audit = structuredClone(legacy);
    expect(projectGoal(legacy)?.verifications).toEqual([]);
    expect(legacy).toEqual(audit);
    current.setGoal(
      goals.resume(settled, {
        goalId: settled.goalId,
        revision: settled.revision,
        branchGeneration: 1,
      }),
    );
  }
});

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
