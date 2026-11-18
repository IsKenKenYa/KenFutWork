import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";

interface SocketState {
  activeRequests: number;
  upgraded: boolean;
  closed(): void;
}

/** 本机客户端可能只预连接TCP；Node的HTTP空闲连接清理不会认领这些socket。 */
export function registerLocalHttpLifecycle(app: FastifyInstance): void {
  const server = app.server;
  const sockets = new Map<Socket, SocketState>();
  const responseCleanups = new Set<() => void>();
  let closing = false;

  const destroyIdle = (socket: Socket, state: SocketState) => {
    if (closing && state.activeRequests === 0 && !state.upgraded)
      socket.destroy();
  };
  const connected = (socket: Socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    const state: SocketState = {
      activeRequests: 0,
      upgraded: false,
      closed: () => sockets.delete(socket),
    };
    sockets.set(socket, state);
    socket.once("close", state.closed);
  };
  const requested = (request: IncomingMessage, response: ServerResponse) => {
    const socket = request.socket;
    const state = sockets.get(socket);
    if (!state) return;
    state.activeRequests += 1;
    let completed = false;
    const detach = () => {
      response.off("finish", complete);
      response.off("close", complete);
      responseCleanups.delete(detach);
    };
    const complete = () => {
      if (completed) return;
      completed = true;
      detach();
      state.activeRequests -= 1;
      destroyIdle(socket, state);
    };
    responseCleanups.add(detach);
    response.once("finish", complete);
    response.once("close", complete);
  };
  const upgraded = (request: IncomingMessage) => {
    const state = sockets.get(request.socket);
    if (state) state.upgraded = true;
  };

  server.on("connection", connected);
  // 先记在途请求再由Fastify派发，避免同步响应先finish而漏掉计数释放。
  server.prependListener("request", requested);
  app.addHook("onReady", async () => {
    // 只保护已有WS消费者，不能因追踪生命周期新增一个upgrade协议入口。
    if (server.listenerCount("upgrade") > 0)
      server.prependListener("upgrade", upgraded);
  });
  app.addHook("preClose", async () => {
    closing = true;
    for (const [socket, state] of sockets) destroyIdle(socket, state);
  });
  app.addHook("onClose", async () => {
    server.off("connection", connected);
    server.off("request", requested);
    server.off("upgrade", upgraded);
    for (const detach of responseCleanups) detach();
    for (const [socket, state] of sockets) socket.off("close", state.closed);
    sockets.clear();
  });
}
