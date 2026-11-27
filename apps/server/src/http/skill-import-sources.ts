import {
  applicationErrorResponseSchema,
  skillImportSourceGitRequestSchema,
  skillImportSourceResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { LocalInstanceError } from "../features/local-instance/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import { parseGitSkillSource } from "../features/skills/import-source-git.js";
import {
  normalizeUploadFileName,
  type SkillImportSourceStager,
} from "../features/skills/import-source-staging.js";
import { SkillImportSourceError } from "../features/skills/import-source-support.js";
import { isZodError } from "./zod-error.js";

/**
 * 技能导入来源的 HTTP 面：git 地址暂存、zip 上传暂存、释放暂存。
 *
 * 用户点「导入」后先把来源内容收进本机临时目录，扫描与导入都在暂存目录里进行。
 * 上传走 multipart（JSON 装不下 zip 包）；git 地址走 JSON。
 */
export async function registerSkillImportSourceRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    localInstance: LocalInstanceService;
    settings: Pick<SettingsService, "getInstanceSettings">;
    stagedSources: SkillImportSourceStager;
    /** 网络安全裁决（设置 → 权限 → 网络安全）：git 地址与网页抓取同一套规则。 */
    checkUrlPolicy?:
      | ((
          url: string,
        ) => { decision: "allow" | "deny"; reason?: string } | undefined)
      | undefined;
    /** git 可执行文件；缺省用 PATH 上的 git。 */
    gitBinary: string;
  },
) {
  const sendUnauthenticated = (reply: FastifyReply) =>
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: { code: "unauthorized", message: "需要本机接入凭据。" },
      }),
    );

  const sendSourceError = (
    reply: FastifyReply,
    error: SkillImportSourceError,
  ) =>
    reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: "skill_import_source_failed", message: error.message },
      }),
    );

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<LocalActor | null> {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) {
      sendUnauthenticated(reply);
      return null;
    }
    try {
      await options.localInstance.resolve(actor);
    } catch (error) {
      if (!(error instanceof LocalInstanceError)) throw error;
      reply.code(error.statusCode).send(
        applicationErrorResponseSchema.parse({
          error: { code: error.code, message: error.message },
        }),
      );
      return null;
    }
    return actor;
  }

  /** 每次现读治理值：用户改了设置后下一次导入立刻用新预算。 */
  const limitsFor = async (actor: LocalActor) => {
    const settings = await options.settings.getInstanceSettings(
      actor,
      actor.instanceId,
    );
    return {
      timeoutMs: settings.skillImportSourceTimeoutMs,
      maxBytes: settings.skillImportSourceMaxBytes,
      maxEntries: settings.skillImportSourceMaxEntries,
    };
  };

  app.post("/api/skills/import-sources/git", async (request, reply) => {
    try {
      const actor = await authenticate(request, reply);
      if (!actor) return reply;
      const { url } = skillImportSourceGitRequestSchema.parse(request.body);
      const source = parseGitSkillSource(url);
      const verdict = options.checkUrlPolicy?.(source.url);
      if (verdict?.decision === "deny") {
        return reply.code(403).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_import_source_denied",
              message:
                verdict.reason ??
                "仓库地址被网络安全规则拒绝，请到「设置 → 权限 → 网络安全」调整。",
            },
          }),
        );
      }
      const staged = await options.stagedSources.stageGit({
        instanceId: actor.instanceId,
        url: source.url,
        binary: options.gitBinary,
        limits: await limitsFor(actor),
      });
      request.log.info(
        { sourceId: staged.id, kind: staged.kind },
        "技能导入来源已暂存",
      );
      return reply.code(201).send(
        skillImportSourceResponseSchema.parse({
          source: { id: staged.id, kind: staged.kind, label: staged.label },
        }),
      );
    } catch (error) {
      return sendSourceFailure(request, reply, error);
    }
  });

  app.post("/api/skills/import-sources/zip", async (request, reply) => {
    try {
      const actor = await authenticate(request, reply);
      if (!actor) return reply;
      const limits = await limitsFor(actor);
      // 上传体积按同一预算放行；解压后的实际字节另由解压步骤计数
      const file = await request.file({
        limits: { fileSize: limits.maxBytes, files: 1, parts: 5 },
      });
      if (!file) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_import_source_failed",
              message: "缺少压缩包（期望 multipart 的 file 字段）。",
            },
          }),
        );
      }
      if (file.mimetype && !/zip|x-zip|x-compressed/u.test(file.mimetype)) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_import_source_failed",
              message: "只支持 ZIP 压缩包。",
            },
          }),
        );
      }
      // busboy 在超出体积上限时对文件流发出 limit：转成可读 413，
      // 不让截断的半截包流入暂存（截断流不报错、只会解出坏包）。
      const uploadTooLarge = () =>
        new SkillImportSourceError(
          `压缩包超过 ${Math.round(limits.maxBytes / 1_048_576)} MB 上限，请在实例设置里调大或换一个更小的包。`,
          413,
        );
      file.file.once("limit", () => file.file.destroy(uploadTooLarge()));
      const staged = await options.stagedSources.stageZip({
        instanceId: actor.instanceId,
        fileName: normalizeUploadFileName(file.filename),
        stream: file.file,
        limits,
      });
      // limit 事件也可能在监听挂上之前就已发出（请求体一次性到达时）：
      // 暂存完成后核对截断标志，超限就撤掉这次暂存。
      if (file.file.truncated) {
        await options.stagedSources.release(actor.instanceId, staged.id);
        request.log.warn(
          { fileName: file.filename },
          "技能导入压缩包超过上传上限",
        );
        return reply.code(413).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_import_source_failed",
              message: uploadTooLarge().message,
            },
          }),
        );
      }
      request.log.info(
        { sourceId: staged.id, kind: staged.kind },
        "技能导入来源已暂存",
      );
      return reply.code(201).send(
        skillImportSourceResponseSchema.parse({
          source: { id: staged.id, kind: staged.kind, label: staged.label },
        }),
      );
    } catch (error) {
      return sendSourceFailure(request, reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/skills/import-sources/:id",
    async (request, reply) => {
      const actor = await authenticate(request, reply);
      if (!actor) return reply;
      const released = await options.stagedSources.release(
        actor.instanceId,
        request.params.id,
      );
      if (!released) {
        return reply.code(404).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "skill_import_source_not_found",
              message: "暂存来源不存在或已释放。",
            },
          }),
        );
      }
      return reply.code(204).send();
    },
  );

  function sendSourceFailure(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
  ) {
    if (isZodError(error)) {
      return reply.code(400).send({
        issues: (error as { issues: unknown[] }).issues,
        message: "请求内容无效",
      });
    }
    if (error instanceof SkillImportSourceError) {
      request.log.warn({ message: error.message }, "技能导入来源准备失败");
      return sendSourceError(reply, error);
    }
    const framework = error as { code?: unknown; statusCode?: unknown };
    if (framework.code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "skill_import_source_failed",
            message: "压缩包超过上传上限，请在实例设置里调大或换一个更小的包。",
          },
        }),
      );
    }
    if (framework.code === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "skill_import_source_failed",
            message: "请以表单方式上传 ZIP 压缩包。",
          },
        }),
      );
    }
    request.log.error({ err: error }, "技能导入来源准备出错");
    return reply.code(500).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "skill_import_source_failed",
          message: "来源准备失败，请稍后重试。",
        },
      }),
    );
  }
}
