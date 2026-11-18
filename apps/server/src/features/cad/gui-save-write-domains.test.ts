import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  type CadGuiSaveDocumentReceipt,
  cadGuiSaveDocumentInputSchema,
  cadGuiSaveDocumentReceiptSchema,
} from "./gui-document-save-contracts.js";
import { createCadGuiOperationController } from "./gui-operation-controller.js";
import {
  type CadGuiOperationBinding,
  type CadGuiOperationRecord,
  createCadGuiOperationStore,
} from "./gui-operation-store.js";
import {
  cadGuiSaveDocumentRequestSchema,
  createCadGuiFileOperationParticipant,
} from "./gui-save-write-domains.js";

const roots: string[] = [];
const passiveChecks: Array<() => void> = [];
const snapshotBytes = "native snapshot";

afterEach(async () => {
  try {
    for (const check of passiveChecks.splice(0)) check();
  } finally {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }
});

function controllerFor(store: ReturnType<typeof createCadGuiOperationStore>) {
  const forbidden = async () => {
    throw new Error("写域对账不能连接或重发 GUI");
  };
  const probe = { list: vi.fn(forbidden), verify: vi.fn(forbidden) };
  const send = vi.fn(forbidden);
  passiveChecks.push(() => {
    expect(probe.list).not.toHaveBeenCalled();
    expect(probe.verify).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  return createCadGuiOperationController({ store, probe, transport: { send } });
}

async function publishReceipt(
  record: CadGuiOperationRecord,
  request: { canonicalPath: string; application: { pid: number } },
  outcome: CadGuiSaveDocumentReceipt["outcome"],
  changed: Record<string, unknown>,
) {
  const receipt = cadGuiSaveDocumentReceiptSchema.parse({
    protocol: "kfw-cad-gui-save/1",
    operationId: record.operationId,
    fingerprint: record.fingerprint,
    pid: request.application.pid,
    guiThread: true,
    completed: true,
    outcome,
    saveStarted: outcome !== "rejected",
    writeFinished: true,
    ...(outcome === "saved"
      ? {
          artifact: {
            canonicalPath: request.canonicalPath,
            size: Buffer.byteLength(snapshotBytes),
            sha256: createHash("sha256").update(snapshotBytes).digest("hex"),
            hasGuiDocument: true,
          },
        }
      : {
          reason:
            outcome === "partial" ? "backup_failed" : "preflight_rejected",
        }),
  });
  await writeFile(
    record.receiptPath,
    JSON.stringify({ ...receipt, ...changed }),
    { mode: 0o600 },
  );
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-cad-save-domains-")),
  );
  roots.push(root);
  const canonicalPath = join(root, "native.FCStd");
  await writeFile(canonicalPath, snapshotBytes, { mode: 0o600 });
  const input = cadGuiSaveDocumentInputSchema.parse({
    application: {
      pid: 1234,
      launchedAt: 1000,
      birth: { startSeconds: 1, startMicroseconds: 123_456 },
      bundleId: "org.freecad.FreeCAD",
      name: "FreeCAD",
      executablePath:
        "/Applications/FreeCAD.app/Contents/Resources/bin/freecad",
      bundlePath: "/Applications/FreeCAD.app",
    },
    operationId: randomUUID(),
    bridgeEpoch: "b1ff2ef8-0854-40c9-9da8-c9ff07bfb219",
    documentHandle: "28686cba-59d6-44c3-a30c-bbca88a7d737",
    expectedApplicationRevision: 2,
    expectedDocumentRevision: 3,
    expectedFileName: canonicalPath,
  });
  const request = {
    ...input,
    canonicalPath,
    writeRoots: [dirname(canonicalPath)],
  };
  const binding: CadGuiOperationBinding = {
    instanceId: "instance-1",
    projectId: "project-1",
    taskId: "task-1",
    scopeGeneration: 7,
    branchGeneration: 9,
    runId: "historical-run",
    toolCallId: "historical-tool",
  };
  const store = createCadGuiOperationStore({ rootDirectory: root });
  const controller = controllerFor(store);
  const participant = createCadGuiFileOperationParticipant({
    store,
    controller,
  });
  const prepare = (owner = binding) => {
    const operationId = randomUUID();
    return store.prepare({
      binding: owner,
      operationId,
      payload: {
        ...request,
        operationId,
        operation: "save-document",
        timeoutMs: 1000,
      },
      buildMacro: () => "# fixed save fixture\npass\n",
    });
  };
  const publish = (
    record: CadGuiOperationRecord,
    outcome: CadGuiSaveDocumentReceipt["outcome"] = "saved",
    changed: Record<string, unknown> = {},
  ) => publishReceipt(record, request, outcome, changed);
  return {
    root,
    canonicalPath,
    input,
    request,
    binding,
    store,
    controller,
    participant,
    prepare,
    publish,
  };
}

test("内部保存请求只接受归一化FCStd及唯一父目录，Host字段不进入公共参数", async () => {
  const f = await fixture();
  expect(cadGuiSaveDocumentRequestSchema.parse(f.request)).toEqual(f.request);
  expect(cadGuiSaveDocumentInputSchema.safeParse(f.input).success).toBe(true);
  expect(cadGuiSaveDocumentInputSchema.safeParse(f.request).success).toBe(
    false,
  );
  for (const changed of [
    { canonicalPath: "native.FCStd" },
    { canonicalPath: `${f.root}/nested/../native.FCStd` },
    { canonicalPath: `${f.root}//native.FCStd` },
    { canonicalPath: `${f.canonicalPath}\0` },
    { canonicalPath: join(f.root, "native.step") },
    { writeRoots: [] },
    { writeRoots: [f.root, f.root] },
    { writeRoots: [dirname(f.root)] },
    { writeRoots: [`${f.root}/.`] },
    { source: "doc.saveAs('/outside.FCStd')" },
  ]) {
    expect(
      cadGuiSaveDocumentRequestSchema.safeParse({ ...f.request, ...changed })
        .success,
      JSON.stringify(changed),
    ).toBe(false);
  }
});

test("prepared及未派发cancelled不占域，旧属性、copy与undo不是公共文件写域", async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  const cancelled = await f.prepare();
  await f.store.cancel(cancelled);
  for (const operation of ["set-properties", "save-copy", "undo"]) {
    const operationId = randomUUID();
    const record = await f.store.prepare({
      binding: f.binding,
      operationId,
      payload: { operation, operationId, timeoutMs: 1000 },
      buildMacro: () => "pass\n",
    });
    await f.store.claimDispatch(record);
  }

  expect(await f.participant.pendingWrites()).toEqual([]);
  expect(await f.store.readState(prepared)).toMatchObject({
    status: "prepared",
    cancelled: false,
  });
  expect(await f.store.readState(cancelled)).toMatchObject({
    status: "cancelled",
    cancelled: true,
  });
});

test("冷重建从持久派发、执行及取消后unknown记录恢复原实例与Task写域", async () => {
  const f = await fixture();
  const dispatched = await f.prepare();
  const executing = await f.prepare({ ...f.binding, taskId: "task-2" });
  const cancelled = await f.prepare({ ...f.binding, instanceId: "instance-2" });
  for (const record of [dispatched, executing, cancelled])
    await f.store.claimDispatch(record);
  await writeFile(executing.executionClaimPath, "gui-owner\n", { mode: 0o600 });
  await f.store.cancel(cancelled);
  const store = createCadGuiOperationStore({ rootDirectory: f.root });
  const participant = createCadGuiFileOperationParticipant({
    store,
    controller: controllerFor(store),
  });

  const domains = await participant.pendingWrites();
  expect(domains).toHaveLength(3);
  expect(domains).toEqual(
    expect.arrayContaining([
      { instanceId: "instance-1", taskId: "task-1", writeRoots: [f.root] },
      { instanceId: "instance-1", taskId: "task-2", writeRoots: [f.root] },
      { instanceId: "instance-2", taskId: "task-1", writeRoots: [f.root] },
    ]),
  );
});

test.each([
  { name: "原始null终态", raw: "null", changed: {} },
  { name: "损坏JSON", raw: "{", changed: {} },
  { name: "错误PID", changed: { pid: 9876 } },
  { name: "错误指纹", changed: { fingerprint: "0".repeat(64) } },
  { name: "写入尚未结束", changed: { writeFinished: false } },
  { name: "其它回执协议", changed: { protocol: "kfw-cad-gui-copy/1" } },
])("$name不能解除已派发保存的持久写域", async ({ raw, changed }) => {
  const f = await fixture();
  const record = await f.prepare();
  await f.store.claimDispatch(record);
  if (raw !== undefined)
    await writeFile(record.receiptPath, raw, { mode: 0o600 });
  else await f.publish(record, "saved", changed);

  expect(await f.participant.pendingWrites()).toEqual([
    {
      instanceId: f.binding.instanceId,
      taskId: f.binding.taskId,
      writeRoots: [f.root],
    },
  ]);
  await expect(
    f.participant.revoke(f.binding.instanceId, f.binding.taskId),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
});

test.each(["saved", "rejected", "partial"] as const)(
  "Controller严格确认%s且writeFinished后，查询与撤销均可确认写域结束",
  async (outcome) => {
    const f = await fixture();
    const record = await f.prepare();
    await f.store.claimDispatch(record);
    await f.publish(record, outcome);

    expect(
      await f.controller.status({
        ...f.binding,
        operationId: record.operationId,
      }),
    ).toMatchObject({
      outcome,
      receipt: { protocol: "kfw-cad-gui-save/1", writeFinished: true },
    });
    expect(await f.participant.pendingWrites()).toEqual([]);
    await expect(
      f.participant.revoke(f.binding.instanceId, f.binding.taskId),
    ).resolves.toBeUndefined();
  },
);

test("revoke只取消指定实例和Task的保存，unknown向上传播且不把marker当结束", async () => {
  const f = await fixture();
  const selected = await f.prepare();
  const selectedOther = await f.prepare();
  const prepared = await f.prepare();
  const otherTask = await f.prepare({ ...f.binding, taskId: "task-2" });
  const otherInstance = await f.prepare({
    ...f.binding,
    instanceId: "instance-2",
  });
  const oldOperation = await f.store.prepare({
    binding: f.binding,
    operationId: randomUUID(),
    payload: { operation: "set-properties", timeoutMs: 1000 },
    buildMacro: () => "pass\n",
  });
  for (const record of [
    selected,
    selectedOther,
    otherTask,
    otherInstance,
    oldOperation,
  ])
    await f.store.claimDispatch(record);

  await expect(
    f.participant.revoke(f.binding.instanceId, f.binding.taskId),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  for (const record of [selected, selectedOther])
    expect(await f.store.readState(record)).toMatchObject({
      status: "dispatched",
      cancelled: true,
      outcome: "unknown",
    });
  expect(await f.store.readState(prepared)).toMatchObject({
    status: "cancelled",
    cancelled: true,
  });
  for (const record of [otherTask, otherInstance, oldOperation])
    expect(await f.store.readState(record)).toMatchObject({
      status: "dispatched",
      cancelled: false,
    });
  expect(await f.participant.pendingWrites()).toContainEqual({
    instanceId: f.binding.instanceId,
    taskId: f.binding.taskId,
    writeRoots: [f.root],
  });
});

test("迟到可信partial回执可在同一参与者解除原写域，不需要重发或重建域缓存", async () => {
  const f = await fixture();
  const record = await f.prepare();
  await f.store.claimDispatch(record);
  await expect(
    f.participant.revoke(f.binding.instanceId, f.binding.taskId),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  await f.publish(record, "partial");

  expect(await f.participant.pendingWrites()).toEqual([]);
  await expect(
    f.participant.revoke(f.binding.instanceId, f.binding.taskId),
  ).resolves.toBeUndefined();
});

test("已派发保存的Host写域payload无效时明确失败，不静默丢弃写域", async () => {
  const f = await fixture();
  const record = await f.store.prepare({
    binding: f.binding,
    operationId: f.input.operationId,
    payload: {
      ...f.request,
      operation: "save-document",
      timeoutMs: 1000,
      writeRoots: ["/"],
    },
    buildMacro: () => "pass\n",
  });
  await f.store.claimDispatch(record);

  await expect(f.participant.pendingWrites()).rejects.toMatchObject({
    code: "invalid_record",
  });
  await expect(
    f.participant.revoke(f.binding.instanceId, f.binding.taskId),
  ).rejects.toThrow();
});

test.each(["scan", "status"])(
  "%s读取错误不能被当作没有在途保存",
  async (failure) => {
    const f = await fixture();
    const record = await f.prepare();
    await f.store.claimDispatch(record);
    const keep = join(f.root, "keep");
    await writeFile(keep, "外部文件");
    if (failure === "scan") await writeFile(record.macroPath, "damaged");
    else {
      await rm(record.dispatchClaimPath);
      await symlink(keep, record.dispatchClaimPath);
    }

    await expect(f.participant.pendingWrites()).rejects.toThrow();
    await expect(
      f.participant.revoke(f.binding.instanceId, f.binding.taskId),
    ).rejects.toThrow();
    expect(await readFile(keep, "utf8")).toBe("外部文件");
  },
);
