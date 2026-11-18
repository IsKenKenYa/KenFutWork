import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import {
  acquireTaskFileRestoreBarrier,
  hasTaskFileOperations,
  registerTaskFileOperationParticipant,
  revokeTaskFileOperations,
} from "../code-tools/file-operations.js";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import type { CadGuiApplication } from "./gui-document-contracts.js";
import {
  type CadGuiSaveDocumentInput,
  cadGuiSaveDocumentInputSchema,
  cadGuiSaveDocumentReceiptSchema,
} from "./gui-document-save-contracts.js";
import { createCadGuiOperationStore } from "./gui-operation-store.js";
import type { CadService } from "./service.js";
import { executeCadTestTool } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";
import { createCadTools } from "./tools.js";

interface GuiSaveOptions {
  tools: ToolDefinition[];
  context: ToolExecutionContext;
  application: CadGuiApplication;
  root: string;
  sourcePath: string;
  service: CadService;
  target(): Promise<Record<string, unknown>>;
  mutate(source: string): Promise<void>;
  reopen(): CadService;
}

interface GuiSaveFixture extends GuiSaveOptions {
  nonce: string;
  startedPath: string;
  releasePath: string;
  observationPath: string;
}

async function call(
  fixture: GuiSaveOptions,
  name: string,
  input: Record<string, unknown>,
  id: string,
  signal?: AbortSignal,
) {
  const tool = fixture.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`缺少真实CAD工具：${name}`);
  return executeCadTestTool(tool, input, {
    ...fixture.context,
    toolCallId: `native-save-${id}`,
    ...(signal ? { signal } : {}),
  });
}

async function successfulCall(
  fixture: GuiSaveOptions,
  name: string,
  input: Record<string, unknown>,
  id: string,
) {
  const result = await call(fixture, name, input, id);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}

async function waitJson(path: string, timeoutMs = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT" ||
        Date.now() >= deadline
      )
        throw error;
    }
    await delay(20);
  }
}

async function fileHash(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function prepareSource(fixture: GuiSaveFixture): string {
  return `import time
doc=owned[0]
assert doc.FileName==${JSON.stringify(fixture.sourcePath)}
assert not doc.HasPendingTransaction and App.getActiveTransaction() is None
assert all(not current.HasPendingTransaction for current in owned)
App.setActiveDocument(doc.Name)
box=doc.getObject('Box')
assert dict(box.ExpressionEngine)['Width']=='Length * 2'
doc.openTransaction('KFW save native 41')
box.Length=41
box.Height=7
doc.recompute()
doc.commitTransaction()
assert (box.Length.Value,box.Width.Value,box.Height.Value)==(41,82,7)
assert abs(box.Shape.Volume-23534)<1e-6
Gui.getDocument(doc.Name).Modified=True
def capture_save_state(current):
    return {'uid':str(current.Uid),'label':current.Label,'fileName':current.FileName,
            'undo':list(current.UndoNames),'redo':list(current.RedoNames),
            'touched':bool(current.isTouched()),'modified':bool(Gui.getDocument(current.Name).Modified)}
save_state={'nonce':${JSON.stringify(fixture.nonce)},'document':doc,'starts':0,
            'holdNext':False,'holding':False,'holdTimedOut':False,'capture':capture_save_state,
            'before':capture_save_state(doc),'records':[]}
class KfwNativeSaveProbe:
    def slotStartSaveDocument(self,current,path):
        if current is not save_state['document']:
            return
        save_state['starts']+=1
        if not save_state['holdNext']:
            return
        save_state['holdNext']=False
        save_state['holding']=True
        marker={'pid':os.getpid(),'starts':save_state['starts'],
                'operationId':save_state['heldOperationId'],'fileName':current.FileName}
        temporary=${JSON.stringify(`${fixture.startedPath}.tmp`)}
        with open(temporary,'x') as stream: json.dump(marker,stream)
        os.replace(temporary,${JSON.stringify(fixture.startedPath)})
        deadline=time.monotonic()+15
        try:
            while not os.path.isfile(${JSON.stringify(fixture.releasePath)}):
                if time.monotonic()>=deadline:
                    save_state['holdTimedOut']=True
                    break
                time.sleep(0.01)
        finally:
            save_state['holding']=False
save_state['observer']=KfwNativeSaveProbe()
builtins.__kfw_gui_save_fixture__=save_state
App.addDocumentObserver(save_state['observer'])`;
}

function checkNativeState(
  fixture: GuiSaveFixture,
  length: number,
  starts: number,
  phase: string,
): string {
  return `state=builtins.__kfw_gui_save_fixture__
assert state['nonce']==${JSON.stringify(fixture.nonce)}
doc=state['document']
assert doc is owned[0] and App.listDocuments().get(doc.Name) is doc
assert App.ActiveDocument is doc and Gui.activeDocument() is Gui.getDocument(doc.Name)
assert state['starts']==${starts}, ('unexpected native save count',state['starts'])
assert not state['holding'] and not state['holdTimedOut']
after=state['capture'](doc)
for key in ('uid','label','fileName','undo','redo'):
    assert after[key]==state['before'][key], ('save changed source identity/history',key)
assert after['modified'], 'save cleared GUI Modified'
assert not doc.HasPendingTransaction and App.getActiveTransaction() is None
box=doc.getObject('Box')
assert (box.Length.Value,box.Width.Value,box.Height.Value)==(${length},${length * 2},7)
assert dict(box.ExpressionEngine)['Width']=='Length * 2'
assert abs(box.Shape.Volume-${length * length * 2 * 7})<1e-6
state['records'].append({'phase':${JSON.stringify(phase)},'before':state['before'],'after':after,'starts':state['starts']})
temporary=${JSON.stringify(`${fixture.observationPath}.tmp`)}
with open(temporary,'w') as stream: json.dump(state['records'],stream)
os.replace(temporary,${JSON.stringify(fixture.observationPath)})`;
}

async function verifyBackgroundSave(fixture: GuiSaveFixture) {
  const bytes = await readFile(fixture.sourcePath);
  const described = cadResultSchema.parse(
    await successfulCall(
      fixture,
      "cad_describe_document",
      { documentPath: fixture.sourcePath },
      "background-read",
    ),
  );
  const box = described.document?.objects.find((entry) => entry.name === "Box");
  expect(box?.type).toBe("Part::Box");
  expect(box?.shape).toMatchObject({ valid: true, null: false, solids: 1 });
  expect(box?.shape?.volume).toBeCloseTo(23534, 6);
  const bounds = box?.shape?.bounds;
  if (!bounds) throw new Error("后台保存文件回读缺少Box几何尺寸");
  expect((bounds[3] ?? NaN) - (bounds[0] ?? NaN)).toBeCloseTo(41, 6);
  expect((bounds[4] ?? NaN) - (bounds[1] ?? NaN)).toBeCloseTo(82, 6);
  expect((bounds[5] ?? NaN) - (bounds[2] ?? NaN)).toBeCloseTo(7, 6);
  expect(await readFile(fixture.sourcePath)).toEqual(bytes);
}

async function saveInput(
  fixture: GuiSaveFixture,
  operationId = randomUUID(),
): Promise<CadGuiSaveDocumentInput> {
  return cadGuiSaveDocumentInputSchema.parse({
    ...(await fixture.target()),
    operationId,
    expectedFileName: fixture.sourcePath,
  });
}

async function verifyCompletedSave(fixture: GuiSaveFixture) {
  const before = await fileHash(fixture.sourcePath);
  const input = await saveInput(fixture);
  const saved = await successfulCall(
    fixture,
    "cad_gui_save_document",
    input,
    "first-save",
  );
  expect(saved).toMatchObject({
    operationId: input.operationId,
    state: "terminal",
    outcome: "saved",
    cancellationRequested: false,
  });
  const receipt = cadGuiSaveDocumentReceiptSchema.parse(saved.receipt);
  expect(receipt).toMatchObject({
    outcome: "saved",
    saveStarted: true,
    writeFinished: true,
    pid: fixture.application.pid,
  });
  if (!receipt.artifact) throw new Error("实际保存回执缺少文件证明");
  const bytes = await readFile(fixture.sourcePath),
    hash = await fileHash(fixture.sourcePath);
  expect(receipt.artifact).toEqual({
    canonicalPath: fixture.sourcePath,
    sha256: hash,
    size: bytes.length,
    hasGuiDocument: true,
  });
  expect(hash).not.toBe(before);
  await fixture.mutate(checkNativeState(fixture, 41, 1, "saved"));
  await verifyBackgroundSave(fixture);
  const cold = fixture.reopen();
  try {
    const restarted = { ...fixture, tools: createCadTools(cold) };
    expect(
      await successfulCall(
        restarted,
        "cad_gui_save_document",
        input,
        "cold-replay",
      ),
    ).toEqual(saved);
    expect(
      await successfulCall(
        restarted,
        "cad_gui_operation_status",
        { operationId: input.operationId },
        "cold-status",
      ),
    ).toEqual(saved);
    expect(await fileHash(fixture.sourcePath)).toBe(hash);
    await fixture.mutate(checkNativeState(fixture, 41, 1, "replayed"));
  } finally {
    await cold.dispose();
  }
}

function restoreScope(fixture: GuiSaveFixture): ScopedFilesystemScope {
  const handle = fixture.context.scopeHandle;
  if (!handle) throw new Error("原生保存验收缺少真实Task作用域");
  const otherTaskId = randomUUID();
  return {
    role: handle.role,
    agentId: "save-native-restore",
    describe: () => ({ ...handle.describe(), taskId: otherTaskId }),
    resolvePath: (path, operation) => handle.resolvePath(path, operation),
  };
}

async function verifyPendingFence(
  fixture: GuiSaveFixture,
  cold: CadService,
  restoring: ScopedFilesystemScope,
) {
  const owner = fixture.context.scopeHandle?.describe();
  if (!owner) throw new Error("原生保存验收缺少真实Task身份");
  expect(hasTaskFileOperations(owner.instanceId, owner.taskId)).toBe(false);
  expect(await cold.fileOperationParticipant?.pendingWrites()).toContainEqual({
    instanceId: owner.instanceId,
    taskId: owner.taskId,
    writeRoots: [fixture.root],
  });
  await expect(
    acquireTaskFileRestoreBarrier(restoring, [fixture.root]),
  ).rejects.toMatchObject({ code: "restore_busy" });
  await expect(
    revokeTaskFileOperations(owner.instanceId, owner.taskId),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  await expect(
    acquireTaskFileRestoreBarrier(restoring, [fixture.root]),
  ).rejects.toMatchObject({ code: "restore_busy" });
}

async function verifyFinishedFence(
  fixture: GuiSaveFixture,
  cold: CadService,
  restoring: ScopedFilesystemScope,
  input: CadGuiSaveDocumentInput,
  receiptPath: string,
) {
  const receipt = cadGuiSaveDocumentReceiptSchema.parse(
    await waitJson(receiptPath),
  );
  expect(receipt).toMatchObject({
    operationId: input.operationId,
    pid: fixture.application.pid,
    outcome: "partial",
    saveStarted: true,
    writeFinished: true,
    reason: "cancelled",
  });
  const status = await successfulCall(
    { ...fixture, tools: createCadTools(cold) },
    "cad_gui_operation_status",
    { operationId: input.operationId },
    "held-status",
  );
  expect(status).toMatchObject({
    operationId: input.operationId,
    state: "terminal",
    outcome: "partial",
    cancellationRequested: true,
    receipt,
  });
  const owner = fixture.context.scopeHandle?.describe();
  if (!owner) throw new Error("原生保存验收缺少真实Task身份");
  const writes = await cold.fileOperationParticipant?.pendingWrites();
  expect(writes?.some((write) => write.taskId === owner.taskId)).toBe(false);
  const lease = await acquireTaskFileRestoreBarrier(restoring, [fixture.root]);
  try {
    expect(lease.authorize(restoring)).toBe(restoring);
  } finally {
    await lease.release();
  }
  await fixture.mutate(
    checkNativeState(fixture, 43, 2, "cancelled-native-returned"),
  );
}

async function verifyHeldSave(fixture: GuiSaveFixture) {
  const operationId = randomUUID();
  await fixture.mutate(`state=builtins.__kfw_gui_save_fixture__
doc=state['document']
assert state['nonce']==${JSON.stringify(fixture.nonce)} and state['starts']==1
App.setActiveDocument(doc.Name)
doc.openTransaction('KFW save native 43')
doc.getObject('Box').Length=43
doc.recompute()
doc.commitTransaction()
Gui.getDocument(doc.Name).Modified=True
state['before']=state['capture'](doc)
state['heldOperationId']=${JSON.stringify(operationId)}
state['holdNext']=True`);
  const input = await saveInput(fixture, operationId),
    controller = new AbortController(),
    pending = call(
      fixture,
      "cad_gui_save_document",
      input,
      "held-save",
      controller.signal,
    );
  let cold: CadService | undefined, unregister: (() => void) | undefined;
  try {
    expect(await waitJson(fixture.startedPath, 12_000)).toMatchObject({
      operationId,
      pid: fixture.application.pid,
      starts: 2,
      fileName: fixture.sourcePath,
    });
    controller.abort();
    const stopped = await pending;
    expect(stopped.isError, JSON.stringify(stopped)).toBe(true);
    expect(stopped.structuredContent).toMatchObject({
      operationId,
      outcome: "unknown",
    });
    const owner = fixture.context.scopeHandle?.describe();
    if (!owner) throw new Error("原生保存验收缺少真实Task身份");
    const store = createCadGuiOperationStore({ rootDirectory: fixture.root }),
      record = await store.lookup({
        instanceId: owner.instanceId,
        taskId: owner.taskId,
        operationId,
      });
    if (!record) throw new Error("实际保存操作缺少持久记录");
    expect(await store.readState(record)).toMatchObject({
      status: "executing",
      cancelled: true,
      outcome: "unknown",
    });
    cold = fixture.reopen();
    if (!cold.fileOperationParticipant)
      throw new Error("冷服务缺少CAD持久写域Provider");
    unregister = registerTaskFileOperationParticipant(
      cold.fileOperationParticipant,
    );
    const restoring = restoreScope(fixture);
    await verifyPendingFence(fixture, cold, restoring);
    await writeFile(fixture.releasePath, "release\n", { mode: 0o600 });
    await verifyFinishedFence(
      fixture,
      cold,
      restoring,
      input,
      record.receiptPath,
    );
  } finally {
    controller.abort();
    try {
      await writeFile(fixture.releasePath, "release\n", { mode: 0o600 });
    } finally {
      try {
        await pending;
      } finally {
        unregister?.();
        await cold?.dispose();
      }
    }
  }
}

/** 仅复用调用方已绑定的自有GUI实例；不启动应用、操作AX或结束任何进程。 */
export async function verifyGuiSaveOperations(
  options: GuiSaveOptions,
): Promise<void> {
  const nonce = randomUUID(),
    fixture: GuiSaveFixture = {
      ...options,
      nonce,
      startedPath: join(options.root, `save-${nonce}-started.json`),
      releasePath: join(options.root, `save-${nonce}-release`),
      observationPath: join(options.root, `save-${nonce}-observations.json`),
    };
  const failures: unknown[] = [];
  try {
    await fixture.mutate(prepareSource(fixture));
    await verifyCompletedSave(fixture);
    await verifyHeldSave(fixture);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      try {
        await writeFile(fixture.releasePath, "release\n", { mode: 0o600 });
      } finally {
        await fixture.mutate(`state=getattr(builtins,'__kfw_gui_save_fixture__',None)
if state is not None and state['nonce']==${JSON.stringify(nonce)}:
    App.removeDocumentObserver(state['observer'])
    del builtins.__kfw_gui_save_fixture__`);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "原生保存验收或自有资源清理失败。");
}
