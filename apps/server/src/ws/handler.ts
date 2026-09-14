import { randomUUID } from "node:crypto";
import type { ContentBlock, ToolBlock, WsCommand } from "@loomic/shared";
import {
  type RunCreateRequest,
  wsCommandSchema,
  wsRpcResponseSchema,
} from "@loomic/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  clampMaxRunRetries,
  DEFAULT_MAX_RUN_RETRIES,
  decideRunRetry,
} from "../agent/run-retry.js";
import type { AgentRunService } from "../agent/runtime.js";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import { isPlanApprovalInput } from "../features/agent-modes/execution-mode-service.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import { deriveSessionTitle } from "../features/chat/session-title.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { CanvasEventBuffer } from "./event-buffer.js";
import { createPipelineLogger } from "./logger.js";

type RegisterWsOptions = {
  agentRuns: AgentRunService;
  agentModes?: ExecutionModeService;
  agentRunMetadataService?: AgentRunMetadataService;
  auth?: RequestAuthenticator;
  chatService?: ChatService;
  connectionManager: ConnectionManager;
  eventBuffer?: CanvasEventBuffer;
  settingsService?: SettingsService;
  threadService?: ThreadService;
  viewerService?: ViewerService;
};

export async function registerWsRoute(
  app: FastifyInstance,
  options: RegisterWsOptions,
) {
  const { agentRuns, connectionManager } = options;

  app.get(
    "/api/ws",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get("token");

      if (!token || !options.auth) {
        socket.close(4001, "Unauthorized");
        return;
      }

      void authenticateAndBind(
        socket,
        token,
        request,
        options,
        agentRuns,
        connectionManager,
      );
    },
  );
}

async function authenticateAndBind(
  socket: WebSocket,
  token: string,
  _request: FastifyRequest,
  options: RegisterWsOptions,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
) {
  const log = createPipelineLogger("ws");

  /**
   * 鉴权期间的早期消息缓冲。
   *
   * 竞态背景：`socket.on("message")` 只能在本函数**异步鉴权之后**才挂上，而客户端在
   * `onopen` 后立刻发命令（首个 run 常如此）。窗口期到达的消息会被直接丢弃——表现为
   * 「点了发送但界面永远停在生成中」，且服务端连一行日志都没有。
   *
   * 修法：在首个 await 之前**同步**挂捕获监听器（async 函数在首个 await 前同步执行，
   * 因此不存在间隙），鉴权成功并挂上真正处理器后回放缓冲。
   */
  const earlyMessages: Array<Buffer | string> = [];
  let forwarding = false;
  const captureEarly = (raw: Buffer | string) => {
    if (!forwarding) earlyMessages.push(raw);
  };
  socket.on("message", captureEarly);

  let authenticatedUser: AuthenticatedUser;
  try {
    const fakeRequest = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as FastifyRequest;
    const user = await options.auth!.authenticate(fakeRequest);
    if (!user) {
      log.warn("auth_rejected", { reason: "invalid_token" });
      socket.close(4001, "Unauthorized");
      return;
    }
    authenticatedUser = user;
    log.info("connected", { userId: user.id });
  } catch (err) {
    log.warn("auth_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    socket.close(4001, "Unauthorized");
    return;
  }

  if (socket.readyState !== 1) return;

  // Use client-provided connectionId for reconnect identity; fallback to server UUID
  const urlForParams = new URL(_request.url, `http://${_request.headers.host}`);
  const connectionId =
    urlForParams.searchParams.get("connectionId") || randomUUID();
  connectionManager.register(connectionId, authenticatedUser.id, socket);

  // Heartbeat with pong timeout (spec §1.3: 60s no-pong → disconnect)
  let lastPong = Date.now();
  socket.on("pong", () => {
    lastPong = Date.now();
  });

  const pingInterval = setInterval(() => {
    if (Date.now() - lastPong > 60_000) {
      log.warn("pong_timeout", { userId: authenticatedUser.id });
      socket.terminate();
      return;
    }
    if (socket.readyState === 1) {
      socket.ping();
    }
  }, 30_000);

  const onMessage = (raw: Buffer | string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof raw === "string" ? raw : raw.toString("utf-8"),
      );
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.type === "rpc.response") {
      try {
        const rpcResponse = wsRpcResponseSchema.parse(parsed);
        connectionManager.handleRpcResponse(connectionId, {
          type: rpcResponse.type,
          id: rpcResponse.id,
          ...(rpcResponse.result !== undefined
            ? { result: rpcResponse.result }
            : {}),
          ...(rpcResponse.error !== undefined
            ? { error: rpcResponse.error }
            : {}),
        });
      } catch {
        // Ignore malformed RPC responses
      }
      return;
    }

    if (obj.type === "command") {
      let msg: WsCommand;
      try {
        msg = wsCommandSchema.parse(parsed);
      } catch {
        socket.send(
          JSON.stringify({ type: "error", message: "Invalid command format" }),
        );
        return;
      }

      if (msg.action === "agent.run") {
        const p = msg.payload;
        const runToken = p.accessToken ?? token;
        void handleRunCommand(
          {
            ...authenticatedUser,
            accessToken: runToken,
          },
          connectionId,
          {
            sessionId: p.sessionId,
            conversationId: p.conversationId,
            prompt: p.prompt,
            ...(p.canvasId !== undefined ? { canvasId: p.canvasId } : {}),
            ...(p.attachments !== undefined
              ? { attachments: p.attachments }
              : {}),
            ...(p.imageGenerationPreference !== undefined
              ? { imageGenerationPreference: p.imageGenerationPreference }
              : {}),
            ...(p.videoGenerationPreference !== undefined
              ? { videoGenerationPreference: p.videoGenerationPreference }
              : {}),
            ...(p.mentions !== undefined ? { mentions: p.mentions } : {}),
            ...(p.model !== undefined ? { model: p.model } : {}),
            ...(p.preset !== undefined ? { preset: p.preset } : {}),
            ...(p.executionMode !== undefined
              ? { executionMode: p.executionMode }
              : {}),
          },
          agentRuns,
          connectionManager,
          options,
        );
      } else if (msg.action === "agent.cancel") {
        log.info("run_cancel", {
          userId: authenticatedUser.id,
          runId: msg.payload.runId,
        });
        const cancelResult = agentRuns.cancelRun(msg.payload.runId);
        if (!cancelResult) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: `Run not found: ${msg.payload.runId}`,
            }),
          );
        }
      } else if (msg.action === "canvas.resume") {
        const p = msg.payload;
        log.info("canvas_resume", {
          userId: authenticatedUser.id,
          canvasId: p.canvasId,
          lastSeq: p.lastSeq,
        });

        // Re-bind this connection to the canvas
        connectionManager.bindCanvas(connectionId, p.canvasId);

        const missed =
          options.eventBuffer?.getAfter(p.canvasId, p.lastSeq) ?? [];
        const activeRun = connectionManager.getActiveRun(p.canvasId);

        // IMPORTANT: Send ACK FIRST so client registers event listener
        // BEFORE replay events arrive. Otherwise replayed events have no handler.
        connectionManager.sendTo(connectionId, {
          type: "command.ack",
          action: "canvas.resume",
          payload: {
            canvasId: p.canvasId,
            latestSeq: options.eventBuffer?.getLatestSeq(p.canvasId) ?? 0,
            activeRunId: activeRun?.runId ?? null,
            replayed: missed.length,
          },
        });

        // THEN replay missed events from buffer
        for (const entry of missed) {
          connectionManager.sendTo(connectionId, {
            type: "event",
            event: entry.event,
          });
        }
      }
    }
  };

  socket.on("message", onMessage);
  // 回放鉴权期间缓冲的早期消息（否则 open 后立即发送的命令会静默丢失）
  forwarding = true;
  socket.off("message", captureEarly);
  for (const raw of earlyMessages.splice(0)) {
    try {
      onMessage(raw);
    } catch (error) {
      log.warn("early_message_replay_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  socket.on("close", () => {
    log.info("disconnected", { userId: authenticatedUser.id, connectionId });
    clearInterval(pingInterval);
    // 带 socket 身份：客户端重连复用 connectionId，迟到的旧 socket close 不得删掉新注册
    connectionManager.remove(connectionId, socket);
  });

  socket.on("error", () => {
    log.error("socket_error", { userId: authenticatedUser.id, connectionId });
    clearInterval(pingInterval);
    connectionManager.remove(connectionId, socket);
  });
}

async function handleRunCommand(
  authenticatedUser: AuthenticatedUser,
  connectionId: string,
  payload: Omit<RunCreateRequest, "accessToken">,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
) {
  const log = createPipelineLogger("agent.run", {
    userId: authenticatedUser.id,
    sessionId: payload.sessionId,
  });
  log.info("started", { prompt: payload.prompt.slice(0, 80) });

  // Code 模式会话供给（方案 A）：工作台用**客户端自造**的 sessionId 发起 run，库里
  // 没有对应 chat_sessions 行——于是线程解析失败、助手消息无处落库（实测 0 行）。
  // 这里按该 id 供给真实会话与线程（载体是工作区隐藏的「Code 工作台」项目/画布），
  // 供给成功则下面的解析直接命中；失败不阻断 run（解析处仍有兜底），只记一条 warn。
  // Design 模式不供给：其会话由画布页经 API 先建行，缺行属真错误，不该被掩盖。
  if (services.chatService && payload.preset !== "design") {
    try {
      const provisioned = await services.chatService.ensureCodeSession(
        authenticatedUser,
        {
          sessionId: payload.sessionId,
          // 标题派生先剥 prompt 首部的【…】指令块（目录提示/思考强度），
          // 否则侧栏会出现「【目录名称：test（仅用户标注的命名提示…」泄漏。
          title: deriveSessionTitle(payload.prompt),
        },
      );
      log.info("code_session_ensured", { sessionId: provisioned.sessionId });
    } catch (error) {
      log.warn("code_session_ensure_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // viewer 解析（工作区作用域）：模型默认值、执行模式持久化共用，只解析一次
  const viewerPromise = (async () => {
    if (!services.viewerService) return undefined;
    try {
      return await services.viewerService.ensureViewer(authenticatedUser);
    } catch (error) {
      log.warn("viewer_resolve_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  })();

  // Resolve thread + model in parallel
  const [threadId, viewer, model] = await Promise.all([
    (async (): Promise<string | undefined> => {
      if (!services.threadService) return undefined;
      try {
        const sessionThread =
          await services.threadService.resolveOwnedSessionThread(
            authenticatedUser,
            payload.sessionId,
          );
        return sessionThread.threadId;
      } catch (error) {
        log.warn("thread_resolve_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })(),
    viewerPromise,
    (async (): Promise<string | undefined> => {
      if (!services.settingsService) return undefined;
      try {
        const viewer = await viewerPromise;
        if (!viewer) return undefined;
        const settings = await services.settingsService.getWorkspaceSettings(
          authenticatedUser,
          viewer.workspace.id,
        );
        return settings.defaultModel;
      } catch (error) {
        log.warn("model_resolve_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })(),
  ]);
  // Client-provided model takes priority over workspace default
  const resolvedModel = payload.model ?? model;
  log.lap("resolve", {
    threadId: !!threadId,
    threadIdValue: threadId ?? null,
    model: resolvedModel,
  });

  // 执行模式（DEC-3）：WS 载荷声明 → 按真实 threadId 激活（写穿 chat_sessions）
  //（threadId 是服务端内部 ID，客户端拿不到，故不走 PUT /execution-modes/:threadId）
  const modeScope = viewer ? { workspaceId: viewer.workspace.id } : undefined;
  // plan 批准门（机器可读）：线程在 plan 且消息本身就是批准短语时，本条消息起按
  // agent 执行——过去文字「批准」不解锁工具门，用户必须再手动切档（GUI 实测多绕一步）
  let effectiveMode = payload.executionMode;
  if (
    effectiveMode === "plan" &&
    threadId &&
    services.agentModes &&
    isPlanApprovalInput(payload.prompt)
  ) {
    effectiveMode = "agent";
    log.info("plan_approval_auto_upgrade", {
      threadId,
      detail: "plan 批准短语命中，本条消息起按 agent 执行",
    });
  }
  if (effectiveMode && threadId && services.agentModes) {
    try {
      await services.agentModes.activate(threadId, effectiveMode, modeScope);
    } catch (error) {
      // 内存激活已先生效（store 失败只影响重启后的读回），run 按新模式继续
      log.warn("execution_mode_persist_failed", {
        executionMode: effectiveMode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (!effectiveMode && threadId && services.agentModes && modeScope) {
    // 未声明模式的 run（画布助手/旧客户端）：读回线程持久化模式，
    // 重启后线程仍按既定模式走（引导 + 工具门都以 hydrate 后的缓存为准）
    try {
      await services.agentModes.hydrate(threadId, modeScope);
    } catch (error) {
      log.warn("execution_mode_hydrate_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (payload.executionMode && payload.executionMode !== "agent") {
    /**
     * 模式**静默降级**是曾经的坑：threadId 解析不出来时，pre-step 会退化成 "agent"、
     * 工具门整段跳过（见 agent-modes/plugin.ts），而客户端与模型都以为自己在目标模式里。
     * 这里必须响亮：运行降级为 agent 时留下可检索的日志，别让它无声发生。
     */
    log.warn("execution_mode_not_applied", {
      executionMode: payload.executionMode,
      reason: threadId ? "agent_modes_service_missing" : "thread_unresolved",
      detail: threadId
        ? "agentModes 服务不可用"
        : "会话未在服务端解析出 thread（客户端 sessionId 未被服务端持久化），模式引导与工具门都不会生效",
    });
  }

  const canvasId = payload.canvasId ?? payload.conversationId;

  /**
   * 起一次尝试：建 run + 落元数据 + 绑定画布 + 发 ack + 标活跃。
   * 重试必须整段重来：**新 runId 要重新 ack 给客户端**，否则事件因 runId 不匹配被丢。
   */
  const startAttempt = async (): Promise<string> => {
    const response = agentRuns.createRun(payload, {
      accessToken: authenticatedUser.accessToken,
      userId: authenticatedUser.id,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(threadId ? { threadId } : {}),
    });
    const runId = response.runId;
    log.lap("run_created", { runId });

    // Persist run metadata
    if (threadId && services.agentRunMetadataService) {
      try {
        await services.agentRunMetadataService.createAcceptedRun({
          ...(resolvedModel ? { model: resolvedModel } : {}),
          runId,
          sessionId: payload.sessionId,
          threadId,
        });
      } catch {
        // Non-fatal
      }
    }

    // Bind this connection to the canvas so events route correctly
    connectionManager.bindCanvas(connectionId, canvasId);

    // Send ACK to the specific connection that initiated the run.
    // Retry with short delays if the connection is temporarily unavailable
    // (e.g., brief disconnect/reconnect during page transitions).
    const ackMessage = {
      type: "command.ack",
      action: "agent.run",
      payload: response,
    };
    let ackSent = connectionManager.sendTo(connectionId, ackMessage);
    if (!ackSent) {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 500));
        ackSent = connectionManager.sendTo(connectionId, ackMessage);
        if (ackSent) break;
      }
    }
    log.lap("ack_sent", { runId, connectionId, delivered: ackSent });

    // Track active run so reconnecting clients can detect it
    connectionManager.setActiveRun(canvasId, runId);
    return runId;
  };

  const keepAlive = setInterval(() => {
    connectionManager.sendTo(connectionId, { type: "keep-alive" });
  }, 15_000);

  // Accumulate assistant content blocks for server-side persistence
  const assistantText: string[] = [];
  const assistantBlocks: ContentBlock[] = [];

  const runSettings =
    viewer && services.settingsService
      ? await services.settingsService
          .getWorkspaceSettings(authenticatedUser, viewer.workspace.id)
          .catch(() => undefined)
      : undefined;
  const maxAttempts = clampMaxRunRetries(
    runSettings?.agentMaxRetries ?? DEFAULT_MAX_RUN_RETRIES,
  );
  let runId = await startAttempt();
  try {
    // 失败自动重试（判定集中在 agent/run-retry.ts）。上限取自工作区设置，缺省 10。
    for (let attempt = 1; ; attempt += 1) {
      assistantText.length = 0;
      assistantBlocks.length = 0;
      let sawToolExecution = false;
      let failureMessage: string | undefined;
      // 显式终态：成功与「用户取消」都不是失败，绝不能被重试判定当成「无原因可重试」
      let terminal: "completed" | "canceled" | undefined;
      let firstEvent = true;
      for await (const event of agentRuns.streamRun(runId)) {
        if (firstEvent) {
          log.lap("first_token", { runId });
          firstEvent = false;
        }

        // Buffer for replay on reconnect
        services.eventBuffer?.push(canvasId, event);

        // Broadcast to all viewers
        connectionManager.pushToCanvas(canvasId, event);
        if (event.type === "run.completed") terminal = "completed";
        if (event.type === "run.canceled") terminal = "canceled";
        // 副作用观测点：只要工具跑过，本轮就**不允许**重试（否则重复施加副作用）
        if (event.type === "tool.started" || event.type === "tool.completed") {
          sawToolExecution = true;
        }
        if (event.type === "run.failed") failureMessage = event.error.message;

        // Accumulate content for server-side persistence
        if (event.type === "message.delta") {
          const lastBlock = assistantBlocks[assistantBlocks.length - 1];
          if (lastBlock && lastBlock.type === "text") {
            (lastBlock as { type: "text"; text: string }).text += event.delta;
          } else {
            assistantBlocks.push({ type: "text", text: event.delta });
          }
          assistantText.push(event.delta);
        } else if (event.type === "tool.started") {
          assistantBlocks.push({
            type: "tool",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "running" as const,
            ...(event.input ? { input: event.input } : {}),
          });
        } else if (event.type === "tool.completed") {
          const idx = assistantBlocks.findIndex(
            (b) =>
              b.type === "tool" &&
              (b as ToolBlock).toolCallId === event.toolCallId,
          );
          if (idx >= 0) {
            assistantBlocks[idx] = {
              ...(assistantBlocks[idx] as ToolBlock),
              status: "completed" as const,
              ...(event.output ? { output: event.output } : {}),
              ...(event.outputSummary
                ? { outputSummary: event.outputSummary }
                : {}),
              ...(event.artifacts ? { artifacts: event.artifacts } : {}),
            };
          }
        }
      }
      log.lap("stream_done", { runId });

      const decision = decideRunRetry({
        attempt,
        failureMessage,
        maxAttempts,
        sawToolExecution,
        terminal,
      });
      if (!decision.retry) {
        // ── Server-side assistant message persistence ──
        if (
          services.chatService &&
          (assistantText.length > 0 || assistantBlocks.length > 0)
        ) {
          try {
            await services.chatService.createMessage(
              authenticatedUser,
              payload.sessionId,
              {
                role: "assistant",
                content: assistantText.join(""),
                contentBlocks: assistantBlocks,
              },
            );
            log.lap("assistant_message_persisted", { runId });
          } catch (err) {
            log.warn("assistant_message_persist_failed", {
              runId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        break;
      }
      log.warn("run_retrying", { attempt, reason: decision.reason, runId });
      runId = await startAttempt();
      const retryEvent = {
        type: "run.retrying" as const,
        runId,
        attempt: attempt + 1,
        maxAttempts,
        reason: decision.reason,
        timestamp: new Date().toISOString(),
      };
      services.eventBuffer?.push(canvasId, retryEvent);
      connectionManager.pushToCanvas(canvasId, retryEvent);
    }
  } catch (error) {
    log.error("stream_error", {
      runId,
      error: error instanceof Error ? error.message : "unknown",
    });
    const failedEvent = {
      type: "run.failed" as const,
      runId,
      error: {
        code: "run_failed" as const,
        message: error instanceof Error ? error.message : "Stream failed",
      },
      timestamp: new Date().toISOString(),
    };
    services.eventBuffer?.push(canvasId, failedEvent);
    connectionManager.pushToCanvas(canvasId, failedEvent);
  } finally {
    clearInterval(keepAlive);
    connectionManager.clearActiveRun(canvasId);
  }
}
