import {
  applicationErrorResponseSchema,
  runCancelResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { AgentRunService } from "../agent/runtime.js";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import { isPlanApprovalInput } from "../features/agent-modes/execution-mode-service.js";
import {
  type AgentRunMetadataService,
  AgentRunPersistenceError,
} from "../features/agent-runs/agent-run-service.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ChatService } from "../features/chat/chat-service.js";
import { deriveSessionTitle } from "../features/chat/session-title.js";
import {
  type ThreadService,
  ThreadServiceError,
} from "../features/chat/thread-service.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { parseInstanceSpecifier } from "../features/model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { SettingsService } from "../features/settings/settings-service.js";

export async function registerRunRoutes(
  app: FastifyInstance,
  agentRuns: AgentRunService,
  options: {
    agentModes?: ExecutionModeService;
    agentRunMetadataService?: AgentRunMetadataService;
    auth?: RequestAuthenticator;
    settingsService?: SettingsService;
    /** Code 模式会话供给（方案 A）：客户端自造 sessionId 时补真实会话行。 */
    chatService?: Pick<ChatService, "ensureCodeSession">;
    threadService?: ThreadService;
    viewerService?: ViewerService;
    /** 平台池额度前置拦截（FORM-10）：只有走系统供应商的运行需要余额。 */
    creditService?: CreditService;
    modelProviders?: ModelProviderService;
  } = {},
) {
  app.post("/api/agent/runs", async (request, reply) => {
    try {
      const payload = runCreateRequestSchema.parse(request.body);
      const hasAuthorization = hasBearerAuthorization(
        request.headers.authorization,
      );
      const authenticatedUser =
        hasAuthorization && options?.auth
          ? await options.auth.authenticate(request)
          : null;

      if (hasAuthorization && !authenticatedUser) {
        return sendUnauthorized(reply);
      }

      // Code 模式会话供给（方案 A，与 WS 路径同口径）：客户端自造的 sessionId 在库里没有
      // 会话行 → 线程解析失败且助手消息无处落库。此处先按该 id 供给真实会话与线程。
      // Design 模式不供给：其会话由画布页经 API 先建行，缺行属真错误，不该被掩盖。
      if (
        authenticatedUser &&
        options?.chatService &&
        payload.preset !== "design"
      ) {
        try {
          await options.chatService.ensureCodeSession(authenticatedUser, {
            sessionId: payload.sessionId,
            // 与 WS 路径同口径：先剥 prompt 首部指令块再派生标题
            title: deriveSessionTitle(payload.prompt),
          });
        } catch {
          // 供给失败不阻断启动：下面仍按原路径解析（拿不到就照旧不带线程）
        }
      }

      const sessionThread =
        authenticatedUser && options?.threadService
          ? await options.threadService.resolveOwnedSessionThread(
              authenticatedUser,
              payload.sessionId,
            )
          : null;

      // Resolve per-workspace model if auth context is available
      let model: string | undefined;
      if (
        authenticatedUser &&
        options.settingsService &&
        options.viewerService
      ) {
        try {
          const viewer =
            await options.viewerService.ensureViewer(authenticatedUser);
          const settings = await options.settingsService.getWorkspaceSettings(
            authenticatedUser,
            viewer.workspace.id,
          );
          model = settings.defaultModel;
        } catch {
          // Fall through to server default model if settings lookup fails
        }
      }

      // 平台池额度前置拦截（FORM-10）：走系统供应商（scope='system'）的运行
      // 先查余额；余额耗尽直接 402，不让 run 起跑后才在结算处失败。
      // 自带 Key（BYOK）不受此限——用户自带凭证不计费。
      const effectiveModel = payload.model ?? model;
      if (
        authenticatedUser &&
        effectiveModel &&
        options.modelProviders &&
        options.creditService &&
        options.viewerService
      ) {
        const specifier = parseInstanceSpecifier(effectiveModel);
        if (specifier) {
          try {
            const scope = await options.modelProviders.getInstanceScope(
              specifier.instanceId,
            );
            if (scope === "system") {
              const viewer =
                await options.viewerService.ensureViewer(authenticatedUser);
              const { balance } = await options.creditService.getBalance(
                viewer.workspace.id,
              );
              if (balance <= 0) {
                return reply.code(402).send(
                  applicationErrorResponseSchema.parse({
                    error: {
                      code: "insufficient_credits",
                      message:
                        "平台额度已用完，请联系管理员充值或改用自己的供应商 Key。",
                    },
                  }),
                );
              }
            }
          } catch {
            // 额度查询失败不阻断启动（结算侧仍有兜底），避免误伤正常使用
          }
        }
      }

      // 执行模式（DEC-3）：载荷声明 → 按真实 threadId 激活并写穿持久化；
      // 未声明 → 读回线程持久化模式（与 WS 路径同口径，重启后仍按线程模式走）。
      // plan 批准门（机器可读）：与 WS 路径同口径，批准短语本条消息起按 agent 执行。
      if (sessionThread && options.agentModes) {
        const workspace =
          authenticatedUser && options.viewerService
            ? await options.viewerService
                .resolveWorkspace(authenticatedUser)
                .catch(() => null)
            : null;
        const modeScope = workspace ? { workspaceId: workspace.id } : undefined;
        let effectiveMode = payload.executionMode;
        if (effectiveMode === "plan" && isPlanApprovalInput(payload.prompt)) {
          effectiveMode = "agent";
        }
        try {
          if (effectiveMode) {
            await options.agentModes.activate(
              sessionThread.threadId,
              effectiveMode,
              modeScope,
            );
          } else if (modeScope) {
            await options.agentModes.hydrate(sessionThread.threadId, modeScope);
          }
        } catch {
          // 持久化失败不阻断启动：内存激活/默认 agent 兜底（载荷模式已过 zod 枚举）
        }
      }

      const response = runCreateResponseSchema.parse(
        agentRuns.createRun(payload, {
          ...(authenticatedUser
            ? {
                accessToken: authenticatedUser.accessToken,
                userId: authenticatedUser.id,
              }
            : {}),
          ...(model ? { model } : {}),
          ...(sessionThread ? { threadId: sessionThread.threadId } : {}),
        }),
      );

      if (sessionThread && options.agentRunMetadataService) {
        await options.agentRunMetadataService.createAcceptedRun({
          ...(model ? { model } : {}),
          runId: response.runId,
          sessionId: payload.sessionId,
          threadId: sessionThread.threadId,
        });
      }

      return reply.code(202).send(response);
    } catch (error) {
      if (error instanceof ThreadServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: error.code,
              message: error.message,
            },
          }),
        );
      }

      if (error instanceof AgentRunPersistenceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: error.code,
              message: error.message,
            },
          }),
        );
      }

      return handleZodError(error, reply);
    }
  });

  app.post("/api/agent/runs/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const canceledRun = agentRuns.cancelRun(runId);

    if (!canceledRun) {
      return reply.code(404).send({
        message: `Run not found: ${runId}`,
      });
    }

    const response = runCancelResponseSchema.parse(canceledRun);
    return reply.code(202).send(response);
  });
}

function hasBearerAuthorization(
  authorizationHeader: string | string[] | undefined,
) {
  return typeof authorizationHeader === "string"
    ? authorizationHeader.trim().toLowerCase().startsWith("bearer ")
    : false;
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

function handleZodError(error: unknown, reply: FastifyReply) {
  if (isZodError(error)) {
    return reply.code(400).send({
      issues: error.issues,
      message: "Invalid request body",
    });
  }

  throw error;
}

function isZodError(
  error: unknown,
): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
