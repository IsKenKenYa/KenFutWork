import {
  applicationErrorResponseSchema,
  assetSignedUrlResponseSchema,
  unauthenticatedErrorResponseSchema,
  uploadResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { LocalInstanceError } from "../features/local-instance/service.js";
import type { LocalInstanceService } from "../features/local-instance/types.js";
import {
  type UploadService,
  UploadServiceError,
} from "../features/uploads/upload-service.js";

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

export async function registerUploadRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    uploadService: UploadService;
    localInstance: LocalInstanceService;
  },
) {
  // Upload a file
  app.post("/api/uploads", async (request, reply) => {
    try {
      const user = await options.localAccess.authenticate(request);
      if (!user) return sendUnauthorized(reply);

      const file = await request.file();
      if (!file) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "upload_failed",
              message: "No file provided.",
            },
          }),
        );
      }

      const mimeType = file.mimetype;
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "upload_failed",
              message: `Unsupported file type: ${mimeType}. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`,
            },
          }),
        );
      }

      const fileBuffer = await file.toBuffer();

      // 核验本地实例；实例 id 由 uploadService 内部自行解析，不从请求传入。
      await options.localInstance.resolve(user);

      // Extract projectId from fields if provided
      const projectId =
        typeof file.fields.projectId === "object" &&
        file.fields.projectId !== null &&
        "value" in file.fields.projectId
          ? String(file.fields.projectId.value)
          : undefined;

      const result = await options.uploadService.uploadFile(user, {
        bucket: "project-assets",
        fileName: file.filename,
        fileBuffer,
        mimeType,
        ...(projectId ? { projectId } : {}),
      });

      return reply.code(201).send(uploadResponseSchema.parse(result));
    } catch (error) {
      return sendUploadError(error, reply);
    }
  });

  // Get signed URL for an asset
  app.get<{ Params: { assetId: string } }>(
    "/api/uploads/:assetId/url",
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        const url = await options.uploadService.getAssetUrl(
          user,
          request.params.assetId,
        );

        return reply
          .code(200)
          .send(assetSignedUrlResponseSchema.parse({ url }));
      } catch (error) {
        return sendUploadError(error, reply);
      }
    },
  );

  // Delete an asset
  app.delete<{ Params: { assetId: string } }>(
    "/api/uploads/:assetId",
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);

        await options.uploadService.deleteAsset(user, request.params.assetId);

        return reply.code(200).send({ ok: true });
      } catch (error) {
        return sendUploadError(error, reply);
      }
    },
  );
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "缺少或无效的本机接入凭据。",
      },
    }),
  );
}

function sendUploadError(error: unknown, reply: FastifyReply) {
  if (
    error instanceof UploadServiceError ||
    error instanceof LocalInstanceError
  ) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: error.code,
          message: error.message,
        },
      }),
    );
  }

  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: "Internal server error.",
      },
    }),
  );
}
