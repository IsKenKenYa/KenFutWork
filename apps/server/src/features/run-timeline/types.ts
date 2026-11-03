import type { StreamEvent } from "@kenfutwork/shared";

/**
 * 单轮运行时间线的服务定义（三元组 Definition）。
 * Provider：`repository.ts` 读事件日志与用量表；
 * Consumer：`http/run-timeline.ts` 的界面回看与 Markdown 导出端点。
 */
export interface RunTimelineService {
  /** 读取一轮运行的时间线（完整条目，不截断）。 */
  get(input: {
    instanceId: string;
    runId: string;
  }): Promise<RunTimelineResult>;
  /** 导出单轮运行的 Markdown（供归档与排查）。 */
  exportMarkdown(input: {
    instanceId: string;
    runId: string;
  }): Promise<{ markdown: string; filename: string }>;
  /** 按 Task 列出轮次：没有检查点的工作区也能看到每一轮的时间与终态。 */
  listTaskRuns(input: {
    instanceId: string;
    projectId: string;
    taskId: string;
    limit: number;
  }): Promise<{ taskId: string; runs: TaskRunRow[] }>;
}

export type RunTimelineResult = {
  run: {
    runId: string;
    model: string | null;
    status: "accepted" | "running" | "completed" | "failed" | "canceled";
    stopReason: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string;
    completedAt: string | null;
    usage: RunTimelineUsage | null;
  };
  entries: RunTimelineEntry[];
};

export type RunTimelineUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

export type RunTimelineEntryKind =
  | "run"
  | "tool"
  | "subagent"
  | "command"
  | "compaction"
  | "hook"
  | "retry";

export type RunTimelineEntry = {
  kind: RunTimelineEntryKind;
  seq: number;
  at: string;
  title: string;
  status?: "success" | "error" | "cancelled" | "running";
  name?: string;
  agentName?: string;
  durationMs?: number;
  detail?: string;
};

/** 数据库里 `agent_runs` 一行的读取结果（时间与状态由仓储归一）。 */
export type RunTimelineRunRow = {
  runId: string;
  /** 该轮所属的根会话；用于缓解子代理会话的事件。 */
  rootSessionId: string;
  model: string | null;
  status: "accepted" | "running" | "completed" | "failed" | "canceled";
  stopReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
};

/** 按 Task 列轮次读到的一行：只保留终态与时间，明细由单轮时间线端点提供。 */
export type TaskRunRow = {
  runId: string;
  status: RunTimelineRunRow["status"];
  stopReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
};

/** 事件日志一行：`seq` 与 `created_at` 用于排序与展示，`event` 是流事件原文。 */
export type RunTimelineEventRow = {
  seq: number;
  createdAt: string;
  event: StreamEvent;
};

/** 根会话下由该轮派发的子代理会话；`parentToolCallId` 形如 `<runId>/<toolCallId>`。 */
export type RunTimelineChildSession = {
  childSessionId: string;
  parentToolCallId: string;
};

export type RunTimelineRepository = {
  /** 按运行 id 读取终态；不属于该实例时返回 null（不区分「不存在」与「别人的」）。 */
  loadRun(instanceId: string, runId: string): Promise<RunTimelineRunRow | null>;
  /** 读取该轮的事件日志；无法解析的历史行跳过。 */
  loadEvents(
    instanceId: string,
    runId: string,
  ): Promise<RunTimelineEventRow[]>;
  /** 读取该轮派发的子代理会话索引（只读，不重建归属）。 */
  loadChildSessions(
    instanceId: string,
    rootSessionId: string,
    runId: string,
  ): Promise<RunTimelineChildSession[]>;
  /** 读取单个子代理会话的事件日志（键前缀 `child-event:<childSessionId>/`）。 */
  loadChildEvents(
    instanceId: string,
    rootSessionId: string,
    childSessionId: string,
  ): Promise<RunTimelineEventRow[]>;
  /** 读取该轮的用量汇总；没有落账时返回 null（不拿 0 冒充）。 */
  loadUsage(
    instanceId: string,
    runId: string,
  ): Promise<RunTimelineUsage | null>;
  /**
   * 读取该 Task 的轮次列表（按开始时间倒序）。
   * 归属走 `agent_turn_boundaries`（写入时已按实例、项目、Task 与有效期校验），
   * 因此只返回真实绑定过执行作用域的轮次。
   */
  listRunsForTask(input: {
    instanceId: string;
    projectId: string;
    taskId: string;
    limit: number;
  }): Promise<TaskRunRow[]>;
};

export class RunTimelineError extends Error {
  constructor(readonly code: "not_found") {
    super(
      code === "not_found"
        ? "该轮运行不存在或不属于当前本地实例。"
        : "运行时间线读取失败。",
    );
  }
}
