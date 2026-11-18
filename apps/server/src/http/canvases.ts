import {
  applicationErrorResponseSchema,
  canvasCreateRequestSchema,
  canvasCreateResponseSchema,
  canvasDeleteRequestSchema,
  canvasDeleteResponseSchema,
  canvasGetResponseSchema,
  canvasListRequestSchema,
  canvasListResponseSchema,
  canvasRenameRequestSchema,
  canvasSaveRequestSchema,
  canvasSaveResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type CanvasService,
  CanvasServiceError,
} from "../features/canvas/canvas-service.js";
import { CanvasFileStoreError } from "../features/canvas/file-store.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { LocalInstanceError } from "../features/local-instance/service.js";
import { ProjectFileError } from "../features/project-files/types.js";
import { ProjectServiceError } from "../features/projects/project-service.js";
import { isZodError } from "./zod-error.js";

export async function registerCanvasRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    canvasService: CanvasService;
  },
) {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/canvases",
    async (request, reply) => {
      try {
        const actor = await options.localAccess.authenticate(request);
        if (!actor) return sendUnauthorized(reply);
        const { query } = canvasListRequestSchema.parse(request.query);
        const canvases = await options.canvasService.listCanvases(
          actor,
          request.params.projectId,
          query,
        );
        return reply.send(canvasListResponseSchema.parse({ canvases }));
      } catch (error) {
        return sendCanvasError(error, reply);
      }
    },
  );
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/canvases",
    async (request, reply) => {
      try {
        const actor = await options.localAccess.authenticate(request);
        if (!actor) return sendUnauthorized(reply);
        const input = canvasCreateRequestSchema.parse(request.body);
        const canvas = await options.canvasService.createCanvas(
          actor,
          request.params.projectId,
          input,
        );
        return reply
          .code(201)
          .send(canvasCreateResponseSchema.parse({ canvas }));
      } catch (error) {
        return sendCanvasError(error, reply);
      }
    },
  );
  app.patch<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    async (request, reply) => {
      try {
        const actor = await options.localAccess.authenticate(request);
        if (!actor) return sendUnauthorized(reply);
        const input = canvasRenameRequestSchema.parse(request.body);
        const canvas = await options.canvasService.renameCanvas(
          actor,
          request.params.canvasId,
          input,
        );
        return reply.send(canvasGetResponseSchema.parse({ canvas }));
      } catch (error) {
        return sendCanvasError(error, reply);
      }
    },
  );
  app.delete<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    async (request, reply) => {
      try {
        const actor = await options.localAccess.authenticate(request);
        if (!actor) return sendUnauthorized(reply);
        const input = canvasDeleteRequestSchema.parse(request.body);
        await options.canvasService.deleteCanvas(
          actor,
          request.params.canvasId,
          input.expectedRevision,
        );
        return reply.send(canvasDeleteResponseSchema.parse({ ok: true }));
      } catch (error) {
        return sendCanvasError(error, reply);
      }
    },
  );
  app.get<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const canvas = await options.canvasService.getCanvas(
          user,
          request.params.canvasId,
        );
        return reply.code(200).send(canvasGetResponseSchema.parse({ canvas }));
      } catch (error) {
        return sendCanvasError(error, reply);
      }
    },
  );

  app.put<{ Params: { canvasId: string } }>(
    "/api/canvases/:canvasId",
    { bodyLimit: 50 * 1024 * 1024 }, // 50 MB — canvas content includes base64 image data
    async (request, reply) => {
      try {
        const user = await options.localAccess.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const payload = canvasSaveRequestSchema.parse(request.body);
        const saved = await options.canvasService.saveCanvasContent(
          user,
          request.params.canvasId,
          payload.content,
          payload.expectedRevision,
        );
        const bodySize = JSON.stringify(request.body).length;
        request.log.info(
          { canvasId: request.params.canvasId, bodyBytes: bodySize },
          "canvas.save OK",
        );
        return reply
          .code(200)
          .send(canvasSaveResponseSchema.parse({ ok: true, ...saved }));
      } catch (error) {
        request.log.error(
          { canvasId: request.params.canvasId, err: error },
          "canvas.save FAILED",
        );
        return sendCanvasError(error, reply);
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

function sendCanvasError(error: unknown, reply: FastifyReply) {
  if (error instanceof ProjectFileError) {
    const code =
      error.code === "file_missing" || error.code === "not_found"
        ? "canvas_file_missing"
        : error.code === "file_conflict"
          ? "canvas_revision_conflict"
          : "canvas_save_failed";
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code, message: error.message },
      }),
    );
  }
  if (error instanceof CanvasFileStoreError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: {
          code:
            error.code === "revision_conflict"
              ? "canvas_revision_conflict"
              : "canvas_save_failed",
          message: error.message,
        },
      }),
    );
  }
  if (
    error instanceof CanvasServiceError ||
    error instanceof LocalInstanceError ||
    error instanceof ProjectServiceError
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

  if (isZodError(error)) {
    return reply.code(400).send({
      issues: error.issues,
      message: "Invalid request body",
    });
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
