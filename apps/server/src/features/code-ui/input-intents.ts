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
  /** 历史操作保留原输入归属；重试与编辑不混用语义，不改变新command/run幂等身份。 */
  historyOf?: {
    action: "editUserQuery" | "retryTurn";
    rootSourceCommandId: string;
    sourceRunId: string;
  };
}

export const codeInputKey = (
  input: Pick<protocol.ConversationInputIntent, "clientId" | "sourceCommandId">,
): string => JSON.stringify([input.clientId, input.sourceCommandId]);

export const codeGuideMessageId = (input: CodeAdmittedInput): string =>
  `guide:${codeInputKey(input.intent)}`;
