import { describe, expect, it } from "vitest";
import { createGoalService } from "./service.js";

const service = createGoalService();
const idle = {
  branchGeneration: 1,
  taskReady: true,
  activeRunId: null,
  userReserved: false,
  userQueued: false,
  approvalWaiting: false,
};
const create = () =>
  service.create(null, {
    goalId: "g",
    objective: "ship",
    branchGeneration: 1,
    at: 1000,
  });
const claim = () =>
  service.claimRun(create(), {
    goalId: "g",
    revision: 1,
    runId: "r",
    at: 1000,
    foreground: idle,
  });

describe("Task Goal lifecycle", () => {
  it("new user input invalidates verification while preserving the claimed Run and progress", () => {
    const claimed = claim();
    const current = service.beginVerification(claimed, {
      goalId: "g",
      revision: claimed.revision,
      runId: "r",
    });
    const next = service.invalidateVerification(current, {
      goalId: "g",
      revision: current.revision,
      runId: "r",
    });
    expect(next).toMatchObject({
      status: "active",
      claimedRunId: "r",
      iteration: 1,
      evaluation: null,
      runs: current.runs,
      tokensUsed: current.tokensUsed,
      timeUsedSeconds: current.timeUsedSeconds,
    });
    expect(current.status).toBe("verifying");
    expect(next.revision).toBe(current.revision + 1);
    expect(() =>
      service.invalidateVerification(next, {
        goalId: "g",
        revision: next.revision,
        runId: "r",
      }),
    ).toThrow();
    expect(() =>
      service.invalidateVerification(current, {
        goalId: "g",
        revision: current.revision,
        runId: "another-run",
      }),
    ).toThrow();
  });

  it("clones input, has no default budget, and never completes on ordinary done", () => {
    const original = claim();
    const next = service.observeTerminal(original, {
      runId: "r",
      outcome: "completed",
      at: 3999,
    });
    expect(original.claimedRunId).toBe("r");
    expect(next.status).toBe("active");
    expect(next.tokenBudget).toBeNull();
    expect(next.timeUsedSeconds).toBe(2);
    expect(next.claimedRunId).toBeNull();
  });
  it("rejects every foreground blocker and stale revision or branch", () => {
    for (const blocker of [
      { activeRunId: "other" },
      { userReserved: true },
      { userQueued: true },
      { approvalWaiting: true },
      { taskReady: false },
      { branchGeneration: 2 },
    ]) {
      expect(() =>
        service.claimRun(create(), {
          goalId: "g",
          revision: 1,
          runId: "r",
          at: 1000,
          foreground: { ...idle, ...blocker },
        }),
      ).toThrow();
    }
    expect(() =>
      service.claimRun(create(), {
        goalId: "g",
        revision: 0,
        runId: "r",
        at: 1000,
        foreground: idle,
      }),
    ).toThrow();
  });
  it("uses cumulative usage once and stops at an explicit budget", () => {
    let goal = service.create(null, {
      goalId: "g",
      objective: "ship",
      branchGeneration: 1,
      tokenBudget: 10,
      at: 0,
    });
    goal = service.claimRun(goal, {
      goalId: "g",
      revision: 1,
      runId: "r",
      at: 0,
      foreground: idle,
    });
    goal = service.observeUsage(goal, { runId: "r", tokensUsed: 8 });
    goal = service.observeUsage(goal, { runId: "r", tokensUsed: 8 });
    expect(goal.tokensUsed).toBe(8);
    goal = service.observeUsage(goal, { runId: "r", tokensUsed: 10 });
    expect(goal.status).toBe("paused");
    expect(goal.reason).toBe("budget.stop");
    expect(
      service.observeUsage(goal, { runId: "old", tokensUsed: 100 }).tokensUsed,
    ).toBe(10);
  });
  it("requires current structured evidence and model verdict", () => {
    const goal = claim();
    expect(() =>
      service.verify(goal, {
        goalId: "g",
        revision: goal.revision,
        runId: "r",
        evidence: [],
        verdict: { passed: true, reason: "done" },
        at: 2000,
      }),
    ).toThrow();
    const complete = service.verify(goal, {
      goalId: "g",
      revision: goal.revision,
      runId: "r",
      evidence: [{ sourceId: "test", passed: true }],
      verdict: { passed: true, reason: "All requirements verified" },
      at: 2000,
    });
    expect(complete.status).toBe("complete");
    expect(complete.verification).toMatchObject({ runId: "r", iteration: 1 });
    expect(
      service.observeTerminal(complete, {
        runId: "r",
        outcome: "completed",
        at: 3000,
      }).status,
    ).toBe("complete");
  });
  it("pauses canceled, failed and recovered runs without replay", () => {
    for (const outcome of ["canceled", "failed"] as const) {
      const goal = service.observeTerminal(claim(), {
        runId: "r",
        outcome,
        at: 3000,
      });
      expect(goal.status).toBe("paused");
      expect(
        service.observeTerminal(goal, { runId: "r", outcome, at: 9000 }),
      ).toEqual(goal);
    }
    const recovered = service.recover(claim(), 4000);
    expect(recovered.status).toBe("paused");
    expect(recovered.claimedRunId).toBeNull();
    expect(recovered.reason).toBe("host.restarted");
  });
  it("fences stale verification after pause and resumes only by explicit call", () => {
    const goal = claim();
    const paused = service.pause(goal, {
      goalId: "g",
      revision: goal.revision,
      reason: "user.stop",
      at: 2000,
    });
    expect(() =>
      service.verify(paused, {
        goalId: "g",
        revision: goal.revision,
        runId: "r",
        evidence: [{ sourceId: "x", passed: true }],
        verdict: { passed: true, reason: "done" },
        at: 3000,
      }),
    ).toThrow();
    const settled = service.observeTerminal(paused, {
      runId: "r",
      outcome: "canceled",
      at: 3000,
    });
    expect(
      service.resume(settled, {
        goalId: "g",
        revision: settled.revision,
        branchGeneration: 1,
      }).status,
    ).toBe("active");
  });
});

it("rejects old terminal and clones evidence while allowing explicit budget revision", () => {
  const goal = claim();
  expect(
    service.observeTerminal(goal, {
      runId: "old",
      outcome: "canceled",
      at: 5000,
    }),
  ).toEqual(goal);
  const evidence = [{ sourceId: "test", passed: false }];
  const verified = service.verify(goal, {
    goalId: "g",
    revision: goal.revision,
    runId: "r",
    evidence,
    verdict: { passed: true, reason: "Test failed" },
    at: 2000,
  });
  evidence[0]!.passed = true;
  expect(verified.status).toBe("notSatisfied");
  expect(verified.verification?.evidence[0]?.passed).toBe(false);
  expect(
    service.setBudget(verified, {
      goalId: "g",
      revision: verified.revision,
      tokenBudget: 20,
    }).tokenBudget,
  ).toBe(20);
});

it("预算停止原因保持到真实终态，完成状态不被迟到计量或停止改写", () => {
  let goal = service.setBudget(claim(), {
    goalId: "g",
    revision: 2,
    tokenBudget: 2,
  });
  goal = service.observeUsage(goal, { runId: "r", tokensUsed: 2 });
  expect(
    service.observeTerminal(goal, { runId: "r", outcome: "canceled", at: 2000 })
      .reason,
  ).toBe("budget.stop");
  const running = claim();
  const complete = service.verify(running, {
    goalId: "g",
    revision: running.revision,
    runId: "r",
    evidence: [{ sourceId: "test", passed: true }],
    verdict: { passed: true, reason: "All requirements verified" },
    at: 2000,
  });
  expect(
    service.observeUsage(
      service.setBudget(complete, {
        goalId: "g",
        revision: complete.revision,
        tokenBudget: 1,
      }),
      { runId: "r", tokensUsed: 5 },
    ).status,
  ).toBe("complete");
  expect(
    service.observeTerminal(complete, {
      runId: "r",
      outcome: "canceled",
      at: 3000,
    }).status,
  ).toBe("complete");
});

it("同Task历史编辑换分支暂停并丢弃旧Run证据，绝不自动接纳", () => {
  const running = claim();
  const completed = service.verify(running, {
    goalId: "g",
    revision: running.revision,
    runId: "r",
    evidence: [{ sourceId: "old", passed: true }],
    verdict: { passed: true, reason: "old branch verified" },
    at: 2000,
  });
  const branched = service.rebranch(completed, 2, 3000);
  expect(branched.status).toBe("paused");
  expect(branched.branchGeneration).toBe(2);
  expect(branched.claimedRunId).toBeNull();
  expect(branched.verification).toBeNull();
  expect(branched.objective).toBe(completed.objective);
  expect(() =>
    service.claimRun(branched, {
      goalId: "g",
      revision: branched.revision,
      runId: "new",
      at: 4000,
      foreground: { ...idle, branchGeneration: 2 },
    }),
  ).toThrow();
  expect(
    service.observeUsage(branched, { runId: "r", tokensUsed: 999 }).tokensUsed,
  ).toBe(branched.tokensUsed);
});

it("预算Run缺计量暂停，不把未知用量冒充零，真实零用量有效", () => {
  const budgeted = service.setBudget(claim(), {
    goalId: "g",
    revision: 2,
    tokenBudget: 100,
  });
  const unknown = service.observeTerminal(budgeted, {
    runId: "r",
    outcome: "completed",
    at: 2000,
  });
  expect(unknown.status).toBe("paused");
  expect(unknown.reason).toBe("budget.usageUnavailable");
  expect(unknown.runUsageObserved).toBe(false);
  const measured = service.observeUsage(budgeted, {
    runId: "r",
    tokensUsed: 0,
  });
  expect(measured.runUsageObserved).toBe(true);
  expect(
    service.observeTerminal(measured, {
      runId: "r",
      outcome: "completed",
      at: 2000,
    }).status,
  ).toBe("active");
  expect(() =>
    service.create(unknown, {
      goalId: "new",
      objective: "replace",
      branchGeneration: 1,
      at: 3000,
    }),
  ).toThrow("unfinished");
});

it("显式预算缺计量时模型验收也不能宣告完成", () => {
  const goal = service.setBudget(claim(), {
    goalId: "g",
    revision: 2,
    tokenBudget: 100,
  });
  const result = service.verify(goal, {
    goalId: "g",
    revision: goal.revision,
    runId: "r",
    evidence: [{ sourceId: "row:1", passed: true }],
    verdict: { passed: true, reason: "Verified output" },
    at: 2000,
  });
  expect(result.status).toBe("paused");
  expect(result.reason).toBe("budget.usageUnavailable");
});
