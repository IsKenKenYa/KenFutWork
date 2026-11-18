import type { CodeUiHostRpcHandler } from "./host-rpc-handler.js";

/**
 * `client-config.getSnapshot` 的宿主实现。
 *
 * 上游这份配置来自远端公开接口（插件商店排序等），本机实例没有远端配置。
 * 回 501 会被消费方当成传输失败并刷控制台；这里如实返回空配置信封，
 * 消费方解析后得到 `pluginStoreOrder: null`。
 */
export function createCodeUiClientConfigHost(): Record<
  string,
  CodeUiHostRpcHandler
> {
  return {
    "client-config.getSnapshot": {
      async call() {
        return { code: 0, msg: "", data: { configs: {} } };
      },
    },
  };
}
