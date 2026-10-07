import type {
  PendingInteraction,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ApprovalCancellation,
  ApprovalIdentity,
  ApprovalResolution,
  PermissionInvocation,
} from "../permissions/approval-types.js";
import type { AskUserQuestionOutput } from "./user-input-schema.js";

export type UserInputInvocation = PermissionInvocation & {
  signal: AbortSignal;
};

export interface BoundUserInputRequest {
  identity: Readonly<ApprovalIdentity>;
  parameterFingerprint: string;
  interaction: PendingInteraction & {
    kind: "userInput";
    payload: UserInputRequestPayload;
  };
}

export type UserInputAction = "accept" | "decline" | "cancel";

export type UserInputEvent = BoundUserInputRequest &
  (
    | { type: "requested" }
    | {
        type: "resolved";
        action: UserInputAction;
        result: AskUserQuestionOutput;
      }
    | { type: "cancelled"; reason: string }
  );

export type UserInputResolutionResult =
  | { status: "resolved"; action: UserInputAction }
  | { status: "alreadyResolved"; reasonCode: "proto.alreadyResolved" }
  | {
      status: "rejected";
      reasonCode: "not_found" | "proto.invalidBinding" | "proto.invalidAnswer";
    };

/** 同一真实工具调用的问答等待；不是权限授权或新的模型运行。 */
export interface CodeUserInputService {
  request(invocation: UserInputInvocation): Promise<AskUserQuestionOutput>;
  resolve(input: ApprovalResolution): Promise<UserInputResolutionResult>;
  listPending(instanceId: string, taskId: string): BoundUserInputRequest[];
  /** 包含已结算请求的只读绑定；消费者必须先核主/子会话归属。 */
  find(
    instanceId: string,
    taskId: string,
    interactionId: string,
  ): BoundUserInputRequest | undefined;
  cancel(selector: ApprovalCancellation, reason: string): Promise<void>;
  onEvent(
    listener: (event: UserInputEvent) => void | Promise<void>,
  ): () => void;
  close(reason: string): Promise<void>;
}
