import {
  applicationErrorResponseSchema,
  executionModeSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance } from "fastify";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";

export async function registerExecutionModeRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    viewer?: ViewerService;
    agentModes: ExecutionModeService;
  },
) {
  // GET /api/execution-modes — 模式词汇表（DEC-3：六档）
  app.get("/api/execution-modes", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }
    return reply.code(200).send({ modes: options.agentModes.listModes() });
  });

  // GET /api/execution-modes/:threadId — 当前线程激活模式（缓存 miss 时读回持久化值）
  app.get("/api/execution-modes/:threadId", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }
    const { threadId } = request.params as { threadId: string };
    try {
      const workspace = options.viewer
        ? await options.viewer.resolveWorkspace(user)
        : null;
      const mode = workspace
        ? await options.agentModes.hydrate(threadId, {
            workspaceId: workspace.id,
          })
        : options.agentModes.getMode(threadId);
      return reply.code(200).send({ mode: executionModeSchema.parse(mode) });
    } catch {
      return reply.code(500).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "internal_error",
            message: "Failed to load execution mode.",
          },
        }),
      );
    }
  });

  // PUT /api/execution-modes/:threadId — 激活/切换（会话级，DEC-2；写穿持久化）
  app.put("/api/execution-modes/:threadId", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }
    const { threadId } = request.params as { threadId: string };
    try {
      const mode = executionModeSchema.parse(
        (request.body as { mode?: unknown }).mode,
      );
      // 归属校验：threadId 属于本用户工作区的会话才允许改（此前内存版无此校验）
      const workspace = options.viewer
        ? await options.viewer.resolveWorkspace(user)
        : null;
      if (options.viewer && !workspace) {
        return reply.code(404).send(
          applicationErrorResponseSchema.parse({
            error: { code: "not_found", message: "Workspace not found." },
          }),
        );
      }
      if (workspace) {
        const lookup = await options.agentModes.lookup(threadId, {
          workspaceId: workspace.id,
        });
        if (!lookup.exists) {
          return reply.code(404).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "not_found",
                message: "Thread not found in this workspace.",
              },
            }),
          );
        }
      }
      await options.agentModes.activate(
        threadId,
        mode,
        workspace ? { workspaceId: workspace.id } : undefined,
      );
      return reply.code(200).send({ mode });
    } catch (error) {
      // 别把「服务端异常」说成「模式非法」：此前 catch-all 一律回 Invalid mode.，
      // 排查时完全看不出真实原因（画布面板传会话 id 时就是这样被误导的）。
      request.log.error(
        { threadId, err: error },
        "execution-mode.activate FAILED",
      );
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "切换执行模式失败（模式非法或会话不存在）。",
          },
        }),
      );
    }
  });
}
