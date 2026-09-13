import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";

import { registerWsRoute } from "./handler.js";

/**
 * WS 早期消息回归测试。
 *
 * 曾经的缺陷：`socket.on("message")` 只能在**异步鉴权之后**挂上，而客户端在 `onopen`
 * 后立刻发命令。窗口期到达的消息被静默丢弃——表现为「点了发送但界面永远停在生成中」，
 * 且服务端连一行日志都没有（当时的 probe 拿到 0 个事件）。
 *
 * 这些用例发送的时机是 **open 回调内同步发出**，即最坏时序；修复前必然超时。
 */

function makeStubs() {
  const sockets = new Map<string, { readyState: number; send: (d: string) => void }>();
  /**
   * 用 Proxy 兜底：连接管理器的方法随 run 流程演进而增减，逐个列举会让测试随实现变化而碎。
   * `register`/`sendTo`/`remove` 必须**真的投递**（否则 ack 到不了客户端，测试假失败）。
   */
  const connectionManager = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "register") {
          return (
            connectionId: string,
            _userId: string,
            socket: { readyState: number; send: (d: string) => void },
          ) => {
            sockets.set(connectionId, socket);
          };
        }
        if (prop === "remove") {
          return (connectionId: string) => {
            sockets.delete(connectionId);
          };
        }
        if (prop === "sendTo") {
          return (connectionId: string, message: unknown) => {
            const socket = sockets.get(connectionId);
            if (!socket || socket.readyState !== 1) return false;
            socket.send(JSON.stringify(message));
            return true;
          };
        }
        return () => undefined;
      },
    },
  );
  const agentRuns = {
    createRun: () => ({ runId: "run-1" }),
    cancelRun: () => true,
    // eslint-disable-next-line require-yield
    streamRun: async function* () {},
  };
  const auth = {
    authenticate: async () => ({ id: "user-1", accessToken: "token" }),
  };
  return { connectionManager, agentRuns, auth, sockets };
}

async function startServer() {
  const app = Fastify();
  await app.register(websocket);
  const stubs = makeStubs();
  registerWsRoute(app, {
    connectionManager: stubs.connectionManager as never,
    agentRuns: stubs.agentRuns as never,
    auth: stubs.auth as never,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return { app, port, stubs };
}

/** 连上后立刻发送 raw，返回服务端第一条回传消息。 */
async function sendImmediatelyOnOpen(
  port: number,
  raw: string,
): Promise<{ got: string | null }> {
  const client = new WebSocket(
    `ws://127.0.0.1:${port}/api/ws?token=t&connectionId=c-${Date.now()}`,
  );
  const got = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000);
    client.on("open", () => {
      // 最坏时序：open 回调内同步发出，此时服务端可能还没挂上 message 监听器
      client.send(raw);
    });
    client.on("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    client.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  client.close();
  return { got };
}

describe("WS 早期消息不丢失（回归）", () => {
  it("open 后立即发送的非法 JSON 会被处理并回错误", async () => {
    const { app, port } = await startServer();
    try {
      const { got } = await sendImmediatelyOnOpen(port, "not-json");
      expect(got).not.toBeNull();
      expect(got).toContain("Invalid JSON");
    } finally {
      await app.close();
    }
  });

  it("open 后立即发送的合法 action + 非法 payload 会回命令格式错误", async () => {
    const { app, port } = await startServer();
    try {
      const { got } = await sendImmediatelyOnOpen(
        port,
        JSON.stringify({ type: "command", action: "agent.cancel", payload: {} }),
      );
      expect(got).not.toBeNull();
      expect(got).toContain("Invalid command format");
    } finally {
      await app.close();
    }
  });

  it("open 后立即发送的合法 agent.run 会被受理（出现 command.ack 或失败事件）", async () => {
    const { app, port } = await startServer();
    try {
      const { got } = await sendImmediatelyOnOpen(
        port,
        JSON.stringify({
          type: "command",
          action: "agent.run",
          payload: {
            sessionId: "s-1",
            conversationId: "c-1",
            prompt: "hi",
          },
        }),
      );
      expect(got).not.toBeNull();
      // 受理即回 ack；若后续构建失败则回 run.failed 事件——两者都证明消息没被丢弃
      expect(
        got!.includes("command.ack") || got!.includes("run.failed"),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
