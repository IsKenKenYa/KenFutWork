import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { ModelInvocationSnapshot } from "../../providers/types.js";

/** Durable canonical input; credentials and attachment bytes remain outside persisted state. */
export interface CodeAdmittedInput {
  intent: protocol.ConversationInputIntent;
  runId: string;
  modelInvocation: ModelInvocationSnapshot;
  scopeGeneration: number;
  branchGeneration: number;
  status: "queued" | "reserved" | "active" | "settled" | "discarded";
  autoDrainAtAdmission?: boolean;
  previousRunId?: string;
}

export const codeInputKey = (
  input: Pick<protocol.ConversationInputIntent, "clientId" | "sourceCommandId">,
): string => JSON.stringify([input.clientId, input.sourceCommandId]);
