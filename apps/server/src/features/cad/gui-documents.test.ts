import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { CadGuiDocumentsSnapshot } from "./gui-document-contracts.js";
import { createCadService } from "./service.js";
import {
  activateCadTestService,
  cadTestLimits,
  createCadTestContext,
} from "./test-fixtures.js";
import { createCadTools } from "./tools.js";

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-gui-document-unit-")),
  );
  closes.push(() => rm(root, { recursive: true, force: true }));
  const sandbox = createProcessSandbox({
    captureRoot: join(root, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  closes.push(() => sandbox.close("fixture_cleanup"));
  const spawn = vi.spyOn(sandbox, "spawnStdio");
  const task = await createCadTestContext(root);
  const application = {
    pid: 1234,
    launchedAt: 1000,
    birth: { startSeconds: 1, startMicroseconds: 123_456 },
    bundleId: "org.freecad.FreeCAD" as const,
    name: "FreeCAD",
    executablePath: "/Applications/FreeCAD.app/Contents/Resources/bin/freecad",
    bundlePath: "/Applications/FreeCAD.app",
  };
  const snapshot: CadGuiDocumentsSnapshot = {
    application,
    observationId: "441b3b2a-c732-473c-99d6-9b82dad0039d",
    version: ["1", "1", "4"],
    documents: [
      {
        name: "Unnamed",
        label: "未保存零件",
        fileName: "",
        uid: "native-uid",
        modified: true,
        touched: false,
        pendingTransaction: false,
        active: true,
      },
    ],
  };
  const reader = { read: vi.fn(async () => snapshot) };
  let installed = true;
  const service = createCadService({
    sandbox,
    guiDocumentReader: reader,
    gate: async () => ({ ok: installed }),
    resolveLimits: async () => ({ limits: cadTestLimits, timeoutMs: 30_000 }),
  });
  activateCadTestService(service);
  return {
    ...task,
    application,
    snapshot,
    reader,
    service,
    spawn,
    disableGate() {
      installed = false;
    },
  };
}

test("当前文档清单声明外部应用执行审批，不接受任意宏或端点", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_documents",
  );
  expect(tool).toMatchObject({
    access: "execute",
    approvalReviewKind: "cad-gui-inspect",
    scope: "shared",
    exposure: "deferred",
  });
  if (!tool?.zodSchema) throw new Error("缺少文档查询的真实参数契约");
  expect(tool.zodSchema.safeParse({ application: f.application }).success).toBe(
    true,
  );
  for (const extra of [
    { source: "unsafe()" },
    { macroPath: "/tmp/model.FCMacro" },
    { endpoint: "/tmp/FreeCAD" },
  ])
    expect(
      tool.zodSchema.safeParse({ application: f.application, ...extra })
        .success,
    ).toBe(false);
});

test("通过现有Task与安装门控查询文档元数据，GUI不冒充Task沙箱进程", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_documents",
  );
  if (!tool) throw new Error("缺少当前文档工具消费方");
  const result = await tool.execute({ application: f.application }, f.context);
  expect(result).toMatchObject({
    structuredContent: { ...f.snapshot, currentDocumentControl: false },
  });
  expect(f.reader.read).toHaveBeenCalledWith(
    f.application,
    expect.objectContaining({
      timeoutMs: 10_000,
      signal: expect.any(AbortSignal),
    }),
  );
  expect(f.spawn).not.toHaveBeenCalled();
  f.disableGate();
  expect(
    await tool.execute(
      { application: f.application },
      { ...f.context, toolCallId: "after-disable" },
    ),
  ).toMatchObject({ isError: true });
  expect(f.reader.read).toHaveBeenCalledOnce();
});

test("查询期间Task代际改变，迟到的文档元数据不能发布", async () => {
  const f = await fixture();
  f.reader.read.mockImplementation(async () => {
    f.stored.scope.generation++;
    return f.snapshot;
  });
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_documents",
  );
  if (!tool) throw new Error("缺少当前文档工具消费方");
  const result = await tool.execute({ application: f.application }, f.context);
  expect(result).toMatchObject({ isError: true });
  expect(result).not.toHaveProperty("structuredContent.documents");
});

test("同一次GUI查询并发与重放只装载一次宏，参数冲突不派发", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_documents",
  );
  if (!tool) throw new Error("缺少当前文档工具消费方");
  const input = { application: f.application };
  const [first, second] = await Promise.all([
    tool.execute(input, f.context),
    tool.execute(input, f.context),
  ]);
  expect(first).toEqual(second);
  expect(f.reader.read).toHaveBeenCalledOnce();
  expect(await tool.execute(input, f.context)).toEqual(first);
  const conflict = await tool.execute(
    { application: { ...f.application, pid: f.application.pid + 1 } },
    f.context,
  );
  expect(conflict).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "invocation_conflict" } },
  });
  expect(f.reader.read).toHaveBeenCalledOnce();
});
