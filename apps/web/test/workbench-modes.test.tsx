import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Workbench } from "../src/components/workbench/workbench";
import { AuthProvider } from "../src/lib/auth-context";

const navigation = vi.hoisted(() => ({ query: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation, useSearchParams: () => new URLSearchParams(navigation.query) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); localStorage.clear(); navigation.query = ""; });

function installFixture() {
  localStorage.setItem("kenfutwork.session.token", "private-session");
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    const path = String(input);
    let result: unknown = {};
    if (path.endsWith("/api/auth/session")) result = { user: { id: "actor", email: "dev@test", displayName: "开发者" }, session: { token: "private-session", expiresAt: "2099-01-01T00:00:00Z" } };
    if (path.endsWith("/api/viewer")) result = { profile: { id: "actor", email: "dev@test", displayName: "开发者" } };
    if (path.includes("/api/projects")) result = { projects: [{ id: "project", name: "设计项目", kind: "design", primaryCanvas: { id: "canvas" }, createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" }] };
    if (path.endsWith("/api/plugins")) result = { plugins: [] };
    if (path.endsWith("/api/models")) result = { models: [] };
    if (path.endsWith("/api/settings")) result = { settings: { commands: [] } };
    return Response.json(result);
  }));
}

it("Code默认主区仍是原iframe，可信原菜单Design请求同时更新URL导航", async () => {
  installFixture();
  render(<AuthProvider><Workbench /></AuthProvider>);
  const frame = await screen.findByTitle("Code 工作台") as HTMLIFrameElement;
  fireEvent(window, new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow, data: { type: "kenfutwork:code-navigate", mode: "design" } }));
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/workbench?mode=design"));
});

it("URL Design始终画布，侧栏折返不替换主区；Flow未装时无入口，Code切换更新URL", async () => {
  navigation.query = "mode=design";
  installFixture();
  render(<AuthProvider><Workbench /></AuthProvider>);
  const canvas = await screen.findByTitle("设计项目 画布");
  expect(canvas.getAttribute("src")).toBe("/canvas?id=canvas");
  expect(screen.queryByTitle("Code 工作台")).toBeNull();
  expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
  expect(screen.getByTitle("设计项目 画布").getAttribute("src")).toBe("/canvas?id=canvas");
  fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
  fireEvent.click(screen.getByRole("radio", { name: "Code" }));
  expect(navigation.replace).toHaveBeenCalledWith("/workbench");
});

it("裸Flow URL不能构造未安装插件入口", async () => {
  navigation.query = "mode=flow";
  installFixture();
  render(<AuthProvider><Workbench /></AuthProvider>);
  expect(await screen.findByTitle("Code 工作台")).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "Flow" })).toBeNull();
});
