import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { AgentContextHistoryReference } from "../../agent/context-history.js";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { AgentBoundaryCapture } from "../agent-runs/types.js";
import type { CodeUiCompletedTurnView } from "./conversation.js";

export type CodeReplayIntent = Pick<
  protocol.ConversationInputIntent,
  | "sourceCommandId"
  | "clientId"
  | "kind"
  | "text"
  | "attachments"
  | "modelSelection"
  | "mode"
  | "planEnabled"
>;
export interface CodeReplayInput {
  intent: CodeReplayIntent;
  modelInvocation: ModelInvocationSnapshot;
}
/** 当前Task的历史事实；source只溯源，不借父资源或伪造执行过的Run。 */
export interface CodeUiOwnedHistoryTurn {
  owner: {
    instanceId: string;
    projectId: string;
    taskId: string;
    turnId: string;
  };
  source: { taskId: string; turnId: string; runId?: string };
  context: {
    threadId: string;
    pre: AgentBoundaryCapture<AgentContextHistoryReference>;
    post: AgentBoundaryCapture<AgentContextHistoryReference>;
  };
  canonical?: CodeReplayInput;
  completedView?: CodeUiCompletedTurnView;
}
