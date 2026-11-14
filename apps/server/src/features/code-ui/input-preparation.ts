import { randomUUID } from "node:crypto";
import {
  zcodeUiProtocol as protocol,
  type SandboxMode,
} from "@kenfutwork/shared";
import { resolveExecutionState } from "@zcode/shared";
import type { ToolContributionSnapshot } from "../../kernel/types.js";
import type { ModelInvocationSnapshot } from "../../providers/types.js";
import type { CodeAdmittedInput } from "./input-intents.js";

export function prepareCodeInputExecution(
  config: Pick<protocol.SessionConfigState, "mode" | "planEnabled">,
  payload: Pick<protocol.CommandPayloadMap["sendText"], "mode" | "planEnabled">,
  compact = false,
) {
  const current = resolveExecutionState({
    mode: config.mode,
    ...(config.planEnabled !== undefined
      ? { planEnabled: config.planEnabled }
      : {}),
  });
  const execution = resolveExecutionState(
    {
      ...(payload.mode !== undefined
        ? {
            mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse({
              mode: payload.mode,
            }).mode,
          }
        : {}),
      ...(payload.planEnabled !== undefined
        ? { planEnabled: payload.planEnabled }
        : {}),
    },
    current,
  );
  const requestedSandboxMode: SandboxMode | undefined =
    !compact && payload.mode !== undefined && payload.mode !== "plan"
      ? execution.mode === "yolo"
        ? "danger-full-access"
        : "workspace-write"
      : undefined;
  return { execution, requestedSandboxMode };
}

interface CodeInputPreparation {
  command: Pick<protocol.CommandEnvelope, "commandId" | "clientId">;
  payload: Pick<
    protocol.CommandPayloadMap["sendText"],
    "text" | "requestedDelivery" | "mode" | "planEnabled"
  >;
  kind: "sendText" | "compact";
  attachments: protocol.AttachmentRef[];
  selection: NonNullable<protocol.SessionConfigState["modelSelection"]>;
  execution: ReturnType<typeof resolveExecutionState>;
  workContext: protocol.ConversationWorkContext;
  modelInvocation: ModelInvocationSnapshot;
  frozenContributions?: ToolContributionSnapshot;
  runId: string;
  scopeGeneration: number;
  branchGeneration: number;
  delivery: "startNow" | "queue" | "guide";
  admissionSeq: number;
  queuePosition: number;
  requestedSandboxMode?: SandboxMode;
  preempt?: { previousRunId: string; autoDrain: boolean };
}

/** 普通发送与创建首条输入共用同一持久输入形状，代际由事务中的 Task 提供。 */
export function prepareCodeInputRecord(
  input: CodeInputPreparation,
): CodeAdmittedInput {
  const { payload, delivery, preempt } = input;
  const guide = delivery === "guide";
  return {
    ...(!guide && input.requestedSandboxMode
      ? { pendingScopeSelection: input.requestedSandboxMode }
      : {}),
    intent: {
      sourceCommandId: input.command.commandId,
      queueItemId: randomUUID(),
      clientId: input.command.clientId,
      kind: input.kind,
      text: payload.text,
      attachments: input.attachments,
      modelSelection: input.selection,
      mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse({
        mode: input.execution.mode,
      }).mode,
      planEnabled: input.execution.planEnabled,
      workContext: input.workContext,
      delivery: {
        requested: payload.requestedDelivery ?? "auto",
        admitted: delivery,
      },
      order: {
        admissionSeq: input.admissionSeq,
        ...(delivery === "queue" ? { queuePosition: input.queuePosition } : {}),
      },
      steer: {
        state: guide
          ? "steering"
          : payload.requestedDelivery === "guide"
            ? "fellBack"
            : "notRequested",
        ...(payload.requestedDelivery === "guide" && !guide
          ? { reasonCode: "guard.steeringUnavailable" }
          : {}),
      },
      dispatch: {
        state: preempt
          ? "reserved"
          : delivery === "queue" || guide
            ? "queued"
            : "admitted",
        ...(preempt ? { reservationId: input.runId } : {}),
      },
      admittedAt: Date.now(),
    },
    runId: input.runId,
    modelInvocation: input.modelInvocation,
    ...(input.frozenContributions
      ? { frozenContributions: structuredClone(input.frozenContributions) }
      : {}),
    scopeGeneration: input.scopeGeneration,
    branchGeneration: input.branchGeneration,
    status: preempt
      ? "reserved"
      : delivery === "queue" || guide
        ? "queued"
        : "active",
    ...(preempt
      ? {
          autoDrainAtAdmission: preempt.autoDrain,
          previousRunId: preempt.previousRunId,
        }
      : {}),
  };
}
