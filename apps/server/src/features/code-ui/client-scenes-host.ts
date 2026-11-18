import type { CodeUiHostRpcHandler } from "./host-rpc-handler.js";

/** 客户端场景目录属于上游远端服务（`ZCODE_CLIENT_SCENES_URL`），本机实例没有这份目录。 */
export const CLIENT_SCENES_UNAVAILABLE_CODE = 501;
export const CLIENT_SCENES_UNAVAILABLE_MESSAGE = "本机实例未提供客户端场景目录";

/**
 * `client-scenes.list` 的宿主实现。
 *
 * 本机实例不接远端目录，但也不该回 501：501 会被消费方当成传输失败，
 * 在 focus/reconnect/可见性恢复时反复重试。如实返回业务失败（HTTP 200 + code≠0），
 * 消费方按业务错误降级为空列表，并停止继续请求。
 */
export function createCodeUiClientScenesHost(): Record<
  string,
  CodeUiHostRpcHandler
> {
  return {
    "client-scenes.list": {
      async call() {
        return {
          code: CLIENT_SCENES_UNAVAILABLE_CODE,
          msg: CLIENT_SCENES_UNAVAILABLE_MESSAGE,
          data: [],
        };
      },
    },
  };
}
