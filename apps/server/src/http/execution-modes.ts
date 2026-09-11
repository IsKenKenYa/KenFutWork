import {
  applicationErrorResponseSchema,
  executionModeSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance } from "fastify";

import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export async function registerExecutionModeRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    agentModes: ExecutionModeService;
  },
) {
  // GET /api/execution-modes — 模式词汇表（DEC-3：v1 agent + plan）
  app.get("/api/execution-modes", async (request, reply) => {
    const user = await options.auth.authenticate(request);
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
    return reply.code(200).send({ modes: options.agentModes.listModes() });
  });

  // GET /api/execution-modes/:threadId — 当前线程激活模式
  app.get("/api/execution-modes/:threadId", async (request, reply) => {
    const user = await options.auth.authenticate(request);
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
    const { threadId } = request.params as { threadId: string };
    return reply
      .code(200)
      .send({
        mode: executionModeSchema.parse(options.agentModes.getMode(threadId)),
      });
  });

  // PUT /api/execution-modes/:threadId — 激活/切换（会话级，DEC-2）
  app.put("/api/execution-modes/:threadId", async (request, reply) => {
    const user = await options.auth.authenticate(request);
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
    try {
      const { threadId } = request.params as { threadId: string };
      const mode = executionModeSchema.parse(
        (request.body as { mode?: unknown }).mode,
      );
      options.agentModes.activate(threadId, mode);
      return reply.code(200).send({ mode });
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: { code: "invalid_request", message: "Invalid mode." },
        }),
      );
    }
  });
}
