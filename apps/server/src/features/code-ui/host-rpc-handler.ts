import type { LocalActor } from "../local-instance/types.js";

/** 非模型宿主方法的贡献缝；key为原service.method，消费前必须验证当前连接。 */
export const CODE_UI_HOST_RPC_CAPABILITY = "code-ui-host-rpc";
export interface CodeUiHostRpcHandler {
  call(actor: LocalActor, args: unknown[]): Promise<unknown>;
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
