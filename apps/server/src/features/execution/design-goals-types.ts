import type { StreamEvent } from "@kenfutwork/shared";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { TaskGoalHost } from "../goals/consumer.js";
import type { GoalFence, GoalRecord } from "../goals/service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { InstanceSqlClient } from "../persistence/types.js";
import type { DesignTaskRow } from "./design-task-metadata.js";
export type DesignInputOrigin =
  | "userInput"
  | "backgroundResult"
  | "goalContinuation";
export type DesignGoalAdmission = {
  runId: string;
  inputId: string;
  origin: DesignInputOrigin;
  goalFence?: GoalFence;
  actor: LocalActor;
  objective?: string;
  modelInvocation?: ModelInvocationSnapshot;
};
export interface DesignGoalLifecycle {
  claim(
    sql: InstanceSqlClient,
    task: DesignTaskRow,
    input: DesignGoalAdmission,
  ): Promise<void>;
  settle(
    sql: InstanceSqlClient,
    task: DesignTaskRow,
    input: {
      runId: string;
      outcome: "completed" | "failed" | "canceled";
      at: number;
    },
  ): Promise<void>;
  pause(
    sql: InstanceSqlClient,
    task: DesignTaskRow,
    reason: string,
    at: number,
  ): Promise<void>;
  recover(
    sql: InstanceSqlClient,
    task: DesignTaskRow,
    at: number,
  ): Promise<void>;
  rebranch(
    sql: InstanceSqlClient,
    task: DesignTaskRow,
    branchGeneration: number,
    at: number,
  ): Promise<void>;
}
export interface DesignGoalsService extends TaskGoalHost {
  initialize(): Promise<void>;
  close(): Promise<void>;
  onLost(listener: () => void): () => void;
  lifecycle: DesignGoalLifecycle;
  readTask(actor: LocalActor, taskId: string): Promise<GoalRecord | null>;
  create(
    actor: LocalActor,
    input: {
      taskId: string;
      objective: string;
      model?: string;
      tokenBudget?: number | null;
      expectedBranchGeneration?: number;
      expectedGoal?: GoalFence | null;
    },
  ): Promise<GoalRecord>;
  pause(
    actor: LocalActor,
    input: GoalFence & {
      taskId: string;
      reason?: string;
      branchGeneration?: number;
    },
  ): Promise<GoalRecord>;
  resume(
    actor: LocalActor,
    input: GoalFence & {
      taskId: string;
      branchGeneration?: number;
      model?: string;
    },
  ): Promise<GoalRecord>;
  setBudget(
    actor: LocalActor,
    input: GoalFence & {
      taskId: string;
      tokenBudget: number | null;
      branchGeneration?: number;
    },
  ): Promise<GoalRecord>;
  observe(
    actor: LocalActor,
    taskId: string,
    event: StreamEvent,
  ): Promise<{ stop: boolean }>;
  continuation(
    instanceId: string,
    taskId: string,
  ): Promise<{
    actor: LocalActor;
    goalFence: GoalFence;
    inputId: string;
    prompt: string;
    modelInvocation: ModelInvocationSnapshot;
  } | null>;
}
