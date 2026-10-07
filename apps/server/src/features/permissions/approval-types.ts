import type {
  CommandPayloadMap,
  PendingInteraction,
  PermissionRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import type { ExecutionRole } from "../execution/scope-service.js";

/** Task-local V4 modes; never implemented by changing the instance tier. */
export type CodeApprovalMode =
  CommandPayloadMap["switchCollaborationMode"]["mode"];

/** 可信工具属主声明的Task控制效果；不属于文件/命令访问授权。 */
export type CodePlanControl = "enter" | "exit";

export interface ApprovalIdentity {
  instanceId: string;
  taskId: string;
  runId: string;
  toolCallId: string;
  agentId: string;
  role: ExecutionRole;
  scopeGeneration: number;
  branchGeneration: number;
  /** 规划批准绑定的可信episode；普通工具不携带。 */
  planningEpoch?: number | undefined;
}

/** All fields except args originate from the trusted host/tool owner. */
export interface PermissionInvocation extends ApprovalIdentity {
  preset: "code";
  threadId?: string | undefined;
  mode: CodeApprovalMode;
  /** Immutable dispatch-time ceiling for worker agents. */
  approvalCeiling: CodeApprovalMode;
  toolName: string;
  /** Parsed by the actual tool schema before either admission gate. */
  args: Record<string, unknown>;
  /** 可信工具属主提供的公开投影；指纹与审批claim仍绑定args。 */
  displayArgs?: Record<string, unknown> | undefined;
  access: "read" | "write" | "execute" | undefined;
  planControl?: CodePlanControl | undefined;
  /** Trusted proof of a readonly filesystem AND denied network. */
  readonlyExecution?: boolean | undefined;
  summary?: string | undefined;
  display?: PermissionRequestPayload["display"] | undefined;
  signal?: AbortSignal | undefined;
}

export interface BoundApprovalRequest {
  identity: Readonly<ApprovalIdentity>;
  parameterFingerprint: string;
  interaction: PendingInteraction;
}

export type ApprovalEvent = BoundApprovalRequest &
  (
    | { type: "requested" }
    | { type: "resolved"; decision: "allow" | "deny" }
    | { type: "cancelled"; reason: string }
  );

export interface ApprovalResolution {
  interactionId: string;
  answer: CommandPayloadMap["resolveInteraction"]["answer"];
  /** Current facts resolved by the authenticated host, never from answer. */
  binding: Pick<
    ApprovalIdentity,
    "instanceId" | "taskId" | "runId" | "scopeGeneration" | "branchGeneration" | "planningEpoch"
  >;
}

export type ApprovalResolutionResult =
  | { status: "resolved"; decision: "allow" | "deny" }
  | { status: "alreadyResolved"; reasonCode: "proto.alreadyResolved" }
  | {
      status: "rejected";
      reasonCode:
        | "approval.invalidBinding"
        | "approval.invalidAnswer"
        | "approval.notFound";
    };

export type ApprovalCancellation = Partial<
  Pick<
    ApprovalIdentity,
    "runId" | "agentId" | "scopeGeneration" | "branchGeneration"
  >
> &
  Pick<ApprovalIdentity, "instanceId" | "taskId">;

export interface CodeApprovalService {
  /** Wait for this actual invocation's human answer. Does not consume grant. */
  admit(
    invocation: PermissionInvocation,
  ): Promise<import("./permission-service.js").PermissionDecision>;
  /** Pure verification for upstream gates; never consumes an approval. */
  peek(
    invocation: PermissionInvocation,
  ): import("./permission-service.js").PermissionDecision;
  /** Final execution gate; consumes this invocation once, including auto grants. */
  claim(
    invocation: PermissionInvocation,
  ): import("./permission-service.js").PermissionDecision;
  resolve(input: ApprovalResolution): Promise<ApprovalResolutionResult>;
  /** 只读绑定含已结算请求；宿主核归属后才可使用迟到回执。 */
  find(
    instanceId: string,
    taskId: string,
    interactionId: string,
  ): BoundApprovalRequest | undefined;
  listPending(instanceId: string, taskId: string): BoundApprovalRequest[];
  cancel(identity: ApprovalCancellation, reason: string): Promise<void>;
  onEvent(listener: (event: ApprovalEvent) => void | Promise<void>): () => void;
}
