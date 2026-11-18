import {
  canvasAssetMoveRequestSchema,
  canvasAssetParamsSchema,
  canvasAssetRestoreReceiptSchema,
  canvasAssetRevisionRequestSchema,
  projectFileLocationSchema,
  projectFileMoveRequestSchema,
  projectFileParamsSchema,
  projectFileRelinkRequestSchema,
} from "@kenfutwork/shared";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";
import type { CanvasAssetLocations } from "../features/canvas/asset-locations.js";
import { CanvasFileStoreError } from "../features/canvas/file-store.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import {
  ProjectFileError,
  type ProjectFileService,
} from "../features/project-files/types.js";
import { isZodError } from "./zod-error.js";

export async function registerProjectFileRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: LocalAccessVerifier;
    projectFiles: ProjectFileService;
    canvasAssets: CanvasAssetLocations;
  },
) {
  const handler =
    (
      action: (
        actor: LocalActor,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ): RouteHandlerMethod =>
    async (request, reply) => {
      const actor = await deps.localAccess.authenticate(request);
      if (!actor)
        return reply.code(401).send({
          error: {
            code: "unauthenticated",
            message: "请从桌面重新建立本机连接",
          },
        });
      try {
        return await action(actor, request, reply);
      } catch (error) {
        if (
          error instanceof ProjectFileError ||
          error instanceof CanvasFileStoreError
        )
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        if (isZodError(error))
          return reply.code(400).send({
            error: {
              code: "invalid_file_request",
              message: "素材操作参数无效",
            },
          });
        throw error;
      }
    };
  app.get(
    "/api/project-files/:assetId",
    handler(async (actor, request) => {
      const { assetId } = projectFileParamsSchema.parse(request.params);
      return projectFileLocationSchema.parse(
        await deps.projectFiles.inspect(actor, assetId),
      );
    }),
  );
  app.post(
    "/api/project-files/:assetId/move",
    handler(async (actor, request) => {
      const { assetId } = projectFileParamsSchema.parse(request.params);
      const input = projectFileMoveRequestSchema.parse(request.body);
      await deps.projectFiles.move(actor, assetId, input.relativePath, input);
      return projectFileLocationSchema.parse(
        await deps.projectFiles.inspect(actor, assetId),
      );
    }),
  );
  app.post(
    "/api/project-files/:assetId/relink",
    handler(async (actor, request) => {
      const { assetId } = projectFileParamsSchema.parse(request.params);
      return projectFileLocationSchema.parse(
        await deps.projectFiles.relink(
          actor,
          assetId,
          projectFileRelinkRequestSchema.parse(request.body),
        ),
      );
    }),
  );
  app.post(
    "/api/canvases/:canvasId/assets/:assetId/move",
    handler(async (actor, request) => {
      const { canvasId } = canvasAssetParamsSchema.parse(request.params);
      const { assetId } = projectFileParamsSchema.parse(request.params);
      return projectFileLocationSchema.parse(
        await deps.canvasAssets.move(
          actor,
          canvasId,
          assetId,
          canvasAssetMoveRequestSchema.parse(request.body),
        ),
      );
    }),
  );
  app.post(
    "/api/canvases/:canvasId/export",
    handler(async (actor, request, reply) => {
      const { canvasId } = canvasAssetParamsSchema.parse(request.params);
      const { expectedRevision } = canvasAssetRevisionRequestSchema.parse(
        request.body,
      );
      const result = await deps.canvasAssets.export(
        actor,
        canvasId,
        expectedRevision,
      );
      return reply
        .type("application/x-tar")
        .header(
          "content-disposition",
          `attachment; filename="${result.filename}"`,
        )
        .header("etag", result.revision)
        .send(Buffer.from(result.bytes));
    }),
  );
  app.post(
    "/api/canvases/:canvasId/restore-assets",
    handler(async (actor, request) => {
      const { canvasId } = canvasAssetParamsSchema.parse(request.params);
      const { expectedRevision } = canvasAssetRevisionRequestSchema.parse(
        request.body,
      );
      return canvasAssetRestoreReceiptSchema.parse(
        await deps.canvasAssets.restoreReferences(
          actor,
          canvasId,
          expectedRevision,
        ),
      );
    }),
  );
}
