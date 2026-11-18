import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeUiConversationState } from "./conversation.js";

export const CODE_UI_WORK_CONTEXT_CAPABILITY = "conversation-work-context";

export type WorkContextBinding = {
  actor: LocalActor;
  projectId: string;
  taskId: string;
  sessionId?: string;
  runId: string;
  scopeGeneration: number;
  branchGeneration: number;
  context: protocol.ConversationWorkContext;
};

/** Document plugins validate references; the shared host owns Task and Run identity. */
export interface ConversationWorkContextProvider {
  prepare(input: {
    actor: LocalActor;
    projectId: string;
    taskId?: string;
    context: protocol.ConversationWorkContext;
  }): Promise<protocol.ConversationWorkContext>;
  revalidate(input: WorkContextBinding): Promise<void>;
}

export function freezeWorkContext(
  input: protocol.ConversationWorkContext | undefined,
): protocol.ConversationWorkContext {
  return structuredClone(
    protocol.conversationWorkContextSchema.parse(input ?? { preset: "code" }),
  );
}

export function workContextForRun(
  state: CodeUiConversationState,
  runId: string,
) {
  return freezeWorkContext(
    state.inputs?.find(
      (input) =>
        input.runId === runId && input.intent.delivery.admitted !== "guide",
    )?.intent.workContext ??
      state.runWorkContexts?.find(([id]) => id === runId)?.[1],
  );
}

export function latestWorkContext(state: CodeUiConversationState) {
  return freezeWorkContext(
    state.runWorkContexts?.find(([id]) => id === state.runId)?.[1] ??
      state.initialWorkContext,
  );
}

export function workContextProviderPreset(
  context: protocol.ConversationWorkContext,
) {
  return context.preset === "design" || context.canvasId || context.brandKitId
    ? "design"
    : "code";
}

export function contributionsForRun(
  state: CodeUiConversationState,
  runId: string,
) {
  const snapshot =
    state.inputs?.find(
      (input) =>
        input.runId === runId && input.intent.delivery.admitted !== "guide",
    )?.frozenContributions ??
    state.runContributions?.find(([id]) => id === runId)?.[1];
  return snapshot ? structuredClone(snapshot) : undefined;
}
