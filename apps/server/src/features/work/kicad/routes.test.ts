import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { LocalAccessVerifier } from "../../local-access/types.js";
import { registerKicadRoutes } from "./routes.js";
import type { KicadWorker } from "./worker.js";

/**
 * KiCad 面板/状态路由：面板与 agent 共用同一个 MCP 服务进程，这里锁定转发口径
 * （只放行 tools/call、resources/read、tools/list）与错误映射。
 */

function fixture(worker: Partial<KicadWorker>) {
  const app = Fastify();
  const localAccess = {
    authenticate: vi.fn(async () => ({ actor: {} })),
  } as unknown as LocalAccessVerifier & { authenticate: ReturnType<typeof vi.fn> };
  registerKicadRoutes(app, {
    localAccess,
    worker: { ensureStarted: vi.fn(), ...worker } as unknown as KicadWorker,
  });
  return { app, localAccess };
}

describe("KiCad 路由", () => {
  it("状态：转发 worker 的就绪事实与工具清单", async () => {
    const status = {
      ready: true,
      error: null,
      tools: ["pcb_build", "kicad_info"],
      kicadVersion: "10.0.6",
      kicadInstalled: true,
      kicadApp: "C:/Program Files/KiCad/10.0",
      kicadInstallHint: "C:/Program Files/KiCad/10.0",
      workspace: "C:/data/work/kicad/workspace",
    };
    const { app } = fixture({ status: vi.fn(async () => status) });
    const response = await app.inject({
      method: "get",
      url: "/api/work/host/kicad/status",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
  });

  it("tools/call：把面板的调用转给服务进程并返回结果", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
    }));
    const { app } = fixture({ callTool: callTool as never });
    const response = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/rpc",
      payload: {
        method: "tools/call",
        params: { name: "kicad_board_view", arguments: { side: "top" } },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.structuredContent).toEqual({ ok: true });
    expect(callTool).toHaveBeenCalledWith("kicad_board_view", { side: "top" });
  });

  it("只放行白名单方法；缺工具名与坏参数都是 400", async () => {
    const { app } = fixture({ callTool: vi.fn() as never });
    const unknown = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/rpc",
      payload: { method: "initialize" },
    });
    expect(unknown.statusCode).toBe(400);
    const nameless = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/rpc",
      payload: { method: "tools/call", params: {} },
    });
    expect(nameless.statusCode).toBe(400);
    const notObject = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/rpc",
      payload: { method: "tools/call", params: { name: "x", arguments: 3 } },
    });
    expect(notObject.statusCode).toBe(200);
  });

  it("服务进程报错映射成 502，并把原因带出来", async () => {
    const { app } = fixture({
      callTool: vi.fn(async () => {
        throw new Error("KiCad 未安装");
      }) as never,
    });
    const response = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/rpc",
      payload: { method: "tools/call", params: { name: "pcb_build" } },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toBe("KiCad 未安装");
  });

  it("面板页与桥页都是同源 HTML，未登录被拦", async () => {
    const { app, localAccess } = fixture({});
    const panel = await app.inject({
      method: "get",
      url: "/api/work/host/kicad/panel.html",
    });
    expect(panel.statusCode).toBe(200);
    expect(panel.headers["content-type"]).toContain("text/html");
    expect(panel.body).toContain("kicad");
    const bridge = await app.inject({
      method: "get",
      url: "/api/work/host/kicad/panel",
    });
    expect(bridge.statusCode).toBe(200);
    expect(bridge.body).toContain("ui/initialize");
    localAccess.authenticate.mockResolvedValueOnce(null);
    const denied = await app.inject({
      method: "get",
      url: "/api/work/host/kicad/status",
    });
    expect(denied.statusCode).toBe(401);
  });
});
