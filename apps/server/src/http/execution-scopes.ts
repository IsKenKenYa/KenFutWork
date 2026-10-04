import { codeTaskScopeParamsSchema, codeTaskScopeResponseSchema, codeTaskScopeUpdateRequestSchema } from "@kenfutwork/shared";
import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import { ExecutionScopeError, type ExecutionScopes } from "../features/execution/scope-service.js";
import { isZodError } from "./zod-error.js";

/** 原 V4 以外的宿主目录授权 API；用户动作不假装成 Agent 工具提权。 */
export async function registerExecutionScopeRoutes(
  app: FastifyInstance,
  deps: { auth: RequestAuthenticator; scopes: ExecutionScopes },
) {
  const handler: RouteHandlerMethod = async (request, reply) => {
      const actor = await deps.auth.authenticate(request);
      if (!actor) return reply.code(401).send({ error: { code: "unauthenticated", message: "请先登录" } });
      try {
        const { taskId } = codeTaskScopeParamsSchema.parse(request.params);
        const scope = request.method === "PATCH"
          ? await deps.scopes.updateTask(actor, taskId, codeTaskScopeUpdateRequestSchema.parse(request.body))
          : (await deps.scopes.openTask(actor, taskId)).describe();
        return codeTaskScopeResponseSchema.parse({ scope });
      } catch (error) {
        if (error instanceof ExecutionScopeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
        if (isZodError(error)) return reply.code(400).send({ error: { code: "invalid_scope_request", message: "工作域请求无效", details: error.issues } });
        throw error;
      }
  };
  app.get("/api/code-ui/tasks/:taskId/scope", handler);
  app.patch("/api/code-ui/tasks/:taskId/scope", handler);
}
