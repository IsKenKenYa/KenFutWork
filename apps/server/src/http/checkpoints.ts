import {
  applicationErrorResponseSchema,
  checkpointDiffResponseSchema,
  checkpointFilesResponseSchema,
  checkpointListQuerySchema,
  checkpointListResponseSchema,
  checkpointPreviewResponseSchema,
  checkpointRestoreFileRequestSchema,
  checkpointRestoreRequestSchema,
  checkpointRestoreResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type CheckpointService,
  CodeCheckpointError,
} from "../features/checkpoints/checkpoint-service.js";
import {
  ExecutionScopeError,
  type ExecutionScopes,
} from "../features/execution/scope-service.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";

/** 所有 Code 检查点调用先打开真实 Task 句柄，再校验检查点属于该 Task。 */
export async function registerCheckpointsRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    executionScopes: Pick<ExecutionScopes, "openTask">;
    checkpointsService: CheckpointService;
  },
) {
  type Query = { taskId?: string; path?: string; rootDirectory?: string };
  type Params = { checkpointId: string };
  const context = async (
    request: Parameters<LocalAccessVerifier["authenticate"]>[0],
    query: Query,
    reply: FastifyReply,
  ) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) {
      reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
      return null;
    }
    const parsed = checkpointListQuerySchema.safeParse(query);
    if (!parsed.success) {
      invalid(reply, "缺少 Task ID。");
      return null;
    }
    return {
      actor,
      scope: await options.executionScopes.openTask(actor, parsed.data.taskId),
    };
  };
  app.get<{ Querystring: Query }>(
    "/api/code/checkpoints",
    async (request, reply) => {
      try {
        const input = await context(request, request.query, reply);
        if (!input) return;
        return reply.send(
          checkpointListResponseSchema.parse({
            checkpoints: await options.checkpointsService.list(input),
          }),
        );
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );
  app.get<{ Querystring: Query; Params: Params }>(
    "/api/code/checkpoints/:checkpointId/diff",
    async (request, reply) => {
      try {
        const input = await context(request, request.query, reply);
        if (!input) return;
        const result = await options.checkpointsService.diffFor({
          ...input,
          checkpointId: request.params.checkpointId,
          ...(request.query.path ? { path: request.query.path } : {}),
          ...(request.query.rootDirectory
            ? { rootDirectory: request.query.rootDirectory }
            : {}),
        });
        return reply.send(
          checkpointDiffResponseSchema.parse({
            diff: result.text,
            files: result.files,
          }),
        );
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );
  app.get<{ Querystring: Query; Params: Params }>(
    "/api/code/checkpoints/:checkpointId/files",
    async (request, reply) => {
      try {
        const input = await context(request, request.query, reply);
        if (!input) return;
        return reply.send(
          checkpointFilesResponseSchema.parse(
            await options.checkpointsService.turnFiles({
              ...input,
              checkpointId: request.params.checkpointId,
            }),
          ),
        );
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );
  app.post<{ Querystring: Query; Params: Params }>(
    "/api/code/checkpoints/:checkpointId/preview",
    async (request, reply) => {
      try {
        const input = await context(request, request.query, reply);
        if (!input) return;
        return reply.send(
          checkpointPreviewResponseSchema.parse(
            await options.checkpointsService.previewRestore({
              ...input,
              checkpointId: request.params.checkpointId,
              ...(request.query.path ? { path: request.query.path } : {}),
              ...(request.query.rootDirectory
                ? { rootDirectory: request.query.rootDirectory }
                : {}),
            }),
          ),
        );
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );
  app.post<{ Querystring: Query; Params: Params }>(
    "/api/code/checkpoints/:checkpointId/restore",
    async (request, reply) => {
      try {
        const input = await context(request, request.query, reply);
        if (!input) return;
        const parsed = checkpointRestoreRequestSchema.safeParse(request.body);
        if (!parsed.success) return invalid(reply, "恢复必须提供预览版本。");
        const checkpoint = await options.checkpointsService.restore({
          ...input,
          checkpointId: request.params.checkpointId,
          ...parsed.data,
        });
        return reply.send(
          checkpointRestoreResponseSchema.parse({ checkpoint }),
        );
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );
  app.post<{ Querystring: Query; Params: Params }>(
    "/api/code/checkpoints/:checkpointId/restore-file",
    async (request, reply) => {
      try {
        const input = await context(request, request.query, reply);
        if (!input) return;
        const parsed = checkpointRestoreFileRequestSchema.safeParse(
          request.body,
        );
        if (!parsed.success)
          return invalid(reply, "撤销必须提供文件路径与预览版本。");
        const checkpoint = await options.checkpointsService.restoreFile({
          ...input,
          checkpointId: request.params.checkpointId,
          ...parsed.data,
        });
        return reply.send(
          checkpointRestoreResponseSchema.parse({ checkpoint }),
        );
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );
}
function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send(
    applicationErrorResponseSchema.parse({
      error: { code: "invalid_input", message },
    }),
  );
}
function sendCheckpointError(error: unknown, reply: FastifyReply) {
  if (
    error instanceof CodeCheckpointError ||
    error instanceof ExecutionScopeError
  ) {
    const code =
      error instanceof ExecutionScopeError
        ? "checkpoint_failed"
        : error.code === "not_found"
          ? "checkpoint_not_found"
          : error.code;
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code, message: error.message },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
}
