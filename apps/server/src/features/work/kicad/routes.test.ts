import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("工具条示例：示例 spec → 校验 → 建板，返回 DRC 摘要", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "pcb_spec_example")
        return { structuredContent: { ok: true, spec: { name: "x", parts: [] } } };
      if (name === "pcb_check_spec")
        return { structuredContent: { ok: true, spec_artifact_id: "a_spec" } };
      return {
        structuredContent: {
          ok: true,
          pcb_artifact_id: "a_board",
          drc: { errors: 0, unconnected: 0 },
        },
      };
    });
    const { app } = fixture({ callTool: callTool as never });
    const response = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/example",
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      artifact_id: "a_board",
      errors: 0,
    });
    expect(callTool).toHaveBeenCalledWith("pcb_build", {
      spec_artifact_id: "a_spec",
      route: true,
    });
  });

  it("工具条导入：坏 JSON 与缺 parts 都是 400；合法 spec 落盘后走文件校验", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "kicad_check_spec_file")
        return { structuredContent: { ok: true, spec_artifact_id: "a_spec" } };
      return {
        structuredContent: { ok: true, pcb_artifact_id: "a_board", drc: {} },
      };
    });
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-kicad-route-"));
    const worker = {
      ensureStarted: vi.fn(),
      workspaceDir: () => dataDir,
      callTool,
    };
    const app = Fastify();
    registerKicadRoutes(app, {
      localAccess: {
        authenticate: async () => ({ actor: {} }),
      } as unknown as LocalAccessVerifier,
      worker: worker as unknown as KicadWorker,
    });
    const bad = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/spec",
      payload: { text: "not json" },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/spec",
      payload: { text: "{}" },
    });
    expect(missing.statusCode).toBe(400);
    const ok = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/spec",
      payload: { text: JSON.stringify({ parts: [] }), name: "my board" },
    });
    expect(ok.statusCode).toBe(200);
    expect(callTool).toHaveBeenCalledWith("kicad_check_spec_file", {
      spec_path: join(dataDir, "kicad", "board_spec.json"),
    });
  });

  it("面板「打开文件」：.kicad_pcb 落盘后交给 kicad_import_board", async () => {
    const callTool = vi.fn(async () => ({
      structuredContent: {
        ok: true,
        artifact_id: "a_imported",
        errors: 1,
        unconnected: 2,
      },
    }));
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-kicad-open-"));
    const app = Fastify();
    registerKicadRoutes(app, {
      localAccess: {
        authenticate: async () => ({ actor: {} }),
      } as unknown as LocalAccessVerifier,
      worker: {
        ensureStarted: vi.fn(),
        workspaceDir: () => dataDir,
        callTool,
      } as unknown as KicadWorker,
    });
    const response = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/file",
      payload: {
        name: "my-board.kicad_pcb",
        base64: Buffer.from("(kicad_pcb)").toString("base64"),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      artifact_id: "a_imported",
      errors: 1,
      unconnected: 2,
    });
    const boardPath = join(dataDir, "kicad", "open", "my-board.kicad_pcb");
    expect(callTool).toHaveBeenCalledWith("kicad_import_board", {
      board_path: boardPath,
      name: "my-board",
    });
    expect(readFileSync(boardPath, "utf8")).toBe("(kicad_pcb)");
  });

  it("面板「打开文件」：spec JSON 走建板，其他扩展名与坏文件名拒绝", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "kicad_check_spec_file")
        return { structuredContent: { ok: true, spec_artifact_id: "a_spec" } };
      return {
        structuredContent: { ok: true, pcb_artifact_id: "a_board", drc: {} },
      };
    });
    const dataDir = mkdtempSync(join(tmpdir(), "kfw-kicad-open-"));
    const app = Fastify();
    registerKicadRoutes(app, {
      localAccess: {
        authenticate: async () => ({ actor: {} }),
      } as unknown as LocalAccessVerifier,
      worker: {
        ensureStarted: vi.fn(),
        workspaceDir: () => dataDir,
        callTool,
      } as unknown as KicadWorker,
    });
    const spec = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/file",
      payload: { name: "board.json", text: JSON.stringify({ parts: [] }) },
    });
    expect(spec.statusCode).toBe(200);
    expect(callTool).toHaveBeenCalledWith("kicad_check_spec_file", {
      spec_path: join(dataDir, "kicad", "open", "board_spec.json"),
    });
    const wrongType = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/file",
      payload: { name: "board.kicad_sch", base64: "AA==" },
    });
    expect(wrongType.statusCode).toBe(400);
    const badName = await app.inject({
      method: "post",
      url: "/api/work/host/kicad/file",
      payload: { name: "../x.kicad_pcb", base64: "AA==" },
    });
    expect(badName.statusCode).toBe(400);
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
    expect(bridge.body).toContain("打开文件");
    expect(bridge.body).toContain('locale: "zh-CN"');
    localAccess.authenticate.mockResolvedValueOnce(null);
    const denied = await app.inject({
      method: "get",
      url: "/api/work/host/kicad/status",
    });
    expect(denied.statusCode).toBe(401);
  });
});
