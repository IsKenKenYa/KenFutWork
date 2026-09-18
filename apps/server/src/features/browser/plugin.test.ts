import { describe, expect, it } from "vitest";

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

/**
 * 「打开调试工具」（右栏浏览器 ⋯ 菜单）：**给受控浏览器的页面开真 DevTools**。
 *
 * 这条是路线 1 的验收面：真机上验过受控 Chrome 里会多出一个 `devtools://devtools/bundled/
 * inspector.html?ws=…` 标签；这里锁路由的两种结果（成功透出 / 没连接受控浏览器时 502 + 可读原因）。
 */
describe("POST /api/browser/cdp/devtools", () => {
  it("受控浏览器连着：透出打开的调试目标", async () => {
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => true,
        openDevtools: async () => ({
          targetId: "DEVTOOLS-1",
          url: "https://example.com/",
        }),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/devtools",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        opened: { targetId: "DEVTOOLS-1", url: "https://example.com/" },
      });
    } finally {
      await app.close();
    }
  });

  it("没连接受控浏览器：502 + 可读原因（客户端据此把菜单项置灰）", async () => {
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => false,
        openDevtools: async () => {
          throw new Error(
            "浏览器未连接：请到「设置 → 浏览器 → 外部浏览器」点『连接到 Chrome』。",
          );
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/browser/cdp/devtools",
      });
      expect(response.statusCode).toBe(502);
      expect(String(response.json().error?.message)).toContain("浏览器未连接");
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/browser/snapshot", () => {
  it("CDP 连着：回来真实渲染页 + 盒模型几何 + 视口 + 截图，source=cdp", async () => {
    const app = buildBrowserApp({
      cdp: {
        isConnected: () => true,
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
});
