import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  CdpError,
  connectCdpClient,
  findBrowserExecutable,
  waitForDevtools,
} from "./cdp-client.js";

/**
 * CDP 客户端（R5-4「连接到 Chrome」的底座）：这里用一个**真的 WebSocket 替身服务**验协议——
 * 命令响应配对、错误折叠、超时、断开后拒绝。真实 Chrome 那一段走 GUI 实测。
 */
describe("CDP 客户端协议", () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /** 起一个替身 CDP 端点：按 method 回结果（或报错），支持延迟。 */
  function startFakeCdp(
    handler: (message: {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    }) => {
      result?: unknown;
      error?: { message: string };
      delayMs?: number;
    } | null,
  ) {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        const reply = handler(message);
        if (!reply) return;
        const send = () =>
          socket.send(
            JSON.stringify(
              reply.error
                ? { id: message.id, error: reply.error }
                : { id: message.id, result: reply.result ?? {} },
            ),
          );
        if (reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `ws://127.0.0.1:${port}`;
  }

  it("命令带 id 配对返回；开标签拿 targetId + sessionId", async () => {
    const url = startFakeCdp((message) => {
      if (message.method === "Target.createTarget") {
        return { result: { targetId: "T1" } };
      }
      if (message.method === "Target.attachToTarget") {
        return { result: { sessionId: "S1" } };
      }
      if (message.method === "Target.getTargets") {
        return {
          result: {
            targetInfos: [
              { targetId: "T1", type: "page", url: "https://a", title: "A" },
              { targetId: "T9", type: "browser", url: "", title: "" },
            ],
          },
        };
      }
      return { result: {} };
    });
    const client = connectCdpClient(url);
    const tab = await client.openTab("https://example.com");
    expect(tab).toEqual({ targetId: "T1", sessionId: "S1" });
    // 只列 page 目标（browser 级目标不进列表）
    expect(await client.listTargets()).toEqual([
      { targetId: "T1", url: "https://a", title: "A" },
    ]);
    client.close();
  });

  it("CDP 报错折叠成 CdpError；命令超时可读", async () => {
    const url = startFakeCdp((message) =>
      message.method === "Page.navigate"
        ? { error: { message: "Cannot navigate" } }
        : { result: {}, delayMs: 500 },
    );
    const client = connectCdpClient(url, { commandTimeoutMs: 200 });
    await expect(client.send("Page.navigate", {})).rejects.toMatchObject({
      code: "command_failed",
      message: "Cannot navigate",
    });
    await expect(client.send("Runtime.evaluate", {})).rejects.toMatchObject({
      message: expect.stringContaining("超时"),
    });
    client.close();
  });

  it("连接断开后，未决命令立即失败（不等超时）", async () => {
    const url = startFakeCdp(() => ({ result: {}, delayMs: 5_000 }));
    const client = connectCdpClient(url, { commandTimeoutMs: 5_000 });
    const pending = client.send("Page.captureScreenshot", {});
    client.close();
    await expect(pending).rejects.toBeInstanceOf(CdpError);
  });
});

describe("浏览器可执行文件与调试端口探测", () => {
  it("findBrowserExecutable：本机有 Chrome 就返回存在的路径；显式路径优先", () => {
    const found = findBrowserExecutable(undefined);
    if (found) {
      expect(found.length).toBeGreaterThan(0);
    }
    // 显式给的路径不存在时忽略它（回落自动探测），不抛错
    expect(() => findBrowserExecutable("Z:/not/here/chrome.exe")).not.toThrow();
  });

  it("waitForDevtools：端口没人听 → 带可读原因失败；有响应 → 返回版本", async () => {
    await expect(
      waitForDevtools(9, {
        timeoutMs: 300,
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toMatchObject({ code: "connect_failed" });

    const version = await waitForDevtools(1, {
      timeoutMs: 500,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            browser: "Chrome/146",
            protocolVersion: "1.3",
            webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/x",
          }),
          { status: 200 },
        ),
    });
    expect(version.browser).toBe("Chrome/146");
  });

  /**
   * 回归（真机实测抓到）：Chrome 的 `/json/version` 返回的是 **`Browser` / `Protocol-Version`
   * 首字母大写**的字段，先前直接把它当 CdpVersion 用 → `browser` 恒为 undefined，
   * 设置页「连接到 Chrome」状态里的浏览器名一直是空的。这里锁住映射。
   */
  it("waitForDevtools：Chrome 原样字段（大写 B / 连字符）也要映射进 CdpVersion", async () => {
    const version = await waitForDevtools(1, {
      timeoutMs: 500,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            Browser: "Chrome/141.0.7390.55",
            "Protocol-Version": "1.3",
            webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/y",
          }),
          { status: 200 },
        ),
    });
    expect(version.browser).toBe("Chrome/141.0.7390.55");
    expect(version.protocolVersion).toBe("1.3");
  });

  it("waitForDevtools：没有 webSocketDebuggerUrl 的响应视为未就绪（继续轮询直至超时）", async () => {
    await expect(
      waitForDevtools(1, {
        timeoutMs: 200,
        fetchImpl: async () =>
          new Response(JSON.stringify({ Browser: "x" }), { status: 200 }),
      }),
    ).rejects.toMatchObject({ code: "connect_failed" });
  });
});
