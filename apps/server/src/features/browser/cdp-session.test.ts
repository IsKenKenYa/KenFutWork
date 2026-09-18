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
  const client: CdpClient = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { clientWidth: 900, clientHeight: 600, scale: 1 },
        };
      }
      if (method === "Runtime.evaluate") return evalResult;
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
      return [{ targetId: "T1", url: "about:blank", title: "" }];
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
  debugConsole: { script: () => Promise<string> } = {
    script: async () => "/* eruda 源码 */",
  },
) {
  return createCdpBrowserSession({
    dataDir: "D:/tmp/kfw-cdp-session-test",
    debugConsole,
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

  it("注入调试控制台：整段源码直投（不是插 script 标签）+ 自检通过才报成功", async () => {
    const fake = fakeClient();
    fake.setEvalResult({
      result: {
        value: JSON.stringify({
          loaded: true,
          initialized: true,
          containers: 1,
        }),
      },
    });
    const session = sessionWith(fake, {
      script: async () => "window.eruda = { _isInit: true };",
    });
    await session.connect();
    await session.injectDebugConsole("about:blank");
    const evaluates = fake.sent.filter(
      (entry) => entry.method === "Runtime.evaluate",
    );
    // 第一条是被注入的源码，第二条是自检探针
    expect(evaluates[0]?.params.expression).toContain("window.eruda");
    expect(String(evaluates[1]?.params.expression)).toContain("_isInit");
    expect(evaluates[1]?.params.returnByValue).toBe(true);
  });

  it("注入后自检没过：如实抛错（不假报「已打开」，用户看到的「点了没反应」就是这么来的）", async () => {
    const fake = fakeClient();
    // 页面侧自报：脚本注进去了但启动失败（探针把原因带出来）
    fake.setEvalResult({
      result: {
        value: JSON.stringify({
          loaded: true,
          initialized: false,
          containers: 0,
          error: "TypeError: eruda is not a function",
        }),
      },
    });
    const session = sessionWith(fake);
    await session.connect();
    await expect(session.injectDebugConsole("about:blank")).rejects.toThrow(
      /eruda is not a function/,
    );
  });

  it("注入的表达式在页面上抛错：把页面的报错原样带出来", async () => {
    const fake = fakeClient();
    fake.setEvalResult({
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "boom" },
      },
    });
    const session = sessionWith(fake);
    await session.connect();
    await expect(session.injectDebugConsole("about:blank")).rejects.toThrow(
      /boom/,
    );
  });

  it("debugConsoleScript() 透出源码（桌面形态取同一份）", async () => {
    const fake = fakeClient();
    const session = sessionWith(fake, {
      script: async () => "/* 同一份 eruda 源码 */",
    });
    await session.connect();
    expect(await session.debugConsoleScript()).toBe("/* 同一份 eruda 源码 */");
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
