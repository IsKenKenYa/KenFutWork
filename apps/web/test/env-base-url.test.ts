// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerBaseUrl } from "../src/lib/env";

/**
 * 回归：**未配置时 API base 跟随「页面自己被谁托管」**。
 *
 * 实测事故（2026-09-17 真机安装包）：`getServerBaseUrl()` 未配置时硬编码
 * `http://localhost:3001`，而桌面壳在 3001 被别人的服务占着时会换端口托管 UI
 * （`apps/desktop/src-tauri/src/lib.rs` 的 `launch_packaged_server`）——换了端口之后页面里的
 * API 调用仍打 3001，整页数据全废（Design 模式的画布也因此空白）。
 * 口径：显式配置（含空串=同源相对）> 同源 > 兜底 3001。
 */
describe("getServerBaseUrl 的解析顺序", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("已配置就用配置值（云端/前后端分域）", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "https://api.example.com");
    expect(getServerBaseUrl()).toBe("https://api.example.com");
  });

  it("显式空串 = 同源相对路径（dev 的 rewrite 代理口径，不得改动）", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");
    expect(getServerBaseUrl()).toBe("");
  });

  it("未配置且页面由 http 托管时走同源", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");
    delete process.env.NEXT_PUBLIC_SERVER_BASE_URL;
    expect(getServerBaseUrl()).toBe(window.location.origin);
  });

  it("非 http(s) 页面（壳自带 tauri:// UI）回落 3001 兜底", () => {
    delete process.env.NEXT_PUBLIC_SERVER_BASE_URL;
    vi.stubGlobal("window", {
      location: { protocol: "tauri:", origin: "tauri://localhost" },
    });
    expect(getServerBaseUrl()).toBe("http://localhost:3001");
  });
});
