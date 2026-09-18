// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { panelTokenTarget } from "../src/lib/plugin-panels";

/**
 * 插件面板的登录态握手（`kenfutwork:plugin-panel-token`）里最容易出错的一环：
 * **该不该把用户令牌递出去**。口径是「只递同源面板，外链一律不递」——
 * 递错就是把令牌交给第三方站；不递则同源面板拿不到登录态（插件路由只能开成 public）。
 *
 * 同源有两种部署：直连后端（base 是 `http://host:3001`）与 dev/桌面的同源代理（base 为空串，
 * 面板 URL 落在页面自己的 origin 上）。
 */
describe("插件面板令牌的投递目标", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("直连后端：相对插件路径与同源绝对路径都递到后端 origin", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://127.0.0.1:3001");

    expect(
      panelTokenTarget("assets/panel.html", "local__kenfutwork-mihome"),
    ).toBe("http://127.0.0.1:3001");
    expect(panelTokenTarget("/api/plugins/abc/panel")).toBe(
      "http://127.0.0.1:3001",
    );
  });

  it("同源代理（base 为空串）：面板与页面同源，递页面 origin", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    expect(panelTokenTarget("assets/panel.html", "p")).toBe(
      window.location.origin,
    );
  });

  it("外链面板一律不递（跨站与同主机不同端口都算外链）", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://127.0.0.1:3001");

    expect(panelTokenTarget("https://example.com/panel.html")).toBeNull();
    expect(panelTokenTarget("http://localhost:3001/panel.html")).toBeNull();
    expect(panelTokenTarget("http://127.0.0.1:3999/panel.html")).toBeNull();
  });

  it("同源代理下的外链同样不递", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    expect(panelTokenTarget("https://example.com/panel.html")).toBeNull();
  });
});
