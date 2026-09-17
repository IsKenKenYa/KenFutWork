import { registerAuthRoutes } from "../../http/auth.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  assertLocalTrustPosture,
  createLocalTrustAuthenticator,
  LOCAL_TRUST_DISPLAY_NAME,
} from "./local-trust.js";
import { createAccountRepository } from "./repository.js";
import { type AuthService, createAuthService } from "./service.js";
import type { RequestAuthenticator } from "./types.js";

/**
 * auth 插件（M1.4 / M2.3.2）：认证 Provider 两种形态，由 `KENFUTWORK_AUTH_DRIVER` 选择。
 *
 * - `managed`（默认：服务端 / 自托管）：本服务签发并校验**不透明会话令牌**
 *   （`account_sessions` 只存 SHA-256），并挂 `/api/auth/*`。原 Supabase Auth（GoTrue）
 *   驱动已随 M1.5 移除——存量 JWT 不再被接受，切换部署前须用 `auth:seed` 写入自管口令。
 * - `local-trust`（桌面，FORM-2）：本机回环免登录，请求直接映射到本机账号。
 *   免登录的安全前提是「只有本机能到达」：本形态**只允许绑定回环地址**（启动期 fail loud），
 *   且拒绝非回环 `Origin`（防用户浏览器里的网页借本机端口读数据），也**不挂** `/api/auth/*`。
 *
 * 未知取值 fail loud（不做静默降级）。
 */
export function createAuthPlugin(): PluginDefinition {
  // apply 期构造、auth 与路由共用同一实例
  let authService: AuthService | undefined;
  let driver: string | undefined;

  return {
    name: "auth",
    inject: ["persistence"],
    apply(ctx) {
      driver = ctx.env.authDriver ?? "managed";
      const repository = createAccountRepository(ctx.get("persistence"));

      if (driver === "local-trust") {
        assertLocalTrustPosture({
          authDriver: driver,
          host: ctx.env.serverHost ?? "127.0.0.1",
        });
        ctx.register("auth", () =>
          createLocalTrustAuthenticator({
            accounts: repository,
            displayName: LOCAL_TRUST_DISPLAY_NAME,
          }),
        );
        return;
      }

      if (driver !== "managed") {
        throw new Error(
          `未知 KENFUTWORK_AUTH_DRIVER：${driver}（可选 managed | local-trust）`,
        );
      }

      // 局部 const 供闭包捕获：闭包内读不到上面那处赋值的类型收窄
      const service = createAuthService({ repository });
      authService = service;
      // RequestAuthenticator 就是本服务（令牌来自 account_sessions）
      const authenticator: RequestAuthenticator = {
        /**
         * 两条令牌路径合成：**会话令牌**（登录）优先，其次**API 令牌**（外部应用）。
         * 第二条走 `apiTokens`（tryGet：worker/未装配时跳过），拿不到就与「没有令牌」同解。
         */
        authenticate: async (request) => {
          const viaSession = await service.resolveRequestUser(request);
          if (viaSession) return viaSession;
          const apiTokens = ctx.tryGet("apiTokens");
          if (!apiTokens) return null;
          const header = request.headers?.authorization;
          return apiTokens.resolveUser(
            typeof header === "string" ? header : undefined,
          );
        },
      };
      ctx.register("auth", () => authenticator);
    },
    mounted(ctx) {
      // local-trust 没有口令/会话流程，不挂认证路由（不保留无人使用的攻击面）
      if (!authService || driver !== "managed") {
        return;
      }
      void registerAuthRoutes(ctx.app, { authService });
    },
  };
}
