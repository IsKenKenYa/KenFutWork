import {
  applicationErrorResponseSchema,
  authErrorResponseSchema,
  authLoginRequestSchema,
  authRegisterRequestSchema,
  authSessionResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AuthError, AuthService } from "../features/auth/service.js";
import { parseBearerToken } from "../features/auth/service.js";

/**
 * 自管认证路由（M1.4；仅 `KENFUTWORK_AUTH_DRIVER=local` 时挂载）。
 *
 *   POST /api/auth/register  注册并直接签发会话
 *   POST /api/auth/login     口令登录
 *   POST /api/auth/logout    吊销当前会话（幂等：无令牌也回 204）
 *   GET  /api/auth/session   校验令牌并回当前用户（前端启动时探活）
 *
 * 错误码走 `authErrorResponseSchema`（共享契约）；未知错误折叠为 500 且不外传细节。
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  options: { authService: AuthService },
): Promise<void> {
  const sendAuthError = (reply: FastifyReply, error: AuthError) =>
    reply.code(error.statusCode).send(
      authErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );

  const isAuthError = (error: unknown): error is AuthError =>
    error instanceof Error &&
    "code" in error &&
    "statusCode" in error &&
    typeof (error as AuthError).statusCode === "number";

  const toSessionResponse = (session: {
    expiresAt: string;
    token: string;
    user: { email: string; id: string; userMetadata: Record<string, unknown> };
  }) => {
    const displayName = session.user.userMetadata.display_name;
    return authSessionResponseSchema.parse({
      session: { expiresAt: session.expiresAt, token: session.token },
      user: {
        displayName: typeof displayName === "string" ? displayName : null,
        email: session.user.email,
        id: session.user.id,
      },
    });
  };

  app.post("/api/auth/register", async (request, reply) => {
    const parsed = authRegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_input",
            message: parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          },
        }),
      );
    }

    try {
      const session = await options.authService.register(parsed.data);
      return reply.code(201).send(toSessionResponse(session));
    } catch (error) {
      if (isAuthError(error)) {
        return sendAuthError(reply, error);
      }
      request.log.error({ err: error }, "auth register error");
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "auth_unavailable",
            message: "注册失败，请稍后重试。",
          },
        }),
      );
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = authLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: { code: "invalid_input", message: "邮箱或口令格式不正确。" },
        }),
      );
    }

    try {
      const session = await options.authService.login(parsed.data);
      return reply.code(200).send(toSessionResponse(session));
    } catch (error) {
      if (isAuthError(error)) {
        return sendAuthError(reply, error);
      }
      request.log.error({ err: error }, "auth login error");
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "auth_unavailable",
            message: "登录失败，请稍后重试。",
          },
        }),
      );
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = parseBearerToken(
      typeof request.headers.authorization === "string"
        ? request.headers.authorization
        : undefined,
    );

    // 幂等：无令牌也视为已登出（前端清本地状态即可，不该因令牌已失效报错）
    if (token) {
      try {
        await options.authService.logout(token);
      } catch (error) {
        request.log.error({ err: error }, "auth logout error");
      }
    }

    return reply.code(204).send();
  });

  app.get("/api/auth/session", async (request, reply) => {
    const user = await options.authService.resolveRequestUser(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }

    const displayName = user.userMetadata.display_name;
    return reply.code(200).send(
      authSessionResponseSchema.pick({ user: true }).parse({
        user: {
          displayName: typeof displayName === "string" ? displayName : null,
          email: user.email,
          id: user.id,
        },
      }),
    );
  });
}
