import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessSandbox } from "../process-sandbox/service.js";
import {
  type CadGuiApplication,
  type CadGuiProbe,
  CadGuiProbeError,
} from "./gui-probe.js";
import { createCadService } from "./service.js";
import {
  activateCadTestService,
  cadTestLimits,
  createCadTestContext,
  executeCadTestTool,
} from "./test-fixtures.js";
import { createCadTools } from "./tools.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-cad-gui-")));
  roots.push(root);
  const task = await createCadTestContext(root);
  const application: CadGuiApplication = {
    pid: 42,
    bundleId: "org.freecad.FreeCAD",
    name: "FreeCAD",
    executablePath: "/Applications/FreeCAD.app/Contents/Resources/bin/freecad",
    bundlePath: "/Applications/FreeCAD.app",
    launchedAt: 1_792_000_000_123.25,
    birth: { startSeconds: 1_792_000_000, startMicroseconds: 174_553 },
  };
  const list = vi.fn<CadGuiProbe["list"]>(async () => [application]);
  const gate = vi.fn(async () => ({ ok: true }));
  const resolveLimits = vi.fn(async () => ({
    limits: cadTestLimits,
    timeoutMs: 30_000 as number | null,
  }));
  const service = createCadService({
    sandbox: createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    }),
    gate,
    resolveLimits,
    guiProbe: { list, verify: vi.fn() },
  });
  activateCadTestService(service);
  const tool = createCadTools(service).find(
    (item) => item.name === "cad_gui_status",
  );
  if (!tool) throw new Error("缺少 FreeCAD 应用状态工具");
  return { ...task, application, list, gate, resolveLimits, service, tool };
}

describe("CAD 当前应用只读查询", () => {
  it("通过真实 Task 的共享按需工具查询，不操作文档并严格拒绝其它参数", async () => {
    const f = await fixture();
    expect(f.tool).toMatchObject({
      scope: "shared",
      exposure: "deferred",
      access: "read",
    });
    expect(f.tool.approvalReviewKind).toBeUndefined();
    expect(await executeCadTestTool(f.tool, {}, f.context)).toMatchObject({
      structuredContent: {
        applications: [f.application],
        currentDocumentControl: false,
      },
    });
    expect(f.list).toHaveBeenCalledOnce();
    expect(f.list.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: 10_000,
      maxOutputBytes: cadTestLimits.maxOutputBytes,
    });
    expect(
      await executeCadTestTool(f.tool, { source: "print('x')" }, f.context),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invalid_arguments" } },
    });
    expect(f.list).toHaveBeenCalledOnce();
  });

  it("未安装或身份不符时不运行宿主查询", async () => {
    const f = await fixture();
    f.gate.mockResolvedValue({ ok: false });
    expect(await f.service.guiStatus(f.context)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "plugin_disabled" } },
    });
    expect(
      await f.service.guiStatus({ ...f.context, instanceId: "another" }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "context_required" } },
    });
    expect(f.list).not.toHaveBeenCalled();
  });

  it("设置读取期间撤权，不派发宿主查询", async () => {
    const f = await fixture();
    f.resolveLimits.mockImplementation(async () => {
      f.stored.scope.generation++;
      return { limits: cadTestLimits, timeoutMs: null };
    });
    expect(await f.service.guiStatus(f.context)).toMatchObject({
      isError: true,
    });
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each(["revoked", "disabled"])(
    "宿主查询返回前%s，拒绝迟到的应用信息",
    async (kind) => {
      const f = await fixture();
      f.list.mockImplementation(async () => {
        if (kind === "revoked") f.stored.scope.generation++;
        else f.gate.mockResolvedValue({ ok: false });
        return [f.application];
      });
      const result = await f.service.guiStatus(f.context);
      expect(result.isError).toBe(true);
      expect(result.structuredContent.applications).toBeUndefined();
    },
  );

  it("Task Work 的停止信号取消查询且不返回成功", async () => {
    const f = await fixture();
    const work = new AbortController();
    const taskWork = f.context.taskWorkContext;
    if (!taskWork) throw new Error("缺少 Task Work");
    f.context.taskWorkContext = {
      ...taskWork,
      signal: work.signal,
    };
    f.list.mockImplementation(async ({ signal }) => {
      work.abort();
      signal?.throwIfAborted();
      return [f.application];
    });
    expect(await f.service.guiStatus(f.context)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "cancelled" } },
    });
  });

  it("无运行应用与不支持当前平台是不同结果", async () => {
    const f = await fixture();
    f.list.mockResolvedValue([]);
    expect(await f.service.guiStatus(f.context)).toMatchObject({
      structuredContent: { applications: [] },
    });
    f.list.mockRejectedValue(
      new CadGuiProbeError("not_supported", "当前系统不支持 FreeCAD 应用查询"),
    );
    expect(await f.service.guiStatus(f.context)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_supported" } },
    });
  });
});
