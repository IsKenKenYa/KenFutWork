import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { createStartupPersistenceFixture } from "../../test-startup-persistence.js";
import { createMemoryTaskWorkManager } from "../task-work/test-store.js";

/**
 * browser 插件的面板数据面：画面流（`/view` `/stream` `/input`）、调试控制台、
 * 截图到对话、页面内元素选择器（`/picker`）。agent 工具面见 browser-tools 相关测试。
 */

async function buildBrowserApp(browser: Record<string, unknown>) {
  const persistence = createStartupPersistenceFixture();
  const app = buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/loenfut-test",
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      desktopDataDir: persistence.dataDir,
    },
    overrides: {
      taskWork: createMemoryTaskWorkManager(),
      persistence,
      browser: browser as never,
    },
  });
  await app.ready();
  const token = await app.kernel.get("localAccess").getDesktopToken();
  return { app, headers: { authorization: `Bearer ${token}` } };
}

function browserStreamLatch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function withinBrowserCloseWindow(promise: Promise<unknown>) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 3000);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

async function openBrowserFrameReader(
  host: Awaited<ReturnType<typeof buildBrowserApp>>,
) {
  const { app, headers } = host;
  app.log.level = "silent";
  if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("浏览器画面流未取得真实HTTP端口。");
  const minted = await app.inject({
    headers,
    method: "POST",
    url: "/api/browser/cdp/view",
    payload: { width: 800, height: 600 },
  });
  expect(minted.statusCode).toBe(200);
  const ticket = (minted.json() as { ticket: string }).ticket;
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/browser/cdp/stream?ticket=${ticket}`,
    { headers },
  );
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("浏览器画面流没有读取通道。");
  return reader;
}

/**
 * 右栏面板的画面流（`/api/browser/cdp/view` + `/stream` + `/input`）。
 *
 * 这三条是「面板里显示受控浏览器画面」的接口：换票（`<img>` 发不了登录头）、开流
 * （MJPEG，浏览器拿 `<img>` 就能渲染）、回填输入。真机实测在 GUI 走查里，这里锁形状与
 * 分流（没连接受控浏览器 → 409 而不是静默空白）。
 */
describe("面板画面流接口", () => {
  it("/view：没连接受控浏览器 → 409 + 可读原因（不给半截票据）", async () => {
    const { app, headers } = await buildBrowserApp({
      cdp: { isConnected: () => false },
    });
    try {
      const response = await app.inject({
        headers,
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
    const { app, headers } = await buildBrowserApp({
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
        headers,
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
        headers,
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

  it("/devtools：透出窗口信息；打不开时 502 带可读原因", async () => {
    const { app: opened, headers: openedHeaders } = await buildBrowserApp({
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
        headers: openedHeaders,
        method: "POST",
        url: "/api/browser/cdp/devtools",
        payload: { left: 20 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ windowId: 4242 });
    } finally {
      await opened.close();
    }

    const { app: failing, headers: failingHeaders } = await buildBrowserApp({
      cdp: {
        openDevToolsWindow: async () => {
          throw new Error("没能在受控浏览器窗口里唤起开发者工具");
        },
      },
    });
    try {
      const response = await failing.inject({
        headers: failingHeaders,
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

  it("/input：形状不对 → 400；对的形状原样转给会话", async () => {
    const events: unknown[] = [];
    const { app, headers } = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        input: async (event: unknown) => {
          events.push(event);
        },
      },
    });
    try {
      const bad = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/input",
        payload: { type: "mouse", action: "pressed" },
      });
      expect(bad.statusCode).toBe(400);

      const ok = await app.inject({
        headers,
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

  it("/stream：静止后的最后一帧要补写一次（multipart 解码器等下一个 part 才上屏）", async () => {
    // 两帧长度不同，方便数 body 里各出现了几个 part
    const frameA = Buffer.from([0xff, 0xd8, 0x01]);
    const frameB = Buffer.from([0xff, 0xd8, 0x02, 0x03]);
    let push: ((jpeg: Buffer) => Promise<void>) | null = null;
    const { app, headers } = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({ status: "connected", currentUrl: "about:blank" }),
        navigate: async (url: string) => ({
          url,
          title: "",
          text: "",
          elements: [],
        }),
        viewport: async () => ({ width: 800, height: 600, scale: 1 }),
        resize: async () => {},
        watch: async (
          _options: unknown,
          onFrame: (jpeg: Buffer) => Promise<void>,
        ) => {
          push = onFrame;
          // 真实 watch 开流即推一张静止帧（否则 hijack 后无任何 write，
          // Node 不 flush 响应头，客户端会一直等响应——测试挂死的坑）
          await onFrame(Buffer.from([0xff]));
          return async () => {};
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const minted = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/view",
        payload: { url: "https://example.com", width: 800, height: 600 },
      });
      expect(minted.statusCode).toBe(200);
      const ticket = (minted.json() as { ticket: string }).ticket;
      // 原生 http 客户端收流（fetch 的 reader 取消行为不可控，曾把本用例挂死）
      const chunks: Buffer[] = [];
      let streamReq: http.ClientRequest | null = null;
      const streamOpened = new Promise<number>((resolve, reject) => {
        streamReq = http.request(
          {
            host: "127.0.0.1",
            port,
            path: `/api/browser/cdp/stream?ticket=${ticket}`,
            method: "GET",
            headers,
          },
          (res) => {
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("error", () => {});
            resolve(res.statusCode ?? 0);
          },
        );
        streamReq.on("error", reject);
        streamReq.end();
      });
      expect(await streamOpened).toBe(200);
      await vi.waitFor(() => expect(push).toBeTruthy());
      // A 之后立刻 B（都在补帧窗口内）：A 不补写；B 之后静止：B 补写一次
      await push!(frameA);
      await new Promise((resolve) => setTimeout(resolve, 40));
      await push!(frameB);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const body = Buffer.concat(chunks).toString("latin1");
      const partsOf = (length: number): number =>
        body
          .split("--kfwframe")
          .filter((part) => part.includes(`Content-Length: ${length}\r\n`))
          .length;
      // 没有补帧机制时最后一帧只写一次——解码器会一直停在旧画面（真机：最小化/关闭后画面分钟级不更新）
      expect(partsOf(frameA.length)).toBe(1);
      expect(partsOf(frameB.length)).toBe(2);
      streamReq?.destroy();
    } finally {
      await app.close();
    }
  });

  it("/stream：真推 MJPEG 分帧（`<img>` 直接能渲染）；票据一次性；坏票据 401", async () => {
    let stopped = false;
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const { app, headers } = await buildBrowserApp({
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
        headers,
        method: "POST",
        url: "/api/browser/cdp/view",
        payload: { url: "https://example.com", width: 800, height: 600 },
      });
      const ticket = (minted.json() as { ticket: string }).ticket;

      const response = await fetch(
        `http://127.0.0.1:${port}/api/browser/cdp/stream?ticket=${ticket}`,
        { headers },
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
        { headers },
      );
      expect(again.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("/stream：开第二路流时把第一路收掉（不堆 Connection: close 连接）", async () => {
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const { app, headers } = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({ status: "connected", currentUrl: "about:blank" }),
        viewport: async () => ({ width: 800, height: 600, scale: 1 }),
        resize: async () => {},
        watch: async (
          _options: unknown,
          onFrame: (jpeg: Buffer) => Promise<void>,
        ) => {
          await onFrame(frame);
          return async () => {};
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const openStream = async () => {
      const minted = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/view",
        payload: { url: "https://example.com", width: 800, height: 600 },
      });
      const ticket = (minted.json() as { ticket: string }).ticket;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/browser/cdp/stream?ticket=${ticket}`,
        { headers },
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("流没有可读通道");
      return reader;
    };
    try {
      const first = await openStream();
      await first.read();
      const second = await openStream();
      // 第一路没有被下游看了：新流一开就该收掉它（否则每路流都占一条连接，浏览器连不上来）
      const closed = await Promise.race([
        first.read().then((result) => result.done),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      expect(closed).toBe(true);
      await second.cancel().catch(() => {});
    } finally {
      await app.close();
    }
  });

  it("/stream：app.close主动结束仍被读取的MJPEG并停止CDP一次", async () => {
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let stopCount = 0;
    const { app, headers } = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({ status: "connected", currentUrl: "about:blank" }),
        viewport: async () => ({ width: 800, height: 600, scale: 1 }),
        resize: async () => {},
        watch: async (
          _options: unknown,
          onFrame: (jpeg: Buffer) => Promise<void>,
        ) => {
          await onFrame(frame);
          return async () => {
            stopCount += 1;
          };
        },
      },
    });
    app.log.level = "silent";
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("浏览器画面流未取得真实HTTP端口。");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const minted = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/view",
        payload: { width: 800, height: 600 },
      });
      expect(minted.statusCode).toBe(200);
      const ticket = (minted.json() as { ticket: string }).ticket;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/browser/cdp/stream?ticket=${ticket}`,
        { headers },
      );
      expect(response.status).toBe(200);
      reader = response.body?.getReader();
      if (!reader) throw new Error("浏览器画面流没有读取通道。");
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(Buffer.from(first.value ?? []).toString("latin1")).toContain(
        "Content-Type: image/jpeg",
      );

      const closed = await Promise.race([
        Promise.all([app.close(), reader.read()]).then(([, result]) =>
          result.done ? "closed" : "unexpected-frame",
        ),
        new Promise<string>((resolve) => {
          deadline = setTimeout(() => resolve("shutdown-blocked"), 3000);
        }),
      ]);
      expect(closed).toBe("closed");
      expect(stopCount).toBe(1);
    } finally {
      if (deadline) clearTimeout(deadline);
      await reader?.cancel().catch(() => {});
      await app.close();
    }
  });

  it("/stream：watch迟到返回stop时先结束HTTP，再等待同一stop完成", async () => {
    const watcherReady = browserStreamLatch();
    const stopEntered = browserStreamLatch();
    const stopReady = browserStreamLatch();
    let stopCount = 0;
    let shutdownFinished = false;
    const host = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({ status: "connected", currentUrl: "about:blank" }),
        viewport: async () => ({ width: 800, height: 600, scale: 1 }),
        resize: async () => {},
        watch: async (
          _options: unknown,
          onFrame: (jpeg: Buffer) => Promise<void>,
        ) => {
          await onFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
          await watcherReady.promise;
          return async () => {
            stopCount += 1;
            stopEntered.release();
            await stopReady.promise;
          };
        },
      },
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = await openBrowserFrameReader(host);
      expect((await reader.read()).done).toBe(false);
      const closing = host.app.close().then(() => {
        shutdownFinished = true;
      });
      const eof = reader.read();
      expect(await withinBrowserCloseWindow(eof)).toBe(true);
      expect((await eof).done).toBe(true);
      expect(shutdownFinished).toBe(false);
      expect(stopCount).toBe(0);

      watcherReady.release();
      expect(await withinBrowserCloseWindow(stopEntered.promise)).toBe(true);
      expect(shutdownFinished).toBe(false);
      await reader.cancel();
      stopReady.release();
      expect(await withinBrowserCloseWindow(closing)).toBe(true);
      expect(stopCount).toBe(1);
    } finally {
      watcherReady.release();
      stopReady.release();
      await reader?.cancel().catch(() => {});
      await host.app.close();
    }
  });

  it("/stream：旧流迟到stop与关闭不停止新流，关服仍独立归还两路资源", async () => {
    const oldStopReady = browserStreamLatch();
    const oldStopEntered = browserStreamLatch();
    const stops = [0, 0];
    let watches = 0;
    const host = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({ status: "connected", currentUrl: "about:blank" }),
        viewport: async () => ({ width: 800, height: 600, scale: 1 }),
        resize: async () => {},
        watch: async (
          _options: unknown,
          onFrame: (jpeg: Buffer) => Promise<void>,
        ) => {
          const index = watches++;
          await onFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
          return async () => {
            stops[index] = (stops[index] ?? 0) + 1;
            if (index === 0) {
              oldStopEntered.release();
              await oldStopReady.promise;
            }
          };
        },
      },
    });
    let first: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let second: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let secondOpening:
      | Promise<ReadableStreamDefaultReader<Uint8Array>>
      | undefined;
    try {
      first = await openBrowserFrameReader(host);
      expect((await first.read()).done).toBe(false);
      secondOpening = openBrowserFrameReader(host);
      expect(await withinBrowserCloseWindow(oldStopEntered.promise)).toBe(true);
      const oldEof = first.read();
      expect(await withinBrowserCloseWindow(oldEof)).toBe(true);
      expect((await oldEof).done).toBe(true);
      expect(watches).toBe(1);
      oldStopReady.release();
      second = await secondOpening;
      expect((await second.read()).done).toBe(false);
      await first.cancel();
      expect(stops).toEqual([1, 0]);

      const eof = second.read();
      const closing = host.app.close();
      expect(await withinBrowserCloseWindow(Promise.all([closing, eof]))).toBe(
        true,
      );
      expect((await eof).done).toBe(true);
      expect(stops).toEqual([1, 1]);
    } finally {
      oldStopReady.release();
      second ??= await secondOpening?.catch(() => undefined);
      await Promise.all([
        first?.cancel().catch(() => {}),
        second?.cancel().catch(() => {}),
      ]);
      await host.app.close();
    }
  });
});

describe("POST /api/browser/cdp/console 与 screenshot（面板拾取/截图配套）", () => {
  it("action=close 只收起悬浮控制台，不导航不重新注入", async () => {
    const hideDebugConsole = vi.fn(async () => {});
    const injectDebugConsole = vi.fn(async () => ({
      url: "https://example.com",
    }));
    const { app, headers } = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({
          status: "connected",
          currentUrl: "https://example.com",
        }),
        hideDebugConsole,
        injectDebugConsole,
      },
    });
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/console",
        payload: { action: "close" },
      });
      expect(response.statusCode).toBe(200);
      expect(hideDebugConsole).toHaveBeenCalledTimes(1);
      expect(injectDebugConsole).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("screenshot 直出 base64（面板组 File 用，不落 blob）", async () => {
    const { app, headers } = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({
          status: "connected",
          currentUrl: "https://example.com",
        }),
        screenshotData: async () => ({
          base64: Buffer.from("png-bytes").toString("base64"),
          width: 1280,
          height: 720,
        }),
      },
    });
    try {
      const response = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/screenshot",
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        base64: string;
        width: number;
        height: number;
      };
      expect(Buffer.from(body.base64, "base64").toString()).toBe("png-bytes");
      expect(body.width).toBe(1280);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/browser/cdp/picker（页面内元素选择器）", () => {
  it("start 注入脚本；read 取走点选结果；stop 退出；非法 action 报 400", async () => {
    const startElementPicker = vi.fn(async () => {});
    const readPickedElement = vi.fn(async () => ({
      picked: {
        tag: "a",
        text: "Learn more",
        hint: "a.pick-me",
        box: { x: 40, y: 60, width: 120, height: 20 },
        viewport: { width: 1280, height: 720 },
        page: "https://example.com/",
      },
      active: false,
      error: null,
    }));
    const stopElementPicker = vi.fn(async () => {});
    const { app, headers } = await buildBrowserApp({
      cdp: {
        isConnected: () => true,
        status: () => ({
          status: "connected",
          currentUrl: "https://example.com",
        }),
        startElementPicker,
        readPickedElement,
        stopElementPicker,
      },
    });
    try {
      const started = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/picker",
        payload: { action: "start" },
      });
      expect(started.statusCode).toBe(200);
      expect(startElementPicker).toHaveBeenCalledTimes(1);

      const read = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/picker",
        payload: { action: "read" },
      });
      expect(read.statusCode).toBe(200);
      const body = read.json() as {
        picked: { tag: string; hint: string } | null;
      };
      expect(body.picked?.tag).toBe("a");
      expect(body.picked?.hint).toBe("a.pick-me");

      const stopped = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/picker",
        payload: { action: "stop" },
      });
      expect(stopped.statusCode).toBe(200);
      expect(stopElementPicker).toHaveBeenCalledTimes(1);

      const invalid = await app.inject({
        headers,
        method: "POST",
        url: "/api/browser/cdp/picker",
        payload: { action: "nope" },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
