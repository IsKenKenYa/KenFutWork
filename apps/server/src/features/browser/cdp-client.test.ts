import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  CdpError,
  connectCdpClient,
  findBrowserExecutable,
  readPickables,
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

/**
 * 可拾取元素（R3-4 的浮层底座）：几何必须走 **DOM 域**（`DOM.getBoxModel`），
 * 而不是页面里现算的矩形——浮层要叠在截图上，和 DevTools 的元素盒同源才对齐。
 *
 * 这里用一个替身 CDP 端点验协议与装配：盒模型 → 视口坐标、`display:none`（盒模型报错）
 * 不丢元素、去重、排序、条数上限。真实几何与截图的像素对齐走真机验收。
 */
describe("可拾取元素（DOM.getBoxModel）", () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  function startFakeCdp(
    handler: (message: {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    }) => { result?: unknown; error?: { message: string } } | null,
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
        socket.send(
          JSON.stringify(
            reply.error
              ? { id: message.id, error: reply.error }
              : { id: message.id, result: reply.result ?? {} },
          ),
        );
      });
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `ws://127.0.0.1:${port}`;
  }

  /** 三个元素：链接（在下方）、按钮（在上方）、隐藏的按钮（盒模型报错）。 */
  function pickableFake(record?: string[]) {
    const boxes: Record<number, unknown> = {
      11: {
        model: {
          border: [10, 300, 90, 300, 90, 320, 10, 320],
          width: 80,
          height: 20,
        },
      },
      12: {
        model: {
          border: [100, 40, 220, 40, 220, 70, 100, 70],
          width: 120,
          height: 30,
        },
      },
    };
    const texts: Record<number, unknown> = {
      11: {
        tag: "a",
        text: "Learn more",
        hint: 'a[href^="https://example.com"]',
      },
      12: { tag: "button", text: "立即开始", hint: "button#start" },
      13: { tag: "button", text: "隐藏的", hint: "button#hidden" },
    };
    return startFakeCdp((message) => {
      record?.push(
        `${message.method}${
          message.params?.expression
            ? `:${String(message.params.expression)}`
            : ""
        }`,
      );
      switch (message.method) {
        case "DOM.getDocument":
          return { result: { root: { nodeId: 1 } } };
        case "DOM.querySelectorAll":
          return message.params?.selector === "a"
            ? { result: { nodeIds: [11] } }
            : { result: { nodeIds: [12, 13] } };
        case "DOM.getBoxModel": {
          const nodeId = Number(message.params?.nodeId);
          const model = boxes[nodeId];
          return model
            ? { result: model }
            : { error: { message: "Could not compute box model." } };
        }
        case "DOM.resolveNode":
          return {
            result: { object: { objectId: `obj-${message.params?.nodeId}` } },
          };
        // Runtime.* 的信封是两层（Chrome 原样：`{result:{result:{value}}}`）——
        // 替身必须照抄这一层，否则「取 value」的代码在替身上永远读到 undefined
        case "Runtime.callFunctionOn": {
          const objectId = String(message.params?.objectId ?? "");
          const nodeId = Number(objectId.replace("obj-", ""));
          return { result: { result: { value: texts[nodeId] ?? null } } };
        }
        case "Runtime.evaluate": {
          const expression = String(message.params?.expression ?? "");
          return expression.includes("location.href")
            ? {
                result: {
                  result: {
                    value: JSON.stringify({
                      url: "https://example.com/",
                      title: "Example",
                    }),
                  },
                },
              }
            : { result: { result: { value: null } } };
        }
        case "Page.getLayoutMetrics":
          return {
            result: {
              cssVisualViewport: { clientWidth: 1280, clientHeight: 720 },
            },
          };
        default:
          return { result: {} };
      }
    });
  }

  it("几何取 DOM.getBoxModel 的边框盒，坐标按阅读顺序（先上后下）排序", async () => {
    const client = connectCdpClient(pickableFake());
    const page = await readPickables(client, "S1");
    expect(page.url).toBe("https://example.com/");
    expect(page.title).toBe("Example");
    expect(page.viewport).toEqual({ width: 1280, height: 720 });
    // 按钮 y=40 在链接 y=300 之前（DOM 里 a 先出现，阅读顺序里按钮在前）
    expect(page.elements.map((element) => element.hint)).toEqual([
      "button#start",
      'a[href^="https://example.com"]',
      "button#hidden",
    ]);
    expect(page.elements[0]?.box).toEqual({
      x: 100,
      y: 40,
      width: 120,
      height: 30,
    });
    // 拿不到盒模型的元素不丢：box 为 null，仍在列表里（浮层只给它列表行）
    expect(page.elements[2]).toMatchObject({ tag: "button", box: null });
    client.close();
  });

  it("先滚到顶再取几何（getBoxModel 是文档坐标，滚到顶才与视口截图对齐）", async () => {
    const record: string[] = [];
    const client = connectCdpClient(pickableFake(record));
    await readPickables(client, "S1");

    const scrollAt = record.findIndex((entry) =>
      entry.includes("window.scrollTo(0, 0)"),
    );
    const documentAt = record.findIndex((entry) =>
      entry.startsWith("DOM.getDocument"),
    );
    const firstBoxAt = record.findIndex((entry) =>
      entry.startsWith("DOM.getBoxModel"),
    );
    expect(scrollAt).toBeGreaterThanOrEqual(0);
    expect(scrollAt).toBeLessThan(documentAt);
    expect(documentAt).toBeLessThan(firstBoxAt);
    client.close();
  });

  it("条数上限：limit 生效，不会把整页元素都读一遍", async () => {
    const url = startFakeCdp((message) => {
      switch (message.method) {
        case "DOM.getDocument":
          return { result: { root: { nodeId: 1 } } };
        case "DOM.querySelectorAll":
          return {
            result: { nodeIds: Array.from({ length: 20 }, (_, i) => 100 + i) },
          };
        case "DOM.getBoxModel":
          return {
            result: {
              model: {
                border: [
                  0,
                  Number(message.params?.nodeId),
                  10,
                  0,
                  10,
                  10,
                  0,
                  10,
                ],
                width: 10,
                height: 10,
              },
            },
          };
        case "DOM.resolveNode":
          return {
            result: { object: { objectId: `obj-${message.params?.nodeId}` } },
          };
        case "Runtime.callFunctionOn":
          return {
            result: {
              result: {
                value: {
                  tag: "a",
                  text: `第 ${message.params?.objectId} 条`,
                  hint: "a",
                },
              },
            },
          };
        case "Runtime.evaluate":
          return {
            result: {
              result: { value: JSON.stringify({ url: "u", title: "t" }) },
            },
          };
        default:
          return { result: {} };
      }
    });
    const client = connectCdpClient(url);
    const page = await readPickables(client, "S1", { limit: 3 });
    expect(page.elements).toHaveLength(3);
    client.close();
  });
});
