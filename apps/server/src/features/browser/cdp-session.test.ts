import { describe, expect, it, vi } from "vitest";

import type { CdpClient } from "./cdp-client.js";
import { createCdpBrowserSession } from "./cdp-session.js";

/**
 * CDP 会话（`createCdpBrowserSession`）：面板画面流的**编排**部分。
 *
 * 依赖全部可注入，所以这里能用替身客户端跑真流程：连接 → 开流 → 帧回调 → ack 顺序、
 * 同时只留一个画面订阅、`stop()` 收尾（还原视口）、页面自己跳走时状态跟上。
 * 真实 Chrome 那一段（真出画面、真点得动）走真机实测。
 */
function fakeClient() {
  const listeners = new Map<
    string,
    Set<
      (params: Record<string, unknown>, sessionId?: string | undefined) => void
    >
  >();
  const sent: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  /** `Runtime.evaluate` 的返回（默认空对象 = 自检探针拿不到 true）。 */
  let evalResult: Record<string, unknown> = {};
  /** 受控浏览器里“已经开着的” DevTools 目标（缺省没有 → 会走按 F12 那条路）。 */
  let devtoolsTarget: { targetId: string; url: string; title: string } | null =
    null;
  /** 连上时报告的实例状态（无头用例要它）。 */
  let headless = false;
  const client: CdpClient = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { clientWidth: 900, clientHeight: 600, scale: 1 },
        };
      }
      if (method === "Runtime.evaluate") return evalResult;
      if (method === "Browser.getWindowForTarget") {
        return {
          windowId: 4242,
          bounds: { left: 0, top: 0, width: 640, height: 640 },
        };
      }
      return {};
    },
    on(method, handler) {
      const set = listeners.get(method) ?? new Set();
      set.add(handler);
      listeners.set(method, set);
      return () => set.delete(handler);
    },
    async openTab() {
      return { targetId: "T1", sessionId: "S1" };
    },
    async listTargets() {
      return [
        { targetId: "T1", url: "about:blank", title: "" },
        ...(devtoolsTarget ? [devtoolsTarget] : []),
      ];
    },
    async closeTab() {},
    close() {},
  };
  return {
    client,
    sent,
    setEvalResult(value: Record<string, unknown>) {
      evalResult = value;
    },
    setDevToolsTarget(target: {
      targetId: string;
      url: string;
      title: string;
    }) {
      devtoolsTarget = target;
    },
    setState(next: "headless" | "headed") {
      headless = next === "headless";
    },
    headless: () => headless,
    emit(method: string, params: Record<string, unknown>, sessionId?: string) {
      for (const handler of listeners.get(method) ?? []) {
        handler(params, sessionId);
      }
    },
    listenerCount(method: string) {
      return listeners.get(method)?.size ?? 0;
    },
  };
}

function sessionWith(
  fake: { client: CdpClient },
  extra: { sendKeys?: (title: string) => Promise<void> } = {},
) {
  return createCdpBrowserSession({
    dataDir: "D:/tmp/kfw-cdp-session-test",
    ...(extra.sendKeys
      ? {
          sendKeys: extra.sendKeys as never,
        }
      : {}),
    findExecutable: () => "C:/fake/chrome.exe",
    launch: async () => ({
      // 会话会给子进程挂 exit 监听（进程自己退了就收回状态）
      child: { pid: 4242, once: () => undefined } as never,
      executable: "C:/fake/chrome.exe",
      port: 9333,
      profileDir: "D:/tmp/kfw-cdp-session-test/profile",
    }),
    waitDevtools: async () => ({
      browser: "Chrome/153",
      protocolVersion: "1.3",
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/x",
    }),
    connectClient: () => fake.client,
    killStaleProfile: async () => false,
  });
}

describe("CDP 会话：面板画面流", () => {
  it("开流后每帧先给回调、再 ack（Chrome 以 ack 做背压）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    const order: string[] = [];
    await session.watch({ width: 900, height: 600 }, async (jpeg) => {
      order.push(`frame:${jpeg.length}`);
    });
    // 视口按面板尺寸真改（自由尺寸），并开始推帧
    expect(
      fake.sent.some(
        (entry) =>
          entry.method === "Emulation.setDeviceMetricsOverride" &&
          entry.params.width === 900,
      ),
    ).toBe(true);
    expect(
      fake.sent.some((entry) => entry.method === "Page.startScreencast"),
    ).toBe(true);

    fake.emit(
      "Page.screencastFrame",
      { data: Buffer.from([1, 2, 3]).toString("base64"), sessionId: 7 },
      "S1",
    );
    await vi.waitFor(() => expect(order).toEqual(["frame:3"]));
    await vi.waitFor(() =>
      expect(
        fake.sent.some(
          (entry) =>
            entry.method === "Page.screencastFrameAck" &&
            entry.params.sessionId === 7,
        ),
      ).toBe(true),
    );
  });

  it("别人标签的帧不转发（事件按 CDP 会话分发）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    let frames = 0;
    await session.watch({}, async () => {
      frames += 1;
    });
    fake.emit(
      "Page.screencastFrame",
      { data: Buffer.from([1]).toString("base64"), sessionId: 1 },
      "别的会话",
    );
    fake.emit(
      "Page.screencastFrame",
      { data: Buffer.from([1]).toString("base64"), sessionId: 2 },
      "S1",
    );
    await vi.waitFor(() => expect(frames).toBe(1));
  });

  it("同时只留一个画面订阅：新开流会把上一个收掉，订阅表不堆积", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    await session.watch({}, async () => {});
    expect(fake.listenerCount("Page.screencastFrame")).toBe(1);
    await session.watch({}, async () => {});
    expect(fake.listenerCount("Page.screencastFrame")).toBe(1);
  });

  it("stop()：停推帧并还原视口（自由尺寸关掉时不留覆盖）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    const stop = await session.watch(
      { width: 900, height: 600 },
      async () => {},
    );
    await stop();
    expect(fake.listenerCount("Page.screencastFrame")).toBe(0);
    expect(
      fake.sent.some((entry) => entry.method === "Page.stopScreencast"),
    ).toBe(true);
    expect(
      fake.sent.some(
        (entry) => entry.method === "Emulation.clearDeviceMetricsOverride",
      ),
    ).toBe(true);
  });

  it("页面自己跳走（点链接）时状态里的 currentUrl 跟着变（只认主框架）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    expect(session.status()).toMatchObject({ currentUrl: "about:blank" });

    fake.emit(
      "Page.frameNavigated",
      { frame: { id: "F1", url: "https://a.com/" } },
      "S1",
    );
    expect(session.status()).toMatchObject({ currentUrl: "https://a.com/" });

    // iframe 自己跳走不改当前页
    fake.emit(
      "Page.frameNavigated",
      { frame: { id: "F2", parentId: "F1", url: "https://ad.example/" } },
      "S1",
    );
    expect(session.status()).toMatchObject({ currentUrl: "https://a.com/" });
  });

  it("输入回填按类型分发（鼠标动作名映射、键盘走按键表）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    await session.input({
      type: "mouse",
      action: "released",
      x: 1,
      y: 2,
      buttons: 0,
    });
    expect(fake.sent.at(-1)?.params).toMatchObject({
      type: "mouseReleased",
      x: 1,
      y: 2,
      buttons: 0,
    });
    await session.input({ type: "wheel", x: 3, y: 4, deltaY: 100 });
    expect(fake.sent.at(-1)?.params).toMatchObject({
      type: "mouseWheel",
      deltaY: 100,
    });
    await session.input({ type: "key", key: "Backspace" });
    expect(fake.sent.at(-1)?.params).toMatchObject({
      key: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await session.input({ type: "text", text: "中文" });
    expect(fake.sent.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "中文" },
    });
    await session.disconnect();
  });

  it("控制台消息：打标签时就订阅，console/异常/浏览器日志都进缓冲（按 seq 增量取）", async () => {
    const fake = fakeClient();
    fake.setEvalResult({ result: { value: "Example" } });
    const session = sessionWith(fake);
    await session.connect();

    fake.emit(
      "Runtime.consoleAPICalled",
      { type: "log", args: [{ type: "string", value: "hello" }] },
      "S1",
    );
    fake.emit(
      "Runtime.exceptionThrown",
      { exceptionDetails: { exception: { description: "Error: boom" } } },
      "S1",
    );
    fake.emit(
      "Log.entryAdded",
      { entry: { level: "error", text: "404", url: "https://a.com/x" } },
      "S1",
    );
    // 别的会话的事件不要
    fake.emit(
      "Runtime.consoleAPICalled",
      { type: "log", args: [{ type: "string", value: "别人的" }] },
      "别的会话",
    );

    const first = await session.messages(0);
    expect(first.messages.map((m) => [m.seq, m.source, m.text])).toEqual([
      [1, "console", "hello"],
      [2, "exception", "Error: boom"],
      [3, "log", "404 (https://a.com/x)"],
    ]);
    expect(first.nextSeq).toBe(3);
    // 增量：只说「我已经拿到 2」就只给 3
    expect((await session.messages(2)).messages.map((m) => m.seq)).toEqual([3]);
  });

  it("控制台里执行表达式：进同一条时间线，能按增量取回", async () => {
    const fake = fakeClient();
    fake.setEvalResult({ result: { type: "string", value: "Example Domain" } });
    const session = sessionWith(fake);
    await session.connect();
    const message = await session.evaluate("document.title");
    expect(message).toMatchObject({
      level: "log",
      source: "input",
      text: "Example Domain",
    });
    expect(message.seq).toBe(1);
    // generatePreview 要开（对象才有预览）；awaitPromise 让 Promise 也回结果
    const params = fake.sent.at(-1)?.params as Record<string, unknown>;
    expect(params).toMatchObject({
      expression: "document.title",
      generatePreview: true,
      awaitPromise: true,
    });
    expect((await session.messages(0)).messages).toHaveLength(1);
  });

  it("清空控制台：消息没了，但 seq 继续涨（客户端游标不回退）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    fake.emit(
      "Runtime.consoleAPICalled",
      { type: "log", args: [{ type: "number", value: 1 }] },
      "S1",
    );
    await session.clearMessages();
    expect((await session.messages(0)).messages).toEqual([]);
    fake.emit(
      "Runtime.consoleAPICalled",
      { type: "log", args: [{ type: "number", value: 2 }] },
      "S1",
    );
    expect((await session.messages(0)).messages.map((m) => m.seq)).toEqual([2]);
  });

  it("断开时退订控制台事件（不留悬空监听）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    expect(fake.listenerCount("Runtime.consoleAPICalled")).toBe(1);
    await session.disconnect();
    expect(fake.listenerCount("Runtime.consoleAPICalled")).toBe(0);
    expect(fake.listenerCount("Runtime.exceptionThrown")).toBe(0);
    expect(fake.listenerCount("Log.entryAdded")).toBe(0);
  });

  it("打开开发者工具：无头实例如实拒绝（要有可见窗口）", async () => {
    const fake = fakeClient();
    fake.setState("headless");
    const session = sessionWith(fake);
    await session.connect({ headless: true });
    await expect(session.openDevToolsWindow()).rejects.toThrow(/可见/);
  });

  it("打开开发者工具：按页面标题唤起（F12 之后浏览器把它开出来），再取消停靠并摆位置", async () => {
    const fake = fakeClient();
    // 会话要先读页面 DOM 拿标题（替身给一份）
    fake.setEvalResult({
      result: {
        value: JSON.stringify({
          url: "https://a.com/",
          title: "Example Domain",
          text: "",
          elements: [],
        }),
      },
    });
    const keys: string[] = [];
    const session = sessionWith(fake, {
      // 替身模拟「被按了 F12 的浏览器」：按键之后 DevTools 目标才出现
      sendKeys: async (title: string) => {
        keys.push(title);
        fake.setDevToolsTarget({
          targetId: "DT1",
          url: "devtools://devtools/bundled/devtools_app.html",
          title: "DevTools",
        });
      },
    });
    await session.connect();
    const opened = await session.openDevToolsWindow({
      left: 10,
      top: 20,
      width: 800,
      height: 600,
    });
    // 按键脚本拿到的就是当前页面标题（它按标题找窗口）
    expect(keys).toEqual(["Example Domain"]);
    // 取消停靠 + 摆位置都发了命令
    const methods = fake.sent.map((entry) => entry.method);
    expect(methods).toContain("Target.attachToTarget");
    expect(methods).toContain("Browser.setWindowBounds");
    expect(opened.bounds).toEqual({
      left: 10,
      top: 20,
      width: 800,
      height: 600,
    });
  });

  it("开发者工具已经开着：直接复用（不再按 F12）", async () => {
    const fake = fakeClient();
    fake.setDevToolsTarget({
      targetId: "DT1",
      url: "devtools://devtools/bundled/devtools_app.html",
      title: "DevTools",
    });
    fake.setEvalResult({
      result: {
        value: JSON.stringify({
          url: "https://a.com/",
          title: "Example Domain",
          text: "",
          elements: [],
        }),
      },
    });
    const keys: string[] = [];
    const session = sessionWith(fake, {
      sendKeys: async (title: string) => {
        keys.push(title);
      },
    });
    await session.connect();
    await session.openDevToolsWindow();
    expect(keys).toEqual([]);
    expect(fake.sent.map((entry) => entry.method)).toContain(
      "Browser.setWindowBounds",
    );
  });

  it("打开开发者工具：唤起失败时如实报错（并告诉用户自己去按 F12）", async () => {
    const fake = fakeClient();
    fake.setEvalResult({
      result: {
        value: JSON.stringify({
          url: "https://a.com/",
          title: "Example Domain",
          text: "",
          elements: [],
        }),
      },
    });
    const session = sessionWith(fake, { sendKeys: async () => {} });
    await session.connect();
    await expect(session.openDevToolsWindow()).rejects.toThrow(/按 F12/);
  });

  it("断开时收掉导航订阅（不留悬空监听）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake);
    await session.connect();
    expect(fake.listenerCount("Page.frameNavigated")).toBe(1);
    await session.disconnect();
    expect(fake.listenerCount("Page.frameNavigated")).toBe(0);
  });
});
