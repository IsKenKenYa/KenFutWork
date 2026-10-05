import { randomUUID } from "node:crypto";
import type { WsCommand, WsTerminalStartCommand } from "@kenfutwork/shared";
import {
  type RunCreateRequest,
  wsCommandSchema,
  wsRpcResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  clampMaxRunRetries,
  DEFAULT_MAX_RUN_RETRIES,
  decideRunRetry,
} from "../agent/run-retry.js";
import type { AgentRunService } from "../agent/runtime.js";
import { resolveSandboxScopeId } from "../agent/sandbox-dir.js";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import { isPlanApprovalInput } from "../features/agent-modes/execution-mode-service.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import { chunkForFrames } from "../features/code-git/terminal-session.js";
import type { CodeTerminalService } from "../features/code-terminal/types.js";
import type { CodeUiService } from "../features/code-ui/service.js";
import {
  ExecutionScopeError,
  type ExecutionScopes,
} from "../features/execution/scope-service.js";
import type {
  LocalAccessService,
  LocalAccessVerifier,
} from "../features/local-access/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import { createAssistantBlockCollector } from "./assistant-block-collector.js";
import {
  ConnectionIdentityConflictError,
  type ConnectionManager,
} from "./connection-manager.js";
import type { CanvasEventBuffer } from "./event-buffer.js";
import { createPipelineLogger } from "./logger.js";

type RegisterWsOptions = {
  agentRuns: AgentRunService;
  agentModes?: ExecutionModeService;
  agentRunMetadataService?: AgentRunMetadataService;
  localAccess?: LocalAccessVerifier &
    Partial<Pick<LocalAccessService, "onRevoked">>;
  chatService?: ChatService;
  codeTerminal?: CodeTerminalService;
  connectionManager: ConnectionManager;
  eventBuffer?: CanvasEventBuffer;
  settingsService?: SettingsService;
  threadService?: ThreadService;
  localInstance?: LocalInstanceService;
  executionScopes?: ExecutionScopes;
  codeUi?: Pick<CodeUiService, "admitExternalRun">;
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
      // WS与HTTP共用Cookie/Bearer准入；回环和Origin不能替代真实凭据。
      if (!options.localAccess) {
        socket.close(4001, "Unauthorized");
        return;
      }

      void authenticateAndBind(
        socket,
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
  request: FastifyRequest,
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

  let authenticatedUser: LocalActor;
  let revoked = false;
  let unsubscribeRevoked = () => {};
  let removeRegistered = () => {};
  const releaseAuth = () => {
    unsubscribeRevoked();
    unsubscribeRevoked = () => {};
  };
  const rejectConnection = (code: number, reason: string) => {
    // 先撤销服务端路由资格，再发close帧；客户端close可能早于服务端close事件。
    // 注册前为noop，冲突拒绝不会删除另一客户端的entry。
    removeRegistered();
    socket.off("message", captureEarly);
    earlyMessages.length = 0;
    releaseAuth();
    try {
      socket.close(code, reason);
    } catch {
      log.warn("socket_close_failed", { reason: "本机连接关闭尚未确认" });
      try {
        socket.terminate();
      } catch {
        log.warn("socket_terminate_failed", {
          reason: "本机连接强制关闭尚未确认",
        });
      }
    }
  };
  socket.once("close", releaseAuth);
  const auth = options.localAccess;
  if (!auth) {
    rejectConnection(4001, "本机连接凭据缺失");
    return;
  }
  const authRequest = { ip: request.ip, headers: request.headers };
  try {
    const user = await auth.authenticate(authRequest);
    if (!user?.accessClientId) {
      rejectConnection(4001, "本机连接凭据已失效");
      return;
    }
    authenticatedUser = user;
    if (!auth.onRevoked) {
      rejectConnection(1011, "本机接入撤权通知不可用");
      return;
    }
    // 注册前先订阅撤权再重验，不能将期间已撤销的身份加入连接索引。
    unsubscribeRevoked = auth.onRevoked((clientId) => {
      if (clientId !== authenticatedUser.accessClientId) return;
      revoked = true;
      rejectConnection(4001, "本机连接授权已撤销");
    });
    if (revoked) releaseAuth();
    const current = await auth.authenticate(authRequest);
    if (
      revoked ||
      !current ||
      current.instanceId !== user.instanceId ||
      current.accessClientId !== user.accessClientId
    ) {
      rejectConnection(4001, "本机连接授权已失效");
      return;
    }
  } catch {
    log.warn("auth_error", { reason: "本机接入校验暂不可用" });
    rejectConnection(1011, "本机服务暂时不可用");
    return;
  }
  if (socket.readyState !== 1) {
    releaseAuth();
    socket.off("message", captureEarly);
    earlyMessages.length = 0;
    return;
  }

  const urlForParams = new URL(request.url, `http://${request.headers.host}`);
  const connectionId =
    urlForParams.searchParams.get("connectionId") || randomUUID();
  try {
    connectionManager.register(
      connectionId,
      authenticatedUser.instanceId,
      socket,
      authenticatedUser.accessClientId,
    );
    removeRegistered = () => connectionManager.remove(connectionId, socket);
  } catch (error) {
    if (error instanceof ConnectionIdentityConflictError) {
      rejectConnection(4001, error.message);
    } else {
      rejectConnection(1011, "本机连接注册失败");
    }
    return;
  }
  log.info("connected", { instanceId: authenticatedUser.instanceId });

  // 沿既有30s心跳/60s无pong门；每轮仅一个授权查询，不累积慢查询。
  let lastPong = Date.now();
  const onPong = () => {
    lastPong = Date.now();
  };
  socket.on("pong", onPong);
  let heartbeatPending = false;
  const pingInterval = setInterval(() => {
    if (socket.readyState !== 1) return;
    if (Date.now() - lastPong > 60_000) {
      log.warn("pong_timeout", { instanceId: authenticatedUser.instanceId });
      removeRegistered();
      releaseAuth();
      socket.terminate();
      return;
    }
    if (heartbeatPending) return;
    heartbeatPending = true;
    void (async () => {
      try {
        const current = await auth.authenticate(authRequest);
        if (socket.readyState !== 1) return;
        if (
          revoked ||
          !current ||
          current.instanceId !== authenticatedUser.instanceId ||
          current.accessClientId !== authenticatedUser.accessClientId
        ) {
          rejectConnection(4001, "本机连接授权已失效");
          return;
        }
        socket.ping();
      } catch {
        rejectConnection(1011, "本机服务暂时不可用");
      } finally {
        heartbeatPending = false;
      }
    })();
  }, 30_000);

  // terminal owner采用本次socket独立身份；重连复用的transport ID不能接管旧PTY。
  const terminalConnectionId = randomUUID();
  const terminalOwner = options.localInstance?.resolve(authenticatedUser);
  const sendToClient = (message: Record<string, unknown>) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };
  const sendTerminal = (message: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== 1) {
        resolve();
        return;
      }
      socket.send(JSON.stringify(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  const terminalFailure = (id: string, error: unknown) =>
    sendToClient({
      type: "terminal.exit",
      sessionId: id,
      exitCode: null,
      reason: error instanceof Error ? error.message : String(error),
    });
  const startTerminal = async (payload: WsTerminalStartCommand["payload"]) => {
    const terminals = options.codeTerminal;
    if (!terminals || !terminalOwner)
      throw new Error("服务端没有装配Task终端能力。");
    await terminalOwner;
    if (socket.readyState !== 1) throw new Error("终端连接已经关闭。");
    const opened = await terminals.create(
      authenticatedUser,
      terminalConnectionId,
      payload,
    );
    await sendTerminal({
      type: "command.ack",
      action: "terminal.start",
      payload: {
        sessionId: opened.id,
        shell: opened.shell,
        executable: opened.executable,
        tty: opened.tty,
        ...(opened.reused ? { reused: true } : {}),
      },
    });
    await terminals.subscribe(
      authenticatedUser,
      terminalConnectionId,
      opened.id,
      {
        output: async (chunk) => {
          for (const data of chunkForFrames(chunk))
            await sendTerminal({
              type: "terminal.output",
              sessionId: opened.id,
              data,
            });
        },
        exit: (exit) =>
          sendTerminal({
            type: "terminal.exit",
            sessionId: opened.id,
            exitCode: exit.exitCode,
            ...(exit.reason ? { reason: exit.reason } : {}),
          }),
      },
    );
  };
  const closeTerminals = async () => {
    const workspace = await terminalOwner;
    if (workspace)
      await options.codeTerminal?.closeConnection(
        workspace.instanceId,
        terminalConnectionId,
        "终端连接断开",
      );
  };

  const onMessage = async (raw: Buffer | string) => {
    try {
      const current = await options.localAccess?.authenticate(request);
      if (
        !current ||
        current.instanceId !== authenticatedUser.instanceId ||
        current.accessClientId !== authenticatedUser.accessClientId
      ) {
        socket.close(4001, "本机连接授权已失效");
        return;
      }
    } catch {
      socket.close(1011, "本机服务暂时不可用");
      return;
    }
    if (socket.readyState !== 1) return;
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
        void handleRunCommand(
          authenticatedUser,
          connectionId,
          {
            sessionId: p.sessionId,
            conversationId: p.conversationId,
            ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
            ...(p.taskId !== undefined ? { taskId: p.taskId } : {}),
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
        ).catch((error: unknown) => {
          socket.send(
            JSON.stringify({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      } else if (msg.action === "agent.cancel") {
        log.info("run_cancel", {
          instanceId: authenticatedUser.instanceId,
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
          instanceId: authenticatedUser.instanceId,
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
      } else if (msg.action === "terminal.start") {
        void startTerminal(msg.payload).catch((error: unknown) =>
          terminalFailure(msg.payload.sessionId, error),
        );
      } else if (msg.action === "terminal.input") {
        void options.codeTerminal
          ?.write(
            authenticatedUser,
            terminalConnectionId,
            msg.payload.sessionId,
            msg.payload.data,
          )
          .catch((error: unknown) =>
            terminalFailure(msg.payload.sessionId, error),
          );
      } else if (msg.action === "terminal.resize") {
        void options.codeTerminal
          ?.resize(
            authenticatedUser,
            terminalConnectionId,
            msg.payload.sessionId,
            msg.payload.cols,
            msg.payload.rows,
          )
          .catch((error: unknown) =>
            terminalFailure(msg.payload.sessionId, error),
          );
      } else if (msg.action === "terminal.stop") {
        void options.codeTerminal
          ?.stop(
            authenticatedUser,
            terminalConnectionId,
            msg.payload.sessionId,
            "客户端关闭终端",
          )
          .catch((error: unknown) =>
            terminalFailure(msg.payload.sessionId, error),
          );
      }
    }
  };

  let messageQueue = Promise.resolve();
  const enqueueMessage = (raw: Buffer | string) => {
    messageQueue = messageQueue
      .then(() => onMessage(raw))
      .catch((error: unknown) => {
        log.warn("message_failed", {
          error: error instanceof Error ? error.message : "消息处理失败",
        });
        socket.close(1011, "本机消息处理失败");
      });
  };
  socket.on("message", enqueueMessage);
  // 回放鉴权期间缓冲的早期消息（否则 open 后立即发送的命令会静默丢失）
  forwarding = true;
  socket.off("message", captureEarly);
  for (const raw of earlyMessages.splice(0)) {
    try {
      enqueueMessage(raw);
    } catch (error) {
      log.warn("early_message_replay_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  socket.on("close", () => {
    log.info("disconnected", {
      instanceId: authenticatedUser.instanceId,
      connectionId,
    });
    clearInterval(pingInterval);
    releaseAuth();
    socket.off("pong", onPong);
    void closeTerminals().catch((error: unknown) =>
      log.warn("terminal_cleanup_unconfirmed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    // 带 socket 身份：客户端重连复用 connectionId，迟到的旧 socket close 不得删掉新注册
    connectionManager.remove(connectionId, socket);
  });

  socket.on("error", () => {
    log.error("socket_error", {
      instanceId: authenticatedUser.instanceId,
      connectionId,
    });
    clearInterval(pingInterval);
    releaseAuth();
    socket.off("pong", onPong);
    connectionManager.remove(connectionId, socket);
    /**
     * 必须把 socket 也收掉，不能只注销注册。
     *
     * 只删 map entry 会留下**半开连接**：客户端那侧 socket 还开着（收不到 close 就不知道
     * 该重连），于是 `connected` 还是 true、命令照样发得进来——服务端会真的把 run 跑起来，
     * 而 ack 与随后所有事件都推不回去（实测日志：`ack_sent delivered=false`，
     * 客户端 12 秒后报「请求未被确认，请重试。」，可那一轮其实在执行）。
     * 关掉它，客户端才会走 onclose → 重连 → resume 对账。
     */
    try {
      socket.close();
    } catch {
      // 已经坏掉的 socket 关它会抛，忽略
    }
  });
}

async function handleRunCommand(
  actor: LocalActor,
  connectionId: string,
  payload: RunCreateRequest,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
) {
  if (!services.localInstance) throw new Error("本地实例准入服务未装配。");
  const release = services.localInstance.beginAdmission();
  try {
    return await handleAdmittedRunCommand(
      actor,
      connectionId,
      payload,
      agentRuns,
      connectionManager,
      services,
    );
  } finally {
    release();
  }
}

async function handleAdmittedRunCommand(
  authenticatedUser: LocalActor,
  connectionId: string,
  payload: RunCreateRequest,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
) {
  const log = createPipelineLogger("agent.run", {
    instanceId: authenticatedUser.instanceId,
    sessionId: payload.sessionId,
  });
  log.info("started", { prompt: payload.prompt.slice(0, 80) });

  if (!services.localInstance) throw new Error("本地实例服务未装配。");
  const viewer = await services.localInstance.resolve(authenticatedUser);
  const [sessionBinding, settings] = await Promise.all([
    services.threadService?.resolveOwnedSessionThread(
      authenticatedUser,
      payload.sessionId,
    ),
    services.settingsService?.getInstanceSettings(
      authenticatedUser,
      viewer.instanceId,
    ),
  ]);
  const model = settings?.defaultModel;
  const threadId = sessionBinding?.threadId;
  const codeMode = sessionBinding?.mode === "code" || payload.preset === "code";
  if (
    sessionBinding &&
    payload.preset &&
    payload.preset !== sessionBinding.mode
  )
    throw new ExecutionScopeError(
      "mode_mismatch",
      "Run 不能改变会话所属模式。",
      409,
    );
  if (payload.projectId && sessionBinding?.projectId !== payload.projectId)
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
    ? services.executionScopes
      ? await services.executionScopes.openTask(
          authenticatedUser,
          payload.sessionId,
        )
      : (() => {
          throw new ExecutionScopeError(
            "scope_unavailable",
            "Code 执行工作域未装配。",
            503,
          );
        })()
    : undefined;

  /**
   * 沙箱目录名必须是**画布 UUID**（用户要求 `tmp/sandbox/<画布UUID>`）。
   *
   * 无工作目录的 Code 会话，客户端手里只有会话 UUID，会把 `canvasId` 发成会话 id ——
   * 直接落盘就是 `tmp/sandbox/<会话UUID>`，与服务端懒供给的「Code 工作台」画布对不上。
   * 这里只在「客户端发的就是会话作用域」时改用会话的真实画布；正常项目作用域不动。
   */
  const sandboxScopeId = scopeHandle
    ? undefined
    : resolveSandboxScopeId({
        conversationId: payload.conversationId,
        requestedCanvasId: payload.canvasId ?? payload.conversationId,
        sessionCanvasId: sessionBinding?.canvasId,
      });

  // Client-provided model takes priority over workspace default
  const resolvedModel = payload.model ?? model;
  log.lap("resolve", {
    threadId: !!threadId,
    threadIdValue: threadId ?? null,
    model: resolvedModel,
  });

  // 执行模式（DEC-3）：WS 载荷声明 → 按真实 threadId 激活（写穿 chat_sessions）
  //（threadId 是服务端内部 ID，客户端拿不到，故不走 PUT /execution-modes/:threadId）
  const modeScope = viewer ? { instanceId: viewer.instanceId } : undefined;
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

  // 共享传输的 Map key：Code 显式 Task 前缀，不是 Canvas UUID，也不创建隐藏画布。
  const canvasId = scopeHandle
    ? `task:${scopeHandle.describe().taskId}`
    : (payload.canvasId ?? sessionBinding?.canvasId ?? payload.conversationId);

  /**
   * 起一次尝试：建 run + 落元数据 + 绑定画布 + 发 ack + 标活跃。
   * 重试必须整段重来：**新 runId 要重新 ack 给客户端**，否则事件因 runId 不匹配被丢。
   */
  const startAttempt = async (): Promise<string> => {
    const acceptedRunId = randomUUID();
    const eventSink = scopeHandle
      ? services.codeUi
        ? await services.codeUi.admitExternalRun(
            authenticatedUser,
            scopeHandle,
            acceptedRunId,
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
    const response = agentRuns.createRun(payload, {
      runId: acceptedRunId,
      ...(eventSink ? { eventSink } : {}),
      ...(scopeHandle ? { scopeHandle } : {}),
      actor: authenticatedUser,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(sandboxScopeId ? { sandboxScopeId } : {}),
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

  // 对话历史块组装（content_blocks 持久化口径）：思考/工具归属/时间戳都落库，
  // 刷新后轨迹时间轴与轮级归属才完整——逻辑与口径见 assistant-block-collector。
  const blockCollector = createAssistantBlockCollector();

  const runSettings =
    viewer && services.settingsService
      ? await services.settingsService
          .getInstanceSettings(authenticatedUser, viewer.instanceId)
          .catch(() => undefined)
      : undefined;
  const maxAttempts = clampMaxRunRetries(
    runSettings?.agentMaxRetries ?? DEFAULT_MAX_RUN_RETRIES,
  );
  let runId = await startAttempt();
  try {
    // 失败自动重试（判定集中在 agent/run-retry.ts）。上限取自工作区设置，缺省 10。
    for (let attempt = 1; ; attempt += 1) {
      blockCollector.reset();
      let sawToolExecution = false;
      let failureMessage: string | undefined;
      // 显式终态：成功与「用户取消」都不是失败，绝不能被重试判定当成「无原因可重试」
      let terminal: "completed" | "canceled" | "failed" | undefined;
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
        if (event.type === "run.failed") {
          failureMessage = event.error.message;
          /**
           * 失败原因进**结构化日志**（pipeline-*.log）。
           * 此前原始错误只 `console.error` 到 stderr（终端一关就没了），实测「每轮 run
           * 都失败」时既回溯不了上游返回了什么、也贴不给上游排查。message 里已含脱敏后的
           * 原始错误（见 error-sanitizer 的 withRawDetail），与 agent_runs.error_message 同源。
           */
          log.error("run_failed", {
            runId,
            code: event.error.code,
            error: event.error.message,
          });
        }

        // Accumulate content for server-side persistence（含思考/归属/时间戳）
        if (
          event.type === "message.delta" ||
          event.type === "thinking.delta" ||
          event.type === "tool.started" ||
          event.type === "tool.completed"
        ) {
          blockCollector.onEvent(event);
        }
      }
      log.lap("stream_done", { runId });

      /**
       * 「空轮次」判据（实测 2026-09-17，aiping GLM-5.3-Flash 可复现）：
       * 推理模型有时**只输出内部思考**（reasoning）而没有正文、也没调工具——协议上算
       * completed，但界面上一个字都没有。这种轮次按**失败**报，并给出可读原因：否则
       * 用户对着一个「成功但空白」的对话只能猜，也拿不到任何重试信号。
       */
      if (
        terminal === "completed" &&
        !blockCollector.hasVisibleContent &&
        !sawToolExecution
      ) {
        const reason =
          "模型本轮没有返回任何内容（可能只输出了内部思考或触发内容过滤）。请重试一次，或换个说法。";
        log.error("run_empty_output", { runId });
        const emptyEvent = {
          error: { code: "run_failed" as const, message: reason },
          runId,
          timestamp: new Date().toISOString(),
          type: "run.failed" as const,
        };
        services.eventBuffer?.push(canvasId, emptyEvent);
        connectionManager.pushToCanvas(canvasId, emptyEvent);
        failureMessage = reason;
        terminal = "failed";
      }

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
          !scopeHandle &&
          services.chatService &&
          blockCollector.hasVisibleContent
        ) {
          try {
            await services.chatService.createMessage(
              authenticatedUser,
              payload.sessionId,
              {
                role: "assistant",
                content: blockCollector.text,
                contentBlocks: [...blockCollector.blocks],
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
