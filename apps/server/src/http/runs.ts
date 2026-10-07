import { randomUUID } from "node:crypto";
import {
  agentRunActivityResponseSchema,
  type AgentRunLatestResponse,
  agentRunLatestResponseSchema,
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
import {
  type ThreadService,
  ThreadServiceError,
} from "../features/chat/thread-service.js";
import type { CodeUiService } from "../features/code-ui/service.js";
import {
  ExecutionScopeError,
  type ExecutionScopes,
} from "../features/execution/scope-service.js";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { LocalInstanceMaintenanceError } from "../features/local-instance/service.js";
import type { LocalInstanceService } from "../features/local-instance/types.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import { isZodError } from "./zod-error.js";

export async function registerRunRoutes(
  app: FastifyInstance,
  agentRuns: AgentRunService,
  options: {
    /** 运行活动查询（Git 弹层的「智能体 N 秒 · M 运行」；口径见仓储 workspaceActivity）。 */
    activityQuery?: (input: {
      instanceId: string;
    }) => Promise<{ runs: number; totalSeconds: number; windowDays: number }>;
    latestRunQuery?: (input: { sessionId: string; instanceId: string }) => Promise<AgentRunLatestResponse["run"]>;
    agentModes?: ExecutionModeService;
    agentRunMetadataService?: AgentRunMetadataService;
    localAccess: LocalAccessVerifier;
    settingsService?: SettingsService;
    threadService?: ThreadService;
    localInstance: LocalInstanceService;
    modelProviders?: ModelProviderService;
    executionScopes?: ExecutionScopes;
    codeUi?: Pick<CodeUiService, "admitExternalRun">;
  },
) {
  /**
   * GET /api/agent/subagents — 子智能体清单（设置 →「子智能体」）。
   *
   * 清单由 agent 装配处导出（`agent/sub-agents.ts`），与真跑起来用的是**同一个来源**；
   * 界面因此不会出现「写着有、跑起来没有」。不依赖工作区，登录即可读。
   */
  app.get("/api/agent/subagents", async (request, reply) => {
    if (!options.localAccess) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message: "认证未装配，无法列出子智能体。",
          },
        }),
      );
    }
    const user = await options.localAccess.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "本机连接凭据缺失或无效。",
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
    const authenticatedUser = options.localAccess
      ? await options.localAccess.authenticate(request)
      : null;
    if (!authenticatedUser) {
      return reply.code(401).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "本机连接凭据缺失或无效。",
          },
        }),
      );
    }
    const workspace = options.localInstance
      ? await options.localInstance.resolve(authenticatedUser).catch(() => null)
      : null;
    const activity =
      workspace && options.activityQuery
        ? await options.activityQuery({ instanceId: workspace.instanceId })
        : { runs: 0, totalSeconds: 0, windowDays: 7 };
    return reply
      .code(200)
      .send(agentRunActivityResponseSchema.parse({ activity }));
  });

  app.get("/api/agent/runs/latest", async (request, reply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) return sendUnauthorized(reply);
    const sessionId = (request.query as { sessionId?: string }).sessionId ?? "";
    const instance = sessionId
      ? await options.localInstance.resolve(actor).catch(() => null)
      : null;
    const run = instance && options.latestRunQuery
      ? await options.latestRunQuery({ sessionId, instanceId: instance.instanceId })
      : null;
    return reply.send(agentRunLatestResponseSchema.parse({ run }));
  });

  app.post("/api/agent/runs", async (request, reply) => {
    let releaseAdmission: (() => void) | undefined;
    try {
      const payload = runCreateRequestSchema.parse(request.body);
      const authenticatedUser = await options.localAccess.authenticate(request);
      if (!authenticatedUser) return sendUnauthorized(reply);
      releaseAdmission = options.localInstance.beginAdmission();
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

      const context = await options.localInstance.resolve(authenticatedUser);
      const settings = options.settingsService
        ? await options.settingsService.getInstanceSettings(
            authenticatedUser,
            context.instanceId,
          )
        : undefined;
      const model = settings?.defaultModel;

      // 执行模式（DEC-3）：载荷声明 → 按真实 threadId 激活并写穿持久化；
      // 未声明 → 读回线程持久化模式（与 WS 路径同口径，重启后仍按线程模式走）。
      // plan 批准门（机器可读）：与 WS 路径同口径，批准短语本条消息起按 agent 执行。
      if (sessionThread && options.agentModes) {
        const modeScope = { instanceId: context.instanceId };
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
          return reply.code(503).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "service_unavailable",
                message: "无法确认执行模式，运行未启动，请稍后重试。",
              },
            }),
          );
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
                actor: authenticatedUser,
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
      if (error instanceof LocalInstanceMaintenanceError)
        return reply
          .code(503)
          .send({ error: { code: error.code, message: error.message } });
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
    } finally {
      releaseAdmission?.();
    }
  });

  app.post("/api/agent/runs/:runId/cancel", async (request, reply) => {
    const actor = await options.localAccess.authenticate(request);
    if (!actor) return sendUnauthorized(reply);
    await options.localInstance.resolve(actor);
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

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "本机连接凭据缺失或无效。",
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
