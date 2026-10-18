import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { PluginStateRevokingEvent } from "../plugins/state-lifecycle.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { CadGuiDocumentsSnapshot } from "./gui-document-contracts.js";
import {
  type CadGuiCopyDocumentInput,
  cadGuiCopyDocumentReceiptSchema,
} from "./gui-document-copy-contracts.js";
import type { CadGuiOperationResult } from "./gui-operation-controller.js";
import {
  type CadGuiOperationBinding,
  type CadGuiOperationIdentity,
  CadGuiOperationStoreError,
  createCadGuiOperationStore,
} from "./gui-operation-store.js";
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
    bridgeEpoch: "b1ff2ef8-0854-40c9-9da8-c9ff07bfb219",
    applicationRevision: 2,
    documents: [
      {
        name: "Unnamed",
        documentHandle: "28686cba-59d6-44c3-a30c-bbca88a7d737",
        revision: 3,
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
  const document = snapshot.documents[0];
  if (!document) throw new Error("测试夹具缺少目标文档");
  const inspection = {
    application,
    observationId: snapshot.observationId,
    version: snapshot.version,
    bridgeEpoch: snapshot.bridgeEpoch,
    applicationRevision: snapshot.applicationRevision,
    document,
    objects: [{ name: "Box", label: "零件", typeId: "Part::Box" }],
  };
  const target = {
    application,
    bridgeEpoch: snapshot.bridgeEpoch,
    documentHandle: document.documentHandle,
    expectedApplicationRevision: snapshot.applicationRevision,
    expectedDocumentRevision: document.revision,
  };
  const reader = {
    read: vi.fn(async () => snapshot),
    inspect: vi.fn(async () => inspection),
  };
  const operationResult: CadGuiOperationResult = {
    operationId: "b357cc8d-e5a1-4a3e-b23f-c145e99f163d",
    state: "terminal",
    outcome: "committed",
    cancellationRequested: false,
  };
  const store = createCadGuiOperationStore({ rootDirectory: root });
  const operations = {
    execute: vi.fn(async () => operationResult),
    undoOperation: vi.fn(async (..._args: unknown[]) => ({
      ...operationResult,
      outcome: "undone" as const,
    })),
    status: vi.fn(
      async (
        identity: CadGuiOperationIdentity,
      ): Promise<CadGuiOperationResult> => {
        const record = await store.lookup(identity);
        if (
          record?.payload &&
          typeof record.payload === "object" &&
          "operation" in record.payload &&
          record.payload.operation === "save-copy"
        ) {
          const state = await store.readState(record);
          const receipt = cadGuiCopyDocumentReceiptSchema.parse(state.receipt);
          return {
            operationId: identity.operationId,
            state: "terminal",
            outcome: receipt.outcome,
            receipt,
            cancellationRequested: state.cancelled,
          };
        }
        return operationResult;
      },
    ),
    copyDocument: vi.fn(
      async (
        input: CadGuiCopyDocumentInput,
        binding: CadGuiOperationBinding,
      ): Promise<CadGuiOperationResult> => {
        const record = await store.prepare({
          operationId: input.operationId,
          binding,
          payload: { operation: "save-copy", ...input, timeoutMs: 30_000 },
          buildMacro: () => "# native copy fixture\n",
        });
        const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x81]);
        const receipt = cadGuiCopyDocumentReceiptSchema.parse({
          protocol: "kfw-cad-gui-copy/1",
          operationId: input.operationId,
          fingerprint: record.fingerprint,
          pid: input.application.pid,
          completed: true,
          guiThread: true,
          outcome: "copied",
          copyStarted: true,
          statePreserved: true,
          artifact: {
            name: "document.FCStd",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            hasGuiDocument: true,
          },
        });
        await writeFile(join(record.directory, "document.FCStd"), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        await writeFile(record.receiptPath, JSON.stringify(receipt), {
          flag: "wx",
          mode: 0o600,
        });
        return {
          operationId: input.operationId,
          state: "terminal",
          outcome: "copied",
          receipt,
          cancellationRequested: false,
        };
      },
    ),
  };
  let installed = true;
  const service = createCadService({
    sandbox,
    guiDocumentReader: reader,
    guiOperationController: operations,
    guiOperationStore: store,
    gate: async () => ({ ok: installed }),
    resolveLimits: async () => ({ limits: cadTestLimits, timeoutMs: 30_000 }),
  });
  activateCadTestService(service);
  return {
    ...task,
    application,
    snapshot,
    inspection,
    target,
    reader,
    operations,
    operationResult,
    store,
    root,
    service,
    spawn,
    disableGate() {
      installed = false;
    },
  };
}

async function oldPending(
  f: Awaited<ReturnType<typeof fixture>>,
  runId: string,
) {
  const old = createCadGuiOperationStore({ rootDirectory: f.root });
  const record = await old.prepare({
    operationId: randomUUID(),
    binding: {
      instanceId: f.scope.instanceId,
      projectId: f.scope.projectId,
      taskId: f.scope.taskId,
      scopeGeneration: f.scope.generation,
      branchGeneration: 1,
      runId,
      toolCallId: "old-call",
    },
    payload: { operation: "fixed-old-operation" },
    buildMacro: () => "pass\n",
  });
  await old.claimDispatch(record);
  return record;
}

test.each(["disable", "uninstall", "replace", "shutdown"] as const)(
  "新宿主无内存调用时，%s仍取消旧持久派发且不重新连接GUI",
  async (reason) => {
    const f = await fixture();
    const record = await oldPending(f, "prior-server-run");
    const event = {
      reason,
      previous: {
        id: "bundled__kenfutwork-cad",
        name: "kenfutwork-cad",
        enabled: true,
      },
      current: null,
    } as PluginStateRevokingEvent;
    await f.service.pluginLifecycle.onStateRevoking?.(event);
    expect(await f.store.readState(record)).toMatchObject({
      status: "dispatched",
      cancelled: true,
      outcome: "unknown",
    });
    expect(f.operations.execute).not.toHaveBeenCalled();
    expect(f.operations.status).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  },
);

test("Run关闭只取消其来源旧请求，宿主dispose再收束其它旧请求", async () => {
  const f = await fixture();
  const one = await oldPending(f, "prior-one");
  const two = await oldPending(f, "prior-two");
  await f.service.releaseRun("prior-one");
  expect(await f.store.readState(one)).toMatchObject({ cancelled: true });
  expect(await f.store.readState(two)).toMatchObject({ cancelled: false });
  await f.service.dispose();
  expect(await f.store.readState(two)).toMatchObject({ cancelled: true });
});

test("持久取消失败不宣称停用成功，也不能用重新启用绕过，成功重试后恢复", async () => {
  const f = await fixture();
  const record = await oldPending(f, "prior-server-run");
  const event = {
    reason: "disable",
    previous: {
      id: "bundled__kenfutwork-cad",
      name: "kenfutwork-cad",
      enabled: true,
    },
    current: null,
  } as PluginStateRevokingEvent;
  const cancel = vi
    .spyOn(f.store, "cancelPending")
    .mockRejectedValue(
      new CadGuiOperationStoreError(
        "stop_unconfirmed",
        "无法确认旧操作已取消。",
      ),
    );
  await expect(
    f.service.pluginLifecycle.onStateRevoking?.(event),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  f.service.pluginLifecycle.afterStateChanged?.({
    reason: "enable",
    previous: event.previous,
    current: event.previous,
  });
  expect(f.service.activationAvailable).toBe(false);
  cancel.mockRestore();
  await f.service.releaseRun("unrelated-run");
  f.service.pluginLifecycle.afterStateChanged?.({
    reason: "enable",
    previous: event.previous,
    current: event.previous,
  });
  expect(f.service.activationAvailable).toBe(false);
  await f.service.pluginLifecycle.onStateRevoking?.(event);
  f.service.pluginLifecycle.afterStateChanged?.({
    reason: "enable",
    previous: event.previous,
    current: event.previous,
  });
  expect(f.service.activationAvailable).toBe(true);
  expect(await f.store.readState(record)).toMatchObject({ cancelled: true });
});

test("其它插件停用不取消CAD，Run关闭等待持久扫描结束才放开屏障", async () => {
  const f = await fixture();
  const cancel = vi.spyOn(f.store, "cancelPending");
  await f.service.pluginLifecycle.onStateRevoking?.({
    reason: "disable",
    previous: {
      id: "local__kenfutwork-cad",
      name: "kenfutwork-cad",
      enabled: true,
    },
    current: null,
  } as PluginStateRevokingEvent);
  expect(cancel).not.toHaveBeenCalled();
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  cancel.mockImplementation(async () => pending);
  const closing = f.service.releaseRun(f.context.runId ?? "");
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  const result = await f.service.guiDocuments(f.application, f.context);
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "cancelled" } },
  });
  expect(f.reader.read).not.toHaveBeenCalled();
  finish();
  await closing;
});

test("副本工具有独立序列化与文件发布审批，真实Task权限发布新FCStd", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_copy_document",
  );
  expect(tool).toMatchObject({
    access: "execute",
    approvalReviewKind: "cad-gui-copy",
  });
  if (!tool) throw new Error("缺少文档副本工具");
  const operationId = randomUUID();
  const input = { ...f.target, operationId, outputPath: "exports/副本.FCStd" };
  const result = await tool.execute(input, f.context);
  expect(result).toMatchObject({
    structuredContent: {
      operationId,
      outcome: "published",
      nativeOutcome: "copied",
      outputPath: join(f.root, "exports/副本.FCStd"),
    },
  });
  expect(f.operations.copyDocument).toHaveBeenCalledWith(
    { ...input, outputPath: join(f.root, "exports/副本.FCStd") },
    expect.objectContaining({
      taskId: f.scope.taskId,
      scopeGeneration: 1,
      branchGeneration: 1,
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    expect.any(Function),
  );
  expect(await readFile(join(f.root, "exports/副本.FCStd"))).toEqual(
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x81]),
  );
  expect(f.operations.execute).not.toHaveBeenCalled();
  const status = await f.service.guiOperationStatus(operationId, {
    ...f.context,
    toolCallId: "copy-status",
  });
  expect(status).toMatchObject({
    structuredContent: {
      operationId,
      nativeOutcome: "copied",
      outcome: "published",
      publicationOutcome: "published",
    },
  });
});

test("副本发布目录未授权时先拒绝，不向GUI发送复制请求", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_copy_document",
  );
  if (!tool) throw new Error("缺少文档副本工具");
  expect(
    await tool.execute(
      {
        ...f.target,
        operationId: randomUUID(),
        outputPath: "/outside/副本.FCStd",
      },
      f.context,
    ),
  ).toMatchObject({ isError: true });
  expect(f.operations.copyDocument).not.toHaveBeenCalled();
});

test("显式撤销工具使用独立审批与当前Task权限，参数冻结且状态查询不派发", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_undo_operation",
  );
  expect(tool).toMatchObject({
    access: "execute",
    approvalReviewKind: "cad-gui-undo",
    scope: "shared",
    exposure: "deferred",
  });
  if (!tool?.zodSchema) throw new Error("缺少正式撤销工具");
  const input = {
    ...f.target,
    operationId: randomUUID(),
    sourceOperationId: f.operationResult.operationId,
  };
  const original = structuredClone(input);
  const undone = {
    ...f.operationResult,
    operationId: input.operationId,
    outcome: "undone" as const,
  };
  let finish = () => {};
  f.operations.undoOperation.mockImplementation(async (payload) => {
    expect(payload).toEqual(original);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return undone;
  });
  const first = tool.execute(input, f.context);
  input.sourceOperationId = randomUUID();
  await vi.waitFor(() =>
    expect(f.operations.undoOperation).toHaveBeenCalledOnce(),
  );
  finish();
  expect(await first).toMatchObject({ structuredContent: undone });
  expect(await tool.execute(original, f.context)).toMatchObject({
    structuredContent: undone,
  });
  expect(f.operations.undoOperation).toHaveBeenCalledOnce();
  expect(f.operations.undoOperation).toHaveBeenCalledWith(
    original,
    expect.objectContaining({
      taskId: f.scope.taskId,
      scopeGeneration: 1,
      branchGeneration: 1,
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    expect.any(Function),
  );
  f.operations.status.mockResolvedValue(undone);
  expect(
    await f.service.guiOperationStatus(undone.operationId, {
      ...f.context,
      toolCallId: "undo-status",
    }),
  ).toMatchObject({ structuredContent: undone });
  expect(f.operations.undoOperation).toHaveBeenCalledOnce();
  expect(f.reader.read).not.toHaveBeenCalled();
  for (const extra of [
    { source: "unsafe()" },
    { undoSource: { receipt: "model-proof" } },
    { sourceOperationId: input.operationId },
    { macroPath: "/tmp/undo.FCMacro" },
  ])
    expect(tool.zodSchema.safeParse({ ...original, ...extra }).success).toBe(
      false,
    );
});

test("撤销调用拒绝只读与停用，迟到代际变化不发布成功", async () => {
  for (const mode of ["readonly", "disabled", "generation"] as const) {
    const f = await fixture();
    const tool = createCadTools(f.service).find(
      (entry) => entry.name === "cad_gui_undo_operation",
    );
    if (!tool) throw new Error("缺少正式撤销工具");
    const input = {
      ...f.target,
      operationId: randomUUID(),
      sourceOperationId: f.operationResult.operationId,
    };
    if (mode === "readonly") f.stored.scope.sandboxMode = "read-only";
    if (mode === "disabled") f.disableGate();
    if (mode === "generation")
      f.operations.undoOperation.mockImplementation(async () => {
        f.stored.scope.generation++;
        return {
          ...f.operationResult,
          operationId: input.operationId,
          outcome: "undone",
        };
      });
    expect(await tool.execute(input, f.context)).toMatchObject({
      isError: true,
    });
    if (mode !== "generation")
      expect(f.operations.undoOperation).not.toHaveBeenCalled();
  }
});

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

test("GUI 对象读取沿用真实 Task、执行审批与参数冻结，重放不重复读取", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_inspect_document",
  );
  expect(tool).toMatchObject({
    access: "execute",
    approvalReviewKind: "cad-gui-inspect",
    scope: "shared",
    exposure: "deferred",
  });
  if (!tool) throw new Error("缺少当前文档对象读取工具");
  const input = { ...f.target, objectNames: ["Box"] };
  const [first, replay] = await Promise.all([
    tool.execute(input, f.context),
    tool.execute(input, f.context),
  ]);
  expect(first).toMatchObject({ structuredContent: f.inspection });
  expect(replay).toEqual(first);
  expect(f.reader.inspect).toHaveBeenCalledOnce();
  expect(f.reader.inspect).toHaveBeenCalledWith(
    input,
    expect.objectContaining({
      timeoutMs: 10_000,
      signal: expect.any(AbortSignal),
    }),
  );
  expect(f.spawn).not.toHaveBeenCalled();
  expect(
    await tool.execute({ ...input, objectNames: ["Other"] }, f.context),
  ).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "invocation_conflict" } },
  });
  expect(f.reader.inspect).toHaveBeenCalledOnce();
});

test("GUI 对象读取拒绝未知代码与含糊对象选择，撤权后不返回迟到内容", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_inspect_document",
  );
  if (!tool) throw new Error("缺少当前文档对象读取工具");
  for (const extra of [
    { source: "unsafe()" },
    { endpoint: "/tmp/FreeCAD" },
    { objectNames: [] },
    { objectNames: ["Box", "Box"] },
  ])
    expect(
      await tool.execute({ ...f.target, ...extra }, f.context),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invalid_arguments" } },
    });
  expect(f.reader.inspect).not.toHaveBeenCalled();
  f.reader.inspect.mockImplementation(async () => {
    f.stored.scope.generation++;
    return f.inspection;
  });
  const late = await tool.execute(f.target, f.context);
  expect(late).toMatchObject({ isError: true });
  expect(late).not.toHaveProperty("structuredContent.objects");
});

test("GUI 对象读取不以文档句柄绕过 Task 只读或插件安装状态", async () => {
  const f = await fixture();
  f.stored.scope.sandboxMode = "read-only";
  expect(await f.service.guiInspectDocument(f.target, f.context)).toMatchObject(
    {
      isError: true,
      structuredContent: { error: { code: "forbidden" } },
    },
  );
  expect(f.reader.inspect).not.toHaveBeenCalled();
  const disabled = await fixture();
  disabled.disableGate();
  expect(
    await disabled.service.guiInspectDocument(
      disabled.target,
      disabled.context,
    ),
  ).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "plugin_disabled" } },
  });
  expect(disabled.reader.inspect).not.toHaveBeenCalled();
});

test("GUI 受控写入使用单独执行审批，持久操作状态查询不接入外部应用", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_set_properties",
  );
  expect(tool).toMatchObject({
    access: "execute",
    approvalReviewKind: "cad-gui-mutate",
  });
  if (!tool) throw new Error("缺少当前文档受控修改工具");
  const input = {
    ...f.target,
    operationId: f.operationResult.operationId,
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        expectedValue: "Box",
        value: "零件",
      },
    ],
  };
  expect(await tool.execute(input, f.context)).toMatchObject({
    structuredContent: f.operationResult,
  });
  expect(f.operations.execute).toHaveBeenCalledWith(
    { ...input, recompute: true },
    expect.objectContaining({
      instanceId: f.scope.instanceId,
      projectId: f.scope.projectId,
      taskId: f.scope.taskId,
      scopeGeneration: f.scope.generation,
      branchGeneration: 1,
      runId: f.context.runId,
      toolCallId: f.context.toolCallId,
    }),
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      timeoutMs: 30_000,
    }),
    expect.any(Function),
  );
  const status = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_operation_status",
  );
  expect(status).toMatchObject({ access: "read" });
  if (!status) throw new Error("缺少持久操作状态工具");
  expect(
    await status.execute(
      { operationId: input.operationId },
      { ...f.context, toolCallId: "status" },
    ),
  ).toMatchObject({
    structuredContent: f.operationResult,
  });
  expect(f.operations.status).toHaveBeenCalledWith({
    instanceId: f.scope.instanceId,
    taskId: f.scope.taskId,
    operationId: input.operationId,
  });
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.reader.read).not.toHaveBeenCalled();
  expect(f.reader.inspect).not.toHaveBeenCalled();
});

test("GUI 写入拒绝只读Task；迟到写入回执仍保留操作编号供查询", async () => {
  const f = await fixture();
  const input = {
    ...f.target,
    operationId: f.operationResult.operationId,
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        expectedValue: "Box",
        value: "零件",
      },
    ],
    recompute: true,
  };
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_set_properties",
  );
  if (!tool) throw new Error("缺少当前文档受控修改工具");
  f.stored.scope.sandboxMode = "read-only";
  expect(await tool.execute(input, f.context)).toMatchObject({ isError: true });
  expect(f.operations.execute).not.toHaveBeenCalled();
  const late = await fixture();
  late.operations.execute.mockImplementation(async () => {
    late.stored.scope.generation++;
    return late.operationResult;
  });
  const lateTool = createCadTools(late.service).find(
    (entry) => entry.name === "cad_gui_set_properties",
  );
  if (!lateTool) throw new Error("缺少当前文档受控修改工具");
  expect(await lateTool.execute(input, late.context)).toMatchObject({
    isError: true,
    structuredContent: { operationId: input.operationId, outcome: "unknown" },
  });
});

test("通过现有Task与安装门控查询文档元数据，GUI不冒充Task沙箱进程", async () => {
  const f = await fixture();
  const tool = createCadTools(f.service).find(
    (entry) => entry.name === "cad_gui_documents",
  );
  if (!tool) throw new Error("缺少当前文档工具消费方");
  const result = await tool.execute({ application: f.application }, f.context);
  expect(result).toMatchObject({
    structuredContent: { ...f.snapshot, currentDocumentControl: true },
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
