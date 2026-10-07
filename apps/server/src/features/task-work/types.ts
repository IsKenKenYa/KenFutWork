import type { CodeExecutionScope } from "@kenfutwork/shared";
import type { LocalActor } from "../local-instance/types.js";

/** Work 属于用户 Task；originRunId 只标记派发事实，不决定生命周期。 */
export type TaskWorkKind = "command" | "subagent";
export type TaskWorkStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";
export interface TaskWorkRecord {
  id: string;
  scope: CodeExecutionScope;
  agentId: string;
  kind: TaskWorkKind;
  detached: boolean;
  label: string;
  originRunId: string;
  toolCallId: string;
  parameterFingerprint: string;
  childSessionId?: string;
  branchGeneration: number;
  status: TaskWorkStatus;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  outputRef?: string;
  outputStats?: {
    retainedBytes: number;
    totalBytes: number;
    discardedBytes: number;
  };
  consumed: boolean;
  ownerId: string;
  executionHostId: string;
}
export interface TaskWorkOutcome {
  status: "completed" | "failed" | "canceled";
  summary: string;
  outputRef?: string;
  outputStats?: TaskWorkRecord["outputStats"];
}
export interface TaskWorkHostLease {
  readonly signal: AbortSignal;
  release(): Promise<void>;
}
export interface TaskWorkCloseFence {
  scopeGeneration: number;
  branchGeneration: number;
  state: "ready" | "revoking" | "failed";
}
export interface TaskWorkHostLoss {
  executionHostId: string;
  tasks: Array<{ instanceId: string; taskId: string }>;
}
export interface TaskWorkStore {
  acquireHost(
    executionHostId: string,
    ownerId: string,
  ): Promise<TaskWorkHostLease | null>;
  closeFence(
    instanceId: string,
    taskId: string,
  ): Promise<TaskWorkCloseFence | null>;
  create(
    record: TaskWorkRecord,
  ): Promise<{ record: TaskWorkRecord; created: boolean }>;
  find(
    instanceId: string,
    taskId: string,
    workId: string,
  ): Promise<TaskWorkRecord | null>;
  list(instanceId: string, taskId: string): Promise<TaskWorkRecord[]>;
  settle(
    instanceId: string,
    taskId: string,
    workId: string,
    outcome: TaskWorkOutcome,
    at: string,
  ): Promise<TaskWorkRecord | null>;
  isCurrent(
    context: TaskWorkContext,
    purpose?: "dispatch" | "notification",
  ): Promise<boolean>;
  /** 原子通知准入与消费回执，终态消息不得重复消费。 */
  consume(context: TaskWorkContext): Promise<TaskWorkRecord[]>;
  /** 同一执行宿主的旧实例中断；保留输出，不唤醒模型或自动重放。 */
  interruptHost(
    executionHostId: string,
    ownerId: string,
    at: string,
  ): Promise<TaskWorkRecord[]>;
  updateOutput(
    instanceId: string,
    taskId: string,
    workId: string,
    ownerId: string,
    outputRef: string,
    stats: NonNullable<TaskWorkRecord["outputStats"]>,
  ): Promise<void>;
}
export interface TaskWorkExecutor {
  run(signal: AbortSignal): Promise<TaskWorkOutcome>;
  stop(reason: string): Promise<void>;
}
export interface TaskWorkContext {
  /** 仅存于宿主内存，不写入后台记录、输出或模型参数。 */
  actor?: LocalActor;
  signal?: AbortSignal;
  scope: CodeExecutionScope;
  agentId: string;
  runId: string;
  branchGeneration: number;
}
export interface TaskWorkManager {
  initialize(): Promise<TaskWorkRecord[]>;
  start(
    context: TaskWorkContext,
    input: {
      kind: TaskWorkKind;
      detached?: boolean;
      label: string;
      toolCallId: string;
      childSessionId?: string;
      parameters?: unknown;
    },
    executor: TaskWorkExecutor,
  ): Promise<TaskWorkRecord>;
  find(
    context: TaskWorkContext,
    workId: string,
  ): Promise<TaskWorkRecord | null>;
  list(context: TaskWorkContext): Promise<TaskWorkRecord[]>;
  stop(context: TaskWorkContext, workId: string, reason: string): Promise<void>;
  closeTask(instanceId: string, taskId: string, reason: string): Promise<void>;
  enterForeground(context: TaskWorkContext): Promise<() => Promise<void>>;
  consumeNotifications(context: TaskWorkContext): Promise<TaskWorkRecord[]>;
  notifyReady(instanceId: string, taskId: string): Promise<void>;
  recordOutput(
    context: TaskWorkContext,
    workId: string,
    outputRef: string,
    stats: NonNullable<TaskWorkRecord["outputStats"]>,
  ): Promise<void>;
  onReady(
    listener: (identity: {
      instanceId: string;
      taskId: string;
    }) => Promise<boolean>,
  ): () => void;
  onHostLost(listener: (event: TaskWorkHostLoss) => Promise<void>): () => void;
  onChanged(listener: (record: TaskWorkRecord) => Promise<void>): () => void;
  close(reason: string): Promise<void>;
}
