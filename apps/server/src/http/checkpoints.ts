import {
  applicationErrorResponseSchema,
  checkpointDiffResponseSchema,
  checkpointFilesResponseSchema,
  checkpointListResponseSchema,
  checkpointPreviewResponseSchema,
  checkpointRestoreFileRequestSchema,
  checkpointRestoreResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgentRunService } from "../agent/runtime.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type CheckpointService,
  CodeCheckpointError,
} from "../features/checkpoints/checkpoint-service.js";

/**
 * Code 模式检查点路由（影子 git）。
 *
 * 鉴权在这里，工作区经 viewer 解析；检查点与画布的归属校验在 service 里
 * （不属当前工作区一律 404，不给枚举信号）。restore 是丢内容操作，若该画布
 * 还有在途 run（accepted/running）则拒绝——恢复会把正在产出的文件冲掉。
 */
export async function registerCheckpointsRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    viewerService: Pick<ViewerService, "resolveWorkspace">;
    checkpointsService: CheckpointService;
    /** 在途守卫（可选依赖）：agent-runs 缺席（部分装配/测试）时 restore 不做运行中拦截。 */
    agentRuns?: Pick<AgentRunService, "hasActiveRunForCanvas">;
  },
) {
  /** 用户 → 工作区 id（解析失败按 404，与 code-git 同一口径）。 */
  const workspaceIdFor = async (user: { id: string }): Promise<string> => {
    const workspace = await options.viewerService
      .resolveWorkspace(user)
      .catch(() => null);
    if (!workspace) {
      throw new CodeCheckpointError("not_found", "工作区不可用。", 404);
    }
    return workspace.id;
  };

  // GET /api/code/checkpoints?canvasId= — 某画布的检查点时间线（升序）
  app.get<{ Querystring: { canvasId?: string } }>(
    "/api/code/checkpoints",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      try {
        const checkpoints = await options.checkpointsService.list({
          workspaceId: await workspaceIdFor(user),
          canvasId,
        });
        return reply
          .code(200)
          .send(checkpointListResponseSchema.parse({ checkpoints }));
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );

  // GET /api/code/checkpoints/:checkpointId/diff?path= — 相对上一检查点的统一 diff
  app.get<{ Querystring: { path?: string }; Params: { checkpointId: string } }>(
    "/api/code/checkpoints/:checkpointId/diff",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      try {
        const result = await options.checkpointsService.diffFor({
          workspaceId: await workspaceIdFor(user),
          checkpointId: request.params.checkpointId,
          ...(request.query.path ? { path: request.query.path } : {}),
        });
        return reply.code(200).send(
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

  // POST /api/code/checkpoints/:checkpointId/preview — 恢复预览（受影响清单）
  app.post<{ Params: { checkpointId: string } }>(
    "/api/code/checkpoints/:checkpointId/preview",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      try {
        const preview = await options.checkpointsService.previewRestore({
          workspaceId: await workspaceIdFor(user),
          checkpointId: request.params.checkpointId,
        });
        return reply
          .code(200)
          .send(checkpointPreviewResponseSchema.parse(preview));
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );

  // POST /api/code/checkpoints/:checkpointId/restore?canvasId= — 回滚（丢内容操作）
  app.post<{
    Querystring: { canvasId?: string };
    Params: { checkpointId: string };
  }>("/api/code/checkpoints/:checkpointId/restore", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    const canvasId = request.query.canvasId ?? "";
    if (!canvasId) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: { code: "invalid_input", message: "缺少 canvasId。" },
        }),
      );
    }
    // 在途守卫：run 还在写工作目录时不允许回滚（画布归属在 service 里再兜一层）
    if (options.agentRuns?.hasActiveRunForCanvas(canvasId)) {
      return reply.code(409).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "run_in_progress",
            message: "该项目的任务正在运行，请等本轮结束或先停止再回滚。",
          },
        }),
      );
    }
    try {
      const checkpoint = await options.checkpointsService.restore({
        workspaceId: await workspaceIdFor(user),
        checkpointId: request.params.checkpointId,
      });
      return reply
        .code(200)
        .send(checkpointRestoreResponseSchema.parse({ checkpoint }));
    } catch (error) {
      return sendCheckpointError(error, reply);
    }
  });

  // GET /api/code/checkpoints/:checkpointId/files — 该轮的逐文件变更清单
  app.get<{ Params: { checkpointId: string } }>(
    "/api/code/checkpoints/:checkpointId/files",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      try {
        const result = await options.checkpointsService.turnFiles({
          workspaceId: await workspaceIdFor(user),
          checkpointId: request.params.checkpointId,
        });
        return reply
          .code(200)
          .send(checkpointFilesResponseSchema.parse({ files: result.files }));
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );

  // POST /api/code/checkpoints/:checkpointId/restore-file?canvasId= — 每文件撤销
  app.post<{
    Querystring: { canvasId?: string };
    Params: { checkpointId: string };
  }>(
    "/api/code/checkpoints/:checkpointId/restore-file",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      const parsed = checkpointRestoreFileRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 path。" },
          }),
        );
      }
      // 在途守卫与整目录回滚同款：run 还在写工作目录时不允许撤销
      if (options.agentRuns?.hasActiveRunForCanvas(canvasId)) {
        return reply.code(409).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "run_in_progress",
              message: "该项目的任务正在运行，请等本轮结束或先停止再撤销。",
            },
          }),
        );
      }
      try {
        const checkpoint = await options.checkpointsService.restoreFile({
          workspaceId: await workspaceIdFor(user),
          checkpointId: request.params.checkpointId,
          path: parsed.data.path,
        });
        return reply
          .code(200)
          .send(checkpointRestoreResponseSchema.parse({ checkpoint }));
      } catch (error) {
        return sendCheckpointError(error, reply);
      }
    },
  );
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendCheckpointError(error: unknown, reply: FastifyReply) {
  if (error instanceof CodeCheckpointError) {
    // 服务内部的语义码 not_found 不在错误码枚举里（直接透传会让响应体退化成
    // ZodError 转储，见 applicationErrorCodeSchema 处注释），映射成 feature 专属码
    const code =
      error.code === "not_found" ? "checkpoint_not_found" : error.code;
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code, message: error.message },
      }),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: { code: "application_error", message },
    }),
  );
}
