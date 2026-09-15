import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  usageStatsResponseSchema,
  usageSummaryResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { UsageService } from "../features/usage/usage-service.js";

/** 统计窗口口径（R4-2 参考图「近 7 日 / 近 30 日」）。 */
const STATS_RANGES = [7, 30] as const;

export async function registerUsageRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    usage: UsageService;
  },
) {
  const unauthorized = (reply: FastifyReply) =>
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: {
          code: "unauthorized",
          message: "Missing or invalid bearer token.",
        },
      }),
    );

  const sendUsageError = (error: unknown, reply: FastifyReply) =>
    reply.code(500).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "usage_query_failed",
          message:
            error instanceof Error ? error.message : "Usage query failed.",
        },
      }),
    );

  // GET /api/usage/summary — 工作区用量汇总（RLS 隔离）
  app.get("/api/usage/summary", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return unauthorized(reply);
    try {
      const summary = await options.usage.summarize(user);
      return reply.code(200).send(usageSummaryResponseSchema.parse(summary));
    } catch (error) {
      return sendUsageError(error, reply);
    }
  });

  // GET /api/usage/stats?days=7|30 — 用户侧使用统计（R4-2）
  app.get<{ Querystring: { days?: string } }>(
    "/api/usage/stats",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthorized(reply);
      const days = Number(request.query.days ?? 7);
      if (
        !STATS_RANGES.includes(days as (typeof STATS_RANGES)[number]) ||
        !Number.isInteger(days)
      ) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "invalid_input",
              message: "days 仅支持 7 或 30。",
            },
          }),
        );
      }
      try {
        const stats = await options.usage.stats(user, days);
        return reply.code(200).send(usageStatsResponseSchema.parse(stats));
      } catch (error) {
        return sendUsageError(error, reply);
      }
    },
  );
}
