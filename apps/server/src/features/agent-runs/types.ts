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
