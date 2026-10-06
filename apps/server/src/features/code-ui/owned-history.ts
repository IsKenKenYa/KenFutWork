import type {
  AgentContextBranchBoundary,
  AgentContextBranchHistoryCloneResult,
} from "../../agent/context-history.js";
import type { AgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import type { ThreadService } from "../chat/thread-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeAdmittedInput } from "./input-intents.js";
import type {
  CodeReplayInput,
  CodeUiOwnedHistoryTurn,
} from "./owned-history-types.js";
import {
  CodeUiRepositoryError,
  type CodeUiSessionRecord,
} from "./repository.js";

function replayInput(input: CodeAdmittedInput): CodeReplayInput {
  const {
    sourceCommandId,
    clientId,
    kind,
    text,
    attachments,
    modelSelection,
    mode,
    planEnabled,
  } = input.intent;
  return structuredClone({
    intent: {
      sourceCommandId,
      clientId,
      kind,
      text,
      attachments,
      modelSelection,
      mode,
      planEnabled,
    },
    modelInvocation: input.modelInvocation,
  });
}

export function historyBoundaryId(turnId: string, phase: "pre" | "post") {
  return JSON.stringify([turnId, phase]);
}

export function mappedHistoryBoundaries(
  turns: readonly CodeUiOwnedHistoryTurn[],
): AgentContextBranchBoundary[] {
  return turns.flatMap((turn) =>
    ["pre", "post"].flatMap((phase) => {
      const capture = phase === "pre" ? turn.context.pre : turn.context.post;
      return capture.status === "captured"
        ? [
            {
              id: historyBoundaryId(
                turn.owner.turnId,
                phase === "pre" ? "pre" : "post",
              ),
              reference: capture.reference,
            },
          ]
        : [];
    }),
  );
}

/** 只使用adapter返回的opaque映射，产品不解析checkpoint key。 */
export function rebindOwnedHistory(input: {
  turns: readonly CodeUiOwnedHistoryTurn[];
  result: AgentContextBranchHistoryCloneResult;
  threadId: string;
  owner: { instanceId: string; projectId: string; taskId: string };
  turnIds?: ReadonlyMap<string, string>;
}): CodeUiOwnedHistoryTurn[] {
  const references = new Map(
    input.result.boundaries.map((entry) => [entry.id, entry.reference]),
  );
  return input.turns.map((turn) => {
    const next = structuredClone(turn);
    next.owner = {
      ...input.owner,
      turnId: input.turnIds?.get(turn.owner.turnId) ?? turn.owner.turnId,
    };
    next.context.threadId = input.threadId;
    for (const phase of ["pre", "post"] as const) {
      if (turn.context[phase].status !== "captured") continue;
      const id = historyBoundaryId(turn.owner.turnId, phase);
      if (!references.has(id))
        throw new CodeUiRepositoryError(
          "command_conflict",
          "原生历史边界映射不完整，未发布新Task或分支。",
        );
      const reference = references.get(id);
      if (
        reference === undefined ||
        (turn.context[phase].reference === null) !== (reference === null)
      )
        throw new CodeUiRepositoryError(
          "command_conflict",
          "原生历史边界映射改变了捕获状态，拒绝发表。",
        );
      next.context[phase] = { status: "captured", reference };
    }
    return next;
  });
}

export function createCodeUiOwnedHistory(deps: {
  agentRunMetadata: AgentRunMetadataService;
  threads: ThreadService;
}) {
  return {
    async resolve(
      actor: LocalActor,
      root: CodeUiSessionRecord,
      turnId: string,
    ): Promise<CodeUiOwnedHistoryTurn | null> {
      const snapshot = root.state?.snapshots.find(
        (entry) => entry.sessionId === root.id,
      );
      if (
        !snapshot ||
        root.deleted_at ||
        root.instance_id !== actor.instanceId ||
        !snapshot.rows.window.some((row) => row.turnId === turnId)
      )
        return null;
      const binding = await deps.threads.resolveOwnedSessionThread(
        actor,
        root.id,
      );
      const inherited = root.state?.inheritedHistory?.find(
        (turn) => turn.owner.turnId === turnId,
      );
      if (inherited) {
        if (
          inherited.owner.instanceId !== actor.instanceId ||
          inherited.owner.projectId !== root.project_id ||
          inherited.owner.taskId !== root.id ||
          inherited.context.threadId !== binding.threadId
        )
          throw new CodeUiRepositoryError(
            "command_conflict",
            "继承历史不属于当前Task及原生分支。",
          );
        return structuredClone(inherited);
      }
      const pair = await deps.agentRunMetadata.getOwnedTurnBoundaries(actor, {
        taskId: root.id,
        runId: turnId,
      });
      if (!pair.pre && !pair.post) return null;
      for (const boundary of [pair.pre, pair.post])
        if (
          boundary &&
          (boundary.instanceId !== actor.instanceId ||
            boundary.projectId !== root.project_id ||
            boundary.taskId !== root.id ||
            boundary.runId !== turnId ||
            boundary.threadId !== binding.threadId)
        )
          return null;
      const identity =
        pair.pre?.inputOrigin === "userInput" ? pair.pre.inputIdentity : null;
      const input = identity
        ? root.state?.inputs?.find(
            (entry) =>
              entry.runId === turnId &&
              entry.intent.sourceCommandId === identity.sourceCommandId &&
              entry.intent.clientId === identity.clientId,
          )
        : undefined;
      const completedView = root.state?.completedTurnViews?.find(
        ([id]) => id === turnId,
      )?.[1];
      return structuredClone({
        owner: {
          instanceId: root.instance_id,
          projectId: root.project_id,
          taskId: root.id,
          turnId,
        },
        source: { taskId: root.id, turnId, runId: turnId },
        context: {
          threadId: binding.threadId,
          pre: pair.pre?.context ?? {
            status: "unavailable",
            reason: "boundary_not_recorded",
          },
          post: pair.post?.context ?? {
            status: "unavailable",
            reason: "boundary_not_recorded",
          },
        },
        ...(input ? { canonical: replayInput(input) } : {}),
        ...(completedView ? { completedView } : {}),
      });
    },
  };
}
