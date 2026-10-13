import type {
  AdditionalDirectory,
  CodeExecutionScope,
  RunCreateRequest,
  RunStopReason,
  SandboxMode,
} from "@kenfutwork/shared";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { GoalFence } from "../goals/service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { DesignInputOrigin } from "./design-goals-types.js";

export type DesignTaskPreparation = {
  instanceId: string;
  projectId: string;
  canvasId: string;
  projectFingerprint: string;
  rootDirectory: string;
  additionalDirectories: AdditionalDirectory[];
};

export type DesignTaskReceipt = {
  taskId: string;
  projectId: string;
  canvasId: string;
  rootDirectory: string;
  additionalDirectories: AdditionalDirectory[];
  sandboxMode: SandboxMode;
  scopeGeneration: number;
  branchGeneration: number;
};

export type DesignTaskPolicy = DesignTaskReceipt & {
  mode: "build" | "edit" | "yolo";
  planEnabled: boolean;
  planningEpoch: number;
  activeRunId: string | null;
  executionState: "ready" | "revoking" | "failed";
};

export type DesignAdmissionReceipt = {
  kind: "running" | "queued" | "duplicate";
  taskId: string;
  inputId: string;
  runId: string;
  sequence: number;
  request: Omit<RunCreateRequest, "accessToken"> | null;
};

export type DesignRestoreBegin = {
  taskId: string;
  expectedScopeGeneration: number;
  expectedBranchGeneration: number;
};
export type DesignRestoreFinish = {
  taskId: string;
  operationId: string;
  scopeGeneration: number;
  branchGeneration: number;
  state: "ready" | "failed";
};
export type DesignRestoreLease = {
  taskId: string;
  projectId: string;
  canvasId: string;
  operationId: string;
  scopeGeneration: number;
  branchGeneration: number;
  scope: CodeExecutionScope;
  activeRunId: string | null;
};
export interface DesignTasksService {
  beginRestore(
    actor: LocalActor,
    input: DesignRestoreBegin,
  ): Promise<DesignRestoreLease>;
  finishRestore(
    actor: LocalActor,
    input: DesignRestoreFinish,
  ): Promise<boolean>;
  markRunStarted(
    actor: LocalActor,
    input: { taskId: string; runId: string },
  ): Promise<boolean>;
  recoverInterruptedTasks(actor: LocalActor): Promise<number>;
  onLeaseLost(
    listener: (instanceId: string, taskId: string) => void,
  ): () => void;
  close(): Promise<void>;
  prepareCreation(
    actor: LocalActor,
    canvasId: string,
  ): Promise<DesignTaskPreparation | null>;
  provision(actor: LocalActor, taskId: string): Promise<DesignTaskReceipt>;
  read(actor: LocalActor, taskId: string): Promise<DesignTaskReceipt>;
  readPolicy(actor: LocalActor, taskId: string): Promise<DesignTaskPolicy>;
  updatePolicy(
    actor: LocalActor,
    input: {
      taskId: string;
      scopeGeneration: number;
      planningEpoch: number;
      mode?: "build" | "edit" | "yolo";
      planEnabled?: boolean;
    },
  ): Promise<DesignTaskPolicy>;
  admitInput(
    actor: LocalActor,
    input: {
      taskId: string;
      inputId: string;
      runId: string;
      modelInvocation?: ModelInvocationSnapshot;
      captureModelInvocation?: () => Promise<ModelInvocationSnapshot>;
      request: RunCreateRequest;
      scopeGeneration: number;
      branchGeneration: number;
      origin?: DesignInputOrigin;
      goalFence?: GoalFence;
    },
  ): Promise<DesignAdmissionReceipt>;
  claimNextInput(
    actor: LocalActor,
    taskId: string,
  ): Promise<DesignAdmissionReceipt | null>;
  requestStop(
    actor: LocalActor,
    input: { taskId: string; expectedRunId?: string },
  ): Promise<{
    kind: "stopping" | "idle" | "targetChanged";
    runId?: string;
  }>;
  settleRun(
    actor: LocalActor,
    input: {
      taskId: string;
      runId: string;
      outcome: "completed" | "canceled" | "failed";
      terminalMetadata?: {
        completedAt: string;
        stopReason?: RunStopReason;
        errorCode?: string;
        errorMessage?: string;
        assistant?: { messageId: string; text: string; blocks: unknown[] };
      };
    },
  ): Promise<boolean>;
}
