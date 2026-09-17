import {
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiTokenService } from "../features/api-tokens/token-service.js";
import { ApiTokenError } from "../features/api-tokens/token-service.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";

/**
 * 外部应用访问令牌的端点（R5-2「外部应用授权」）：列出 / 创建 / 吊销。
 *
 * 「令牌不能签发令牌」在这里落地：会话令牌来自登录（或 local-trust），
 * 而 API 令牌只在认证缝的第二条路径上被接受——它没有登录端点，也就拿不到**会话**，
 * 三个端点都要求有会话（`options.requireSession`）。
 */
export async function registerApiTokenRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    apiTokens: ApiTokenService;
    viewerService: Pick<ViewerService, "ensureViewer">;
    /** 当前请求是否来自登录会话（false = 来自 API 令牌）。 */
    isSessionRequest: (request: {
      headers: Record<string, unknown>;
    }) => boolean;
  },
): Promise<void> {
  const sendUnauthorized = (reply: FastifyReply) =>
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: {
          code: "unauthorized",
          message: "Missing or invalid bearer token.",
        },
      }),
    );

  const sendTokenError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ApiTokenError) {
      return reply.code(error.statusCode).send(
        applicationErrorResponseSchema.parse({
          error: { code: "invalid_input", message: error.message },
        }),
      );
    }
    return reply.code(500).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "application_error",
          message: error instanceof Error ? error.message : "令牌操作失败。",
        },
      }),
    );
  };

  /** 认证 + 会话检查（令牌签不了令牌：这条挡的就是「泄漏的令牌永久续命」）。 */
  const authorize = async (
    request: Parameters<RequestAuthenticator["authenticate"]>[0],
    reply: FastifyReply,
  ) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      sendUnauthorized(reply);
      return null;
    }
    if (!options.isSessionRequest(request)) {
      reply.code(403).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "application_error",
            message:
              "访问令牌不能管理访问令牌（这是有意的）：请用登录后的界面创建/吊销。",
          },
        }),
      );
      return null;
    }
    const viewer = await options.viewerService.ensureViewer(user);
    return { user, workspaceId: viewer.workspace.id };
  };

  app.get("/api/tokens", async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    try {
      const tokens = await options.apiTokens.list(context.workspaceId);
      return reply.code(200).send(apiTokenListResponseSchema.parse({ tokens }));
    } catch (error) {
      return sendTokenError(reply, error);
    }
  });

  app.post("/api/tokens", async (request, reply) => {
    const context = await authorize(request, reply);
    if (!context) return;
    try {
      const payload = apiTokenCreateRequestSchema.parse(request.body);
      const created = await options.apiTokens.create(
        context.user,
        context.workspaceId,
        payload.name,
      );
      return reply.code(201).send(
        apiTokenCreateResponseSchema.parse({
          token: created.token,
          record: created.record,
        }),
      );
    } catch (error) {
      return sendTokenError(reply, error);
    }
  });

  app.delete<{ Params: { id?: string } }>(
    "/api/tokens/:id",
    async (request, reply) => {
      const context = await authorize(request, reply);
      if (!context) return;
      const id = request.params.id ?? "";
      if (!id) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少令牌 id。" },
          }),
        );
      }
      try {
        await options.apiTokens.revoke(context.user, context.workspaceId, id);
        return reply.code(200).send({ ok: true });
      } catch (error) {
        return sendTokenError(reply, error);
      }
    },
  );
}
