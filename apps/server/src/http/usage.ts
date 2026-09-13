import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  usageSummaryResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { UsageService } from "../features/usage/usage-service.js";

export async function registerUsageRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    usage: UsageService;
  },
) {
  // GET /api/usage/summary — 工作区用量汇总（RLS 隔离）
  app.get("/api/usage/summary", async (request, reply) => {
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
      const summary = await options.usage.summarize(user);
      return reply.code(200).send(usageSummaryResponseSchema.parse(summary));
    } catch (error) {
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "usage_query_failed",
            message:
              error instanceof Error ? error.message : "Usage query failed.",
          },
        }),
      );
    }
  });
}
