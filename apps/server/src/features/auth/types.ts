import type { FastifyRequest } from "fastify";

/**
 * 认证缝的身份类型（M1.4 起从 `supabase/user.ts` 迁出）。
 *
 * 这两个类型是**跨所有 feature 的稳定契约**（约 60 个文件引用）：认证 Provider 换成
 * 自管实现后，它们与任何具体 IdP 无关，故放在认证 feature 内、不再挂在 `supabase/` 下。
 *
 * `accessToken` 是**不透明会话令牌**（自管形态）或外部 IdP 令牌（过渡期形态）——消费方
 * 只应把它当作「转发给下游凭据解析的字符串」，不得假定其格式或自行解析。
 */

export type AuthenticatedUser = {
  accessToken: string;
  email: string;
  id: string;
  userMetadata: Record<string, unknown>;
};

export type RequestAuthenticator = {
  /**
   * `ip` 由 Fastify 从 socket 取（不可由请求头伪造），仅 local-trust 形态用它做回环判定；
   * 自管形态忽略之。声明为可选，以便 WS 握手等只有 headers 的调用点复用同一契约。
   */
  authenticate(
    request: Pick<FastifyRequest, "headers"> & { ip?: string },
  ): Promise<AuthenticatedUser | null>;
};
