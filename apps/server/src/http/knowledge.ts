/**
 * SAG2 知识库 HTTP 路由（M2）。
 *
 * 鉴权沿用 `http/voice.ts` 的范式：路由内 `localAccess.authenticate` +
 * `localInstance.resolve` 复核（全局 onRequest 门另有一层）。错误码只用
 * `packages/shared/src/http.ts` 封闭枚举里的三个值，避免响应退化成
 * ZodError 转储（历史事故见《语音助手插件规划》§2.4）。
 *
 * `read` 与 `settings` 路由顺延 M4（侧边栏跳原文与开关），本期不注册。
 */

import {
  applicationErrorResponseSchema,
  knowledgeAddRootRequestSchema,
  knowledgeRemoveRootRequestSchema,
  knowledgeRootMutationResponseSchema,
  knowledgeRootsResponseSchema,
  knowledgeSearchRequestSchema,
  knowledgeSearchResponseSchema,
  knowledgeStatusResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  type KnowledgeService,
  KnowledgeServiceError,
} from "../features/knowledge/types.js";
import type { LocalActor } from "../features/local-instance/types.js";

type RouteErrorCode =
  | "invalid_input"
  | "service_unavailable"
  | "application_error";

export interface KnowledgeRouteDeps {
  localAccess: {
    authenticate(request: FastifyRequest): Promise<LocalActor | null>;
  };
  localInstance: {
    resolve(actor: LocalActor): Promise<unknown>;
  };
  knowledge: KnowledgeService;
}

function sendError(
  reply: FastifyReply,
  code: RouteErrorCode,
  message: string,
  status: number,
) {
  return reply
    .code(status)
    .send(applicationErrorResponseSchema.parse({ error: { code, message } }));
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "本机连接凭据缺失或无效。" },
    }),
  );
}

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof KnowledgeServiceError) {
    const status =
      error.code === "invalid_input"
        ? 400
        : error.code === "service_unavailable"
          ? 503
          : 500;
    return sendError(reply, error.code, error.message, status);
  }
  if (error instanceof ZodError) {
    return sendError(
      reply,
      "invalid_input",
      `请求参数不合法：${error.issues.map((issue) => issue.message).join("；")}`,
      400,
    );
  }
  return sendError(
    reply,
    "application_error",
    `知识库请求失败：${error instanceof Error ? error.message : String(error)}`,
    500,
  );
}

export async function registerKnowledgeRoutes(
  app: FastifyInstance,
  options: KnowledgeRouteDeps,
) {
  async function authenticate(
    request: FastifyRequest,
  ): Promise<LocalActor | null> {
    const actor = await options.localAccess.authenticate(request);
    if (actor) await options.localInstance.resolve(actor);
    return actor;
  }

  app.get("/api/knowledge/status", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      return reply
        .code(200)
        .send(
          knowledgeStatusResponseSchema.parse(await options.knowledge.status()),
        );
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/knowledge/roots", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const roots = await options.knowledge.listRoots();
      return reply
        .code(200)
        .send(knowledgeRootsResponseSchema.parse({ roots }));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/knowledge/roots", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const body = knowledgeAddRootRequestSchema.parse(request.body);
      const result = await options.knowledge.addRoot({
        path: body.path,
        ...(body.types ? { types: body.types } : {}),
      });
      return reply
        .code(200)
        .send(knowledgeRootMutationResponseSchema.parse(result));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/knowledge/roots/remove", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const body = knowledgeRemoveRootRequestSchema.parse(request.body);
      const result = await options.knowledge.removeRoot(body.path);
      return reply
        .code(200)
        .send(knowledgeRootMutationResponseSchema.parse(result));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/knowledge/search", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const body = knowledgeSearchRequestSchema.parse(request.body);
      const result = await options.knowledge.search({
        query: body.query,
        ...(body.path ? { path: body.path } : {}),
        ...(body.maxResults === undefined
          ? {}
          : { maxResults: body.maxResults }),
      });
      return reply.code(200).send(knowledgeSearchResponseSchema.parse(result));
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
