import { afterEach, expect, it, vi } from "vitest";
import { resolvePanelUrl } from "../src/lib/plugin-panels";

afterEach(() => vi.unstubAllEnvs());
it("相对插件面板与图标均由同一个本机服务路径提供", () => {
  vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://127.0.0.1:3001");
  expect(resolvePanelUrl("assets/panel.html", "local__plugin")).toBe(
    "http://127.0.0.1:3001/api/plugins/local__plugin/assets/panel.html",
  );
  expect(resolvePanelUrl("/api/plugins/p/assets/icon.svg")).toBe(
    "http://127.0.0.1:3001/api/plugins/p/assets/icon.svg",
  );
});
it("外部面板URL不追加本机接入凭据", () => {
  expect(resolvePanelUrl("https://example.com/panel.html", "p")).toBe(
    "https://example.com/panel.html",
  );
});
