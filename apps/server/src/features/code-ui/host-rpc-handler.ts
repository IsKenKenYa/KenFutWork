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

/** 原宿主贡献共用连接接纳与等待关闭；错误仍交给原 HTTP 消费方处理。 */
export async function runCodeUiHostRpc<T>(
  context: CodeUiHostRpcContext,
  call: () => Promise<T>,
): Promise<T> {
  context.requireInitialized();
  context.signal.throwIfAborted();
  const operation = call();
  const release = context.onClose(() =>
    operation.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    const result = await operation;
    context.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (context.signal.aborted)
      throw new CodeUiHostRpcError(
        "code_ui_not_found",
        "连接已关闭，请重新连接工作台。",
        404,
      );
    throw error;
  } finally {
    release();
  }
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
