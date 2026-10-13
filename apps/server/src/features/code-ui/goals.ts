import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { GoalRecord, GoalService } from "../goals/service.js";
import { isGoalToolEvidence } from "../goals/tool-evidence.js";
import type { CodeUiConversationState } from "./conversation.js";

export function projectGoal(
  goal: GoalRecord | null,
): protocol.GoalState | null {
  if (!goal) return null;
  const status = goal.status === "complete" ? "verified" : goal.status;
  return {
    targetId: goal.goalId,
    objective: goal.objective,
    summaryTitle: null,
    status,
    iteration: goal.iteration,
    iterations: [],
    timeUsedSeconds: goal.timeUsedSeconds,
    activeRunStartedAtMs: goal.runStartedAt,
    verifications: goal.verification
      ? [
          {
            iteration: goal.iteration,
            outcome:
              goal.status === "failed"
                ? "failed"
                : goal.verification.passed
                  ? "pass"
                  : "notSatisfied",
            at: goal.verification.at,
            anchorRowId: null,
            reason: goal.verification.reason,
          },
        ]
      : [],
  };
}
export function projectGoalSnapshot(
  root: protocol.ConversationSnapshot,
  goal: GoalRecord | null,
): void {
  root.goal = projectGoal(goal);
  const canPause =
    !!goal && ["active", "verifying", "notSatisfied"].includes(goal.status);
  root.availability.pauseGoal = canPause
    ? { allowed: true }
    : { allowed: false, reasonCode: "guard.capabilityUnavailable" };
  const canResume =
    !!goal &&
    goal.status === "paused" &&
    !goal.claimedRunId &&
    (goal.tokenBudget === null || goal.tokensUsed < goal.tokenBudget);
  root.availability.resumeGoal = canResume
    ? { allowed: true }
    : { allowed: false, reasonCode: "guard.capabilityUnavailable" };
}
export function syncGoal(state: CodeUiConversationState, rootId: string): void {
  const root = state.snapshots.find(
    (snapshot) => snapshot.sessionId === rootId,
  );
  if (root) projectGoalSnapshot(root, state.goalRecord ?? null);
}
export function pauseTaskGoal(
  state: CodeUiConversationState,
  rootId: string,
  reason: string,
  at: number,
  goals: GoalService,
): void {
  const goal = state.goalRecord;
  if (!goal || goal.status === "complete" || goal.status === "paused") return;
  state.goalRecord = goals.pause(goal, {
    goalId: goal.goalId,
    revision: goal.revision,
    reason,
    at,
  });
  syncGoal(state, rootId);
}

import { createHash } from "node:crypto";
import type {
  PromptExecutionContext,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { TaskGoalHost } from "../goals/consumer.js";
import { matchesActiveCodeRun } from "./active-run-binding.js";
import type { CodeUiRepository } from "./repository.js";

export function createTaskGoalHost(deps: {
  goals: GoalService;
  repository: Pick<CodeUiRepository, "find" | "appendEvent">;
  refresh(instanceId: string, path: string, projectId: string): Promise<void>;
}): TaskGoalHost {
  function scopeOf(context: PromptExecutionContext) {
    const scope = context.scopeHandle?.describe();
    if (
      !scope ||
      !context.actor ||
      context.actor.instanceId !== scope.instanceId ||
      context.scopeHandle?.role !== "main" ||
      context.scopeHandle.agentId !== "main" ||
      !context.runId
    )
      throw new Error("目标必须绑定当前主Task与Run");
    context.signal?.throwIfAborted();
    return scope;
  }
  return {
    async read(context) {
      const scope = scopeOf(context);
      const root = await deps.repository.find(scope.instanceId, scope.taskId);
      if (!root?.state?.goalRecord) return null;
      if (!root || !matchesActiveCodeRun(root, context))
        throw new Error("目标所属Run已失效");
      const goal = root.state?.goalRecord;
      const snapshot = root.state?.snapshots.find(
        (item) => item.sessionId === root.id,
      );
      const visible = goal ? structuredClone(goal) : null;
      for (const evidence of visible?.verification?.evidence ?? [])
        delete evidence.detail;
      return goal && visible
        ? {
            ...visible,
            evidenceCandidates: goalEvidenceCandidates(
              snapshot?.rows.window ?? [],
              context.runId!,
              goal.revision,
            ),
          }
        : null;
    },
    async verify(context: ToolExecutionContext, input) {
      const scope = scopeOf(context);
      if (!context.toolCallId) throw new Error("验证缺少可信工具调用身份");
      let result: GoalRecord | undefined;
      const event = {
        type: "goal.verify",
        runId: context.runId,
        toolCallId: context.toolCallId,
        input,
      };
      await deps.repository.appendEvent(
        scope.instanceId,
        scope.taskId,
        {
          key: `goal-verify:${context.runId}/${context.toolCallId}`,
          fingerprint: createHash("sha256")
            .update(JSON.stringify(event))
            .digest("hex"),
          event,
        },
        (root) => {
          if (!matchesActiveCodeRun(root, context))
            throw new Error("目标验证所属Run或授权代际已失效");
          const state = structuredClone(root.state!);
          const snapshot = state.snapshots.find(
            (item) => item.sessionId === root.id,
          )!;
          const goal = state.goalRecord;
          if (!goal || goal.branchGeneration !== Number(root.branch_generation))
            throw new Error("当前Task没有有效目标");
          const evidence = goalEvidence(
            snapshot.rows.window,
            context.runId!,
            input.evidenceIds,
          );
          result = deps.goals.verify(goal, {
            goalId: goal.goalId,
            revision: input.revision,
            runId: context.runId!,
            evidence,
            verdict: { passed: input.passed, reason: input.reason },
            at: Date.now(),
          });
          state.goalRecord = result;
          syncGoal(state, root.id);
          snapshot.revision += 1;
          snapshot.seq += 1;
          return { state, activeRunId: root.active_run_id };
        },
      );
      const root = await deps.repository.find(scope.instanceId, scope.taskId);
      if (!root?.state?.goalRecord) throw new Error("目标已删除");
      await deps.refresh(
        scope.instanceId,
        root.root_directory!,
        root.project_id,
      );
      return result ?? structuredClone(root.state.goalRecord);
    },
  };
}

import type { GoalEvidenceCandidate } from "../goals/consumer.js";

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function commandOf(row: protocol.ToolCallRow): string {
  const input = objectValue(row.input) ?? objectValue(row.inputText);
  if (input && typeof input.command !== "string") return "";
  return typeof input?.command === "string"
    ? input.command.trim().replace(/;$/, "").trim()
    : row.inputText.trim().replace(/;$/, "").trim();
}
function evidenceDetail(
  row: protocol.ConversationRow,
  runId: string,
): string | null {
  if (row.turnId !== runId) return null;
  if (row.kind === "assistantText")
    return ["streaming", "complete"].includes(row.state) && row.text.trim()
      ? row.text
      : null;
  if (
    row.kind !== "toolCall" ||
    !row.toolCallId.startsWith(`${runId}/`) ||
    row.status !== "success"
  )
    return null;
  const text = row.output?.text ?? "";
  return isGoalToolEvidence(row.toolName, text, commandOf(row)) ? text : null;
}
export function goalEvidenceCandidates(
  rows: protocol.ConversationRow[],
  runId: string,
  revision: number,
): GoalEvidenceCandidate[] {
  return rows.flatMap((row) =>
    evidenceDetail(row, runId) === null
      ? []
      : [
          {
            id: `row:${row.rowId}`,
            kind:
              row.kind === "assistantText"
                ? ("assistantText" as const)
                : ("toolCall" as const),
            revision,
          },
        ],
  );
}
export function goalEvidence(
  rows: protocol.ConversationRow[],
  runId: string,
  evidenceIds: string[],
) {
  if (!evidenceIds.length) throw new Error("验收引用不能为空");
  return evidenceIds.map((id) => {
    const row = rows.find((item) => `row:${item.rowId}` === id);
    const detail = row ? evidenceDetail(row, runId) : null;
    if (detail === null)
      throw new Error("验收引用不属于当前Run的有效结果，请先读取GetGoal候选");
    return { sourceId: id, passed: true, detail };
  });
}
