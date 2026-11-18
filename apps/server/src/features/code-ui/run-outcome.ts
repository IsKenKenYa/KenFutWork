import type { CodeUiConversationState } from "./conversation.js";

/** Applied Stop intent and accepted preemption both fence the exact original Run. */
export function codeUiRunHasStopIntent(
  state:
    | Pick<CodeUiConversationState, "stopRequestedRuns" | "inputs">
    | null
    | undefined,
  runId: string,
): boolean {
  return (
    state?.stopRequestedRuns?.includes(runId) === true ||
    state?.inputs?.some(
      (input) => input.status === "reserved" && input.previousRunId === runId,
    ) === true
  );
}

/** Only executor-published terminal facts count. Missing historical facts stay unknown. */
export function codeUiRunOutcome(
  state: CodeUiConversationState | null | undefined,
  runId: string,
): "active" | "completed" | "canceled" | "failed" | "unknown" {
  const terminal = state?.runOutcomes?.find(([id]) => id === runId)?.[1];
  if (terminal) return terminal;
  if (state?.closedRuns.includes(runId)) return "unknown";
  return state?.snapshots.some((snapshot) =>
    snapshot.control.activeWorks.some(
      (work) => work.foregroundExecutionId === runId,
    ),
  )
    ? "active"
    : "unknown";
}

/** A stopped executor may finish already accepted media without restarting the Run. */
export function codeUiRunStoppedByHost(
  state: CodeUiConversationState | null | undefined,
  runId: string,
): boolean {
  const outcome = codeUiRunOutcome(state, runId);
  return (
    !codeUiRunHasStopIntent(state, runId) &&
    (outcome === "canceled" || outcome === "failed") &&
    state?.closedRuns.includes(runId) === true &&
    state.hostShutdownRuns?.includes(runId) === true
  );
}
