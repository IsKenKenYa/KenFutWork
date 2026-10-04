import { randomUUID } from "node:crypto";
import {
  agentRunActivityResponseSchema,
  agentSubagentListResponseSchema,
  applicationErrorResponseSchema,
  runCancelResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgentRunService } from "../agent/runtime.js";
import { resolveSandboxScopeId } from "../agent/sandbox-dir.js";
import {
  listSubagentDefinitions,
  SUBAGENT_DISPATCH_TOOLS,
} from "../agent/subagent-definitions.js";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import { isPlanApprovalInput } from "../features/agent-modes/execution-mode-service.js";
import {
  type AgentRunMetadataService,
  AgentRunPersistenceError,
} from "../features/agent-runs/agent-run-service.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  type ThreadService,
  ThreadServiceError,
} from "../features/chat/thread-service.js";
import type { CodeUiService } from "../features/code-ui/service.js";
import type { CreditService } from "../features/credits/credit-service.js";
import {
  ExecutionScopeError,
  type ExecutionScopes,
} from "../features/execution/scope-service.js";
import { parseInstanceSpecifier } from "../features/model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import { isZodError } from "./zod-error.js";

export async function registerRunRoutes(
  app: FastifyInstance,
  agentRuns: AgentRunService,
  options: {
    /** 运行活动查询（Git 弹层的「智能体 N 秒 · M 运行」；口径见仓储 workspaceActivity）。 */
    activityQuery?: (input: {
      workspaceId: string;
    }) => Promise<{ runs: number; totalSeconds: number; windowDays: number }>;
    agentModes?: ExecutionModeService;
    agentRunMetadataService?: AgentRunMetadataService;
    auth?: RequestAuthenticator;
    settingsService?: SettingsService;
    threadService?: ThreadService;
    viewerService?: ViewerService;
    /** 平台池额度前置拦截（FORM-10）：只有走系统供应商的运行需要余额。 */
    creditService?: CreditService;
    modelProviders?: ModelProviderService;
    executionScopes?: ExecutionScopes;
    codeUi?: Pick<CodeUiService, "admitExternalRun">;
  } = {},
) {
  /**
   * GET /api/agent/subagents — 子智能体清单（设置 →「子智能体」）。
   *
   * 清单由 agent 装配处导出（`agent/sub-agents.ts`），与真跑起来用的是**同一个来源**；
   * 界面因此不会出现「写着有、跑起来没有」。不依赖工作区，登录即可读。
   */
  app.get("/api/agent/subagents", async (request, reply) => {
    if (!options.auth) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message: "认证未装配，无法列出子智能体。",
          },
        }),
      );
    }
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
    return reply.code(200).send(
      agentSubagentListResponseSchema.parse({
        // 子代理清单唯一来源是定义注册表（DEC-16）；派发工具 task/task_background
        // 是我们自己的缝（不再是 deepagents 内置），一并列给界面。
        subagents: listSubagentDefinitions(),
        builtin: SUBAGENT_DISPATCH_TOOLS,
      }),
    );
  });

  // GET /api/agent/runs/activity — 该**工作区**近 7 天的运行次数与累计时长。
  // 范围取工作区而不是会话/画布：客户端任务 id 与服务端会话 id 不保证一致，
  // run 挂的又是会话的载体画布而非项目画布——两条更细的路实测都不可靠（详见仓储注释）。
  // 归属校验：先解析工作区（拿不到就返回全 0——不区分「不存在」与「不属于你」，
  // 与其它只读端点同一口径，不给账号/资源枚举留信号）。
  app.get("/api/agent/runs/activity", async (request, reply) => {
    const authenticatedUser = options.auth
      ? await options.auth.authenticate(request)
      : null;
    if (!authenticatedUser) {
      return reply.code(401).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }
    const workspace = options.viewerService
      ? await options.viewerService
          .resolveWorkspace(authenticatedUser)
          .catch(() => null)
      : null;
    const activity =
      workspace && options.activityQuery
        ? await options.activityQuery({ workspaceId: workspace.id })
        : { runs: 0, totalSeconds: 0, windowDays: 7 };
    return reply
      .code(200)
      .send(agentRunActivityResponseSchema.parse({ activity }));
  });

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
      const sessionThread =
        authenticatedUser && options?.threadService
          ? await options.threadService.resolveOwnedSessionThread(
              authenticatedUser,
              payload.sessionId,
            )
          : null;
      const codeMode =
        sessionThread?.mode === "code" || payload.preset === "code";
      if (
        sessionThread &&
        payload.preset &&
        payload.preset !== sessionThread.mode
      )
        throw new ExecutionScopeError(
          "mode_mismatch",
          "Run 不能改变会话所属模式。",
          409,
        );
      if (payload.projectId && sessionThread?.projectId !== payload.projectId)
        throw new ExecutionScopeError(
          "scope_mismatch",
          "Run 的项目与持久 Task 不一致。",
          409,
        );
      if (
        codeMode &&
        (payload.canvasId ||
          (payload.taskId && payload.taskId !== payload.sessionId))
      )
        throw new ExecutionScopeError(
          "scope_mismatch",
          "Code Run 只能使用所属 Task 工作域，不能传 Canvas 或另一 Task。",
          400,
        );
      const scopeHandle = codeMode
        ? authenticatedUser && options.executionScopes
          ? await options.executionScopes.openTask(
              authenticatedUser,
              payload.sessionId,
            )
          : (() => {
              throw new ExecutionScopeError(
                "scope_unavailable",
                "Code 执行需要已认证的持久 Task 工作域。",
                503,
              );
            })()
        : undefined;

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

      const runId = randomUUID();
      const eventSink = scopeHandle
        ? authenticatedUser && options.codeUi
          ? await options.codeUi.admitExternalRun(
              authenticatedUser,
              scopeHandle,
              runId,
              payload.prompt,
            )
          : (() => {
              throw new ExecutionScopeError(
                "admission_unavailable",
                "Code Task 前台 admission 未装配，不能绕过 Task 并发控制。",
                503,
              );
            })()
        : undefined;
      const response = runCreateResponseSchema.parse(
        agentRuns.createRun(payload, {
          runId,
          ...(eventSink ? { eventSink } : {}),
          ...(scopeHandle ? { scopeHandle } : {}),
          ...(authenticatedUser
            ? {
                accessToken: authenticatedUser.accessToken,
                userId: authenticatedUser.id,
              }
            : {}),
          ...(model ? { model } : {}),
          // 与 WS 路径同口径：客户端只能给会话 UUID 时，沙箱目录名改用会话的真实画布
          ...(() => {
            const sandboxScopeId = scopeHandle
              ? undefined
              : resolveSandboxScopeId({
                  conversationId: payload.conversationId,
                  requestedCanvasId: payload.canvasId ?? payload.conversationId,
                  sessionCanvasId: sessionThread?.canvasId,
                });
            return sandboxScopeId ? { sandboxScopeId } : {};
          })(),
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
      if (error instanceof ExecutionScopeError)
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
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
