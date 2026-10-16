import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { ToolContributionSnapshot } from "../../kernel/types.js";
import type { GoalService } from "../goals/service.js";
import { createCodeUiConversation } from "./conversation.js";
import type { CodeUiSessionRecord } from "./repository.js";
import { freezeWorkContext } from "./work-context.js";
export function claimGoalContinuation(
  root: CodeUiSessionRecord,
  input: {
    goalId: string;
    revision: number;
    runId: string;
    commandId: string;
    text: string;
    owner: { hostId: string; runtimeId: string };
    at: number;
    modelSelection?: NonNullable<protocol.SessionConfigState["modelSelection"]>;
    frozenContributions?: ToolContributionSnapshot;
  },
  goals: GoalService,
) {
  const current = root.state!.snapshots.find(
    (item) => item.sessionId === root.id,
  )!;
  const state = structuredClone(root.state!);
  state.goalRecord = goals.claimRun(state.goalRecord!, {
    goalId: input.goalId,
    revision: input.revision,
    runId: input.runId,
    at: input.at,
    foreground: {
      branchGeneration: Number(root.branch_generation),
      taskReady:
        !root.archived && !root.deleted_at && root.execution_state === "ready",
      activeRunId: root.active_run_id,
      userReserved: !!state.inputs?.some((item) => item.status === "reserved"),
      userQueued:
        !!state.inputs?.some((item) => item.status === "queued") ||
        current.queue.items.length > 0,
      approvalWaiting:
        current.pendingInteractions.length > 0 ||
        current.config.planEnabled === true,
    },
  });
  const host = createCodeUiConversation({
    goals,
    sessionId: root.id,
    workspacePath: root.root_directory!,
    config: current.config,
    state,
  });
  host.setInputOwner(input.owner);
  host.startTurn({
    executionMode: "goal",
    runId: input.runId,
    commandId: input.commandId,
    text: input.text,
    origin: "backgroundResult",
    workContext: freezeWorkContext(state.goalModel?.workContext),
    frozenContributions: input.frozenContributions,
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
  });
  return {
    state: host.exportState(),
    activeRunId: input.runId,
    ack: {
      commandId: input.commandId,
      status: "accepted" as const,
      revisionAtDecision: host.getSnapshot().revision,
    },
  };
}
