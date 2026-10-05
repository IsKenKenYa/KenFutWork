export type PersistedAgentRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  /**
   * 用户主动取消（`run.canceled`）。与 `failed` 分开记：取消不是故障，
   * 混在一起会让失败率失真（迁移 `20260916090000` 给 CHECK 加了这一档）。
   */
  | "canceled";

export type CreateAcceptedAgentRunInput = {
  model?: string;
  runId: string;
  sessionId: string;
  threadId: string;
};

export type UpdateAgentRunInput = {
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  runId: string;
  status: PersistedAgentRunStatus;
};

import type { AgentContextHistoryReference } from "../../agent/context-history.js";

export type AgentTurnBoundaryPhase = "pre" | "post";
export type AgentBoundaryCapture<T> =
  | { status: "captured"; reference: T | null }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

/** phase属于本run；files.reference允许指向此前run的同一实际文件版本。 */
export interface AgentTurnBoundary {
  instanceId: string;
  projectId: string;
  taskId: string;
  runId: string;
  threadId: string;
  phase: AgentTurnBoundaryPhase;
  scopeGeneration: number;
  /** 尚未进入授权执行的失败/取消Run可未知；控制consumer必须拒绝此partial边界。 */
  branchGeneration: number | null;
  inputIdentity: { clientId: string; sourceCommandId: string } | null;
  inputOrigin: "userInput" | "backgroundResult" | "controlOperation";
  inputMessageId: string | null;
  operation?: { kind: "compact" };
  context: AgentBoundaryCapture<AgentContextHistoryReference>;
  files: AgentBoundaryCapture<string>;
}
export interface AgentTurnBoundaries {
  pre: AgentTurnBoundary | null;
  post: AgentTurnBoundary | null;
}
