import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

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
  const sockets = new Map<
    string,
    { readyState: number; send: (d: string) => void }
  >();
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
  /**
   * 终端会话的 cwd 解析替身。默认落到调用方给的临时目录；
   * `deny: true` 时抛错（模拟「画布不属于这个工作区」的 404）。
   */
  const workDirState = { dir: "", deny: false };
  const codeGitService = {
    terminalWorkDir: async () => {
      if (workDirState.deny) throw new Error("画布不存在。");
      return workDirState.dir;
    },
  };
  return {
    connectionManager,
    agentRuns,
    auth,
    sockets,
    codeGitService,
    workDirState,
  };
}

async function startServer() {
  const app = Fastify();
  await app.register(websocket);
  const stubs = makeStubs();
  registerWsRoute(app, {
    connectionManager: stubs.connectionManager as never,
    agentRuns: stubs.agentRuns as never,
    auth: stubs.auth as never,
    codeGitService: stubs.codeGitService as never,
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
        JSON.stringify({
          type: "command",
          action: "agent.cancel",
          payload: {},
        }),
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
      expect(got!.includes("command.ack") || got!.includes("run.failed")).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });
});


/**
 * 终端会话这条 WS 通道的端到端（真 shell + 真 socket）：起会话 → 输入 → 收到输出 → 结束。
 *
 * 单元层面 `terminal-session` 已经验过常驻 shell 的性质（cd 保留、REPL）；这里验的是
 * **接线**：命令解析、归属校验、ack 与 output/exit 的投递、以及连接断开时收掉会话。
 */
describe("终端会话（WS 通道）", () => {
  /** 连上并返回一个「发命令 + 等消息」的小客户端。 */
  async function connect(port: number) {
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws?token=t&connectionId=c-${Date.now()}`,
    );
    const received: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      match: (msg: Record<string, unknown>) => boolean;
      resolve: (msg: Record<string, unknown>) => void;
    }> = [];
    client.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      received.push(msg);
      for (const waiter of [...waiters]) {
        if (waiter.match(msg)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(msg);
        }
      }
    });
    await new Promise<void>((resolve) => client.on("open", () => resolve()));
    return {
      client,
      received,
      /** 发一条命令并等第一条满足条件的回传（超时即抛，便于定位）。 */
      async sendAndWait(
        payload: Record<string, unknown>,
        match: (msg: Record<string, unknown>) => boolean,
        timeoutMs = 15_000,
      ): Promise<Record<string, unknown>> {
        const pending = new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`等待回传超时；已收到：${JSON.stringify(received)}`)),
            timeoutMs,
          );
          waiters.push({
            match,
            resolve: (msg) => {
              clearTimeout(timer);
              resolve(msg);
            },
          });
        });
        client.send(JSON.stringify(payload));
        return pending;
      },
    };
  }

  const isAck = (msg: Record<string, unknown>) =>
    msg.type === "command.ack" && msg.action === "terminal.start";

  it("起会话拿到 ack；输入的命令原样回到输出；stop 后回 exit", async () => {
    const { app, port, stubs } = await startServer();
    const dir = mkdtempSync(join(tmpdir(), "kfw-ws-term-"));
    stubs.workDirState.dir = dir;
    const session = await connect(port);
    try {
      const ack = await session.sendAndWait(
        {
          type: "command",
          action: "terminal.start",
          payload: { sessionId: "t1", canvasId: "canvas-1" },
        },
        isAck,
      );
      expect((ack.payload as { sessionId: string }).sessionId).toBe("t1");

      // 输入一条命令：真 shell 的输出经 terminal.output 回来
      const output = await session.sendAndWait(
        {
          type: "command",
          action: "terminal.input",
          payload: { sessionId: "t1", data: "echo WS_TERM_OK" },
        },
        (msg) =>
          msg.type === "terminal.output" &&
          String(msg.data).includes("WS_TERM_OK"),
      );
      expect(output.sessionId).toBe("t1");

      const exit = await session.sendAndWait(
        {
          type: "command",
          action: "terminal.stop",
          payload: { sessionId: "t1" },
        },
        (msg) => msg.type === "terminal.exit",
      );
      expect(exit.sessionId).toBe("t1");
    } finally {
      session.client.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);

  it("同一个 sessionId 重复 start 复用会话（重连重放不该多起一条 shell）", async () => {
    const { app, port, stubs } = await startServer();
    const dir = mkdtempSync(join(tmpdir(), "kfw-ws-term-"));
    stubs.workDirState.dir = dir;
    const session = await connect(port);
    try {
      await session.sendAndWait(
        {
          type: "command",
          action: "terminal.start",
          payload: { sessionId: "t1", canvasId: "canvas-1" },
        },
        isAck,
      );
      const again = await session.sendAndWait(
        {
          type: "command",
          action: "terminal.start",
          payload: { sessionId: "t1", canvasId: "canvas-1" },
        },
        isAck,
      );
      expect((again.payload as { reused?: boolean }).reused).toBe(true);
    } finally {
      session.client.close();
      await app.close();
      // 断开后服务端异步收会话：等进程退干净再删目录（否则 EBUSY）
      await new Promise((resolve) => setTimeout(resolve, 1500));
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }, 30_000);

  it("画布不属于这个工作区：起会话被拒并给出可读原因（不摆一个空终端）", async () => {
    const { app, port, stubs } = await startServer();
    stubs.workDirState.deny = true;
    const session = await connect(port);
    try {
      const exit = await session.sendAndWait(
        {
          type: "command",
          action: "terminal.start",
          payload: { sessionId: "t1", canvasId: "别人的画布" },
        },
        (msg) => msg.type === "terminal.exit",
      );
      expect(String(exit.reason)).toContain("画布不存在");
    } finally {
      session.client.close();
      await app.close();
    }
  }, 30_000);

  it("连接断开：会话被收掉（不留孤儿 shell 进程）", async () => {
    const { app, port, stubs } = await startServer();
    const dir = mkdtempSync(join(tmpdir(), "kfw-ws-term-"));
    stubs.workDirState.dir = dir;
    const session = await connect(port);
    try {
      await session.sendAndWait(
        {
          type: "command",
          action: "terminal.start",
          payload: { sessionId: "t1", canvasId: "canvas-1" },
        },
        isAck,
      );
      session.client.close();
      // 断开后服务端收会话：等一小会儿再删目录，删得掉即说明进程退了
      await new Promise((resolve) => setTimeout(resolve, 1500));
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } finally {
      await app.close();
    }
  }, 30_000);
});
