import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CodeGitService } from "../features/code-git/code-git-service.js";
import {
  type CodeIndexStore,
  IndexTooLargeError,
} from "../features/code-index/index-store.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";

/**
 * 索引库路由（R4-3）：状态 / 重建 / 清空 / 搜索。
 *
 * 两个开关都在**工作区设置**，对应参考图的两行（`docs/参考图/索引库-代码库索引开关.png`）：
 * - `codeIndexEnabled` =「索引存储库以实现即时搜索」：右栏「文件目录」的搜索走索引；
 *   关着时搜索端点**如实拒绝并指路**（不是静默回空列表——那会让人以为「搜不到」是内容问题）。
 * - `codeIndexAutoNewFolder` =「索引新文件夹」：搜到还没有索引的目录时自动建一份；
 *   关着时如实说「没有索引，请手动重建」；文件数达 50,000 时不自动建（可读原因）。
 * 索引数据是本机缓存（`<cwd>/.kenfutwork/index/<taskId>.json`），所以「清空」是真删文件。
 */
export async function registerCodeIndexRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
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

  /** 画布 → 工作目录（越权 404，与其它 code 端点同一处校验）+ 该工作区的两个索引开关。 */
  const scopeFor = async (
    user: LocalActor,
    taskId: string,
  ): Promise<{ enabled: boolean; autoNewFolder: boolean; dir: string }> => {
    const scope = await options.codeGitService.indexScope(user, taskId);
    const settings = await options.settingsService.getInstanceSettings(
      user,
      scope.instanceId,
    );
    return {
      enabled: settings.codeIndexEnabled,
      autoNewFolder: settings.codeIndexAutoNewFolder,
      dir: scope.dir,
    };
  };

  app.get<{ Querystring: { taskId?: string } }>(
    "/api/code/index",
    async (request, reply) => {
      const user = await options.localAccess.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const taskId = request.query.taskId ?? "";
      if (!taskId) return sendBadInput(reply, "缺少 taskId。");
      try {
        const { enabled, autoNewFolder } = await scopeFor(user, taskId);
        const index = await options.indexStore.load(taskId);
        return reply.code(200).send({
          enabled,
          autoNewFolder,
          stats: await options.indexStore.stats(index),
        });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  app.post("/api/code/index/rebuild", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    const taskId = (request.body as { taskId?: unknown } | undefined)?.taskId;
    if (typeof taskId !== "string" || !taskId) {
      return sendBadInput(reply, "缺少 taskId。");
    }
    try {
      const { dir } = await scopeFor(user, taskId);
      const index = await options.indexStore.rebuild(taskId, dir);
      return reply
        .code(200)
        .send({ stats: await options.indexStore.stats(index) });
    } catch (error) {
      return sendIndexError(reply, error);
    }
  });

  app.delete<{ Querystring: { taskId?: string } }>(
    "/api/code/index",
    async (request, reply) => {
      const user = await options.localAccess.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const taskId = request.query.taskId ?? "";
      if (!taskId) return sendBadInput(reply, "缺少 taskId。");
      try {
        await scopeFor(user, taskId);
        await options.indexStore.clear(taskId);
        return reply.code(200).send({ ok: true });
      } catch (error) {
        return sendIndexError(reply, error);
      }
    },
  );

  app.get<{ Querystring: { taskId?: string; q?: string } }>(
    "/api/code/index/search",
    async (request, reply) => {
      const user = await options.localAccess.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const taskId = request.query.taskId ?? "";
      const query = request.query.q ?? "";
      if (!taskId || !query.trim()) {
        return sendBadInput(reply, "缺少 taskId 或 q。");
      }
      try {
        const { enabled, autoNewFolder, dir } = await scopeFor(user, taskId);
        if (!enabled) {
          return reply.code(409).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "index_disabled",
                message:
                  "「索引存储库以实现即时搜索」没开：请到「设置 → 索引库」打开后再搜索。",
              },
            }),
          );
        }
        const index = await options.indexStore.ensure(taskId, dir, {
          auto: autoNewFolder,
        });
        if (!index) {
          return reply.code(409).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "index_not_built",
                message:
                  "这个工作目录还没有索引，而「索引新文件夹」是关着的：请到「设置 → 索引库」点「重建索引」，或打开「索引新文件夹」。",
              },
            }),
          );
        }
        return reply.code(200).send({
          hits: options.indexStore.search(index, query),
          builtAt: index.builtAt,
        });
      } catch (error) {
        if (error instanceof IndexTooLargeError) {
          return reply.code(413).send(
            applicationErrorResponseSchema.parse({
              error: { code: "index_too_large", message: error.message },
            }),
          );
        }
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
