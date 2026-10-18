import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { CadGuiApplication } from "./gui-document-contracts.js";
import {
  CadGuiOperationError,
  createCadGuiOperationController,
} from "./gui-operation-controller.js";
import {
  type CadGuiOperationStore,
  createCadGuiOperationStore,
} from "./gui-operation-store.js";
import { CadGuiProbeError } from "./gui-probe.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-cad-controller-")),
  );
  roots.push(root);
  const application = {
    pid: 1234,
    launchedAt: 1000,
    birth: { startSeconds: 1, startMicroseconds: 123_456 },
    bundleId: "org.freecad.FreeCAD" as const,
    name: "FreeCAD",
    executablePath: "/Applications/FreeCAD.app/Contents/Resources/bin/freecad",
    bundlePath: "/Applications/FreeCAD.app",
  };
  const input = {
    application,
    operationId: randomUUID(),
    bridgeEpoch: "b1ff2ef8-0854-40c9-9da8-c9ff07bfb219",
    documentHandle: "28686cba-59d6-44c3-a30c-bbca88a7d737",
    expectedApplicationRevision: 2,
    expectedDocumentRevision: 3,
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
  const binding = {
    instanceId: "instance-1",
    projectId: "project-1",
    taskId: "task-1",
    scopeGeneration: 1,
    branchGeneration: 1,
    runId: "run-1",
    toolCallId: "tool-1",
  };
  const store = createCadGuiOperationStore({ rootDirectory: root });
  const probe = {
    list: vi.fn(async () => [application]),
    verify: vi.fn(async () => application),
  };
  const signal = new AbortController();
  const context = {
    signal: signal.signal,
    timeoutMs: 1000,
    maxOutputBytes: 65_536,
  };
  const publish = async (
    macroPath: string,
    changed: Record<string, unknown> = {},
    raw?: string,
  ) => {
    const directory = dirname(macroPath);
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    const receipt = {
      protocol: "kfw-cad-gui-operation/1",
      operationId: input.operationId,
      fingerprint: manifest.fingerprint,
      pid: application.pid,
      guiThread: true,
      completed: true,
      outcome: "committed",
      mutationStarted: true,
      commitAttempted: true,
      commitObserved: true,
      transactionState: "none",
      changes: [
        {
          objectName: "Box",
          propertyName: "Label",
          before: "Box",
          requested: "零件",
          observed: "零件",
          changed: true,
        },
      ],
      ...changed,
    };
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, raw ?? JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    await link(temporary, join(directory, "receipt.json"));
  };
  const send = vi.fn(
    async (_application: CadGuiApplication, macroPath: string) =>
      publish(macroPath),
  );
  const controller = createCadGuiOperationController({
    store,
    probe,
    transport: { send },
  });
  return {
    root,
    input,
    binding,
    store,
    probe,
    signal,
    context,
    send,
    publish,
    controller,
  };
}

test("先持久认领再派发固定写入宏，匹配回执后返回已提交", async () => {
  const f = await fixture();
  const result = await f.controller.execute(f.input, f.binding, f.context);
  expect(result).toMatchObject({
    operationId: f.input.operationId,
    state: "terminal",
    outcome: "committed",
    cancellationRequested: false,
    receipt: { mutationStarted: true, commitObserved: true },
  });
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.probe.verify).toHaveBeenCalled();
});

test("复制当前文档后仅匹配私有native副本回执，不宣称Task文件已发布", async () => {
  const f = await fixture();
  const input = configureCopy(f);
  expect(
    await f.controller.copyDocument(input, f.binding, f.context),
  ).toMatchObject({
    state: "terminal",
    outcome: "copied",
    cancellationRequested: false,
    receipt: {
      artifact: { name: "document.FCStd", hasGuiDocument: true },
      statePreserved: true,
    },
  });
  f.probe.verify.mockRejectedValue(new Error("GUI已经退出"));
  expect(
    await restart(f).copyDocument(
      input,
      { ...f.binding, runId: "run-2" },
      { ...f.context, timeoutMs: 2000 },
    ),
  ).toMatchObject({ outcome: "copied" });
  expect(
    await restart(f).status({ ...f.binding, operationId: input.operationId }),
  ).toMatchObject({ outcome: "copied" });
  expect(await f.store.readPublication(await operation(f))).toEqual({});
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.probe.verify).toHaveBeenCalledTimes(2);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

function undoProvenanceReceipt(f: Fixture) {
  const transactionName = `KFW CAD ${randomUUID()}`;
  const history = (names: string[]) => ({
    count: names.length,
    sha256: createHash("sha256").update(JSON.stringify(names)).digest("hex"),
  });
  return {
    undoProvenance: {
      transactionName,
      undoHistory: history([transactionName]),
      redoHistory: history([]),
    },
    snapshot: {
      bridgeEpoch: f.input.bridgeEpoch,
      applicationRevision: f.input.expectedApplicationRevision + 1,
      document: {
        name: "Part",
        label: "零件",
        fileName: "",
        uid: "native-uid",
        modified: true,
        touched: false,
        pendingTransaction: false,
        active: true,
        documentHandle: f.input.documentHandle,
        revision: f.input.expectedDocumentRevision + 1,
      },
    },
  };
}

async function prepareUndo(
  f: Fixture,
  sourceFields: Record<string, unknown> = {},
) {
  const source = undoProvenanceReceipt(f);
  f.send.mockImplementation(async (_application, macroPath) =>
    f.publish(macroPath, { ...source, ...sourceFields }),
  );
  await f.controller.execute(f.input, f.binding, f.context);
  const sourceRecord = await operation(f);
  const input = {
    application: f.input.application,
    operationId: randomUUID(),
    sourceOperationId: f.input.operationId,
    bridgeEpoch: source.snapshot.bridgeEpoch,
    documentHandle: source.snapshot.document.documentHandle,
    expectedApplicationRevision: source.snapshot.applicationRevision,
    expectedDocumentRevision: source.snapshot.document.revision,
  };
  const binding = {
    ...f.binding,
    scopeGeneration: 2,
    branchGeneration: 2,
    runId: "undo-run",
    toolCallId: "undo-call",
  };
  return { source, sourceRecord, input, binding };
}

type UndoFixture = Awaited<ReturnType<typeof prepareUndo>>;

function configureUndo(
  f: Fixture,
  prepared: UndoFixture,
  changed: Record<string, unknown> = {},
) {
  const { source, sourceRecord, input } = prepared;
  f.send.mockImplementation(async (_application, macroPath) => {
    const manifest = JSON.parse(
      await readFile(join(dirname(macroPath), "manifest.json"), "utf8"),
    );
    const history = (names: string[]) => ({
      count: names.length,
      sha256: createHash("sha256").update(JSON.stringify(names)).digest("hex"),
    });
    await f.publish(
      macroPath,
      {},
      JSON.stringify({
        protocol: "kfw-cad-gui-undo/1",
        operationId: input.operationId,
        fingerprint: manifest.fingerprint,
        pid: input.application.pid,
        sourceOperationId: input.sourceOperationId,
        sourceFingerprint: sourceRecord.fingerprint,
        guiThread: true,
        completed: true,
        outcome: "undone",
        undoStarted: true,
        undoObserved: true,
        historyVerified: true,
        transactionName: source.undoProvenance.transactionName,
        changes: [
          {
            objectName: "Box",
            propertyName: "Label",
            before: "零件",
            observed: "Box",
            changed: true,
          },
        ],
        undoHistory: history([]),
        redoHistory: history([source.undoProvenance.transactionName]),
        snapshot: {
          ...source.snapshot,
          applicationRevision: input.expectedApplicationRevision + 1,
          document: {
            ...source.snapshot.document,
            revision: input.expectedDocumentRevision + 1,
          },
        },
        ...changed,
      }),
    );
  });
}

test("当前Run用持久源提交的原post snapshot撤销自身事务，匹配完整撤销回执", async () => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  configureUndo(f, prepared);
  expect(
    await f.controller.undoOperation(
      prepared.input,
      prepared.binding,
      f.context,
    ),
  ).toMatchObject({
    state: "terminal",
    outcome: "undone",
    cancellationRequested: false,
    receipt: {
      sourceOperationId: prepared.input.sourceOperationId,
      sourceFingerprint: prepared.sourceRecord.fingerprint,
      historyVerified: true,
    },
  });
  expect(f.send).toHaveBeenCalledTimes(2);
});

test("提交回执持久保留自身事务归属，重建控制器查询不连接GUI", async () => {
  const f = await fixture();
  const receipt = undoProvenanceReceipt(f);
  f.send.mockImplementation(async (_application, macroPath) =>
    f.publish(macroPath, receipt),
  );
  const result = await f.controller.execute(f.input, f.binding, f.context);
  expect(result).toMatchObject({ outcome: "committed", receipt });
  f.probe.verify.mockRejectedValue(new Error("GUI已经退出"));
  expect(
    await restart(f).status({ ...f.binding, operationId: f.input.operationId }),
  ).toEqual(result);
  expect(f.send).toHaveBeenCalledOnce();
});

test.each([
  "epoch",
  "handle",
  "applicationRevision",
  "documentRevision",
  "pending",
  "inactive",
] as const)("带撤销归属的%s不一致回执不能作为可信提交", async (changed) => {
  const f = await fixture();
  const receipt = undoProvenanceReceipt(f);
  if (changed === "epoch") receipt.snapshot.bridgeEpoch = randomUUID();
  if (changed === "handle")
    receipt.snapshot.document.documentHandle = randomUUID();
  if (changed === "applicationRevision")
    receipt.snapshot.applicationRevision =
      f.input.expectedApplicationRevision - 1;
  if (changed === "documentRevision")
    receipt.snapshot.document.revision = f.input.expectedDocumentRevision - 1;
  if (changed === "pending")
    receipt.snapshot.document.pendingTransaction = true;
  if (changed === "inactive") receipt.snapshot.document.active = false;
  f.send.mockImplementation(async (_application, macroPath) =>
    f.publish(macroPath, receipt),
  );
  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
});

function copyInput(f: Fixture) {
  return {
    application: f.input.application,
    operationId: f.input.operationId,
    bridgeEpoch: f.input.bridgeEpoch,
    documentHandle: f.input.documentHandle,
    expectedApplicationRevision: f.input.expectedApplicationRevision,
    expectedDocumentRevision: f.input.expectedDocumentRevision,
  };
}

function configureCopy(f: Fixture, changed: Record<string, unknown> = {}) {
  const input = copyInput(f);
  f.send.mockImplementation(async (_app, macroPath) => {
    const directory = dirname(macroPath);
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    const bytes = Buffer.from("private native FCStd");
    await writeFile(join(directory, "document.FCStd"), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    await f.publish(
      macroPath,
      {},
      JSON.stringify({
        protocol: "kfw-cad-gui-copy/1",
        operationId: input.operationId,
        fingerprint: manifest.fingerprint,
        pid: input.application.pid,
        guiThread: true,
        completed: true,
        outcome: "copied",
        copyStarted: true,
        statePreserved: true,
        artifact: {
          name: "document.FCStd",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          hasGuiDocument: true,
        },
        ...changed,
      }),
    );
  });
  return input;
}

async function operation(f: Fixture) {
  const record = await f.store.lookup({
    ...f.binding,
    operationId: f.input.operationId,
  });
  if (!record) throw new Error("应找到持久操作记录");
  return record;
}

function restart(
  f: Fixture,
  store: CadGuiOperationStore = createCadGuiOperationStore({
    rootDirectory: f.root,
  }),
) {
  return createCadGuiOperationController({
    store,
    probe: f.probe,
    transport: { send: f.send },
  });
}

async function prepareWithoutClaim(f: Fixture) {
  const interrupted: CadGuiOperationStore = {
    ...f.store,
    async prepare(input) {
      await f.store.prepare(input);
      throw new Error("准备响应丢失");
    },
  };
  await expect(
    restart(f, interrupted).execute(f.input, f.binding, f.context),
  ).rejects.toThrow("准备响应丢失");
  return operation(f);
}

test("重启和新Run读取已提交结果，不要求原GUI仍存活且不重新派发", async () => {
  const f = await fixture();
  await f.controller.execute(f.input, f.binding, f.context);
  f.probe.verify.mockRejectedValue(new Error("应用已退出"));
  const controller = restart(f);

  const replay = await controller.execute(
    f.input,
    { ...f.binding, runId: "run-2", toolCallId: "tool-2" },
    { ...f.context, timeoutMs: 2000 },
  );
  const status = await controller.status({
    ...f.binding,
    operationId: f.input.operationId,
  });

  expect(replay).toMatchObject({ state: "terminal", outcome: "committed" });
  expect(status).toMatchObject({ state: "terminal", outcome: "committed" });
  expect((await operation(f)).binding.runId).toBe("run-1");
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.probe.verify).toHaveBeenCalledTimes(2);
});

test("准备响应丢失后沿用原timeout与preparedAt，当前批准的新Run可认领一次", async () => {
  const f = await fixture();
  const prepared = await prepareWithoutClaim(f);

  const result = await restart(f).execute(
    f.input,
    { ...f.binding, runId: "run-2", toolCallId: "tool-2" },
    { ...f.context, timeoutMs: 2000 },
  );
  const persisted = await operation(f);

  expect(result.outcome).toBe("committed");
  expect(persisted.preparedAt).toBe(prepared.preparedAt);
  expect(persisted.payload).toMatchObject({ timeoutMs: 1000 });
  expect(f.send).toHaveBeenCalledOnce();
});

test("claim后send前重启没有GUI ACK，跨新store和新Run保持unknown且绝不重发", async () => {
  const f = await fixture();
  const prepared = await prepareWithoutClaim(f);
  const claimable = await f.store.prepare({
    binding: f.binding,
    operationId: f.input.operationId,
    payload: prepared.payload,
    buildMacro: () => {
      throw new Error("不得重建固定宏");
    },
  });
  expect(await f.store.claimDispatch(claimable)).toBe(true);

  const result = await restart(f).execute(
    f.input,
    { ...f.binding, runId: "run-2", toolCallId: "tool-2" },
    f.context,
  );

  expect(result).toMatchObject({
    state: "dispatched",
    outcome: "unknown",
    cancellationRequested: false,
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(f.probe.verify).not.toHaveBeenCalled();
});

test("两个独立控制器并发同键仅发送一次，随后status读取同一回执", async () => {
  const f = await fixture();
  const other = restart(f);

  const replies = await Promise.all([
    f.controller.execute(f.input, f.binding, f.context),
    other.execute(
      f.input,
      { ...f.binding, runId: "run-2", toolCallId: "tool-2" },
      f.context,
    ),
  ]);

  expect(f.send).toHaveBeenCalledOnce();
  expect(replies.map((reply) => reply.outcome)).toContain("committed");
  expect(
    replies.every((reply) => ["committed", "unknown"].includes(reply.outcome)),
  ).toBe(true);
  expect(
    await other.status({ ...f.binding, operationId: f.input.operationId }),
  ).toMatchObject({ outcome: "committed" });
});

test("同一操作编号换参数明确冲突，原提交和来源保持不变", async () => {
  const f = await fixture();
  const originalChange = f.input.changes[0];
  if (!originalChange) throw new Error("测试夹具应包含属性修改");
  await f.controller.execute(f.input, f.binding, f.context);

  await expect(
    restart(f).execute(
      { ...f.input, changes: [{ ...originalChange, value: "另一个值" }] },
      f.binding,
      f.context,
    ),
  ).rejects.toMatchObject({
    code: "conflict",
    operationId: f.input.operationId,
  });
  expect(
    await f.controller.status({
      ...f.binding,
      operationId: f.input.operationId,
    }),
  ).toMatchObject({ outcome: "committed" });
  expect(f.send).toHaveBeenCalledOnce();
});

test.each([
  { scopeGeneration: 2 },
  { branchGeneration: 2 },
  { projectId: "other-project" },
])("已提交记录也不能跨授权代际或项目复用：%j", async (changed) => {
  const f = await fixture();
  await f.controller.execute(f.input, f.binding, f.context);

  await expect(
    restart(f).execute(f.input, { ...f.binding, ...changed }, f.context),
  ).rejects.toMatchObject({
    code: "conflict",
    operationId: f.input.operationId,
  });
  expect(f.send).toHaveBeenCalledOnce();
});

test.each([
  { operationId: "a8279e10-eabe-41db-b731-abf856ef9115" },
  { fingerprint: "0".repeat(64) },
  { pid: 9876 },
  { commitObserved: false },
  { extraField: true },
])(
  "回执schema或身份不匹配时保持unknown，不接受成功且不重发：%j",
  async (changed) => {
    const f = await fixture();
    f.send.mockImplementation(async (_app, macroPath) =>
      f.publish(macroPath, changed),
    );
    const result = await f.controller.execute(f.input, f.binding, f.context);
    const replay = await restart(f).execute(
      f.input,
      { ...f.binding, runId: "run-2" },
      f.context,
    );

    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "invalid_receipt",
    });
    expect(result).not.toHaveProperty("receipt");
    expect(replay).toMatchObject({
      outcome: "unknown",
      reason: "invalid_receipt",
    });
    expect(f.send).toHaveBeenCalledOnce();
  },
);

test("损坏JSON回执保持unknown，status不调用probe或transport", async () => {
  const f = await fixture();
  f.send.mockImplementation(async (_app, macroPath) =>
    f.publish(macroPath, {}, "{"),
  );
  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({
    state: "dispatched",
    outcome: "unknown",
    reason: "invalid_receipt",
  });
  const before = f.probe.verify.mock.calls.length;

  expect(
    await restart(f).status({ ...f.binding, operationId: f.input.operationId }),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
  expect(f.probe.verify).toHaveBeenCalledTimes(before);
  expect(f.send).toHaveBeenCalledOnce();
});

test.each([
  { changes: [] },
  {
    changes: [
      {
        objectName: "OtherBox",
        propertyName: "Label",
        before: "Box",
        requested: "零件",
        observed: "零件",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "OtherProperty",
        before: "Box",
        requested: "零件",
        observed: "零件",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "别的旧值",
        requested: "零件",
        observed: "零件",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "Box",
        requested: "别的新值",
        observed: "别的新值",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "Box",
        requested: "零件",
        observed: "错误结果",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "Box",
        requested: "零件",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "Box",
        requested: "零件",
        observed: "零件",
        changed: false,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "Box",
        requested: "零件",
        observed: "零件",
        changed: true,
      },
      {
        objectName: "Box",
        propertyName: "Label",
        before: "Box",
        requested: "零件",
        observed: "零件",
        changed: true,
      },
    ],
  },
  {
    outcome: "no_op",
    mutationStarted: false,
    commitAttempted: false,
    commitObserved: false,
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "Box",
        requested: "零件",
        observed: "零件",
        changed: true,
      },
    ],
  },
  {
    outcome: "no_op",
    mutationStarted: false,
    commitAttempted: false,
    commitObserved: false,
    changes: [],
  },
])("合法JSON不能伪造成功：修改条目必须匹配完整原批次：%j", async (changed) => {
  const f = await fixture();
  f.send.mockImplementation(async (_app, macroPath) =>
    f.publish(macroPath, changed),
  );

  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
  expect(
    await restart(f).status({ ...f.binding, operationId: f.input.operationId }),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
  expect(f.send).toHaveBeenCalledOnce();
});

test("claim后send前撤销授权会持久取消，保留未知认领且不发送", async () => {
  const f = await fixture();
  const guard = async () => {
    const record = await f.store.lookup({
      ...f.binding,
      operationId: f.input.operationId,
    });
    if (record && (await f.store.readState(record)).status === "dispatched")
      throw new CadGuiOperationError("plugin_disabled", "插件已停用");
  };

  await expect(
    f.controller.execute(f.input, f.binding, f.context, guard),
  ).rejects.toMatchObject({
    code: "plugin_disabled",
    operationId: f.input.operationId,
    outcome: "unknown",
  });
  expect(await f.store.readState(await operation(f))).toMatchObject({
    status: "dispatched",
    cancelled: true,
    outcome: "unknown",
  });
  expect(f.send).not.toHaveBeenCalled();
});

test("进程身份在claim后变化时阻止send并持久取消", async () => {
  const f = await fixture();
  f.probe.verify
    .mockResolvedValueOnce(f.input.application)
    .mockRejectedValueOnce(
      new CadGuiProbeError("application_changed", "应用已变化"),
    );

  await expect(
    f.controller.execute(f.input, f.binding, f.context),
  ).rejects.toMatchObject({
    code: "application_changed",
    operationId: f.input.operationId,
    outcome: "unknown",
  });
  expect(await f.store.readState(await operation(f))).toMatchObject({
    status: "dispatched",
    cancelled: true,
    outcome: "unknown",
  });
  expect(f.send).not.toHaveBeenCalled();
});

test("send后等待期间取消会持久墓碑，结果保持unknown并保留全部请求文件", async () => {
  const f = await fixture();
  f.send.mockImplementation(async () => {
    queueMicrotask(() => f.signal.abort());
  });

  const result = await f.controller.execute(f.input, f.binding, f.context);
  const record = await operation(f);

  expect(result).toMatchObject({
    state: "dispatched",
    outcome: "unknown",
    cancellationRequested: true,
    reason: "cancelled",
  });
  expect(await readFile(record.cancelledPath, "utf8")).toBe("cancelled\n");
  expect(await readFile(record.macroPath, "utf8")).toContain(
    "_kfw_cad_set_properties(",
  );
  expect(await readFile(record.requestPath, "utf8")).toContain(
    '"operation":"set-properties"',
  );
});

test("无GUI ACK超时后不重发，迟到回执仍可由status读取实际提交", async () => {
  const f = await fixture();
  const now = vi.spyOn(Date, "now");
  f.send.mockImplementation(async () => {
    now.mockReturnValue(Date.now() + 2000);
  });
  try {
    expect(
      await f.controller.execute(f.input, f.binding, f.context),
    ).toMatchObject({
      state: "dispatched",
      outcome: "unknown",
      cancellationRequested: true,
      reason: "timeout",
    });
  } finally {
    now.mockRestore();
  }
  const record = await operation(f);
  const replay = await restart(f).execute(
    f.input,
    { ...f.binding, runId: "run-2" },
    f.context,
  );
  expect(replay).toMatchObject({
    outcome: "unknown",
    cancellationRequested: true,
  });
  expect(f.send).toHaveBeenCalledOnce();
  await f.publish(record.macroPath);

  expect(
    await restart(f).status({ ...f.binding, operationId: f.input.operationId }),
  ).toMatchObject({
    state: "terminal",
    outcome: "committed",
    cancellationRequested: true,
  });
});

test("取消marker保存失败必须stop_unconfirmed，不能声称已停止", async () => {
  const f = await fixture();
  f.send.mockImplementation(async () => {
    f.signal.abort();
  });
  const store: CadGuiOperationStore = {
    ...f.store,
    async cancel() {
      throw new Error("磁盘不可写");
    },
  };

  await expect(
    restart(f, store).execute(f.input, f.binding, f.context),
  ).rejects.toMatchObject({
    code: "stop_unconfirmed",
    operationId: f.input.operationId,
    outcome: "unknown",
  });
  expect(await f.store.readState(await operation(f))).toMatchObject({
    status: "dispatched",
    cancelled: false,
    outcome: "unknown",
  });
  expect(f.send).toHaveBeenCalledOnce();
});

test("旧实现留下的prepared记录不能被当前固定宏认领", async () => {
  const f = await fixture();
  await f.store.prepare({
    binding: f.binding,
    operationId: f.input.operationId,
    payload: {
      operation: "set-properties",
      ...f.input,
      timeoutMs: f.context.timeoutMs,
    },
    buildMacro: () => "# old implementation\n",
  });

  await expect(
    f.controller.execute(f.input, f.binding, f.context),
  ).rejects.toMatchObject({
    code: "implementation_changed",
    operationId: f.input.operationId,
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(await f.store.readState(await operation(f))).toMatchObject({
    status: "cancelled",
    cancelled: true,
  });
});

test("status限定同一Instance和Task，不借操作编号读取另一Task", async () => {
  const f = await fixture();
  await f.controller.execute(f.input, f.binding, f.context);

  await expect(
    f.controller.status({
      ...f.binding,
      taskId: "other-task",
      operationId: f.input.operationId,
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(f.send).toHaveBeenCalledOnce();
});

test("两项批次只回执一项即使该项已提交也不能认定全批成功", async () => {
  const f = await fixture();
  f.input.changes.push({
    objectName: "Box",
    propertyName: "Description",
    expectedValue: "旧描述",
    value: "新描述",
  });

  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
});

test("完整且未发生改动的no_op回执可以接受", async () => {
  const f = await fixture();
  const change = f.input.changes[0];
  if (!change) throw new Error("测试夹具应包含属性修改");
  change.value = "Box";
  f.send.mockImplementation(async (_app, macroPath) =>
    f.publish(macroPath, {
      outcome: "no_op",
      mutationStarted: false,
      commitAttempted: false,
      commitObserved: false,
      changes: [
        {
          objectName: "Box",
          propertyName: "Label",
          before: "Box",
          requested: "Box",
          observed: "Box",
          changed: false,
        },
      ],
    }),
  );

  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({ state: "terminal", outcome: "no_op" });
});

test("no_op的changed标记必须与before和requested实际是否相等一致", async () => {
  const f = await fixture();
  f.send.mockImplementation(async (_app, macroPath) =>
    f.publish(macroPath, {
      outcome: "no_op",
      mutationStarted: false,
      commitAttempted: false,
      commitObserved: false,
      changes: [
        {
          objectName: "Box",
          propertyName: "Label",
          before: "Box",
          requested: "零件",
          observed: "零件",
          changed: false,
        },
      ],
    }),
  );

  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
});

test.each([
  { operationId: "7cce6253-b797-427b-99d4-5d10204cb5ae" },
  { fingerprint: "0".repeat(64) },
  { pid: 9876 },
  { statePreserved: false },
  { artifact: undefined },
  { protocol: "kfw-cad-gui-operation/1" },
])("复制回执身份或副本证明无效时保持unknown且不重发：%j", async (changed) => {
  const f = await fixture();
  const input = configureCopy(f, changed);

  expect(
    await f.controller.copyDocument(input, f.binding, f.context),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
  expect(
    await restart(f).copyDocument(
      input,
      { ...f.binding, runId: "run-2" },
      f.context,
    ),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
  expect(f.send).toHaveBeenCalledOnce();
});

test("复制记录不能跨授权代际、参数或操作种类复用", async () => {
  const f = await fixture();
  const input = configureCopy(f);
  await f.controller.copyDocument(input, f.binding, f.context);

  await expect(
    restart(f).copyDocument(
      input,
      { ...f.binding, branchGeneration: 2 },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    restart(f).copyDocument(
      { ...input, outputPath: "different.FCStd" },
      f.binding,
      f.context,
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    restart(f).execute(f.input, f.binding, f.context),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.send).toHaveBeenCalledOnce();
});

test("复制认领后无GUI ACK时持久取消且未知不重发，也不认领Node发布", async () => {
  const f = await fixture();
  const input = copyInput(f);
  f.send.mockImplementation(async () => {
    f.signal.abort();
  });

  expect(
    await f.controller.copyDocument(input, f.binding, f.context),
  ).toMatchObject({
    state: "dispatched",
    outcome: "unknown",
    cancellationRequested: true,
  });
  expect(
    await restart(f).status({ ...f.binding, operationId: input.operationId }),
  ).toMatchObject({
    state: "dispatched",
    outcome: "unknown",
    cancellationRequested: true,
  });
  expect(await f.store.readPublication(await operation(f))).toEqual({});
  expect(f.send).toHaveBeenCalledOnce();
});

test("preflight拒绝的空修改子集可以接受，不伪造已开始修改", async () => {
  const f = await fixture();
  f.send.mockImplementation(async (_app, macroPath) =>
    f.publish(macroPath, {
      outcome: "rejected",
      mutationStarted: false,
      commitAttempted: false,
      commitObserved: false,
      changes: [],
      reason: "stale_target",
    }),
  );

  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({
    state: "terminal",
    outcome: "rejected",
    reason: "stale_target",
  });
});

test("partial允许合法子集和不同于请求值的观察结果，不声称整批提交", async () => {
  const f = await fixture();
  f.input.changes.push({
    objectName: "Box",
    propertyName: "Description",
    expectedValue: "旧描述",
    value: "新描述",
  });
  f.send.mockImplementation(async (_app, macroPath) =>
    f.publish(macroPath, {
      outcome: "partial",
      commitAttempted: false,
      commitObserved: false,
      transactionState: "unknown",
      changes: [
        {
          objectName: "Box",
          propertyName: "Label",
          before: "Box",
          requested: "零件",
          observed: "部分结果",
          changed: true,
        },
      ],
    }),
  );

  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({
    state: "terminal",
    outcome: "partial",
    receipt: { commitObserved: false },
  });
});

test("partial也不能携带另一批次的修改条目", async () => {
  const f = await fixture();
  f.send.mockImplementation(async (_app, macroPath) =>
    f.publish(macroPath, {
      outcome: "partial",
      commitAttempted: false,
      commitObserved: false,
      transactionState: "unknown",
      changes: [
        {
          objectName: "Box",
          propertyName: "Label",
          before: "别的旧值",
          requested: "零件",
          observed: "部分结果",
          changed: true,
        },
      ],
    }),
  );

  expect(
    await f.controller.execute(f.input, f.binding, f.context),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
});

test.each([
  {
    outcome: "rejected",
    copyStarted: false,
    statePreserved: true,
    artifact: undefined,
    reason: "stale_target",
  },
  {
    outcome: "partial",
    copyStarted: true,
    statePreserved: false,
    artifact: undefined,
    reason: "state_changed",
  },
])(
  "匹配的复制$outcome回执保留实际结果，不伪装copied或发布Task文件",
  async (receipt) => {
    const f = await fixture();
    const input = configureCopy(f, receipt);

    expect(
      await f.controller.copyDocument(input, f.binding, f.context),
    ).toMatchObject({
      state: "terminal",
      outcome: receipt.outcome,
      reason: receipt.reason,
    });
    expect(await f.store.readPublication(await operation(f))).toEqual({});
  },
);

async function storedUndo(f: Fixture, input: UndoFixture["input"]) {
  const record = await f.store.lookup({
    ...f.binding,
    operationId: input.operationId,
  });
  if (!record) throw new Error("应找到持久撤销记录");
  return record;
}

async function prepareUndoWithoutClaim(f: Fixture, prepared: UndoFixture) {
  const interrupted: CadGuiOperationStore = {
    ...f.store,
    async prepare(input) {
      await f.store.prepare(input);
      throw new Error("撤销准备响应丢失");
    },
  };
  await expect(
    restart(f, interrupted).undoOperation(
      prepared.input,
      prepared.binding,
      f.context,
    ),
  ).rejects.toThrow("撤销准备响应丢失");
  return storedUndo(f, prepared.input);
}

test("Undo终态重放只读取冻结来源，不依赖已删除的源记录或存活GUI", async () => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  configureUndo(f, prepared);
  const original = await f.controller.undoOperation(
    prepared.input,
    prepared.binding,
    f.context,
  );
  await rm(prepared.sourceRecord.directory, { recursive: true });
  f.probe.verify.mockRejectedValue(new Error("原GUI已关闭"));

  expect(
    await restart(f).undoOperation(
      prepared.input,
      { ...prepared.binding, runId: "later-run", toolCallId: "later-call" },
      { ...f.context, timeoutMs: 2000 },
    ),
  ).toEqual(original);
  expect(
    await restart(f).status({
      ...prepared.binding,
      operationId: prepared.input.operationId,
    }),
  ).toEqual(original);
  expect(f.send).toHaveBeenCalledTimes(2);
});

test("Undo prepared重放沿用原timeout和冻结proof，源记录删除后仍由当前Run授权一次", async () => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  const record = await prepareUndoWithoutClaim(f, prepared);
  await rm(prepared.sourceRecord.directory, { recursive: true });
  configureUndo(f, prepared);

  expect(
    await restart(f).undoOperation(
      prepared.input,
      { ...prepared.binding, runId: "later-run" },
      { ...f.context, timeoutMs: 2000 },
    ),
  ).toMatchObject({ outcome: "undone" });
  const persisted = await storedUndo(f, prepared.input);
  expect(persisted.preparedAt).toBe(record.preparedAt);
  expect(persisted.payload).toMatchObject({
    operation: "undo",
    timeoutMs: 1000,
    undoSource: {
      input: f.input,
      receipt: { operationId: f.input.operationId },
    },
  });
  expect(f.send).toHaveBeenCalledTimes(2);
});

test("Undo claim后send前丢失响应保持unknown，重建后不查旧来源或重新派发", async () => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  const record = await prepareUndoWithoutClaim(f, prepared);
  const claimable = await f.store.prepare({
    binding: prepared.binding,
    operationId: prepared.input.operationId,
    payload: record.payload,
    buildMacro: () => {
      throw new Error("不应重建宏");
    },
  });
  expect(await f.store.claimDispatch(claimable)).toBe(true);
  await rm(prepared.sourceRecord.directory, { recursive: true });
  f.probe.verify.mockRejectedValue(new Error("不应查询GUI"));

  expect(
    await restart(f).undoOperation(
      prepared.input,
      { ...prepared.binding, runId: "later-run" },
      f.context,
    ),
  ).toMatchObject({
    state: "dispatched",
    outcome: "unknown",
    cancellationRequested: false,
  });
  expect(f.send).toHaveBeenCalledTimes(1);
});

test("Undo同编号更改public参数冲突，不允许用新快照刷新旧前提", async () => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  configureUndo(f, prepared);
  await f.controller.undoOperation(prepared.input, prepared.binding, f.context);

  await expect(
    restart(f).undoOperation(
      {
        ...prepared.input,
        expectedDocumentRevision: prepared.input.expectedDocumentRevision + 1,
      },
      prepared.binding,
      f.context,
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.send).toHaveBeenCalledTimes(2);
});

test.each(["missing", "no-proof", "partial"] as const)(
  "新Undo来源%s时拒绝派发",
  async (kind) => {
    const f = await fixture();
    const prepared = await prepareUndo(f);
    if (kind === "missing")
      await rm(prepared.sourceRecord.directory, { recursive: true });
    else {
      const receipt = JSON.parse(
        await readFile(prepared.sourceRecord.receiptPath, "utf8"),
      );
      delete receipt.undoProvenance;
      if (kind === "partial") receipt.outcome = "partial";
      await writeFile(
        prepared.sourceRecord.receiptPath,
        JSON.stringify(receipt),
      );
    }

    await expect(
      f.controller.undoOperation(prepared.input, prepared.binding, f.context),
    ).rejects.toMatchObject({ code: "undo_source_unavailable" });
    expect(
      await f.store.lookup({
        ...prepared.binding,
        operationId: prepared.input.operationId,
      }),
    ).toBeNull();
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);

test.each([
  { taskId: "other-task" },
  { instanceId: "other-instance" },
  { projectId: "other-project" },
])("新Undo不得消费其它归属的源记录：%j", async (changed) => {
  const f = await fixture();
  const prepared = await prepareUndo(f);

  await expect(
    f.controller.undoOperation(
      prepared.input,
      { ...prepared.binding, ...changed },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "undo_source_unavailable" });
  expect(f.send).toHaveBeenCalledTimes(1);
});

test.each([
  "application",
  "epoch",
  "handle",
  "applicationRevision",
  "documentRevision",
] as const)("新Undo的%s必须完全匹配原source post snapshot", async (field) => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  const input = structuredClone(prepared.input);
  if (field === "application") input.application.pid++;
  if (field === "epoch") input.bridgeEpoch = randomUUID();
  if (field === "handle") input.documentHandle = randomUUID();
  if (field === "applicationRevision") input.expectedApplicationRevision++;
  if (field === "documentRevision") input.expectedDocumentRevision++;

  await expect(
    f.controller.undoOperation(input, prepared.binding, f.context),
  ).rejects.toMatchObject({ code: "undo_target_mismatch" });
  expect(f.send).toHaveBeenCalledTimes(1);
});

test("public Undo参数不能携带自行伪造的undoSource", async () => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  const forged = Object.assign({}, prepared.input, { undoSource: {} });

  await expect(
    f.controller.undoOperation(forged, prepared.binding, f.context),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.send).toHaveBeenCalledTimes(1);
});

test.each([
  { operationId: "57ac0119-b842-4968-bc10-81c922722911" },
  { fingerprint: "0".repeat(64) },
  { pid: 9876 },
  { sourceOperationId: "57ac0119-b842-4968-bc10-81c922722911" },
  { sourceFingerprint: "0".repeat(64) },
  { transactionName: "KFW CAD 57ac0119-b842-4968-bc10-81c922722911" },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "别的起点",
        observed: "Box",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "零件",
        observed: "别的终点",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Other",
        propertyName: "Label",
        before: "零件",
        observed: "Box",
        changed: true,
      },
    ],
  },
  {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "零件",
        observed: "Box",
        changed: true,
      },
      {
        objectName: "Box",
        propertyName: "Label",
        before: "零件",
        observed: "Box",
        changed: true,
      },
    ],
  },
  { undoHistory: { count: 1, sha256: "a".repeat(64) } },
  { redoHistory: { count: 0, sha256: "a".repeat(64) } },
])("Undo回执身份、原事务或反向结果不匹配时保持unknown：%j", async (changed) => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  configureUndo(f, prepared, changed);

  expect(
    await f.controller.undoOperation(
      prepared.input,
      prepared.binding,
      f.context,
    ),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
  expect(
    await restart(f).undoOperation(
      prepared.input,
      { ...prepared.binding, runId: "later-run" },
      f.context,
    ),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
  expect(f.send).toHaveBeenCalledTimes(2);
});

test("Undo成功回执必须包含源提交的完整批次，不能只恢复其中一项", async () => {
  const f = await fixture();
  f.input.changes.push({
    objectName: "Box",
    propertyName: "Description",
    expectedValue: "旧描述",
    value: "新描述",
  });
  const prepared = await prepareUndo(f, {
    changes: [
      {
        objectName: "Box",
        propertyName: "Label",
        before: "Box",
        requested: "零件",
        observed: "零件",
        changed: true,
      },
      {
        objectName: "Box",
        propertyName: "Description",
        before: "旧描述",
        requested: "新描述",
        observed: "新描述",
        changed: true,
      },
    ],
  });
  configureUndo(f, prepared);

  expect(
    await f.controller.undoOperation(
      prepared.input,
      prepared.binding,
      f.context,
    ),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
});

test.each([
  "epoch",
  "handle",
  "applicationRevision",
  "documentRevision",
] as const)("Undo完成后的%s不能失配或倒退", async (kind) => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  const snapshot = structuredClone(prepared.source.snapshot);
  if (kind === "epoch") snapshot.bridgeEpoch = randomUUID();
  if (kind === "handle") snapshot.document.documentHandle = randomUUID();
  if (kind === "applicationRevision")
    snapshot.applicationRevision =
      prepared.input.expectedApplicationRevision - 1;
  if (kind === "documentRevision")
    snapshot.document.revision = prepared.input.expectedDocumentRevision - 1;
  configureUndo(f, prepared, { snapshot });

  expect(
    await f.controller.undoOperation(
      prepared.input,
      prepared.binding,
      f.context,
    ),
  ).toMatchObject({ outcome: "unknown", reason: "invalid_receipt" });
});

test("Undo预检拒绝可以携带匹配源observed的只读before诊断，不声称撤销成功", async () => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  configureUndo(f, prepared, {
    outcome: "rejected",
    undoStarted: false,
    undoObserved: false,
    historyVerified: false,
    transactionName: undefined,
    undoHistory: undefined,
    redoHistory: undefined,
    snapshot: undefined,
    changes: [{ objectName: "Box", propertyName: "Label", before: "零件" }],
    reason: "history_changed",
  });

  expect(
    await f.controller.undoOperation(
      prepared.input,
      prepared.binding,
      f.context,
    ),
  ).toMatchObject({
    state: "terminal",
    outcome: "rejected",
    reason: "history_changed",
  });
});

test("Undo已开始但无法完整观察时保留partial诊断，不伪装undone", async () => {
  const f = await fixture();
  const prepared = await prepareUndo(f);
  configureUndo(f, prepared, {
    outcome: "partial",
    undoStarted: true,
    undoObserved: false,
    historyVerified: false,
    transactionName: undefined,
    undoHistory: undefined,
    redoHistory: undefined,
    snapshot: undefined,
    changes: [{ objectName: "Box", propertyName: "Label", before: "零件" }],
    reason: "native_operation_failed",
  });

  expect(
    await f.controller.undoOperation(
      prepared.input,
      prepared.binding,
      f.context,
    ),
  ).toMatchObject({
    state: "terminal",
    outcome: "partial",
    reason: "native_operation_failed",
  });
});
