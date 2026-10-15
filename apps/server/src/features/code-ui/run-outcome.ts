import type { CodeUiConversationState } from "./conversation.js";

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
