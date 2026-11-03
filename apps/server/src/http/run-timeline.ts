import { runIdSchema } from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import {
  RunTimelineError,
  type RunTimelineService,
} from "../features/run-timeline/types.js";

/** 单轮运行时间线的 HTTP 消费方：JSON 回看与 Markdown 导出。 */
export async function registerRunTimelineRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: LocalAccessVerifier;
    timeline: RunTimelineService;
  },
) {
  app.get<{ Params: { runId: string } }>(
    "/api/agent/runs/:runId/timeline",
    async (request, reply) => {
      const user = await deps.localAccess.authenticate(request);
      if (!user) return unauthenticated(reply);
      const runId = parseRunId(request.params.runId, reply);
      if (!runId) return;
      try {
        return await deps.timeline.get({
          instanceId: user.instanceId,
          runId,
        });
      } catch (error) {
        return sendTimelineError(reply, error);
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/api/agent/runs/:runId/timeline/export",
    async (request, reply) => {
      const user = await deps.localAccess.authenticate(request);
      if (!user) return unauthenticated(reply);
      const runId = parseRunId(request.params.runId, reply);
      if (!runId) return;
      try {
        const exported = await deps.timeline.exportMarkdown({
          instanceId: user.instanceId,
          runId,
        });
        return reply
          .header("content-type", "text/markdown; charset=utf-8")
          .header(
            "content-disposition",
            `attachment; filename="${exported.filename}"`,
          )
          .send(exported.markdown);
      } catch (error) {
        return sendTimelineError(reply, error);
      }
    },
  );
}

function parseRunId(value: string, reply: FastifyReply): string | null {
  const parsed = runIdSchema.safeParse(value);
  if (!parsed.success) {
    reply.code(400).send({
      error: { code: "invalid_input", message: "运行 id 不合法。" },
    });
    return null;
  }
  return parsed.data;
}

function unauthenticated(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: "unauthenticated",
      message: "本机连接凭据缺失或已失效。",
    },
  });
}

function sendTimelineError(reply: FastifyReply, error: unknown) {
  if (error instanceof RunTimelineError) {
    return reply.code(404).send({
      error: { code: "run_not_found", message: error.message },
    });
  }
  return reply.code(500).send({
    error: {
      code: "application_error",
      message:
        error instanceof Error ? error.message : "运行时间线读取失败。",
    },
  });
}
