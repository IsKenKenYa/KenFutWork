import { registerApiTokenRoutes } from "../../http/api-tokens.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createApiTokenRepository } from "./repository.js";
import { createApiTokenService, parseApiTokenHeader } from "./token-service.js";

/**
 * api-tokens 插件（R5-2「外部应用授权」）：外部应用 / 脚本 / CI 用的访问令牌。
 *
 * 两条消费路径：
 * - **HTTP**：`/api/tokens` 列出/创建/吊销（都要登录会话）；
 * - **认证缝**：auth 插件的认证器把「会话令牌」与「API 令牌」两条路径串起来
 *   （见 auth/plugin.ts 的合成），所以外部应用拿令牌就能直接调本服务的 API。
 */
export function createApiTokensPlugin(): PluginDefinition {
  return {
    name: "api-tokens",
    inject: ["persistence", "auth"],
    apply(ctx) {
      const repository = createApiTokenRepository(ctx.get("persistence"));
      ctx.register("apiTokens", () => createApiTokenService({ repository }));
    },
    mounted(ctx) {
      const auth = ctx.get("auth");
      void registerApiTokenRoutes(ctx.app, {
        auth,
        apiTokens: ctx.get("apiTokens"),
        viewerService: ctx.get("viewer"),
        /* 会话请求判定：auth 插件在解析时记下「这条请求走的是哪条令牌路径」 */
        isSessionRequest: (request) =>
          !parseApiTokenHeader(
            typeof request.headers.authorization === "string"
              ? request.headers.authorization
              : undefined,
          ),
      });
    },
  };
}
