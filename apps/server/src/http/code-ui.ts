import {
  codeUiRpcRequestSchema,
  codeUiRpcResponseSchema,
  codeUiSnapshotParamsSchema,
  codeUiWorkspaceListSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { CodeTerminalError } from "../features/code-terminal/service.js";
import { CodeAttachmentError } from "../features/code-ui/attachments/types.js";
import { CodeUiHostRpcError } from "../features/code-ui/host-rpc-handler.js";
import { CodeUiRepositoryError } from "../features/code-ui/repository.js";
import type { CodeUiService } from "../features/code-ui/service.js";
import { ExecutionScopeError } from "../features/execution/scope-service.js";
import type {
  LocalAccessService,
  LocalAccessVerifier,
} from "../features/local-access/types.js";
import { LocalInstanceMaintenanceError } from "../features/local-instance/service.js";
import { ModelProviderServiceError } from "../features/model-providers/model-provider-service.js";
import { PluginRegistryError } from "../features/plugins/plugin-registry-service.js";
import { ProjectServiceError } from "../features/projects/project-service.js";
import { isZodError } from "./zod-error.js";

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof CodeUiHostRpcError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof LocalInstanceMaintenanceError)
    return reply
      .code(503)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof PluginRegistryError)
    return reply
      .code(
        error.report
          ? 422
          : error.code === "system_plugin"
            ? 403
            : error.code === "plugin_not_found" ||
                error.code === "not_installed"
              ? 404
              : 400,
      )
      .send({
        error: {
          code: error.report ? "plugin_incompatible" : error.code,
          message: error.message,
        },
        ...(error.report ? { report: error.report } : {}),
      });
  if (error instanceof ProjectServiceError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof CodeAttachmentError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof ModelProviderServiceError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof CodeTerminalError)
    return reply.code(error.statusCode).send({
      error: { code: `code_terminal_${error.code}`, message: error.message },
    });
  if (error instanceof ExecutionScopeError)
    return reply
      .code(error.code === "path_denied" ? 404 : error.statusCode)
      .send({
        error: { code: `code_ui_${error.code}`, message: error.message },
      });
  if (isZodError(error))
    return reply.code(400).send({
      error: {
        code: "invalid_code_ui_request",
        message: "Code 宿主请求不符合原协议",
        details: error.issues,
      },
    });
  if (error instanceof CodeUiRepositoryError)
    return reply.code(error.code === "not_found" ? 404 : 409).send({
      error: { code: `code_ui_${error.code}`, message: error.message },
    });
  return reply.code(500).send({
    error: {
      code: "code_ui_error",
      message: error instanceof Error ? error.message : "Code 宿主请求失败",
    },
  });
}

async function writeSseFrame(
  reply: FastifyReply,
  frame: string,
): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  if (reply.raw.write(frame)) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      reply.raw.off("drain", finish);
      reply.raw.off("close", finish);
      reply.raw.off("finish", finish);
      resolve();
    };
    reply.raw.once("drain", finish);
    reply.raw.once("close", finish);
    reply.raw.once("finish", finish);
  });
}

export async function registerCodeUiRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: LocalAccessVerifier &
      Partial<Pick<LocalAccessService, "onRevoked">>;
    service: Pick<
      CodeUiService,
      | "openConnection"
      | "closeConnections"
      | "listWorkspaces"
      | "getSnapshot"
      | "hostRpc"
      | "transportRpc"
      | "modelViews"
      | "createSession"
    >;
  },
) {
  const eventStreams = new Set<() => Promise<void>>();
  app.addHook("preClose", async () => {
    console.log(
      `[shutdown] Code事件流preClose开始：${eventStreams.size}个连接。`,
    );
    const closing = await Promise.allSettled(
      [...eventStreams].map((close) => close()),
    );
    const failures = closing.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    console.log(
      `[shutdown] Code事件流释放结束：剩余${eventStreams.size}个连接，失败${failures.length}项。`,
    );
    try {
      await deps.service.closeConnections();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, "Code事件连接资源尚未确认关闭。");
    }
    console.log("[shutdown] Code事件流preClose完成。");
  });
  app.get("/api/code-ui/events", async (request, reply) => {
    const user = await deps.localAccess.authenticate(request);
    if (!user?.accessClientId) {
      return reply.code(401).send({
        error: {
          code: "unauthenticated",
          message: "本机连接凭据缺失或已失效。",
        },
      });
    }
    if (!deps.localAccess.onRevoked) {
      return reply.code(503).send({
        error: {
          code: "service_unavailable",
          message: "本机接入撤权通知服务不可用。",
        },
      });
    }
    type Connection = Awaited<ReturnType<CodeUiService["openConnection"]>>;
    let connection: Connection | undefined;
    let opening: Promise<Connection> | undefined;
    let closed = false;
    let started = false;
    let unsubscribe = () => {};
    let disposed: Promise<void> | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    let keepAliveInFlight = false;
    const close = (): Promise<void> => {
      if (disposed) return disposed;
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
      unsubscribe = () => {};
      request.raw.socket.off("close", disconnected);
      reply.raw.off("close", disconnected);
      if (started && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
      disposed = (async () => {
        if (opening) {
          try {
            connection = await opening;
          } catch {
            return;
          }
        }
        await connection?.dispose();
      })().then(() => {
        eventStreams.delete(close);
      });
      return disposed;
    };
    const disconnected = () => {
      void close().catch((error: unknown) =>
        request.log.warn({ error }, "Code连接资源尚未确认关闭"),
      );
    };
    const sendAuthenticated = async (frame: string) => {
      if (closed || !started) return;
      const current = await deps.localAccess.authenticate(request).catch(() => {
        request.log.warn("本机事件流接入校验失败，连接已关闭。");
        return null;
      });
      if (
        !current ||
        current.instanceId !== user.instanceId ||
        current.accessClientId !== user.accessClientId
      ) {
        // Controller释放会等待当前发送队列；帧内只启动关闭，外部撤权/preClose仍join同一Promise。
        disconnected();
        return;
      }
      if (closed) return;
      await writeSseFrame(reply, frame);
    };
    eventStreams.add(close);
    request.raw.socket.once("close", disconnected);
    reply.raw.once("close", disconnected);
    unsubscribe = deps.localAccess.onRevoked((clientId) => {
      if (clientId === user.accessClientId) return close();
    });
    if (closed) {
      unsubscribe();
      unsubscribe = () => {};
    }
    try {
      // 先订阅撤权，再查当前授权，堵住握手与监听注册之间的撤权空窗。
      const current = await deps.localAccess.authenticate(request);
      if (
        closed ||
        current?.accessClientId !== user.accessClientId ||
        current.instanceId !== user.instanceId
      ) {
        await close();
        return reply.code(401).send({
          error: { code: "unauthenticated", message: "本机连接凭据已失效。" },
        });
      }
      opening = deps.service.openConnection(
        user,
        (event) => sendAuthenticated(`data: ${JSON.stringify(event)}\n\n`),
        disconnected,
      );
      connection = await opening;
      if (closed || reply.raw.destroyed) {
        await close();
        if (!reply.raw.destroyed) {
          return reply.code(401).send({
            error: { code: "unauthenticated", message: "本机连接凭据已失效。" },
          });
        }
        return reply;
      }
      reply.hijack();
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(key, value);
      }
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
      started = true;
      await sendAuthenticated(
        `data: ${JSON.stringify({
          event: "ready",
          hello: connection.hello,
          reconnectDelayMs: connection.reconnectDelayMs,
        })}\n\n`,
      );
      if (closed) return reply;
      // WebKit慢消费时可能暂存尾部网络数据；标准SSE注释推动交付，也检查闲置连接授权。
      keepAlive = setInterval(() => {
        if (closed || keepAliveInFlight) return;
        keepAliveInFlight = true;
        void sendAuthenticated(": keepalive\n\n")
          .catch((error: unknown) => {
            request.log.warn({ error }, "Code事件流保活失败，连接已关闭。");
            disconnected();
          })
          .finally(() => {
            keepAliveInFlight = false;
          });
      }, 5_000);
      keepAlive.unref();
    } catch (error) {
      await close();
      if (started || reply.raw.destroyed) return reply;
      return sendError(reply, error);
    }
  });
  app.get("/api/code-ui/workspaces", async (request, reply) => {
    const user = await deps.localAccess.authenticate(request);
    if (!user)
      return reply.code(401).send({
        error: {
          code: "unauthenticated",
          message: "请从桌面重新建立本机连接",
        },
      });
    try {
      return codeUiWorkspaceListSchema.parse({
        workspaces: await deps.service.listWorkspaces(user),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get("/api/code-ui/sessions/:sessionId", async (request, reply) => {
    const user = await deps.localAccess.authenticate(request);
    if (!user)
      return reply.code(401).send({
        error: {
          code: "unauthenticated",
          message: "请从桌面重新建立本机连接",
        },
      });
    try {
      const { sessionId } = codeUiSnapshotParamsSchema.parse(request.params);
      return { snapshot: await deps.service.getSnapshot(user, sessionId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post("/api/code-ui/rpc", async (request, reply) => {
    const user = await deps.localAccess.authenticate(request);
    if (!user)
      return reply.code(401).send({
        error: {
          code: "unauthenticated",
          message: "请从桌面重新建立本机连接",
        },
      });
    try {
      const { service, method, args, connectionId } =
        codeUiRpcRequestSchema.parse(request.body);
      const hostResult = await deps.service.hostRpc(
        user,
        service,
        method,
        args,
        connectionId,
      );
      if (hostResult) return codeUiRpcResponseSchema.parse(hostResult);
      if (service === "zcodeAgentService") {
        const prepared = await deps.service.transportRpc(
          user,
          connectionId,
          method,
          args,
        );
        if (prepared) {
          if (prepared.publish) {
            const publish = prepared.publish;
            let published = false;
            const publishAfterResponse = () => {
              if (published) return;
              published = true;
              reply.raw.off("finish", publishAfterResponse);
              reply.raw.off("close", publishAfterResponse);
              void publish().catch((error: unknown) =>
                request.log.warn({ error }, "Code 订阅通知失败"),
              );
            };
            // 输入已经持久认领，HTTP响应丢失不能把它留成永不派发的accepted状态。
            if (reply.raw.destroyed || reply.raw.writableEnded)
              publishAfterResponse();
            else {
              reply.raw.once("finish", publishAfterResponse);
              reply.raw.once("close", publishAfterResponse);
            }
          }
          return codeUiRpcResponseSchema.parse({ result: prepared.result });
        }
      }
      let result: unknown;
      if (service === "providerSettingsService" && method === "getView")
        result = (await deps.service.modelViews(user)).settings;
      else if (service === "modelSelectionService" && method === "getView") {
        const input = args[0] as
          | { selection?: protocol.SessionConfigState["modelSelection"] | null }
          | undefined;
        result = (await deps.service.modelViews(user, input?.selection))
          .selection;
      } else if (
        service === "zcodeAgentService" &&
        method === "sendConversationCommandV4"
      ) {
        const target = args[0] as { envelope?: unknown } | undefined;
        const parsed = protocol.parseCommandEnvelope(target?.envelope);
        if (!parsed.ok) throw parsed.error;
        if (parsed.envelope.type !== "createSession")
          return reply.code(501).send({
            error: {
              code: "code_ui_command_unavailable",
              message: `Code 命令 ${parsed.envelope.type} 尚未接通`,
            },
          });
        result = await deps.service.createSession(user, parsed.envelope);
      } else
        return reply.code(501).send({
          error: {
            code: "code_ui_method_unavailable",
            message: `Code 宿主接口 ${service}.${method} 尚未接通`,
          },
        });
      return codeUiRpcResponseSchema.parse({ result });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
