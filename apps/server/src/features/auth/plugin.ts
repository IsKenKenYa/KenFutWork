import { registerAuthRoutes } from "../../http/auth.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { RequestAuthenticator } from "../../supabase/user.js";
import { createSupabaseRequestAuthenticator } from "../../supabase/user.js";
import { createAccountRepository } from "./repository.js";
import { type AuthService, createAuthService } from "./service.js";

/**
 * auth 插件（M1.4）：认证 Provider 的选择。
 *
 * - **`supabase`（默认，过渡期）**：校验 Supabase Auth 签发的 JWT（存量实现）；
 *   不挂 `/api/auth/*` 路由（登录走 GoTrue，前端也没换）。
 * - **`local`（目标态）**：本服务签发/校验不透明会话令牌，并挂 `/api/auth/*` 路由。
 *
 * 默认仍是 `supabase` 是**有意的**：切到 `local` 会让 GoTrue 签发的令牌全部失效，
 * 必须与前端替换、账号口令种子同时进行（一个 PR 内完成），否则用户立刻登不进来。
 * 故本插件先落缝与路由，切换由 `LOOMIC_AUTH_DRIVER=local` 显式触发。
 */
export function createAuthPlugin(): PluginDefinition {
  // apply 期构造、auth 与路由共用同一实例
  let authService: AuthService | undefined;

  return {
    name: "auth",
    inject: ["persistence"],
    apply(ctx) {
      const driver = ctx.env.authDriver ?? "supabase";

      if (driver === "supabase") {
        ctx.register("auth", () => createSupabaseRequestAuthenticator(ctx.env));
        return;
      }

      if (driver !== "local") {
        throw new Error(
          `[auth] 未知 LOOMIC_AUTH_DRIVER：${driver}（可用：supabase | local）`,
        );
      }

      const repository = createAccountRepository(ctx.get("persistence"));
      authService = createAuthService({ repository });
      // local 形态下 RequestAuthenticator 就是本服务（令牌来自 account_sessions）
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
