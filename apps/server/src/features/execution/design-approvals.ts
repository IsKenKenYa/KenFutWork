import { EXIT_PLAN_MODE_TOOL_NAME } from "../code-ui/plan-approval.js";
import type { LocalActor } from "../local-instance/types.js";
import type {
  ApprovalResolution,
  ApprovalResolutionResult,
  BoundApprovalRequest,
} from "../permissions/approval-types.js";
import type { PermissionService } from "../permissions/permission-service.js";
import type {
  DesignTaskPolicy,
  DesignTasksService,
} from "./design-task-types.js";

export class DesignApprovalError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export interface DesignApprovalsService {
  list(
    actor: LocalActor,
    taskId: string,
  ): Promise<BoundApprovalRequest["interaction"][]>;
  resolve(
    actor: LocalActor,
    taskId: string,
    interactionId: string,
    answer: ApprovalResolution["answer"],
  ): Promise<Exclude<ApprovalResolutionResult, { status: "rejected" }>>;
}
function supported(request: BoundApprovalRequest) {
  const interaction = request.interaction;
  if (interaction.kind === "permission") return true;
  const payload = interaction.payload;
  return (
    interaction.kind === "userInput" &&
    payload.kind === "userInput" &&
    payload.toolName === EXIT_PLAN_MODE_TOOL_NAME &&
    typeof payload.schema === "object" &&
    payload.schema !== null &&
    "interaction" in payload.schema &&
    payload.schema.interaction === "plan_approval"
  );
}
function current(
  request: BoundApprovalRequest,
  actor: LocalActor,
  policy: DesignTaskPolicy,
) {
  const identity = request.identity;
  return (
    supported(request) &&
    policy.executionState === "ready" &&
    policy.activeRunId !== null &&
    identity.instanceId === actor.instanceId &&
    identity.taskId === policy.taskId &&
    identity.runId === policy.activeRunId &&
    identity.scopeGeneration === policy.scopeGeneration &&
    identity.branchGeneration === policy.branchGeneration &&
    (request.interaction.kind !== "userInput" ||
      (policy.planEnabled && identity.planningEpoch !== undefined)) &&
    (identity.planningEpoch === undefined ||
      identity.planningEpoch === policy.planningEpoch)
  );
}
export function createDesignApprovalsService(options: {
  designTasks: Pick<DesignTasksService, "readPolicy">;
  permissions: Pick<PermissionService, "find" | "listPending" | "resolve">;
}): DesignApprovalsService {
  return {
    async list(actor, taskId) {
      const policy = await options.designTasks.readPolicy(actor, taskId);
      return options.permissions
        .listPending(actor.instanceId, taskId)
        .filter((request) => current(request, actor, policy))
        .map((request) => request.interaction);
    },
    async resolve(actor, taskId, interactionId, answer) {
      const request = options.permissions.find(
        actor.instanceId,
        taskId,
        interactionId,
      );
      if (!request || !supported(request))
        throw new DesignApprovalError(404, "审批不属于当前任务。");
      const policy = await options.designTasks.readPolicy(actor, taskId);
      if (!current(request, actor, policy))
        throw new DesignApprovalError(409, "任务或审批已变更，请刷新。");
      const result = await options.permissions.resolve({
        interactionId,
        answer,
        binding: {
          instanceId: actor.instanceId,
          taskId,
          runId: policy.activeRunId ?? "",
          scopeGeneration: policy.scopeGeneration,
          branchGeneration: policy.branchGeneration,
          ...(request.identity.planningEpoch !== undefined
            ? { planningEpoch: policy.planningEpoch }
            : {}),
        },
      });
      if (result.status === "rejected") {
        const status =
          result.reasonCode === "approval.notFound"
            ? 404
            : result.reasonCode === "approval.invalidAnswer"
              ? 400
              : 409;
        throw new DesignApprovalError(
          status,
          status === 400 ? "请选择有效的审批答案。" : "审批已失效，请刷新。",
        );
      }
      return result;
    },
  };
}
