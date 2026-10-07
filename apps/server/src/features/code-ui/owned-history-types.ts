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
export interface CodeUiFileChangesFact {
  result: protocol.V4ConversationFileChangesResult;
  eventCount: number;
  bytes: number;
}

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
  /** 原journal验证出的完整只读结果，不携带文件恢复授权或伪Run事件。 */
  fileChanges?: CodeUiFileChangesFact;
}

/** 只读子转录独立事实，没有Run/执行域/native恢复身份。 */
export interface CodeUiInheritedSession {
  owner: {
    instanceId: string;
    projectId: string;
    taskId: string;
    sessionId: string;
  };
  source: { taskId: string; sessionId: string };
  fileChanges: Array<{
    turnId: string;
    details: CodeUiFileChangesFact;
  }>;
}
