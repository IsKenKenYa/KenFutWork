import type { StreamEvent } from "@kenfutwork/shared";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeApprovalMode } from "../permissions/approval-types.js";
import type { TaskWorkRecord } from "../task-work/types.js";

export type CodeSubagentRole = "explore" | "review" | "worker";
export interface ChildSession {
  sessionId: string;
  threadId: string;
  emit(event: StreamEvent): Promise<void>;
  storeResult(text: string): Promise<{
    path: string;
    stats: NonNullable<TaskWorkRecord["outputStats"]>;
  }>;
}
export interface CodeChildRequest {
  childSessionId: string;
  approvalCeiling: CodeApprovalMode;
  actor: LocalActor;
  scope: ExecutionScopeHandle;
  model: string;
  parentSessionId: string;
  parentRunId: string;
  toolCallId: string;
  branchGeneration: number;
  delegationDepth: number;
  role: CodeSubagentRole;
  description: string;
  ownership: string[];
  completionCriteria: string;
  detached: boolean;
}
export interface CodeChildSessions {
  open(request: CodeChildRequest): Promise<ChildSession>;
}
export interface CodeChildResult {
  status: "completed" | "failed" | "canceled";
  summary: string;
  outputRef: string;
  childSessionId: string;
  childRunId: string;
  outputStats: NonNullable<TaskWorkRecord["outputStats"]>;
}
