import { once } from "node:events";
import { Agent, type IncomingMessage, request } from "node:http";
import { Socket } from "node:net";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { registerLocalHttpLifecycle } from "./http-lifecycle.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

async function listen(app: FastifyInstance) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("回环HTTP服务未取得TCP端口。");
  return { host: "127.0.0.1", port: address.port };
}

async function connectRaw(
  app: FastifyInstance,
  endpoint: { host: string; port: number },
  socket = new Socket(),
) {
  const accepted = once(app.server, "connection");
  const connected = once(socket, "connect");
  socket.connect(endpoint);
  await Promise.all([accepted, connected]);
  return socket;
}

function requestHttp(
  endpoint: { host: string; port: number },
  path: string,
  agent: Agent,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ ...endpoint, path, agent }, resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function readBody(response: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of response) body += chunk.toString();
  return body;
}

describe("本机HTTP/TCP停机生命周期", () => {
  it("没有发送HTTP请求的真实TCP预连接不会吊住app.close", async () => {
    const app = Fastify();
    registerLocalHttpLifecycle(app);
    const endpoint = await listen(app);
    let socket: Socket | undefined;
    try {
      socket = await connectRaw(app, endpoint);
      const disconnected = once(socket, "close");
      await app.close();
      await disconnected;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket?.destroy();
      await app.close();
    }
  });

  it("已完成HTTP的keep-alive连接关闭，客户端仍收到完整响应", async () => {
    const app = Fastify();
    registerLocalHttpLifecycle(app);
    app.get("/complete", async () => "完整响应");
    const endpoint = await listen(app);
    const agent = new Agent({ keepAlive: true });
    try {
      const response = await requestHttp(endpoint, "/complete", agent);
      const socket = response.socket;
      if (!socket) throw new Error("HTTP响应没有真实TCP连接。");
      expect(await readBody(response)).toBe("完整响应");
      const disconnected = once(socket, "close");
      await app.close();
      await disconnected;
      expect(socket.destroyed).toBe(true);
    } finally {
      agent.destroy();
      await app.close();
    }
  });

  it("回收预连接而保留活动stream，等待消费者发送ack后完成停机", async () => {
    const app = Fastify();
    registerLocalHttpLifecycle(app);
    const preClosing = latch();
    let streamReply: FastifyReply | undefined;
    let finished = false;
    app.get("/stream", async (_request, reply) => {
      streamReply = reply;
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write("data: started\n\n");
    });
    app.addHook("preClose", async () => preClosing.release());
    const endpoint = await listen(app);
    const agent = new Agent({ keepAlive: true });
    let preconnected: Socket | undefined;
    try {
      preconnected = await connectRaw(app, endpoint);
      const preconnectionClosed = once(preconnected, "close");
      const response = await requestHttp(endpoint, "/stream", agent);
      const socket = response.socket;
      if (!socket || !streamReply)
        throw new Error("活动stream没有真实连接或响应句柄。");
      const body = readBody(response);
      const shutdown = app.close().then(() => {
        finished = true;
      });
      await preClosing.promise;
      await preconnectionClosed;
      expect(preconnected.destroyed).toBe(true);
      expect(socket.destroyed).toBe(false);
      expect(finished).toBe(false);
      streamReply.raw.end("data: shutdown-ack\n\n");
      expect(await body).toBe("data: started\n\ndata: shutdown-ack\n\n");
      await shutdown;
      expect(finished).toBe(true);
    } finally {
      streamReply?.raw.end();
      preconnected?.destroy();
      agent.destroy();
      await app.close();
    }
  });

  it("同一TCP上的流水线请求计数独立，先完成一个响应不会杀掉另一条stream", async () => {
    const app = Fastify();
    registerLocalHttpLifecycle(app);
    const admitted = latch();
    const preClosing = latch();
    let firstReply: FastifyReply | undefined;
    let streamReply: FastifyReply | undefined;
    let serverSocket: Socket | undefined;
    app.get("/first", async (_request, reply) => {
      firstReply = reply;
      reply.hijack();
      if (streamReply) admitted.release();
    });
    app.get("/stream", async (incoming, reply) => {
      serverSocket = incoming.raw.socket;
      streamReply = reply;
      reply.hijack();
      if (firstReply) admitted.release();
    });
    app.addHook("preClose", async () => preClosing.release());
    const endpoint = await listen(app);
    const client = await connectRaw(app, endpoint);
    let body = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      body += chunk;
    });
    try {
      const disconnected = once(client, "close");
      client.write(
        "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\nGET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n",
      );
      await admitted.promise;
      if (!firstReply || !streamReply || !serverSocket)
        throw new Error("流水线请求没有被真实HTTP服务同时接纳。");
      const shutdown = app.close();
      await preClosing.promise;
      const firstFinished = once(firstReply.raw, "finish");
      firstReply.raw.end("first-ack");
      await firstFinished;
      expect(serverSocket.destroyed).toBe(false);
      streamReply.raw.end("stream-ack");
      await shutdown;
      await disconnected;
      expect(body).toContain("first-ack");
      expect(body).toContain("stream-ack");
    } finally {
      firstReply?.raw.end();
      streamReply?.raw.end();
      client.destroy();
      await app.close();
    }
  });

  it("closing后新预连接立即关闭", async () => {
    const app = Fastify();
    registerLocalHttpLifecycle(app);
    const preClosing = latch();
    const continueClosing = latch();
    app.addHook("preClose", async () => {
      preClosing.release();
      await continueClosing.promise;
    });
    const endpoint = await listen(app);
    const socket = new Socket();
    try {
      const shutdown = app.close();
      await preClosing.promise;
      const disconnected = once(socket, "close");
      await connectRaw(app, endpoint, socket);
      await disconnected;
      expect(socket.destroyed).toBe(true);
      continueClosing.release();
      await shutdown;
    } finally {
      continueClosing.release();
      socket.destroy();
      await app.close();
    }
  });

  it("onReady保护已有真实WS升级，由原消费者发送ack并正常关闭", async () => {
    const app = Fastify();
    registerLocalHttpLifecycle(app);
    let peer: WebSocket | undefined;
    await app.register(websocket, {
      preClose: async () => {
        if (!peer) throw new Error("原WS消费者未取得连接。");
        expect(peer.readyState).toBe(WebSocket.OPEN);
        const closed = once(peer, "close");
        peer.send("shutdown-ack");
        peer.close(1000, "本机宿主关闭");
        await closed;
        await new Promise<void>((resolve, reject) =>
          app.websocketServer.close((error) =>
            error ? reject(error) : resolve(),
          ),
        );
      },
    });
    app.get("/ws", { websocket: true }, (socket) => {
      peer = socket;
    });
    const endpoint = await listen(app);
    const client = new WebSocket(`ws://${endpoint.host}:${endpoint.port}/ws`);
    try {
      await once(client, "open");
      const acknowledgment = new Promise<string>((resolve) =>
        client.once("message", (data) => resolve(data.toString())),
      );
      const closed = new Promise<number>((resolve) =>
        client.once("close", (code) => resolve(code)),
      );
      await app.close();
      expect(await acknowledgment).toBe("shutdown-ack");
      expect(await closed).toBe(1000);
    } finally {
      client.terminate();
      await app.close();
    }
  });
});
