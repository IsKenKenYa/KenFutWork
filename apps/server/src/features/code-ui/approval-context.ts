import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { ApprovalHostContext } from "../permissions/approval-types.js";
import { matchesActiveCodeRun } from "./active-run-binding.js";
import { type CodeAdmittedInput, codeInputKey } from "./input-intents.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";

interface RootUserInput {
  clientId: string;
  sourceCommandId: string;
  admissionSeq: number;
  text: string;
}

/** Canonical admissions prove origin; visible root rows exclude edited-away history. */
function rootUserInputs(
  root: CodeUiSessionRecord,
  runId: string,
): RootUserInput[] | null {
  const state = root.state;
  const snapshot = state?.snapshots.find(
    (entry) => entry.sessionId === root.id,
  );
  if (
    !state ||
    !snapshot ||
    snapshot.rows.window.length !== snapshot.rows.totalCount
  )
    return null;
  const canonical = new Map<string, CodeAdmittedInput>();
  for (const input of state.inputs ?? []) {
    if (input.intent.kind !== "sendText" || input.status === "discarded")
      continue;
    const key = codeInputKey(input.intent);
    if (canonical.has(key)) return null;
    canonical.set(key, input);
  }
  const selected = new Map<string, CodeAdmittedInput>();
  for (const row of snapshot.rows.window) {
    if (row.kind !== "userInput" || row.origin !== "realUser") continue;
    if (!row.clientId || !row.sourceCommandId) return null;
    const key = codeInputKey({
      clientId: row.clientId,
      sourceCommandId: row.sourceCommandId,
    });
    const input = canonical.get(key);
    const text =
      row.epilogueStart === undefined
        ? row.text
        : row.text.slice(0, row.epilogueStart);
    if (
      !input ||
      input.runId !== row.turnId ||
      input.intent.text !== text ||
      !["active", "settled"].includes(input.status)
    )
      return null;
    selected.set(key, input);
  }
  if (!selected.size) return null;
  for (const [key, input] of canonical) {
    if (
      !["queued", "reserved"].includes(input.status) ||
      input.branchGeneration !== Number(root.branch_generation)
    )
      continue;
    // Future ordinary input cannot grant this Run a new task; accepted guides already constrain it.
    if (
      input.status !== "queued" ||
      input.runId !== runId ||
      input.intent.delivery.admitted !== "guide"
    )
      return null;
    selected.set(key, input);
  }
  const inputs = [...selected.values()]
    .map(({ intent }) => ({
      clientId: intent.clientId,
      sourceCommandId: intent.sourceCommandId,
      admissionSeq: intent.order.admissionSeq,
      text: intent.text,
    }))
    .sort((left, right) => left.admissionSeq - right.admissionSeq);
  if (
    !inputs.some((input) => input.text.trim()) ||
    inputs.some(
      (input, index) =>
        !Number.isSafeInteger(input.admissionSeq) ||
        input.admissionSeq < 0 ||
        (index > 0 && input.admissionSeq === inputs[index - 1]!.admissionSeq),
    )
  )
    return null;
  return inputs;
}

/** Private root-Task requirements; never derive human authority from a Run prompt or tool output. */
export async function readCodeApprovalContext(
  repository: Pick<CodeUiRepository, "find">,
  context: ToolExecutionContext,
): Promise<ApprovalHostContext | null> {
  if (context.signal?.aborted || !context.runId) return null;
  const scope = context.scopeHandle?.describe();
  if (!scope || context.actor?.instanceId !== scope.instanceId) return null;
  const root = await repository.find(scope.instanceId, scope.taskId);
  if (
    context.signal?.aborted ||
    !root?.state ||
    root.id !== scope.taskId ||
    root.instance_id !== scope.instanceId ||
    root.project_id !== scope.projectId ||
    root.parent_session_id ||
    root.root_session_id !== root.id ||
    !matchesActiveCodeRun(root, context) ||
    root.state.stopRequestedRuns?.includes(context.runId) ||
    root.state.closedRuns.includes(context.runId)
  )
    return null;
  const inputs = rootUserInputs(root, context.runId);
  if (!inputs) return null;
  const currentGoal = root.state.goalRecord;
  if (
    currentGoal &&
    currentGoal.branchGeneration !== Number(root.branch_generation)
  )
    return null;
  if (
    currentGoal &&
    ["active", "verifying", "notSatisfied"].includes(currentGoal.status) &&
    currentGoal.claimedRunId !== context.runId
  )
    return null;
  const goal = currentGoal?.claimedRunId === context.runId ? currentGoal : null;
  const remainingTokens =
    goal?.tokenBudget === null || !goal
      ? null
      : Math.max(0, goal.tokenBudget - goal.tokensUsed);
  if (
    remainingTokens !== null &&
    (!Number.isSafeInteger(remainingTokens) || remainingTokens < 0)
  )
    return null;
  return {
    userRequest: JSON.stringify({
      rootUserInputs: inputs.map((input) => input.text),
      ...(goal ? { goalObjective: goal.objective } : {}),
    }),
    remainingTokens,
    requirementsVersion: createHash("sha256")
      .update(
        JSON.stringify({
          instanceId: root.instance_id,
          taskId: root.id,
          branchGeneration: Number(root.branch_generation),
          inputs,
          goal: goal
            ? {
                goalId: goal.goalId,
                objective: goal.objective,
                revision: goal.revision,
                tokenBudget: goal.tokenBudget,
              }
            : null,
        }),
      )
      .digest("hex"),
  };
}
