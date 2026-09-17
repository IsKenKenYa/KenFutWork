import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AuthenticatedUser } from "../features/auth/types.js";
import type { CodeGitService } from "../features/code-git/code-git-service.js";
import type { CodeIndexStore } from "../features/code-index/index-store.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";

/**
 * 索引库路由（R4-3）：状态 / 重建 / 清空 / 搜索。
 *
 * 开关在**工作区设置**（`codeIndexEnabled`）；关着的时候搜索端点**如实拒绝并指路**
 * （不是静默回空列表——那会让人以为「搜不到」是内容问题）。索引数据是本机缓存
 * （`<cwd>/.kenfutwork/index/<canvasId>.json`），所以「清空」是真删文件。
 */
export async function registerCodeIndexRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    codeGitService: CodeGitService;
    settingsService: SettingsService;
    indexStore: CodeIndexStore;
  },
) {
  const sendUnauthorized = (reply: FastifyReply) =>
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: {
          code: "unauthorized",
          message: "Missing or invalid bearer token.",
        },
      }),
    );
  const sendBadInput = (reply: FastifyReply, message: string) =>
    reply.code(400).send(
      applicationErrorResponseSchema.parse({
        error: { code: "invalid_input", message },
      }),
    );

  /** 画布 → 工作目录（越权 404，与其它 code 端点同一处校验）+ 该工作区的索引开关。 */
  const scopeFor = async (
    user: AuthenticatedUser,
    canvasId: string,
  ): Promise<{ enabled: boolean; dir: string }> => {
    const scope = await options.codeGitService.indexScope(user, canvasId);
    const settings = await options.settingsService.getWorkspaceSettings(
      user,
      scope.workspaceId,
    );
    return { enabled: settings.codeIndexEnabled, dir: scope.dir };
  };

  app.get<{ Querystring: { canvasId?: string } }>(
    "/api/code/index",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) return sendBadInput(reply, "缺少 canvasId。");
      try {
        const { enabled } = await scopeFor(user, canvasId);
        const index = await options.indexStore.load(canvasId);
        return reply.code(200).send({
          enabled,
          stats: await options.indexStore.stats(index),
        });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  app.post("/api/code/index/rebuild", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    const canvasId = (request.body as { canvasId?: unknown } | undefined)
      ?.canvasId;
    if (typeof canvasId !== "string" || !canvasId) {
      return sendBadInput(reply, "缺少 canvasId。");
    }
    try {
      const { dir } = await scopeFor(user, canvasId);
      const index = await options.indexStore.rebuild(canvasId, dir);
      return reply
        .code(200)
        .send({ stats: await options.indexStore.stats(index) });
    } catch (error) {
      return sendIndexError(reply, error);
    }
  });

  app.delete<{ Querystring: { canvasId?: string } }>(
    "/api/code/index",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) return sendBadInput(reply, "缺少 canvasId。");
      try {
        await scopeFor(user, canvasId);
        await options.indexStore.clear(canvasId);
        return reply.code(200).send({ ok: true });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  app.get<{ Querystring: { canvasId?: string; q?: string } }>(
    "/api/code/index/search",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      const query = request.query.q ?? "";
      if (!canvasId || !query.trim()) {
        return sendBadInput(reply, "缺少 canvasId 或 q。");
      }
      try {
        const { enabled, dir } = await scopeFor(user, canvasId);
        if (!enabled) {
          return reply.code(409).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "index_disabled",
                message: "索引库未开启：请到「设置 → 索引库」打开后再搜索。",
              },
            }),
          );
        }
        const index = await options.indexStore.ensure(canvasId, dir);
        return reply.code(200).send({
          hits: options.indexStore.search(index, query),
          builtAt: index.builtAt,
        });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );
}

function sendIndexError(reply: FastifyReply, error: unknown) {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode) || 500
      : 500;
  return reply.code(status).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "index_failed",
        message: error instanceof Error ? error.message : "索引操作失败。",
      },
    }),
  );
}
