import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import { evaluateGoal } from "../goals/evaluation.js";
import type {
  GoalEvidence,
  GoalRecord,
  GoalRunMember,
  GoalService,
} from "../goals/service.js";
import { isGoalToolEvidence } from "../goals/tool-evidence.js";
import type { CodeUiConversationState } from "./conversation.js";

function verificationIteration(goal: GoalRecord): number | null {
  const verification = goal.verification;
  if (!verification) return null;
  if (verification.iteration !== undefined)
    return Number.isSafeInteger(verification.iteration) &&
      verification.iteration > 0 &&
      verification.iteration <= goal.iteration
      ? verification.iteration
      : null;
  if (verification.runId === goal.claimedRunId) return goal.iteration;
  if (verification.runId !== goal.lastSettledRunId) return null;
  // Only the current or immediately preceding claim can be recovered from legacy Run identities.
  return goal.claimedRunId ? Math.max(0, goal.iteration - 1) : goal.iteration;
}

export function projectGoal(
  goal: GoalRecord | null,
): protocol.GoalState | null {
  if (!goal) return null;
  const status = goal.status === "complete" ? "verified" : goal.status;
  const verifiedIteration = verificationIteration(goal);
  return {
    targetId: goal.goalId,
    objective: goal.objective,
    summaryTitle: null,
    status,
    // V4 active means the next open iteration; GoalRecord already counts its claimed Run.
    iteration:
      goal.status === "active" && goal.claimedRunId
        ? Math.max(0, goal.iteration - 1)
        : goal.iteration,
    iterations: [],
    timeUsedSeconds: goal.timeUsedSeconds,
    activeRunStartedAtMs: goal.runStartedAt,
    verifications:
      goal.verification && verifiedIteration !== null
        ? [
            {
              iteration: verifiedIteration,
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
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";

function matchesGoalTaskRun(
  root: CodeUiSessionRecord,
  context: PromptExecutionContext,
) {
  const scope = context.scopeHandle?.describe();
  return (
    !!scope &&
    root.id === scope.taskId &&
    root.instance_id === scope.instanceId &&
    root.project_id === scope.projectId &&
    matchesActiveCodeRun(root, context)
  );
}

async function revalidateEvidence(
  context: PromptExecutionContext,
  evidence: GoalEvidence[],
) {
  context.signal?.throwIfAborted();
  for (const entry of evidence)
    for (const file of entry.tool?.files ?? []) {
      if (!context.scopeHandle)
        throw new Error("验收证据缺少可信Task目录授权。");
      const current = await context.scopeHandle.backend.observeBinary(
        file.path,
      );
      context.signal?.throwIfAborted();
      if (current.path !== file.path || current.version !== file.version)
        throw new Error("验收文件已删除或变化，请重新读取实际结果。");
    }
}

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
  async function settleEvaluation(
    context: ToolExecutionContext,
    scope: ReturnType<typeof scopeOf>,
    captured: { goal: GoalRecord },
    verdict: Awaited<ReturnType<typeof evaluateGoal>>,
  ) {
    const requestId = captured.goal.evaluation!.requestId;
    await revalidateEvidence(context, captured.goal.evaluation!.evidence);
    await deps.repository.appendEvent(
      scope.instanceId,
      scope.taskId,
      {
        key: `${requestId}:result`,
        fingerprint: createHash("sha256")
          .update(JSON.stringify(verdict))
          .digest("hex"),
        event: {
          type: "goal.evaluation",
          runId: context.runId,
          requestId,
          verdict,
        },
      },
      (root) => {
        const goal = root.state?.goalRecord;
        if (
          !matchesGoalTaskRun(root, context) ||
          !goal ||
          goal.revision !== captured.goal.revision ||
          goal.status !== "verifying" ||
          goal.evaluation?.requestId !== requestId ||
          goal.branchGeneration !== Number(root.branch_generation)
        )
          throw new Error(
            "独立评估所属目标、Run或授权代际已改变，旧结果不再生效。",
          );
        const state = structuredClone(root.state!);
        state.goalRecord =
          "error" in verdict
            ? deps.goals.pause(goal, {
                goalId: goal.goalId,
                revision: goal.revision,
                reason: verdict.error,
                at: Date.now(),
              })
            : deps.goals.verify(goal, {
                goalId: goal.goalId,
                revision: goal.revision,
                runId: context.runId!,
                evidence: captured.goal.evaluation!.evidence,
                verdict,
                at: Date.now(),
              });
        state.goalRecord.evaluation = null;
        syncGoal(state, root.id);
        const snapshot = state.snapshots.find(
          (item) => item.sessionId === root.id,
        )!;
        snapshot.revision += 1;
        snapshot.seq += 1;
        return { state, activeRunId: root.active_run_id };
      },
    );
  }
  return {
    async read(context) {
      const scope = scopeOf(context);
      const root = await deps.repository.find(scope.instanceId, scope.taskId);
      if (!root?.state?.goalRecord) return null;
      if (!root || !matchesGoalTaskRun(root, context))
        throw new Error("目标所属Run已失效");
      const goal = root.state?.goalRecord;
      const snapshot = root.state?.snapshots.find(
        (item) => item.sessionId === root.id,
      );
      const boundGoal = goal
        ? withGoalMembers(goal, snapshot?.rows.window ?? [])
        : null;
      const visible = boundGoal ? structuredClone(boundGoal) : null;
      if (visible) delete visible.evaluation;
      for (const evidence of visible?.verification?.evidence ?? [])
        delete evidence.detail;
      return goal && visible
        ? {
            ...visible,
            evidenceCandidates: goalEvidenceCandidates(
              snapshot?.rows.window ?? [],
              context.runId!,
              goal.revision,
              boundGoal ?? undefined,
            ),
          }
        : null;
    },
    async verify(context: ToolExecutionContext, input) {
      const scope = scopeOf(context);
      if (!context.toolCallId) throw new Error("验证缺少可信工具调用身份");
      const before = await deps.repository.find(scope.instanceId, scope.taskId);
      if (!before?.state?.goalRecord || !matchesGoalTaskRun(before, context))
        throw new Error("目标验证所属Run或授权代际已失效");
      const beforeRows =
        before.state.snapshots.find((item) => item.sessionId === before.id)
          ?.rows.window ?? [];
      const beforeGoal = withGoalMembers(before.state.goalRecord, beforeRows);
      const evidence = goalEvidence(
        beforeRows,
        context.runId!,
        input.evidenceIds,
        beforeGoal,
      );
      await revalidateEvidence(context, evidence);
      let pending:
        | { goal: GoalRecord; invocation: ModelInvocationSnapshot | null }
        | undefined;
      const requestId = `goal-verify:${context.runId}/${context.toolCallId}`;
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
          key: requestId,
          fingerprint: createHash("sha256")
            .update(JSON.stringify(event))
            .digest("hex"),
          event,
        },
        (root) => {
          if (!matchesGoalTaskRun(root, context))
            throw new Error("目标验证所属Run或授权代际已失效");
          const state = structuredClone(root.state!);
          const snapshot = state.snapshots.find(
            (item) => item.sessionId === root.id,
          )!;
          const goal = state.goalRecord
            ? withGoalMembers(state.goalRecord, snapshot.rows.window)
            : null;
          if (!goal || goal.branchGeneration !== Number(root.branch_generation))
            throw new Error("当前Task没有有效目标");
          const currentEvidence = goalEvidence(
            snapshot.rows.window,
            context.runId!,
            input.evidenceIds,
            goal,
          );
          if (JSON.stringify(currentEvidence) !== JSON.stringify(evidence))
            throw new Error("验收证据已改变，请重新读取GetGoal候选。");
          const started = deps.goals.beginVerification(goal, {
            goalId: goal.goalId,
            revision: input.revision,
            runId: context.runId!,
          });
          started.evaluation = {
            requestId,
            runId: context.runId!,
            revision: started.revision,
            evidence,
            proposal: { passed: input.passed, reason: input.reason },
          };
          state.goalRecord = started;
          pending = {
            goal: structuredClone(started),
            invocation:
              state.goalModel?.goalId === goal.goalId
                ? structuredClone(state.goalModel.invocation)
                : null,
          };
          syncGoal(state, root.id);
          snapshot.revision += 1;
          snapshot.seq += 1;
          return { state, activeRunId: root.active_run_id };
        },
      );
      // A replay reads persisted state; it must not send a second billable request.
      if (pending) {
        const captured = pending;
        const verdict = await evaluateGoal({
          request: context.requestModel,
          invocation: captured.invocation,
          goal: captured.goal,
          evidence: captured.goal.evaluation!.evidence,
          proposal: captured.goal.evaluation!.proposal,
        });
        context.signal?.throwIfAborted();
        await settleEvaluation(context, scope, captured, verdict);
      }
      const root = await deps.repository.find(scope.instanceId, scope.taskId);
      if (!root?.state?.goalRecord) throw new Error("目标已删除");
      if (!matchesGoalTaskRun(root, context))
        throw new Error("目标所属Run或授权代际已失效。");
      await deps.refresh(
        scope.instanceId,
        root.root_directory!,
        root.project_id,
      );
      const visible = structuredClone(root.state.goalRecord);
      delete visible.evaluation;
      return visible;
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
function withGoalMembers(
  goal: GoalRecord,
  rows: protocol.ConversationRow[],
): GoalRecord {
  const runs = [...(goal.runs ?? [])];
  for (const row of rows) {
    if (
      row.kind !== "toolCall" ||
      row.toolName !== "GetGoal" ||
      row.status !== "success" ||
      !row.toolCallId.startsWith(`${row.turnId}/`) ||
      row.startedAt === undefined ||
      row.endedAt === undefined ||
      row.endedAt < row.startedAt
    )
      continue;
    const receipt = objectValue(row.output?.text);
    if (
      !receipt ||
      receipt.goalId !== goal.goalId ||
      receipt.objective !== goal.objective ||
      receipt.branchGeneration !== goal.branchGeneration ||
      receipt.claimedRunId !== row.turnId ||
      typeof receipt.iteration !== "number" ||
      !Number.isSafeInteger(receipt.iteration) ||
      receipt.iteration < 1 ||
      receipt.iteration > goal.iteration
    )
      continue;
    if (
      !runs.some(
        (member) =>
          member.runId === row.turnId &&
          member.branchGeneration === goal.branchGeneration,
      )
    )
      runs.push({
        runId: row.turnId,
        branchGeneration: goal.branchGeneration,
        iteration: receipt.iteration,
      });
  }
  return { ...goal, runs };
}

function belongsToGoal(
  runId: string,
  currentRunId: string,
  goal?: GoalRecord,
): boolean {
  if (!goal) return runId === currentRunId;
  return (
    goal.claimedRunId === runId ||
    !!goal.runs?.some(
      (member) =>
        member.runId === runId &&
        member.branchGeneration === goal.branchGeneration,
    )
  );
}

function evidenceFiles(
  row: protocol.ToolCallRow,
): Array<{ path: string; version: string }> | undefined {
  const text = row.output?.text ?? "";
  const display = row.output?.display;
  if (["Write", "Edit"].includes(row.toolName)) {
    const version = text.match(/，版本 ([a-f0-9]{64})$/u)?.[1];
    if (display?.kind !== "file_diff" || !version) return;
    return [{ path: display.filePath, version }];
  }
  if (["Read", "preview_file"].includes(row.toolName)) {
    const media = objectValue(text);
    if (
      typeof media?.filePath === "string" &&
      typeof media.version === "string"
    )
      return [{ path: media.filePath, version: media.version }];
    const match = text.match(/^([^\n]+)\n版本：([a-f0-9]{64})\n/u);
    if (match) return [{ path: match[1]!, version: match[2]! }];
  }
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
  goal?: GoalRecord,
): string | null {
  if (!belongsToGoal(row.turnId, runId, goal)) return null;
  if (row.kind === "assistantText")
    return (row.state === "complete" ||
      (row.turnId === runId && row.state === "streaming")) &&
      row.text.trim()
      ? row.text
      : null;
  if (
    row.kind !== "toolCall" ||
    !row.toolCallId.startsWith(`${row.turnId}/`) ||
    row.status !== "success"
  )
    return null;
  if (
    row.turnId !== runId &&
    ["Write", "Edit", "Read", "preview_file", "ApplyPatch"].includes(
      row.toolName,
    ) &&
    !evidenceFiles(row)
  )
    return null;
  const text = row.output?.text ?? "";
  return isGoalToolEvidence(row.toolName, text, commandOf(row)) ? text : null;
}
export function goalEvidenceCandidates(
  rows: protocol.ConversationRow[],
  runId: string,
  revision: number,
  goal?: GoalRecord,
): GoalEvidenceCandidate[] {
  return rows.flatMap((row) =>
    evidenceDetail(row, runId, goal) === null
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
  goal?: GoalRecord,
): GoalEvidence[] {
  if (!evidenceIds.length) throw new Error("验收引用不能为空");
  return evidenceIds.map((id) => {
    const row = rows.find((item) => `row:${item.rowId}` === id);
    const detail = row ? evidenceDetail(row, runId, goal) : null;
    if (detail === null)
      throw new Error("验收引用不属于当前Goal的有效结果，请先读取GetGoal候选");
    const files = row?.kind === "toolCall" ? evidenceFiles(row) : undefined;
    return {
      sourceId: id,
      sourceRunId: row!.turnId,
      passed: true,
      detail,
      ...(row?.kind === "toolCall"
        ? {
            tool: {
              name: row.toolName,
              inputText: row.input ? JSON.stringify(row.input) : row.inputText,
              ...(files ? { files } : {}),
            },
          }
        : {}),
    };
  });
}
