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
  knowledgeLibraryResponseSchema,
  knowledgeReadQuerySchema,
  knowledgeReadResponseSchema,
  knowledgeRemoveRootRequestSchema,
  knowledgeRootMutationResponseSchema,
  knowledgeRootsResponseSchema,
  knowledgeSearchRequestSchema,
  knowledgeSearchResponseSchema,
  knowledgeSettingsPatchSchema,
  knowledgeSettingsSchema,
  knowledgeStatusResponseSchema,
  knowledgeUploadResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";
import { ZodError } from "zod";

import type { KnowledgeSettingsReader } from "../features/knowledge/settings.js";
import {
  type KnowledgeService,
  KnowledgeServiceError,
} from "../features/knowledge/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import {
  type SettingsService,
  SettingsServiceError,
} from "../features/settings/settings-service.js";

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
  /** 面板设置读写；最小装配可无（此时接口返回显式不可用）。 */
  readSettings?: KnowledgeSettingsReader;
  settings?: Pick<SettingsService, "updateInstanceSettings">;
  /** preflight 最近一轮结果（面板状态条）；最小装配可无。 */
  preflight?: {
    lastOutcome(): {
      at: string;
      outcome: "injected" | "no-evidence" | "skipped" | "failed";
      reason: string | null;
    } | null;
  };
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
  if (error instanceof SettingsServiceError) {
    const status = error.statusCode;
    return sendError(
      reply,
      status >= 400 && status < 500 ? "invalid_input" : "application_error",
      error.message,
      status,
    );
  }
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
      return reply.code(200).send(
        knowledgeStatusResponseSchema.parse({
          ...(await options.knowledge.status()),
          preflight: options.preflight?.lastOutcome() ?? null,
        }),
      );
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/knowledge/roots", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const settings = options.readSettings
        ? await options.readSettings(user.instanceId)
        : undefined;
      const roots = await options.knowledge.listRoots(
        settings
          ? {
              timeoutMs: settings.listTimeoutMs,
              retries: settings.listRetries,
            }
          : {},
      );
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

  /**
   * 原始字节流：png/pdf/xlsx 等二进制预览用。与 read 同一套根包含校验
   * （realpath 后必须落在某个已注册根内，符号链接不扩权），只读不写。
   */
  app.get("/api/knowledge/file", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const query = knowledgeReadQuerySchema.parse(request.query);
      const path = query.path.trim();
      if (!path || !isAbsolute(path)) {
        throw new KnowledgeServiceError("invalid_input", "路径必须是绝对路径。");
      }
      let realPath: string;
      try {
        realPath = await realpath(path);
      } catch {
        throw new KnowledgeServiceError(
          "invalid_input",
          `文件不存在或不可读：${path}`,
        );
      }
      const roots = await options.knowledge.listRoots();
      const inside = await Promise.all(
        roots.map(async (root) => {
          try {
            const realRoot = await realpath(root.path);
            const tail = relative(realRoot, realPath);
            return (
              tail !== "" &&
              !isAbsolute(tail) &&
              tail !== ".." &&
              !tail.startsWith(`..${sep}`)
            );
          } catch {
            return false;
          }
        }),
      );
      if (!inside.some(Boolean)) {
        throw new KnowledgeServiceError(
          "invalid_input",
          "路径不在任何已注册的知识库根内。",
        );
      }
      const info = await stat(realPath);
      if (!info.isFile()) {
        throw new KnowledgeServiceError("invalid_input", `不是普通文件：${path}`);
      }
      const mime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".bmp": "image/bmp",
        ".pdf": "application/pdf",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
      };
      reply.header(
        "content-type",
        mime[extname(realPath).toLowerCase()] ?? "application/octet-stream",
      );
      reply.header("content-length", String(info.size));
      return reply.send(createReadStream(realPath));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/knowledge/read", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const query = knowledgeReadQuerySchema.parse(request.query);
      const settings = options.readSettings
        ? await options.readSettings(user.instanceId)
        : undefined;
      const result = await options.knowledge.read({
        path: query.path,
        ...(query.startLine === undefined
          ? {}
          : { startLine: query.startLine }),
        ...(query.endLine === undefined ? {} : { endLine: query.endLine }),
        ...(settings ? { maxBytes: settings.readMaxBytes } : {}),
      });
      return reply.code(200).send(knowledgeReadResponseSchema.parse(result));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/knowledge/settings", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      if (!options.readSettings) {
        return sendError(
          reply,
          "service_unavailable",
          "知识库设置读取不可用（最小装配）。",
          503,
        );
      }
      const settings = await options.readSettings(user.instanceId);
      return reply.code(200).send(knowledgeSettingsSchema.parse(settings));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/knowledge/settings", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      if (!options.readSettings || !options.settings) {
        return sendError(
          reply,
          "service_unavailable",
          "知识库设置写入不可用（最小装配）。",
          503,
        );
      }
      const body = knowledgeSettingsPatchSchema.parse(request.body);
      if (Object.values(body).every((value) => value === undefined)) {
        return sendError(
          reply,
          "invalid_input",
          "至少提供一个要更新的设置字段。",
          400,
        );
      }
      await options.settings.updateInstanceSettings(user, user.instanceId, {
        ...(body.autoInject === undefined
          ? {}
          : { knowledgeAutoInject: body.autoInject }),
        ...(body.localMatch === undefined
          ? {}
          : { knowledgeLocalMatch: body.localMatch }),
        ...(body.maxResults === undefined
          ? {}
          : { knowledgeMaxResults: body.maxResults }),
        ...(body.minHits === undefined
          ? {}
          : { knowledgeMinHits: body.minHits }),
        ...(body.searchTimeoutMs === undefined
          ? {}
          : { knowledgeSearchTimeoutMs: body.searchTimeoutMs }),
        ...(body.maxConcurrentSearches === undefined
          ? {}
          : { knowledgeMaxConcurrentSearches: body.maxConcurrentSearches }),
        ...(body.evidenceMaxChars === undefined
          ? {}
          : { knowledgeEvidenceMaxChars: body.evidenceMaxChars }),
        ...(body.cacheTtlMs === undefined
          ? {}
          : { knowledgeCacheTtlMs: body.cacheTtlMs }),
        ...(body.readMaxBytes === undefined
          ? {}
          : { knowledgeReadMaxBytes: body.readMaxBytes }),
      });
      const settings = await options.readSettings(user.instanceId);
      return reply.code(200).send(knowledgeSettingsSchema.parse(settings));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/knowledge/library", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      return reply
        .code(200)
        .send(
          knowledgeLibraryResponseSchema.parse(
            await options.knowledge.library(),
          ),
        );
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/knowledge/library", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      // 云盘式上传：单个文件，字段名固定 file；落盘后自动注册托管目录为根。
      let uploaded: { name: string; bytes: Buffer } | undefined;
      for await (const part of request.parts({
        limits: { files: 1, fields: 0, parts: 1 },
      })) {
        if (part.type !== "file" || part.fieldname !== "file" || uploaded) {
          return sendError(reply, "invalid_input", "请选择一个文件。", 400);
        }
        uploaded = {
          name: part.filename || "file",
          bytes: await part.toBuffer(),
        };
      }
      if (!uploaded) {
        return sendError(reply, "invalid_input", "请选择一个文件。", 400);
      }
      const result = await options.knowledge.uploadFile(uploaded);
      return reply.code(200).send(knowledgeUploadResponseSchema.parse(result));
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/knowledge/search", async (request, reply) => {
    try {
      const user = await authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const body = knowledgeSearchRequestSchema.parse(request.body);
      // 检索档必须沿用实例设置：面板开「本地匹配」后不能仍走语义检索（真机踩到）。
      const settings = options.readSettings
        ? await options.readSettings(user.instanceId)
        : undefined;
      const result = await options.knowledge.search({
        query: body.query,
        ...(body.path ? { path: body.path } : {}),
        ...(body.maxResults === undefined
          ? settings
            ? { maxResults: settings.maxResults }
            : {}
          : { maxResults: body.maxResults }),
        ...(settings
          ? {
              timeoutMs: settings.searchTimeoutMs,
              localMatch: settings.localMatch,
            }
          : {}),
      });
      return reply.code(200).send(knowledgeSearchResponseSchema.parse(result));
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
