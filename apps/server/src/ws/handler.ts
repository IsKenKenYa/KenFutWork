import { randomUUID } from "node:crypto";
import type { WsCommand, WsTerminalStartCommand } from "@kenfutwork/shared";
import { wsCommandSchema, wsRpcResponseSchema } from "@kenfutwork/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { AgentRunService } from "../agent/runtime.js";
import type { ExecutionModeService } from "../features/agent-modes/execution-mode-service.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import { chunkForFrames } from "../features/code-git/terminal-session.js";
import type { CodeTerminalService } from "../features/code-terminal/types.js";
import { CodeUiRepositoryError } from "../features/code-ui/repository.js";
import type { CodeUiService } from "../features/code-ui/service.js";
import {
  ExecutionScopeError,
  type ExecutionScopes,
} from "../features/execution/scope-service.js";
import type { FlowProjectControl } from "../features/flow/project-control.js";
import type {
  LocalAccessService,
  LocalAccessVerifier,
} from "../features/local-access/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import {
  ConnectionIdentityConflictError,
  type ConnectionManager,
} from "./connection-manager.js";
import { type CanvasEventBuffer, flowEventScopeKey } from "./event-buffer.js";
import { createPipelineLogger } from "./logger.js";

type WsRunPayload = Extract<WsCommand, { action: "agent.run" }>["payload"];
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
  flowProjectControl?: Pick<FlowProjectControl, "snapshot">;
  settingsService?: SettingsService;
  threadService?: ThreadService;
  localInstance?: LocalInstanceService;
  executionScopes?: ExecutionScopes;
  codeUi?: Pick<CodeUiService, "admitExternalRun" | "cancelExternalRun">;
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
    removeRegistered = () => {
      connectionManager.remove(connectionId, socket);
    };
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
  const terminalFailure = (
    id: string,
    error: unknown,
    action?: string,
    requestId?: string,
  ) => {
    if (requestId)
      sendToClient({
        type: "error",
        requestId,
        action,
        code: "terminal_failed",
        message: error instanceof Error ? error.message : "终端操作失败",
      });
    sendToClient({
      type: "terminal.exit",
      sessionId: id,
      exitCode: null,
      reason: error instanceof Error ? error.message : String(error),
    });
  };
  const startTerminal = async (
    payload: WsTerminalStartCommand["payload"],
    requestId?: string,
  ) => {
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
      ...(requestId ? { requestId } : {}),
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
          JSON.stringify({
            type: "error",
            code: "invalid_command",
            message: "请求格式无效",
            ...(typeof obj.id === "string" && obj.id.length <= 128
              ? { requestId: obj.id }
              : {}),
            ...(typeof obj.action === "string" ? { action: obj.action } : {}),
          }),
        );
        return;
      }

      if (msg.action === "agent.run") {
        const p = msg.payload;
        void handleRunCommand(
          authenticatedUser,
          connectionId,
          p,
          agentRuns,
          connectionManager,
          options,
          msg.id,
        ).catch((error: unknown) => {
          socket.send(
            JSON.stringify({
              type: "error",
              action: msg.action,
              ...(msg.id ? { requestId: msg.id } : {}),
              ...(error instanceof CodeUiRepositoryError ||
              error instanceof ExecutionScopeError
                ? { code: error.code }
                : {}),
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      } else if (msg.action === "task.resume") {
        connectionManager.sendTo(connectionId, {
          type: "error",
          action: msg.action,
          ...(msg.id ? { requestId: msg.id } : {}),
          code: "shared_conversation_required",
          message: "请重新连接共享会话。",
        });
      } else if (msg.action === "agent.cancel") {
        log.info("run_cancel", {
          instanceId: authenticatedUser.instanceId,
          runId: msg.payload.runId,
        });
        const identity = agentRuns.getRunIdentity?.(msg.payload.runId);
        if (identity && identity.instanceId !== authenticatedUser.instanceId) {
          connectionManager.sendTo(connectionId, {
            type: "error",
            action: msg.action,
            ...(msg.id ? { requestId: msg.id } : {}),
            code: "run_not_found",
            message: "运行不存在",
          });
          return;
        }
        if (
          identity &&
          msg.payload.taskId &&
          identity.taskId !== msg.payload.taskId
        ) {
          connectionManager.sendTo(connectionId, {
            type: "error",
            action: msg.action,
            ...(msg.id ? { requestId: msg.id } : {}),
            code: "scope_mismatch",
            message: "取消目标与Task不匹配",
          });
          return;
        }
        try {
          if (!options.codeUi)
            throw new ExecutionScopeError(
              "admission_unavailable",
              "共享会话服务未加载，请重启应用后重试。",
              503,
            );
          const cancelResult = await options.codeUi.cancelExternalRun(
            authenticatedUser,
            msg.payload.runId,
            msg.payload.taskId,
          );
          connectionManager.sendTo(connectionId, {
            type: "command.ack",
            action: msg.action,
            ...(msg.id ? { requestId: msg.id } : {}),
            payload: cancelResult,
          });
        } catch (error) {
          connectionManager.sendTo(connectionId, {
            type: "error",
            action: msg.action,
            ...(msg.id ? { requestId: msg.id } : {}),
            message: error instanceof Error ? error.message : "运行停止失败。",
          });
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
          ...(msg.id ? { requestId: msg.id } : {}),
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
      } else if (msg.action === "flow.resume") {
        /**
         * flow 事件续传（P5）：作用域是本地实例（flowRun 事件没有 canvasId），
         * 与其他 flowRun 事件同一条 WS 通道；客户端按 runId + payload.seq 去重。
         */
        const scope = flowEventScopeKey(authenticatedUser.instanceId);
        log.info("flow_resume", {
          instanceId: authenticatedUser.instanceId,
          lastSeq: msg.payload.lastSeq,
        });
        const buffered =
          options.eventBuffer?.getAfter(scope, msg.payload.lastSeq) ?? [];
        const missed = [];
        for (const entry of buffered) {
          const event = entry.event;
          if (
            event.type !== "flowRun.event" ||
            !event.hostProjectId ||
            !event.hostGeneration ||
            !options.flowProjectControl
          )
            continue;
          const gate = await options.flowProjectControl.snapshot(
            authenticatedUser,
            event.hostProjectId,
          );
          if (!gate.draining && gate.generation === event.hostGeneration)
            missed.push(entry);
        }
        // ACK 先行（与 canvas.resume 同一时序口径）：客户端先注册监听再收重放
        connectionManager.sendTo(connectionId, {
          type: "command.ack",
          action: "flow.resume",
          ...(msg.id ? { requestId: msg.id } : {}),
          payload: {
            latestSeq: options.eventBuffer?.getLatestSeq(scope) ?? 0,
            replayed: missed.length,
          },
        });
        for (const entry of missed) {
          connectionManager.sendTo(connectionId, {
            type: "event",
            event: entry.event,
          });
        }
      } else if (msg.action === "terminal.start") {
        void startTerminal(msg.payload, msg.id).catch((error: unknown) =>
          terminalFailure(msg.payload.sessionId, error, msg.action, msg.id),
        );
      } else if (msg.action === "terminal.input") {
        void options.codeTerminal
          ?.write(
            authenticatedUser,
            terminalConnectionId,
            msg.payload.sessionId,
            msg.payload.data,
          )
          .then(() => {
            if (msg.id)
              sendToClient({
                type: "command.ack",
                action: msg.action,
                requestId: msg.id,
                payload: { sessionId: msg.payload.sessionId },
              });
          })
          .catch((error: unknown) =>
            terminalFailure(msg.payload.sessionId, error, msg.action, msg.id),
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
          .then(() => {
            if (msg.id)
              sendToClient({
                type: "command.ack",
                action: msg.action,
                requestId: msg.id,
                payload: { sessionId: msg.payload.sessionId },
              });
          })
          .catch((error: unknown) =>
            terminalFailure(msg.payload.sessionId, error, msg.action, msg.id),
          );
      } else if (msg.action === "terminal.stop") {
        void options.codeTerminal
          ?.stop(
            authenticatedUser,
            terminalConnectionId,
            msg.payload.sessionId,
            "客户端关闭终端",
          )
          .then(() => {
            if (msg.id)
              sendToClient({
                type: "command.ack",
                action: msg.action,
                requestId: msg.id,
                payload: { sessionId: msg.payload.sessionId },
              });
          })
          .catch((error: unknown) =>
            terminalFailure(msg.payload.sessionId, error, msg.action, msg.id),
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
  payload: WsRunPayload,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
  requestId?: string,
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
      requestId,
    );
  } finally {
    release();
  }
}

async function handleAdmittedRunCommand(
  actor: LocalActor,
  connectionId: string,
  payload: WsRunPayload,
  _agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
  requestId?: string,
) {
  const log = createPipelineLogger("agent.run", {
    instanceId: actor.instanceId,
    sessionId: payload.sessionId,
  });
  // 只记长度：prompt 是用户内容，桌面形态落本机日志、自托管形态落运维日志，都不该带上原文。
  log.info("started", { promptChars: payload.prompt.length });

  if (!services.executionScopes || !services.codeUi)
    throw new ExecutionScopeError(
      "admission_unavailable",
      "共享会话服务未加载，请重启应用后重试。",
      503,
    );
  const scope = await services.executionScopes.openTask(
    actor,
    payload.taskId ?? payload.sessionId,
  );
  if (scope.describe().taskId !== payload.sessionId)
    throw new ExecutionScopeError(
      "scope_mismatch",
      "运行必须绑定所属会话的任务。",
      409,
    );
  const admitted = await services.codeUi.admitExternalRun(
    actor,
    scope,
    payload.inputId ?? requestId ?? randomUUID(),
    payload.prompt,
    payload,
  );
  connectionManager.sendTo(connectionId, {
    type: "command.ack",
    action: "agent.run",
    ...(requestId ? { requestId } : {}),
    payload: {
      runId: admitted.runId,
      sessionId: admitted.sessionId,
      conversationId: admitted.conversationId,
      status: admitted.status,
    },
  });
  await admitted.publish();
}
