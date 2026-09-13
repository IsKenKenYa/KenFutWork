import { registerAuthRoutes } from "../../http/auth.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createAccountRepository } from "./repository.js";
import { type AuthService, createAuthService } from "./service.js";
import type { RequestAuthenticator } from "./types.js";

/**
 * auth 插件（M1.4）：自管认证 Provider（唯一形态）。
 *
 * 本服务签发并校验**不透明会话令牌**（`account_sessions` 只存 SHA-256），并挂
 * `/api/auth/*` 路由。原 Supabase Auth（GoTrue）驱动已随 M1.5 移除——存量 JWT 不再被接受，
 * 故部署切换时必须已为账号写入自管口令（`auth:seed`）。
 *
 * `/api/auth/*` 由本插件在 `mounted` 挂载；无独立 enabled 门控——认证是必需能力。
 */
export function createAuthPlugin(): PluginDefinition {
  // apply 期构造、auth 与路由共用同一实例
  let authService: AuthService | undefined;

  return {
    name: "auth",
    inject: ["persistence"],
    apply(ctx) {
      const repository = createAccountRepository(ctx.get("persistence"));
      authService = createAuthService({ repository });
      // RequestAuthenticator 就是本服务（令牌来自 account_sessions）
      const authenticator: RequestAuthenticator = {
        authenticate: (request) => authService!.resolveRequestUser(request),
      };
      ctx.register("auth", () => authenticator);
    },
    mounted(ctx) {
      if (!authService) {
        return;
      }
      void registerAuthRoutes(ctx.app, { authService });
    },
  };
}
