export type GoalStatus =
  | "active"
  | "paused"
  | "verifying"
  | "complete"
  | "notSatisfied"
  | "failed";
/** Evidence is accepted only after the Task consumer validates its real Run provenance. */
export interface GoalEvidence {
  sourceId: string;
  sourceRunId?: string;
  passed: boolean;
  detail?: string;
  /** Private evaluation context; public verification retains only source/result/detail. */
  tool?: {
    name: string;
    inputText: string;
    files?: Array<{ path: string; version: string }>;
  };
}
export interface GoalRunMember {
  runId: string;
  branchGeneration: number;
  iteration: number;
}
/** Authenticated historical operations, separate from evidence of the current artifact state. */
export interface GoalExecutionFacts {
  complete: boolean;
  runs: GoalRunMember[];
  tools: Array<{
    sourceId: string;
    sourceSessionId: string;
    sourceRunId: string;
    toolCallId: string;
    status: string;
    tool: { name: string; inputText: string };
    outputText: string;
    error?: { code: string; message: string };
  }>;
}
export interface GoalVerification {
  runId: string;
  /** Captured at verification; absent only in older persisted Goal records. */
  iteration?: number;
  evidence: GoalEvidence[];
  passed: boolean;
  reason: string;
  at: number;
}
export interface GoalRecord {
  goalId: string;
  objective: string;
  status: GoalStatus;
  revision: number;
  branchGeneration: number;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  iteration: number;
  /** Real claims within this Goal; older records can lack this membership ledger. */
  runs?: GoalRunMember[];
  claimedRunId: string | null;
  lastSettledRunId: string | null;
  runTokensUsed: number;
  runUsageObserved: boolean;
  runStartedAt: number | null;
  verification: GoalVerification | null;
  /** Persisted under the Task lock before sending an independent model request. */
  evaluation?: {
    requestId: string;
    runId: string;
    revision: number;
    evidence: GoalEvidence[];
    executionFacts: GoalExecutionFacts;
    proposal: { passed: boolean; reason: string };
  } | null;
  reason: string | null;
}
export interface GoalFence {
  goalId: string;
  revision: number;
}
export interface GoalForeground {
  branchGeneration: number;
  taskReady: boolean;
  activeRunId: string | null;
  userReserved: boolean;
  userQueued: boolean;
  approvalWaiting: boolean;
}
export interface CreateGoalInput {
  goalId: string;
  objective: string;
  branchGeneration: number;
  tokenBudget?: number | null;
  at: number;
}
export interface ClaimGoalRunInput extends GoalFence {
  runId: string;
  at: number;
  foreground: GoalForeground;
}
export interface VerifyGoalInput extends GoalFence {
  runId: string;
  evidence: GoalEvidence[];
  verdict: { passed: boolean; reason: string; failed?: boolean };
  at: number;
}
export interface GoalService {
  create(current: GoalRecord | null, input: CreateGoalInput): GoalRecord;
  setBudget(
    current: GoalRecord,
    input: GoalFence & { tokenBudget: number | null },
  ): GoalRecord;
  beginVerification(
    current: GoalRecord,
    input: GoalFence & { runId: string },
  ): GoalRecord;
  pause(
    current: GoalRecord,
    input: GoalFence & { reason: string; at: number },
  ): GoalRecord;
  resume(
    current: GoalRecord,
    input: GoalFence & { branchGeneration: number },
  ): GoalRecord;
  claimRun(current: GoalRecord, input: ClaimGoalRunInput): GoalRecord;
  observeUsage(
    current: GoalRecord,
    input: { runId: string; tokensUsed: number },
  ): GoalRecord;
  observeTerminal(
    current: GoalRecord,
    input: {
      runId: string;
      outcome: "completed" | "failed" | "canceled";
      at: number;
    },
  ): GoalRecord;
  verify(current: GoalRecord, input: VerifyGoalInput): GoalRecord;
  rebranch(
    current: GoalRecord,
    branchGeneration: number,
    lastObservedAt: number,
  ): GoalRecord;
  recover(current: GoalRecord, lastObservedAt: number): GoalRecord;
}
function clone(current: GoalRecord): GoalRecord {
  return structuredClone(current);
}
function fence(current: GoalRecord, input: GoalFence): void {
  if (current.goalId !== input.goalId || current.revision !== input.revision)
    throw new Error("Goal identity or revision changed");
}
function settleTime(goal: GoalRecord, at: number): void {
  if (goal.runStartedAt !== null)
    goal.timeUsedSeconds += Math.floor(
      Math.max(0, at - goal.runStartedAt) / 1000,
    );
  goal.runStartedAt = null;
}
function validBudget(budget: number | null): void {
  if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0))
    throw new Error("Goal budget must be a positive integer");
}
/** Pure Task-state provider; the consumer persists every transition under the Task root lock. */
const provider: GoalService = {
  create(current, input) {
    if (current && current.status !== "complete")
      throw new Error("An unfinished Goal already exists");
    const objective = input.objective.trim();
    if (!objective || !input.goalId)
      throw new Error("Goal identity and objective are required");
    const tokenBudget = input.tokenBudget ?? null;
    validBudget(tokenBudget);
    return {
      goalId: input.goalId,
      objective,
      status: "active",
      revision: 1,
      branchGeneration: input.branchGeneration,
      tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      iteration: 0,
      runs: [],
      claimedRunId: null,
      lastSettledRunId: null,
      runTokensUsed: 0,
      runUsageObserved: false,
      runStartedAt: null,
      verification: null,
      reason: null,
    };
  },
  setBudget(current, input) {
    fence(current, input);
    validBudget(input.tokenBudget);
    const goal = clone(current);
    goal.tokenBudget = input.tokenBudget;
    goal.revision += 1;
    if (goal.status === "verifying") {
      goal.status = "paused";
      goal.reason = "goal.evaluationChanged";
      if (goal.evaluation) goal.evaluation = null;
    }
    if (
      goal.tokenBudget !== null &&
      goal.tokensUsed >= goal.tokenBudget &&
      goal.status !== "complete"
    ) {
      goal.status = "paused";
      goal.reason = "budget.stop";
    }
    return goal;
  },
  beginVerification(current, input) {
    fence(current, input);
    if (current.claimedRunId !== input.runId || current.status !== "active")
      throw new Error("Verification Run is no longer current");
    const goal = clone(current);
    goal.status = "verifying";
    goal.revision += 1;
    return goal;
  },
  pause(current, input) {
    fence(current, input);
    const goal = clone(current);
    if (goal.status === "complete") return goal;
    goal.status = "paused";
    if (goal.evaluation) goal.evaluation = null;
    goal.reason = input.reason;
    goal.revision += 1;
    return goal;
  },
  resume(current, input) {
    fence(current, input);
    if (
      current.branchGeneration !== input.branchGeneration ||
      current.status !== "paused"
    )
      throw new Error("Goal cannot resume in this Task state");
    if (current.claimedRunId)
      throw new Error("The previous Goal Run has not settled");
    if (
      current.tokenBudget !== null &&
      current.tokensUsed >= current.tokenBudget
    )
      throw new Error("Goal budget is exhausted");
    const goal = clone(current);
    goal.status = "active";
    goal.reason = null;
    goal.revision += 1;
    return goal;
  },
  claimRun(current, input) {
    fence(current, input);
    const facts = input.foreground;
    if (
      !["active", "notSatisfied"].includes(current.status) ||
      current.claimedRunId ||
      !input.runId ||
      facts.branchGeneration !== current.branchGeneration ||
      !facts.taskReady ||
      facts.activeRunId ||
      facts.userReserved ||
      facts.userQueued ||
      facts.approvalWaiting
    )
      throw new Error("Task is not available for Goal continuation");
    if (
      current.tokenBudget !== null &&
      current.tokensUsed >= current.tokenBudget
    )
      throw new Error("Goal budget is exhausted");
    const goal = clone(current);
    goal.status = "active";
    goal.claimedRunId = input.runId;
    goal.runStartedAt = input.at;
    goal.runTokensUsed = 0;
    goal.runUsageObserved = false;
    goal.iteration += 1;
    goal.runs = [
      ...(goal.runs ?? []),
      {
        runId: input.runId,
        branchGeneration: goal.branchGeneration,
        iteration: goal.iteration,
      },
    ];
    goal.revision += 1;
    return goal;
  },
  observeUsage(current, input) {
    const goal = clone(current);
    if (input.runId !== goal.claimedRunId) return goal;
    if (!Number.isSafeInteger(input.tokensUsed) || input.tokensUsed < 0)
      throw new Error("Run usage must be a nonnegative cumulative integer");
    goal.runUsageObserved = true;
    const delta = Math.max(0, input.tokensUsed - goal.runTokensUsed);
    if (!delta) return goal;
    goal.tokensUsed += delta;
    goal.runTokensUsed += delta;
    if (
      goal.tokenBudget !== null &&
      goal.tokensUsed >= goal.tokenBudget &&
      goal.status !== "complete"
    ) {
      goal.status = "paused";
      goal.reason = "budget.stop";
      goal.revision += 1;
    }
    return goal;
  },
  observeTerminal(current, input) {
    const goal = clone(current);
    if (input.runId !== goal.claimedRunId) return goal;
    settleTime(goal, input.at);
    goal.lastSettledRunId = input.runId;
    goal.claimedRunId = null;
    goal.revision += 1;
    if (
      input.outcome === "completed" &&
      goal.tokenBudget !== null &&
      !goal.runUsageObserved &&
      !["complete", "paused"].includes(goal.status)
    ) {
      goal.status = "paused";
      goal.reason = "budget.usageUnavailable";
    }
    if (input.outcome !== "completed" && goal.status !== "complete") {
      goal.reason =
        goal.status === "paused" && goal.reason
          ? goal.reason
          : `run.${input.outcome}`;
      goal.status = "paused";
    }
    return goal;
  },
  verify(current, input) {
    fence(current, input);
    if (
      current.claimedRunId !== input.runId ||
      !["active", "verifying"].includes(current.status)
    )
      throw new Error("Verification Run is no longer current");
    if (
      !input.evidence.length ||
      input.evidence.some((item) => !item.sourceId.trim()) ||
      !input.verdict.reason.trim()
    )
      throw new Error("Real verification evidence and verdict are required");
    const goal = clone(current);
    const passed =
      !input.verdict.failed &&
      input.verdict.passed &&
      input.evidence.every((item) => item.passed);
    goal.verification = structuredClone({
      runId: input.runId,
      iteration: goal.iteration,
      evidence: input.evidence.map(
        ({ sourceId, sourceRunId, passed, detail }) => ({
          sourceId,
          ...(sourceRunId === undefined ? {} : { sourceRunId }),
          passed,
          ...(detail === undefined ? {} : { detail }),
        }),
      ),
      passed,
      reason: input.verdict.reason,
      at: input.at,
    });
    goal.status = input.verdict.failed
      ? "failed"
      : passed
        ? "complete"
        : "notSatisfied";
    goal.reason = input.verdict.reason;
    if (goal.tokenBudget !== null && !goal.runUsageObserved) {
      goal.status = "paused";
      goal.reason = "budget.usageUnavailable";
    }
    goal.revision += 1;
    return goal;
  },
  rebranch(current, branchGeneration, lastObservedAt) {
    const goal = clone(current);
    settleTime(goal, lastObservedAt);
    goal.status = "paused";
    goal.reason = "task.branchChanged";
    goal.branchGeneration = branchGeneration;
    goal.claimedRunId = null;
    goal.lastSettledRunId = null;
    goal.runTokensUsed = 0;
    goal.runUsageObserved = false;
    goal.verification = null;
    if (goal.evaluation) goal.evaluation = null;
    goal.revision += 1;
    return goal;
  },
  recover(current, at) {
    const goal = clone(current);
    if (goal.evaluation) goal.evaluation = null;
    if (goal.claimedRunId) {
      settleTime(goal, at);
      goal.lastSettledRunId = goal.claimedRunId;
      goal.claimedRunId = null;
    }
    if (["active", "verifying", "notSatisfied"].includes(goal.status)) {
      goal.status = "paused";
      goal.reason = "host.restarted";
      goal.revision += 1;
    }
    return goal;
  },
};

export function createGoalService(): GoalService {
  return { ...provider };
}
