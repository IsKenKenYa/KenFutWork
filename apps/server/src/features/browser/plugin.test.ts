import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../app.js";

/**
 * `POST /api/browser/snapshot` 的两条路（右栏「选择网页元素加入聊天」的接口）。
 *
 * CDP 连着时回来的是**真实渲染页 + 盒模型几何 + 视口截图**（浮层据此叠框点选），
 * 没连（或 CDP 读页失败）时回落静态抓取。这条形状是客户端浮层的输入契约，
 * 改这里必须同步改 `panel-browser-view.tsx`。
 */

const USER = {
  accessToken: "tok",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

function buildBrowserApp(browser: Record<string, unknown>) {
  return buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/loenfut-test",
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      credentialSecret: "test-secret",
    },
    overrides: {
      auth: {
        authenticate: async () => USER,
        resolveUser: async () => USER,
      } as never,
      browser: browser as never,
    },
  });
}

describe("POST /api/browser/snapshot", () => {
  it("CDP 连着：回来真实渲染页 + 盒模型几何 + 视口 + 截图，source=cdp", async () => {
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => true,
        // 受控浏览器停在别处：这一页要真的导航过去
        status: () => ({ status: "connected", currentUrl: "about:blank" }),
        navigate: async () => ({
          url: "https://example.com/",
          title: "Example",
          text: "正文",
          elements: [{ tag: "a", text: "静态", hint: "a" }],
        }),
        pickables: async () => ({
          url: "https://example.com/",
          title: "Example",
          viewport: { width: 1280, height: 720 },
          elements: [
            {
              tag: "button",
              text: "立即开始",
              hint: "button#start",
              box: { x: 100, y: 40, width: 120, height: 30 },
            },
          ],
          screenshotUrl: "https://blob.test/browser/1.png",
        }),
      },
      snapshot: async () => {
        throw new Error("CDP 可用时不该走静态抓取");
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/browser/snapshot",
        payload: { url: "https://example.com" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        source: string;
        screenshotUrl?: string;
        snapshot: {
          title: string;
          viewport?: { width: number; height: number };
          elements: Array<{ hint: string; box?: unknown }>;
        };
      };
      expect(body.source).toBe("cdp");
      expect(body.screenshotUrl).toBe("https://blob.test/browser/1.png");
      expect(body.snapshot.viewport).toEqual({ width: 1280, height: 720 });
      // 元素取带几何的那一份（静态那路的元素没有 box）
      expect(body.snapshot.elements).toEqual([
        {
          tag: "button",
          text: "立即开始",
          hint: "button#start",
          box: { x: 100, y: 40, width: 120, height: 30 },
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("CDP 读页失败：回落静态抓取，source=static（不给半截几何）", async () => {
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => true,
        navigate: async () => {
          throw new Error("页面忙");
        },
      },
      snapshot: async () => ({
        url: "https://example.com/",
        title: "Example",
        text: "正文",
        elements: [{ tag: "a", text: "Learn more", hint: "a" }],
      }),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/browser/snapshot",
        payload: { url: "https://example.com" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        source: string;
        screenshotUrl?: string;
        snapshot: { elements: Array<{ tag: string }>; viewport?: unknown };
      };
      expect(body.source).toBe("static");
      expect(body.screenshotUrl).toBeUndefined();
      expect(body.snapshot.viewport).toBeUndefined();
      expect(body.snapshot.elements).toEqual([
        { tag: "a", text: "Learn more", hint: "a" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("CDP 没连：直接走静态抓取（不用等 CDP 超时）", async () => {
    let cdpCalled = false;
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => false,
        navigate: async () => {
          cdpCalled = true;
          return { url: "", title: "", text: "", elements: [] };
        },
      },
      snapshot: async () => ({
        url: "https://example.com/",
        title: "Example",
        text: "正文",
        elements: [],
      }),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/browser/snapshot",
        payload: { url: "https://example.com" },
      });
      expect(response.json().source).toBe("static");
      expect(cdpCalled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("受控浏览器已经在这一页：只读、不重复导航（面板里的一切不该被刷掉）", async () => {
    let navigated = false;
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({
          status: "connected",
          currentUrl: "https://example.com/",
        }),
        navigate: async () => {
          navigated = true;
          return { url: "", title: "", text: "", elements: [] };
        },
        snapshot: async () => ({
          url: "https://example.com/",
          title: "Example",
          text: "正文",
          elements: [],
        }),
        pickables: async () => ({
          url: "https://example.com/",
          title: "Example",
          viewport: { width: 800, height: 600 },
          elements: [],
        }),
      },
      snapshot: async () => {
        throw new Error("CDP 可用时不该走静态抓取");
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/browser/snapshot",
        payload: { url: "https://example.com" },
      });
      expect(response.statusCode).toBe(200);
      expect(navigated).toBe(false);
      expect(response.json().source).toBe("cdp");
    } finally {
      await app.close();
    }
  });
});

/**
 * 右栏面板的画面流（`/api/browser/cdp/view` + `/stream` + `/input`）。
 *
 * 这三条是「面板里显示受控浏览器画面」的接口：换票（`<img>` 发不了登录头）、开流
 * （MJPEG，浏览器拿 `<img>` 就能渲染）、回填输入。真机实测在 GUI 走查里，这里锁形状与
 * 分流（没连接受控浏览器 → 409 而不是静默空白）。
 */
describe("面板画面流接口", () => {
  it("/view：没连接受控浏览器 → 409 + 可读原因（不给半截票据）", async () => {
    const app = buildBrowserApp({
      cdp: { isConnected: () => false },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/view",
        payload: { url: "https://example.com" },
      });
      expect(response.statusCode).toBe(409);
      expect(String(response.json().error?.message)).toContain("受控浏览器");
    } finally {
      await app.close();
    }
  });

  it("/view：换票顺带设视口；同一页不重复导航（换地址才导航）", async () => {
    const navigated: string[] = [];
    const resized: Array<{ width: number; height: number } | null> = [];
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({
          status: "connected",
          currentUrl: "https://example.com/",
        }),
        navigate: async (url: string) => {
          navigated.push(url);
          return { url, title: "", text: "", elements: [] };
        },
        resize: async (size: { width: number; height: number } | null) => {
          resized.push(size);
        },
        viewport: async () => ({ width: 900, height: 600, scale: 1 }),
      },
    });
    try {
      const same = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/view",
        payload: { url: "https://example.com", width: 900, height: 600 },
      });
      expect(same.statusCode).toBe(200);
      expect(navigated).toEqual([]);
      expect(resized).toEqual([{ width: 900, height: 600 }]);
      const body = same.json() as {
        ticket: string;
        viewport: { width: number; height: number };
      };
      expect(body.ticket.length).toBeGreaterThan(8);
      expect(body.viewport).toEqual({ width: 900, height: 600, scale: 1 });

      const moved = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/view",
        payload: { url: "https://example.com/other" },
      });
      expect(moved.statusCode).toBe(200);
      expect(navigated).toEqual(["https://example.com/other"]);
      // 没给尺寸 → 还原窗口尺寸（自由尺寸关掉时）
      expect(resized.at(-1)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("控制台接口：消息按 since 增量取、执行表达式、清空", async () => {
    const messages: Array<{ method: string; args: unknown[] }> = [];
    const cleared: string[] = [];
    const app = buildBrowserApp({
      cdp: {
        messages: async (since: number) => {
          messages.push({ method: "messages", args: [since] });
          return {
            messages: [
              {
                seq: 7,
                level: "error",
                text: "404",
                at: "2026-09-18T00:00:00.000Z",
                source: "log",
              },
            ],
            nextSeq: 7,
          };
        },
        evaluate: async (expression: string) => {
          messages.push({ method: "evaluate", args: [expression] });
          return {
            seq: 8,
            level: "log",
            text: "Example",
            at: "2026-09-18T00:00:00.000Z",
            source: "input",
          };
        },
        clearMessages: async () => {
          cleared.push("yes");
        },
      },
    });
    try {
      const list = await app.inject({
        method: "GET",
        url: "/api/browser/cdp/messages?since=6",
      });
      expect(list.statusCode).toBe(200);
      expect(messages[0]).toEqual({ method: "messages", args: [6] });
      expect(list.json()).toMatchObject({ nextSeq: 7 });

      // since 非法（空/负数/非数字）一律当 0：客户端不必自己兜
      await app.inject({ method: "GET", url: "/api/browser/cdp/messages" });
      await app.inject({
        method: "GET",
        url: "/api/browser/cdp/messages?since=-5",
      });
      expect(messages[1]).toEqual({ method: "messages", args: [0] });
      expect(messages[2]).toEqual({ method: "messages", args: [0] });

      const evaluated = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/eval",
        payload: { expression: "document.title" },
      });
      expect(evaluated.statusCode).toBe(200);
      expect(evaluated.json().message).toMatchObject({ text: "Example" });

      const empty = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/eval",
        payload: { expression: "   " },
      });
      expect(empty.statusCode).toBe(400);

      const clear = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/messages/clear",
      });
      expect(clear.statusCode).toBe(200);
      expect(cleared).toEqual(["yes"]);
    } finally {
      await app.close();
    }
  });

  it("/devtools：透出窗口信息；打不开时 502 带可读原因", async () => {
    const opened = buildBrowserApp({
      cdp: {
        openDevToolsWindow: async (options: { left?: number }) => ({
          windowId: 4242,
          bounds: {
            left: options.left ?? 60,
            top: 60,
            width: 1280,
            height: 860,
          },
        }),
      },
    });
    try {
      const response = await opened.inject({
        method: "POST",
        url: "/api/browser/cdp/devtools",
        payload: { left: 20 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ windowId: 4242 });
    } finally {
      await opened.close();
    }

    const failing = buildBrowserApp({
      cdp: {
        openDevToolsWindow: async () => {
          throw new Error("没能在受控浏览器窗口里唤起开发者工具");
        },
      },
    });
    try {
      const response = await failing.inject({
        method: "POST",
        url: "/api/browser/cdp/devtools",
        payload: {},
      });
      expect(response.statusCode).toBe(502);
      expect(String(response.json().error?.message)).toContain("唤起");
    } finally {
      await failing.close();
    }
  });

  it("/requests：网络请求按 since 增量取；没连接如实 502", async () => {
    const app = buildBrowserApp({
      cdp: {
        requests: async (since: number) => ({
          requests: [
            {
              seq: since + 1,
              method: "GET",
              url: "https://a.com/x",
              status: 200,
              at: "2026-09-18T00:00:00.000Z",
            },
          ],
          nextSeq: since + 1,
        }),
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/browser/cdp/requests?since=4",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ nextSeq: 5 });
      expect(response.json().requests[0]).toMatchObject({
        url: "https://a.com/x",
      });
    } finally {
      await app.close();
    }

    const failing = buildBrowserApp({
      cdp: {
        requests: async () => {
          throw new Error("浏览器未连接");
        },
      },
    });
    try {
      const response = await failing.inject({
        method: "GET",
        url: "/api/browser/cdp/requests",
      });
      expect(response.statusCode).toBe(502);
      expect(String(response.json().error?.message)).toContain("未连接");
    } finally {
      await failing.close();
    }
  });

  it("/input：形状不对 → 400；对的形状原样转给会话", async () => {
    const events: unknown[] = [];
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => true,
        input: async (event: unknown) => {
          events.push(event);
        },
      },
    });
    try {
      const bad = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/input",
        payload: { type: "mouse", action: "pressed" },
      });
      expect(bad.statusCode).toBe(400);

      const ok = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/input",
        payload: { type: "key", key: "Enter" },
      });
      expect(ok.statusCode).toBe(200);
      expect(events).toEqual([{ type: "key", key: "Enter" }]);
    } finally {
      await app.close();
    }
  });

  it("/stream：真推 MJPEG 分帧（`<img>` 直接能渲染）；票据一次性；坏票据 401", async () => {
    let stopped = false;
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({ status: "connected", currentUrl: "about:blank" }),
        navigate: async () => ({
          url: "https://example.com/",
          title: "",
          text: "",
          elements: [],
        }),
        resize: async () => {},
        viewport: async () => ({ width: 800, height: 600, scale: 1 }),
        watch: async (
          _options: unknown,
          onFrame: (jpeg: Buffer) => Promise<void>,
        ) => {
          await onFrame(frame);
          return async () => {
            stopped = true;
          };
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const minted = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/view",
        payload: { url: "https://example.com", width: 800, height: 600 },
      });
      const ticket = (minted.json() as { ticket: string }).ticket;

      const response = await fetch(
        `http://127.0.0.1:${port}/api/browser/cdp/stream?ticket=${ticket}`,
      );
      expect(response.headers.get("content-type")).toContain(
        "multipart/x-mixed-replace",
      );
      const reader = response.body?.getReader();
      const chunk = await reader?.read();
      const head = Buffer.from(chunk?.value ?? []).toString("latin1");
      expect(head).toContain("--kfwframe");
      expect(head).toContain("Content-Type: image/jpeg");
      expect(head).toContain(`Content-Length: ${frame.length}`);
      // 断开 → 服务端收尾（停掉 CDP 那边的画面推送）
      await reader?.cancel();
      await vi.waitFor(() => expect(stopped).toBe(true));

      // 票据一次性：同一张再开一次就是 401
      const again = await fetch(
        `http://127.0.0.1:${port}/api/browser/cdp/stream?ticket=${ticket}`,
      );
      expect(again.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
