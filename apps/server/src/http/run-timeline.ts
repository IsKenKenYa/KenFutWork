import { identifierSchema, runIdSchema } from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import {
  RunTimelineError,
  type RunTimelineService,
} from "../features/run-timeline/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";

type SettingsReader = Pick<SettingsService, "getInstanceSettings">;

/** 单轮运行时间线的 HTTP 消费方：JSON 回看与 Markdown 导出。 */
export async function registerRunTimelineRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: LocalAccessVerifier;
    settings: SettingsReader;
    timeline: RunTimelineService;
  },
) {
  app.get<{
    Params: { taskId: string; runId: string };
    Querystring: { projectId?: string };
  }>(
    "/api/agent/tasks/:taskId/runs/:runId/timeline",
    async (request, reply) => {
      const user = await deps.localAccess.authenticate(request);
      if (!user) return unauthenticated(reply);
      const taskId = parseIdentifier(request.params.taskId, "Task id", reply);
      if (!taskId) return;
      const projectId = parseIdentifier(
        request.query.projectId,
        "项目 id",
        reply,
      );
      if (!projectId) return;
      const runId = parseRunId(request.params.runId, reply);
      if (!runId) return;
      try {
        return await deps.timeline.get({
          instanceId: user.instanceId,
          projectId,
          taskId,
          runId,
        });
      } catch (error) {
        return sendTimelineError(reply, error);
      }
    },
  );

  app.get<{
    Params: { taskId: string; runId: string };
    Querystring: { projectId?: string };
  }>(
    "/api/agent/tasks/:taskId/runs/:runId/timeline/export",
    async (request, reply) => {
      const user = await deps.localAccess.authenticate(request);
      if (!user) return unauthenticated(reply);
      const taskId = parseIdentifier(request.params.taskId, "Task id", reply);
      if (!taskId) return;
      const projectId = parseIdentifier(
        request.query.projectId,
        "项目 id",
        reply,
      );
      if (!projectId) return;
      const runId = parseRunId(request.params.runId, reply);
      if (!runId) return;
      try {
        const settings = await deps.settings.getInstanceSettings(
          user,
          user.instanceId,
        );
        const exported = await deps.timeline.exportMarkdown({
          instanceId: user.instanceId,
          projectId,
          taskId,
          runId,
          maxBytes: settings.codeReadMaxBytes,
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

  app.get<{
    Params: { taskId: string };
    Querystring: { projectId?: string; limit?: string };
  }>("/api/agent/tasks/:taskId/runs", async (request, reply) => {
    const user = await deps.localAccess.authenticate(request);
    if (!user) return unauthenticated(reply);
    const taskId = parseIdentifier(request.params.taskId, "Task id", reply);
    if (!taskId) return;
    const projectId = parseIdentifier(
      request.query.projectId,
      "项目 id",
      reply,
    );
    if (!projectId) return;
    // 单页 1..50 是接口分页边界，只影响一次查询返回多少行，不进运行时治理表。
    const limit = parseLimit(request.query.limit, reply);
    if (limit === null) return;
    try {
      return await deps.timeline.listTaskRuns({
        instanceId: user.instanceId,
        projectId,
        taskId,
        limit,
      });
    } catch (error) {
      return sendTimelineError(reply, error);
    }
  });
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

function parseIdentifier(
  value: string | undefined,
  label: string,
  reply: FastifyReply,
): string | null {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    reply.code(400).send({
      error: { code: "invalid_input", message: `${label} 不合法。` },
    });
    return null;
  }
  return parsed.data;
}

const TASK_RUNS_DEFAULT_LIMIT = 20;
const TASK_RUNS_MAX_LIMIT = 50;

function parseLimit(
  value: string | undefined,
  reply: FastifyReply,
): number | null {
  if (value === undefined) return TASK_RUNS_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > TASK_RUNS_MAX_LIMIT) {
    reply.code(400).send({
      error: { code: "invalid_input", message: "limit 必须在 1 到 50 之间。" },
    });
    return null;
  }
  return parsed;
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
    if (error.code === "archived") {
      return reply.code(409).send({
        error: { code: "task_archived", message: error.message },
      });
    }
    return reply.code(404).send({
      error: { code: "run_not_found", message: error.message },
    });
  }
  return reply.code(500).send({
    error: {
      code: "application_error",
      message: error instanceof Error ? error.message : "运行时间线读取失败。",
    },
  });
}
