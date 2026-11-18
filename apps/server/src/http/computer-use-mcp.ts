import { randomUUID } from "node:crypto";
import {
  computerUseMcpQuerySchema,
  computerUseMcpTransportErrorSchema,
} from "@kenfutwork/shared";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CancelledNotificationSchema,
  ErrorCode,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ComputerUseMcpExport } from "../features/computer-use/mcp-server.js";
import {
  LocalAccessError,
  type LocalAccessService,
} from "../features/local-access/types.js";
import { LocalInstanceError } from "../features/local-instance/service.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../features/local-instance/types.js";
import { adaptSdkTransport } from "../features/mcp/sdk-transport.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import { ToolDeniedError } from "../kernel/context.js";

interface Session {
  id: string;
  actor: LocalActor;
  runId: string;
  controller: AbortController;
  server?: ReturnType<ComputerUseMcpExport["createServer"]>;
  transport?: StreamableHTTPServerTransport;
}

function sendProtocolError(
  reply: FastifyReply,
  status: number,
  message: string,
) {
  return reply.code(status).send(
    computerUseMcpTransportErrorSchema.parse({
      jsonrpc: "2.0",
      id: null,
      error: { code: ErrorCode.InvalidRequest, message },
    }),
  );
}

/** 每个SDK Protocol保留请求取消控制器；不以无状态transport伪装跨POST取消。 */
export function registerComputerUseMcpRoutes(
  app: FastifyInstance,
  deps: {
    localAccess: Pick<LocalAccessService, "authenticate" | "onRevoked">;
    localInstance: LocalInstanceService;
    settings: Pick<SettingsService, "getInstanceSettings">;
    exporter: ComputerUseMcpExport;
  },
) {
  const sessions = new Map<string, Session>();
  let closed = false;
  const closeSession = async (session: Session) => {
    sessions.delete(session.id);
    session.controller.abort();
    await session.server?.close();
  };
  const closeWhere = async (matches: (session: Session) => boolean) => {
    const results = await Promise.allSettled(
      [...sessions.values()].filter(matches).map(closeSession),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "桌面MCP会话关闭失败。");
  };
  const unsubscribe = deps.localAccess.onRevoked((clientId) =>
    closeWhere((session) => session.actor.accessClientId === clientId),
  );
  const dispose = async () => {
    closed = true;
    unsubscribe();
    await closeWhere(() => true);
  };
  app.addHook("preClose", dispose);

  const createSession = async (actor: LocalActor, runId: string) => {
    if (closed) throw new Error("桌面MCP出口正在关闭。");
    deps.exporter.assertRun(actor, runId);
    const id = randomUUID();
    const session: Session = {
      id,
      actor,
      runId,
      controller: new AbortController(),
    };
    sessions.set(id, session);
    try {
      const settings = await deps.settings.getInstanceSettings(
        actor,
        actor.instanceId,
      );
      session.controller.signal.throwIfAborted();
      deps.exporter.assertRun(actor, runId);
      const server = deps.exporter.createServer(actor, runId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        keepAliveMs: settings.computerUseMcpKeepAliveMs,
      });
      session.server = server;
      session.transport = transport;
      server.onclose = () => {
        sessions.delete(id);
        session.controller.abort();
      };
      await server.connect(adaptSdkTransport(transport));
      session.controller.signal.throwIfAborted();
      deps.exporter.assertRun(actor, runId);
      return session;
    } catch (error) {
      await closeSession(session);
      throw error;
    }
  };

  const resolveRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Session | undefined> => {
    const actor = await deps.localAccess.authenticate(request);
    if (!actor) {
      sendProtocolError(reply, 401, "本机访问未授权。");
      return;
    }
    await deps.localInstance.resolve(actor);
    const query = computerUseMcpQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendProtocolError(reply, 400, "必须指定真实活动Run。");
      return;
    }
    const { runId } = query.data;
    const id = request.headers["mcp-session-id"];
    if (typeof id === "string") {
      const session = sessions.get(id);
      if (!session) {
        sendProtocolError(reply, 404, "MCP会话不存在或已结束。");
        return;
      }
      if (
        session.runId !== runId ||
        session.actor.instanceId !== actor.instanceId ||
        session.actor.accessClientId !== actor.accessClientId
      ) {
        sendProtocolError(reply, 403, "MCP会话不属于当前连接或Run。");
        return;
      }
      deps.exporter.assertRun(actor, runId);
      if (!session.transport) {
        sendProtocolError(reply, 409, "MCP会话正在初始化。");
        return;
      }
      return session;
    }
    if (
      id !== undefined ||
      request.method !== "POST" ||
      !isInitializeRequest(request.body)
    ) {
      sendProtocolError(reply, 400, "必须先初始化MCP会话。");
      return;
    }
    return createSession(actor, runId);
  };

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    let session: Session | undefined;
    try {
      session = await resolveRequest(request, reply);
    } catch (error) {
      if (
        error instanceof LocalAccessError ||
        error instanceof LocalInstanceError
      )
        return sendProtocolError(reply, error.statusCode, error.message);
      return sendProtocolError(
        reply,
        409,
        error instanceof ToolDeniedError
          ? error.message
          : "Run或MCP出口已不可用。",
      );
    }
    if (!session?.transport) return;
    // hijack后的标准SDK响应也须保留第一方CORS头，浏览器才能读取原session nonce。
    reply.header("access-control-expose-headers", "Mcp-Session-Id");
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(name, value);
    reply.hijack();
    try {
      await session.transport.handleRequest(
        request.raw,
        reply.raw,
        request.body,
      );
      // 原Protocol先处理signal；本版本无eventStore，关闭已取消流不会重连/重放。
      const cancelled = CancelledNotificationSchema.safeParse(request.body);
      if (cancelled.success && cancelled.data.params.requestId !== undefined)
        session.transport.closeSSEStream(cancelled.data.params.requestId);
    } finally {
      if (!session.server?.getClientCapabilities()) await closeSession(session);
    }
  };
  app.post("/api/computer-use/mcp", handle);
  app.get("/api/computer-use/mcp", handle);
  app.delete("/api/computer-use/mcp", handle);
  return {
    dispose,
    closeRun: (runId: string) => {
      return closeWhere((session) => session.runId === runId);
    },
  };
}
