import {
  applicationErrorResponseSchema,
  codeGitCheckoutRequestSchema,
  codeGitStatusResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import {
  CodeGitError,
  type CodeGitService,
} from "../features/code-git/code-git-service.js";

/**
 * Code 模式 git 分支视图路由（工作目录=项目）。
 *
 * 归属校验在 service 里（画布必须属于当前用户的工作区）；这里只做鉴权与错误映射。
 */
export async function registerCodeGitRoutes(
  app: FastifyInstance,
  options: { auth: RequestAuthenticator; codeGitService: CodeGitService },
) {
  app.get<{ Querystring: { canvasId?: string } }>(
    "/api/code/git",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      try {
        const git = await options.codeGitService.status(user, canvasId);
        return reply.code(200).send(codeGitStatusResponseSchema.parse({ git }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  app.post("/api/code/git/checkout", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    try {
      const payload = codeGitCheckoutRequestSchema.parse(request.body);
      const git = await options.codeGitService.checkout(
        user,
        payload.canvasId,
        payload.branch,
      );
      return reply.code(200).send(codeGitStatusResponseSchema.parse({ git }));
    } catch (error) {
      return sendCodeGitError(error, reply);
    }
  });
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendCodeGitError(error: unknown, reply: FastifyReply) {
  if (error instanceof CodeGitError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: { code: "application_error", message },
    }),
  );
}
