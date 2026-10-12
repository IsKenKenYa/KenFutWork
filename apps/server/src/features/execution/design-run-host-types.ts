import type { RunCreateRequest, StreamEvent } from "@kenfutwork/shared";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { LocalActor } from "../local-instance/types.js";
import type { DesignInputOrigin } from "./design-goals-types.js";
import type {
  DesignAdmissionReceipt,
  DesignRestoreBegin,
  DesignRestoreFinish,
  DesignRestoreLease,
} from "./design-task-types.js";

export type DesignHostEvent = {
  instanceId: string;
  taskId: string;
  canvasId: string;
  event: StreamEvent;
};
export type DesignHostInput = {
  taskId: string;
  inputId: string;
  modelInvocation?: ModelInvocationSnapshot;
  request: RunCreateRequest;
  scopeGeneration: number;
  branchGeneration: number;
};
export interface DesignRunHost {
  beginRestore(
    actor: LocalActor,
    input: DesignRestoreBegin,
  ): Promise<DesignRestoreLease>;
  finishRestore(
    actor: LocalActor,
    input: DesignRestoreFinish,
  ): Promise<boolean>;
  initialize(): Promise<void>;
  submit(
    actor: LocalActor,
    input: DesignHostInput,
  ): Promise<DesignAdmissionReceipt>;
  stop(
    actor: LocalActor,
    input: { taskId: string; expectedRunId?: string },
  ): Promise<{ kind: "stopping" | "idle" | "targetChanged"; runId?: string }>;
  dispatchNext(instanceId: string, taskId: string): Promise<boolean>;
  dispatchGoal(instanceId: string, taskId: string): Promise<boolean>;
  onEvent(
    listener: (event: DesignHostEvent) => void | Promise<void>,
  ): () => void;
  close(): Promise<void>;
}
export type DesignHostStoredInput = {
  actor: LocalActor;
  taskId: string;
  inputId: string;
  runId: string;
  scopeGeneration: number;
  branchGeneration: number;
  request: Omit<RunCreateRequest, "accessToken">;
  modelInvocation?: ModelInvocationSnapshot;
  model?: string;
  origin: DesignInputOrigin;
};
export interface DesignHostRepository {
  loadLatestActor(
    instanceId: string,
    taskId: string,
  ): Promise<{
    actor: LocalActor;
    model?: string;
    modelInvocation?: ModelInvocationSnapshot;
  } | null>;
  cancelQueuedForClient(instanceId: string, clientId: string): Promise<void>;
  loadInput(
    instanceId: string,
    taskId: string,
    runId: string,
  ): Promise<DesignHostStoredInput | null>;
  loadOriginActor(
    instanceId: string,
    taskId: string,
    runId: string,
  ): Promise<{
    actor: LocalActor;
    model?: string;
    modelInvocation?: ModelInvocationSnapshot;
  } | null>;
  listPending(instanceId: string): Promise<string[]>;
  lastOutcome(instanceId: string, taskId: string): Promise<string | null>;
  persistInput(input: DesignHostStoredInput): Promise<void>;
}
