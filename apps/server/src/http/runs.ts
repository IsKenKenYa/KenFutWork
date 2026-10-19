import { randomUUID } from "node:crypto";
import {
  type AgentRunLatestResponse,
  agentRunActivityResponseSchema,
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
import {
  listSubagentDefinitions,
  SUBAGENT_DISPATCH_TOOLS,
} from "../agent/subagent-definitions.js";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import {
  type AgentRunMetadataService,
  AgentRunPersistenceError,
} from "../features/agent-runs/agent-run-service.js";
import {
  type ThreadService,
  ThreadServiceError,
} from "../features/chat/thread-service.js";
import { CodeUiRepositoryError } from "../features/code-ui/repository.js";
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
  _agentRuns: AgentRunService,
  options: {
    /** 运行活动查询（Git 弹层的「智能体 N 秒 · M 运行」；口径见仓储 workspaceActivity）。 */
    activityQuery?: (input: {
      instanceId: string;
    }) => Promise<{ runs: number; totalSeconds: number; windowDays: number }>;
    latestRunQuery?: (input: {
      sessionId: string;
      instanceId: string;
    }) => Promise<AgentRunLatestResponse["run"]>;
    agentModes?: ExecutionModeService;
    agentRunMetadataService?: AgentRunMetadataService;
    localAccess: LocalAccessVerifier;
    settingsService?: SettingsService;
    threadService?: ThreadService;
    localInstance: LocalInstanceService;
    modelProviders?: ModelProviderService;
    executionScopes?: ExecutionScopes;
    codeUi?: Pick<CodeUiService, "admitExternalRun" | "cancelExternalRun">;
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
    const run =
      instance && options.latestRunQuery
        ? await options.latestRunQuery({
            sessionId,
            instanceId: instance.instanceId,
          })
        : null;
    return reply.send(agentRunLatestResponseSchema.parse({ run }));
  });

  app.post("/api/agent/runs", async (request, reply) => {
    let releaseAdmission: (() => void) | undefined;
    try {
      const payload = runCreateRequestSchema.parse(request.body);
      const actor = await options.localAccess.authenticate(request);
      if (!actor) return sendUnauthorized(reply);
      releaseAdmission = options.localInstance.beginAdmission();
      if (!options.executionScopes || !options.codeUi)
        throw new ExecutionScopeError(
          "admission_unavailable",
          "共享会话服务未加载，请重启应用后重试。",
          503,
        );
      const scope = await options.executionScopes.openTask(
        actor,
        payload.taskId ?? payload.sessionId,
      );
      if (scope.describe().taskId !== payload.sessionId)
        throw new ExecutionScopeError(
          "scope_mismatch",
          "运行必须绑定所属会话的任务。",
          409,
        );
      const idempotencyHeader = request.headers["x-idempotency-key"];
      const inputId =
        payload.inputId ??
        (typeof idempotencyHeader === "string" && idempotencyHeader
          ? idempotencyHeader
          : randomUUID());
      const admitted = await options.codeUi.admitExternalRun(
        actor,
        scope,
        inputId,
        payload.prompt,
        payload,
      );
      void admitted
        .publish()
        .catch((error: unknown) =>
          app.log.error({ err: error }, "共享会话运行发布失败"),
        );
      return reply.code(202).send(runCreateResponseSchema.parse(admitted));
    } catch (error) {
      if (error instanceof LocalInstanceMaintenanceError)
        return reply
          .code(503)
          .send({ error: { code: error.code, message: error.message } });
      if (
        error instanceof ExecutionScopeError ||
        error instanceof CodeUiRepositoryError
      )
        return reply
          .code(
            error instanceof ExecutionScopeError
              ? error.statusCode
              : error.code === "not_found"
                ? 404
                : 409,
          )
          .send(
            applicationErrorResponseSchema.parse({
              error: { code: error.code, message: error.message },
            }),
          );
      if (
        error instanceof ThreadServiceError ||
        error instanceof AgentRunPersistenceError
      )
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
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
    if (!options.codeUi)
      return reply.code(503).send({
        error: {
          code: "admission_unavailable",
          message: "共享会话服务未加载，请重启应用后重试。",
        },
      });
    let canceledRun: Awaited<ReturnType<CodeUiService["cancelExternalRun"]>>;
    try {
      canceledRun = await options.codeUi.cancelExternalRun(actor, runId);
    } catch (error) {
      if (error instanceof CodeUiRepositoryError)
        return reply
          .code(error.code === "not_found" ? 404 : 409)
          .send({ error: { code: error.code, message: error.message } });
      throw error;
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
