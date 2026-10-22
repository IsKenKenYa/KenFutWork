import type { LocalActor } from "../local-instance/types.js";

/** 非模型宿主方法的贡献缝；key为原service.method，消费前必须验证当前连接。 */
export const CODE_UI_HOST_RPC_CAPABILITY = "code-ui-host-rpc";
export type CodeUiHostRpcCleanup = () => void | Promise<void>;

/** 身份由活动连接持有；具体 Task 由每次方法调用另行校验。 */
export interface CodeUiHostRpcContext {
  readonly actor: LocalActor;
  readonly connectionId: string;
  readonly signal: AbortSignal;
  requireInitialized(): void;
  onClose(cleanup: CodeUiHostRpcCleanup): () => void;
}

export interface CodeUiHostRpcHandler {
  call(
    actor: LocalActor,
    args: unknown[],
    context: CodeUiHostRpcContext,
  ): Promise<unknown>;
}

/** feature贡献的原宿主方法沿同一HTTP边界报告可读错误。 */
export class CodeUiHostRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
