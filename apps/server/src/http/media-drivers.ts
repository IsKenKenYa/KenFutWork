import {
  AGENT_GOVERNANCE_LIMITS,
  applicationErrorResponseSchema,
  mediaDriverEnabledRequestSchema,
  mediaDriverIdParamsSchema,
  mediaDriverInstallRequestSchema,
  mediaDriverInstallResponseSchema,
  mediaDriverPreviewRequestSchema,
  mediaDriverPreviewResponseSchema,
  mediaDriverRemoveResponseSchema,
  mediaDriverRevisionRequestSchema,
  mediaDriverSourceResponseSchema,
  mediaDriverUpdateRequestSchema,
  mediaDriverVersionListResponseSchema,
  mediaDriverVersionParamsSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import {
  isMediaDriverStorageFailure,
  MediaDriverRegistryError,
} from "../features/media-drivers/errors.js";
import { MediaDriverFileError } from "../features/media-drivers/preview.js";
import type { MediaDriverService } from "../features/media-drivers/service.js";
import { isZodError } from "./zod-error.js";

export async function registerMediaDriverRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: LocalAccessVerifier;
    mediaDrivers: MediaDriverService;
  },
) {
  const guarded =
    (
      status: number,
      operation: (
        actor: LocalActor,
        request: FastifyRequest,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await deps.localAccess.authenticate(request);
      if (!actor)
        return reply.code(401).send({
          error: { code: "unauthorized", message: "请重新连接本机实例" },
        });
      try {
        return reply.code(status).send(await operation(actor, request));
      } catch (error) {
        if (
          error instanceof MediaDriverFileError ||
          error instanceof MediaDriverRegistryError
        )
          return reply.code(error.statusCode).send(
            applicationErrorResponseSchema.parse({
              error: { code: error.code, message: error.message },
            }),
          );
        if (isZodError(error))
          return reply.code(400).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "invalid_request",
                message: "请检查供应商请求字段",
              },
            }),
          );
        if (isMediaDriverStorageFailure(error))
          return reply.code(503).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "media_driver_storage_error",
                message: "供应商文件处理失败，请检查应用数据目录",
              },
            }),
          );
        throw error;
      }
    };
  // JSON 转义最多将每字节编码为六字符；文件预算仍由运行期设置检查。
  const fileOptions = {
    bodyLimit: AGENT_GOVERNANCE_LIMITS.mediaDriverMaxSourceBytes.max * 6,
  };
  app.post(
    "/api/media-drivers/preview",
    fileOptions,
    guarded(200, async (actor, request) => {
      const input = mediaDriverPreviewRequestSchema.parse(request.body);
      const { compiledCode: _compiledCode, ...preview } =
        await deps.mediaDrivers.preview(actor, input.source);
      return mediaDriverPreviewResponseSchema.parse(preview);
    }),
  );
  app.post(
    "/api/media-drivers",
    fileOptions,
    guarded(201, async (actor, request) =>
      mediaDriverInstallResponseSchema.parse(
        await deps.mediaDrivers.install(
          actor,
          mediaDriverInstallRequestSchema.parse(request.body),
        ),
      ),
    ),
  );
  app.get(
    "/api/media-drivers/:driverId/versions",
    guarded(200, async (actor, request) => {
      const { driverId } = mediaDriverIdParamsSchema.parse(request.params);
      return mediaDriverVersionListResponseSchema.parse(
        await deps.mediaDrivers.versions(actor, driverId),
      );
    }),
  );
  app.post(
    "/api/media-drivers/:driverId/versions",
    fileOptions,
    guarded(201, async (actor, request) => {
      const { driverId } = mediaDriverIdParamsSchema.parse(request.params);
      return mediaDriverInstallResponseSchema.parse(
        await deps.mediaDrivers.update(
          actor,
          driverId,
          mediaDriverUpdateRequestSchema.parse(request.body),
        ),
      );
    }),
  );
  app.patch(
    "/api/media-drivers/:driverId",
    guarded(200, async (actor, request) => {
      const { driverId } = mediaDriverIdParamsSchema.parse(request.params);
      return mediaDriverInstallResponseSchema.parse(
        await deps.mediaDrivers.setEnabled(
          actor,
          driverId,
          mediaDriverEnabledRequestSchema.parse(request.body),
        ),
      );
    }),
  );
  app.delete(
    "/api/media-drivers/:driverId",
    guarded(200, async (actor, request) => {
      const { driverId } = mediaDriverIdParamsSchema.parse(request.params);
      return mediaDriverRemoveResponseSchema.parse(
        await deps.mediaDrivers.remove(
          actor,
          driverId,
          mediaDriverRevisionRequestSchema.parse(request.body),
        ),
      );
    }),
  );
  app.get(
    "/api/media-drivers/:driverId/versions/:versionId/source",
    guarded(200, async (actor, request) => {
      const { driverId, versionId } = mediaDriverVersionParamsSchema.parse(
        request.params,
      );
      return mediaDriverSourceResponseSchema.parse(
        await deps.mediaDrivers.source(actor, driverId, versionId),
      );
    }),
  );
}
