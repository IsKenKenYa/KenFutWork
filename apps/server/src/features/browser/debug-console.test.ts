// @vitest-environment jsdom
/// <reference lib="dom" />

import { describe, expect, it, vi } from "vitest";

import {
  buildInjectableScript,
  createDebugConsoleSource,
  DEBUG_CONSOLE_PROBE,
  DEBUG_CONSOLE_SCRIPT_URL,
} from "./debug-console.js";

/**
 * 调试控制台脚本来源（「打开调试工具」注入的那份 Eruda）。
 *
 * 关键取舍在这里钉住：**整段源码直投**（而不是往页面里插 `<script src=…>`）——
 * 真机撞到过「注入报成功、页面上什么都没有」。所以测试盯三件事：只取一次（缓存）、
 * 带上启动尾巴（幂等地 init + show）、失败要可读且**不缓存**（网络恢复后还能成）。
 */
describe("调试控制台脚本来源", () => {
  const okFetch = (source = "window.eruda = {};"): typeof fetch =>
    vi.fn(
      async () => new Response(source, { status: 200 }),
    ) as unknown as typeof fetch;

  it("取一次就缓存（几百 KB，不该每次点都下载）", async () => {
    const fetchImpl = okFetch();
    const source = createDebugConsoleSource({ fetchImpl });
    const first = await source.script();
    const second = await source.script();
    expect(first).toBe(second);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      DEBUG_CONSOLE_SCRIPT_URL,
    );
  });

  it("脚本尾部接上「初始化 + 显示」（幂等：重复点只是再 show 一次）", async () => {
    const source = createDebugConsoleSource({
      fetchImpl: okFetch("var x = 1;"),
    });
    const script = await source.script();
    // 源码整段在里面（外面套着 UMD 分支修正的壳，见后面的用例）
    expect(script).toContain("var x = 1;");
    expect(script).toContain("window.eruda.init()");
    expect(script).toContain("window.eruda.show()");
  });

  it("HTTP 不是 200：可读错误（带状态码与来源）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    const source = createDebugConsoleSource({ fetchImpl });
    await expect(source.script()).rejects.toThrow(/503/);
  });

  it("空脚本：不返回空串（注入了也等于没注入）", async () => {
    const source = createDebugConsoleSource({ fetchImpl: okFetch("   ") });
    await expect(source.script()).rejects.toThrow(/空的/);
  });

  it("失败不缓存：网络恢复后下一次能成", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response("boom", { status: 500 })
        : new Response("window.eruda = {};", { status: 200 });
    }) as unknown as typeof fetch;
    const source = createDebugConsoleSource({ fetchImpl });
    await expect(source.script()).rejects.toThrow();
    await expect(source.script()).resolves.toContain("window.eruda");
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("自检探针读的是 Eruda 自己置的初始化位", () => {
    expect(DEBUG_CONSOLE_PROBE).toContain("eruda");
    expect(DEBUG_CONSOLE_PROBE).toContain("_isInit");
  });
});

/**
 * UMD 分支（真机踩到的根因）：Eruda 是 UMD 包，页面上只要有 `define`（AMD 加载器）或
 * `module` / `exports`，它就注册成模块、**不往 window 上挂 eruda**——百度这类站点正是如此
 * （`typeof window.define === "function"`），用户那边看到的就是「点了没反应」。
 * 所以注入前要把它藏起来（跑完还回去）。下面用一段**同形状的 UMD 包**把这条钉死。
 */
describe("可注入脚本：UMD 分支修正", () => {
  /** 与 Eruda 同形状的 UMD 包（三种分支都写全）。 */
  const FAKE_UMD = `(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.eruda = factory());
  })(this, function () {
    return {
      _isInit: false,
      init: function () { this._isInit = true; },
      show: function () { window.__erudaShown = true; }
    };
  });`;

  it("页面有 AMD 加载器（define.amd）时也走浏览器全局分支，并把 define 原样还回去", () => {
    const amdCalls: unknown[] = [];
    const originalDefine = Object.assign(
      (...args: unknown[]) => {
        amdCalls.push(args);
      },
      { amd: {} },
    );
    Reflect.set(window, "define", originalDefine);
    Reflect.deleteProperty(window, "eruda");

    // 直接跑我们组装出来的注入脚本（与 Runtime.evaluate 里执行的是同一段）
    // biome-ignore lint/security/noGlobalEval: 这条测试就是要跑页面侧脚本
    const runScript = eval;
    runScript(buildInjectableScript(FAKE_UMD));

    const eruda = (window as unknown as { eruda?: { _isInit?: boolean } })
      .eruda;
    expect(eruda).toBeTruthy();
    expect(eruda?._isInit).toBe(true);
    expect((window as unknown as { __erudaShown?: boolean }).__erudaShown).toBe(
      true,
    );
    // AMD 加载器没被塞进我们的包，且**原样还在**
    expect(amdCalls).toEqual([]);
    expect((window as unknown as { define?: unknown }).define).toBe(
      originalDefine,
    );
    Reflect.deleteProperty(window, "define");
  });

  it("悬浮窗改造：样式进 Eruda 自己的 root（影子根里页面样式进不去）+ 拖动 + 关闭", () => {
    const script = buildInjectableScript("var x = 1;");
    expect(script).toContain("getRootNode");
    expect(script).toContain(".eruda-container{position:fixed");
    expect(script).toContain('setProperty("left"');
    expect(script).toContain("eruda.hide()");
    expect(script).toContain("__kfwFloating = true");
    // 关闭要连**容器**一起收（光 eruda.hide() 会留个空框：我们的样式钉死了宽高）
    expect(script).toContain('setProperty("display", "none", "important")');
    // 重新打开要放回来（幂等分支里）
    expect(script).toContain('removeProperty("display")');
  });

  it("源码抛错也要把 define 还回去（不能把人家的加载器弄坏）", () => {
    const originalDefine = Object.assign(() => {}, { amd: {} });
    Reflect.set(window, "define", originalDefine);
    // biome-ignore lint/security/noGlobalEval: 同上，测的就是页面侧执行
    const runScript = eval;
    expect(() =>
      runScript(buildInjectableScript("throw new Error('bundle 炸了');")),
    ).toThrow(/bundle 炸了/);
    expect((window as unknown as { define?: unknown }).define).toBe(
      originalDefine,
    );
    Reflect.deleteProperty(window, "define");
  });

  it("组装顺序：先藏、再跑源码、最后还原", () => {
    const script = buildInjectableScript("SOURCE_MARK");
    expect(script.indexOf("delete window.define")).toBeLessThan(
      script.indexOf("SOURCE_MARK"),
    );
    expect(script.indexOf("SOURCE_MARK")).toBeLessThan(
      script.indexOf("if (hadDefine)"),
    );
    // UMD 拿 this 当全局对象：外层必须仍以 window 为 this
    expect(script).toContain("}).call(window);");
    // 尾部还接了「悬浮窗改造」（可拖动 / 可关闭）
    expect(script).toContain("__kfwFloating");
  });
});
