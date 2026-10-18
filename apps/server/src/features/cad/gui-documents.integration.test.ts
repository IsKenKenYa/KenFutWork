import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { runJxa } from "../computer-use/jxa.js";
import type { PluginStateRevokingEvent } from "../plugins/state-lifecycle.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { CadGuiApplication } from "./gui-document-contracts.js";
import { buildCadGuiOperationMacro } from "./gui-operation-controller.js";
import { createCadGuiOperationStore } from "./gui-operation-store.js";
import { createMacosCadGuiProbe } from "./gui-probe.js";
import { createMacosCadGuiTransport } from "./gui-transport.js";
import { detectFreeCadRuntime } from "./runtime.js";
import { createCadService } from "./service.js";
import {
  activateCadTestService,
  cadTestLimits,
  createCadTestContext,
  executeCadTestTool,
} from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";
import { createCadTools } from "./tools.js";

async function nativeToolCall(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`缺少真实CAD工具：${name}`);
  const result = await executeCadTestTool(tool, args, context);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}

async function verifyBackgroundCopy(
  tools: ToolDefinition[],
  documentPath: string,
  context: ToolExecutionContext,
) {
  const call = async (name: string, input: Record<string, unknown>) =>
    cadResultSchema.parse(
      await nativeToolCall(tools, name, input, {
        ...context,
        toolCallId: `gui-copy-handoff-${name}`,
      }),
    );
  const bytes = await readFile(documentPath);
  const described = await call("cad_describe_document", { documentPath });
  const shape = described.document?.objects.find(
    (entry) => entry.name === "Box",
  )?.shape;
  expect(shape).toMatchObject({ valid: true, null: false, solids: 1 });
  expect(shape?.volume).toBeCloseTo(12500, 6);
  const edited = await call("cad_run_python", {
    documentPath,
    source:
      "box = doc.getObject('Box')\nbox.Height = 15\nresult = {'height': box.Height.Value, 'expression': dict(box.ExpressionEngine)['Width']}",
    requireSolids: true,
    expectedVolume: { objectName: "Box", value: 18750 },
  });
  expect(edited.data).toEqual({ height: 15, expression: "Length * 2" });
  expect(edited.outputPath).not.toBe(documentPath);
  const exported = await call("cad_export", {
    documentPath: edited.outputPath,
    format: "step",
  });
  expect(await readFile(String(exported.outputPath), "utf8")).toContain(
    "ISO-10303-21",
  );
  expect(await readFile(documentPath)).toEqual(bytes);
}

async function verifyGuiCopies(options: {
  tools: ToolDefinition[];
  context: ToolExecutionContext;
  target(name?: string): Promise<Record<string, unknown>>;
  mutate(source: string): Promise<void>;
}) {
  const { tools, context, target, mutate } = options;
  const call = (name: string, args: Record<string, unknown>, id: string) =>
    nativeToolCall(tools, name, args, { ...context, toolCallId: id });
  await mutate(
    "doc=owned[0]\ndoc.openTransaction('KFW copy redo fixture')\ndoc.getObject('Box').Height=11\ndoc.recompute()\ndoc.commitTransaction()\ndoc.undo()\ndoc.recompute()\ndoc.getObject('Box').touch()\nGui.getDocument(doc.Name).Modified=True\nApp.setActiveDocument(owned[1].Name)\nbuiltins.__kfw_copy_state__=(doc.FileName,Gui.getDocument(doc.Name).Modified,doc.isTouched(),list(doc.UndoNames),list(doc.RedoNames),App.ActiveDocument.Name)\nassert doc.RedoCount>0 and doc.UndoCount>0",
  );
  const input = { ...(await target()), operationId: randomUUID() };
  const copied = await call("cad_gui_copy_document", input, "copy-saved");
  expect(copied).toMatchObject({
    outcome: "published",
    nativeOutcome: "copied",
    publicationOutcome: "published",
    receipt: { copyStarted: true, statePreserved: true },
  });
  const documentPath = z.string().parse(copied.outputPath);
  expect(documentPath).toMatch(/\.kfw-cad\/gui-snapshots\/.*\.FCStd$/u);
  const bytes = await readFile(documentPath);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(copied.sha256);
  expect(bytes.length).toBe(copied.sizeBytes);
  expect(await call("cad_gui_copy_document", input, "copy-replay")).toEqual(
    copied,
  );
  expect(
    await call(
      "cad_gui_operation_status",
      { operationId: input.operationId },
      "copy-status",
    ),
  ).toEqual(copied);
  await verifyBackgroundCopy(tools, documentPath, context);
  await mutate(
    "doc=owned[0]\nassert (doc.FileName,Gui.getDocument(doc.Name).Modified,doc.isTouched(),list(doc.UndoNames),list(doc.RedoNames),App.ActiveDocument.Name)==builtins.__kfw_copy_state__, 'copy changed source/native history/active document'\nbox=doc.getObject('Box')\nassert (box.Length.Value,box.Width.Value,box.Height.Value)==(25,50,10)\nassert dict(box.ExpressionEngine)['Width']=='Length * 2'\nassert owned[1].FileName==''",
  );
  const unsaved = await call(
    "cad_gui_copy_document",
    { ...(await target("KfwGuiUnsaved")), operationId: randomUUID() },
    "copy-unsaved",
  );
  expect(unsaved).toMatchObject({
    outcome: "published",
    nativeOutcome: "copied",
    receipt: { statePreserved: true },
  });
  await mutate(
    "assert owned[1].FileName==''\nassert Gui.getDocument(owned[1].Name).Modified\nassert App.ActiveDocument is owned[1]\nowned[1].openTransaction('KFW copy busy fixture')\nowned[1].getObject('Box').Height=12",
  );
  const copyTool = tools.find(
    (entry) => entry.name === "cad_gui_copy_document",
  );
  if (!copyTool) throw new Error("缺少实际GUI副本工具");
  const rejected = await executeCadTestTool(
    copyTool,
    { ...(await target()), operationId: randomUUID() },
    { ...context, toolCallId: "copy-pending-rejected" },
  );
  expect(rejected.isError).toBe(true);
  expect(rejected.structuredContent).toMatchObject({
    outcome: "rejected",
    receipt: { reason: "document_busy", copyStarted: false },
  });
  await mutate(
    "owned[1].abortTransaction()\nApp.setActiveDocument(owned[0].Name)",
  );
}

async function waitJson(path: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        Date.now() > deadline
      )
        throw error;
    }
    await delay(30);
  }
}

test.skipIf(
  process.platform !== "darwin" ||
    process.env.KENFUTWORK_CAD_GUI_DOCUMENTS_INTEGRATION !== "1",
)(
  "独立GUI经Task工具检查、修改与复制，后台接力且重放不保存源文件",
  async () => {
    const root = await realpath(
      await mkdtemp("/private/tmp/kfw-gui-document-"),
    );
    const runtime = await detectFreeCadRuntime();
    if (!runtime) throw new Error("原生GUI验收要求已安装FreeCAD");
    const nonce = randomUUID();
    const readyPath = join(root, "ready.json");
    const readyTemporary = `${readyPath}.tmp`;
    const savedPath = join(root, "saved.FCStd");
    const macroPath = join(root, "fixture.FCMacro");
    const cleanupPath = join(root, "cleanup.FCMacro");
    const cleanupReceipt = join(root, "cleanup.json");
    for (const entry of ["qt", "home", "data", "cache", "config"])
      await mkdir(join(root, entry), { mode: 0o700 });
    const metadataFunction = `def metadata(doc):
    return {'name':doc.Name,'label':doc.Label,'fileName':doc.FileName,'uid':str(doc.Uid),
            'modified':bool(Gui.getDocument(doc.Name).Modified),'touched':bool(doc.isTouched()),
            'pendingTransaction':bool(doc.HasPendingTransaction),'active':doc is App.ActiveDocument}
`;
    await writeFile(
      macroPath,
      `import FreeCAD as App, FreeCADGui as Gui, Part, os, json, builtins
from PySide import QtCore, QtWidgets
${metadataFunction}
def prepare():
    result={'pid':os.getpid(),'success':False}
    try:
        assert not App.listDocuments() and App.getActiveTransaction() is None, 'fixture refuses existing work'
        assert QtCore.QThread.currentThread()==QtWidgets.QApplication.instance().thread()
        saved=App.newDocument('saved'); box=saved.addObject('Part::Box','Box'); box.Length=20
        box.addProperty('App::PropertyInteger','ReadOnlyCount'); box.ReadOnlyCount=4; box.setEditorMode('ReadOnlyCount',1)
        box.addProperty('App::PropertyString','Note'); box.Note='自有验收属性'
        box.addProperty('App::PropertyString','FrozenNote'); box.FrozenNote='不可修改'; box.setPropertyStatus('FrozenNote','Immutable')
        box.addProperty('App::PropertyBool','Enabled'); box.Enabled=True
        box.addProperty('App::PropertyEnumeration','Choice'); box.Choice=['A','B']; box.Choice='B'
        box.setExpression('Width','Length * 2')
        saved.recompute(); saved.saveAs(${JSON.stringify(savedPath)})
        unsaved=App.newDocument('KfwGuiUnsaved'); unsaved.Label='未保存验收'; part=unsaved.addObject('Part::Box','Box'); part.Width=9; unsaved.recompute()
        unsaved.openTransaction('KFW metadata fixture pending'); part.Length=8
        App.setActiveDocument(unsaved.Name)
        Gui.getMainWindow().setWindowTitle('KenFutWork CAD 文档查询验收')
        builtins.__kfw_gui_metadata_fixture__=[saved,unsaved]
        builtins.__kfw_gui_metadata_nonce__=${JSON.stringify(nonce)}
        result.update(success=True,documents=[metadata(saved),metadata(unsaved)],version=list(App.Version()),qtTemp=QtCore.QDir.tempPath())
    except Exception as error: result['error']=str(error)
    with open(${JSON.stringify(readyTemporary)},'w') as stream: json.dump(result,stream)
    os.replace(${JSON.stringify(readyTemporary)},${JSON.stringify(readyPath)})
QtCore.QTimer.singleShot(0,prepare)
# 测试宿主失联时也只清理本实例的自有文档，绝不按PID杀其它应用。
QtCore.QTimer.singleShot(180000,lambda:exec(compile(open(${JSON.stringify(cleanupPath)},encoding='utf-8').read(),'kfw-fixture-cleanup','exec'),{}))
`,
      { mode: 0o600 },
    );
    await writeFile(
      cleanupPath,
      `import FreeCAD as App, FreeCADGui as Gui, builtins, json, os
from PySide import QtCore
def finish():
    assert getattr(builtins,'__kfw_gui_metadata_nonce__',None)==${JSON.stringify(nonce)}, 'fixture nonce changed'
    owned=getattr(builtins,'__kfw_gui_metadata_fixture__',[])
    current=App.listDocuments()
    assert len(current)==len(owned) and all(current.get(doc.Name) is doc for doc in owned), 'fixture refuses unexpected work'
    for doc in owned:
        if doc.HasPendingTransaction: doc.abortTransaction()
        App.closeDocument(doc.Name)
    with open(${JSON.stringify(cleanupReceipt)},'w') as stream: json.dump({'pid':os.getpid(),'documents':list(App.listDocuments())},stream)
    Gui.getMainWindow().close()
QtCore.QTimer.singleShot(0,finish)
`,
      { mode: 0o600 },
    );
    const work = createProcessSandbox({
      captureRoot: join(root, "work"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    const probe = createMacosCadGuiProbe();
    const probeContext = { timeoutMs: 10_000, maxOutputBytes: 65_536 };
    let application: CadGuiApplication | undefined;
    let completed = false;
    const environment = {
      HOME: join(root, "home"),
      FREECAD_USER_HOME: join(root, "home"),
      FREECAD_USER_DATA: join(root, "data"),
      FREECAD_USER_TEMP: join(root, "qt"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      TMPDIR: join(root, "qt"),
      QT_QPA_PLATFORM: "cocoa",
    };
    const args = [
      "--user-cfg",
      join(root, "user.cfg"),
      "--system-cfg",
      join(root, "system.cfg"),
      macroPath,
    ];
    try {
      const previous = await probe.list(probeContext);
      // LaunchServices 才会建立真实 bundle 登记；外部GUI不是Task子进程。
      const launched = z.object({ pid: z.number().int().min(2) }).parse(
        await runJxa(
          `ObjC.import('AppKit');
const error=Ref();
const configuration=$({NSWorkspaceLaunchConfigurationArguments:${JSON.stringify(args)},NSWorkspaceLaunchConfigurationEnvironment:${JSON.stringify(environment)}});
const app=$.NSWorkspace.sharedWorkspace.launchApplicationAtURLOptionsConfigurationError(
  $.NSURL.fileURLWithPath(${JSON.stringify(runtime.runtimeRoot)}),
  $.NSWorkspaceLaunchNewInstance | $.NSWorkspaceLaunchWithoutActivation,
  configuration,error);
if (app.isNil()) throw new Error('isolated GUI launch failed');
JSON.stringify({pid:Number(app.processIdentifier)});`,
          10_000,
        ),
      );
      expect(previous.some((entry) => entry.pid === launched.pid)).toBe(false);
      const ready = await waitJson(readyPath);
      expect(ready).toMatchObject({
        success: true,
        pid: launched.pid,
        qtTemp: join(root, "qt"),
      });
      const beforeHash = createHash("sha256")
        .update(await readFile(savedPath))
        .digest("hex");
      const applications = await probe.list({
        timeoutMs: 10_000,
        maxOutputBytes: 65536,
      });
      application = applications.find((entry) => entry.pid === ready.pid);
      if (!application) {
        const registration = await runJxa(
          `ObjC.import('AppKit');
const apps=$.NSWorkspace.sharedWorkspace.runningApplications;
const a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${ready.pid});
JSON.stringify({count:Number(apps.count),target: a.isNil() ? null : {
  pid:Number(a.processIdentifier),policy:Number(a.activationPolicy),
  bundleId:ObjC.unwrap(a.bundleIdentifier),
  executablePath:ObjC.unwrap(a.executableURL.path),
  bundlePath:ObjC.unwrap(a.bundleURL.path)
}});`,
          10_000,
        );
        await writeFile(
          join(root, "registration.json"),
          JSON.stringify({ applications, registration }),
        );
        throw new Error("无法以系统事实绑定独立测试GUI，不选择其它应用兜底");
      }
      const { context } = await createCadTestContext(root);
      const service = createCadService({
        sandbox: work,
        guiProbe: probe,
        guiOperationStore: createCadGuiOperationStore({ rootDirectory: root }),
        gate: async () => ({ ok: true }),
        resolveLimits: async () => ({
          limits: cadTestLimits,
          timeoutMs: 30_000,
        }),
      });
      activateCadTestService(service);
      const tool = createCadTools(service).find(
        (entry) => entry.name === "cad_gui_documents",
      );
      if (!tool) throw new Error("缺少实际GUI文档工具");
      const first = await executeCadTestTool(tool, { application }, context);
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      expect(first.structuredContent).toMatchObject({
        application,
        documents: expect.arrayContaining(
          ready.documents.map((doc: Record<string, unknown>) =>
            expect.objectContaining(doc),
          ),
        ),
        currentDocumentControl: true,
      });
      const second = await executeCadTestTool(
        tool,
        { application },
        { ...context, toolCallId: "second-observation" },
      );
      expect(second.isError, JSON.stringify(second)).not.toBe(true);
      expect(first.structuredContent.documents).toHaveLength(2);
      expect(second.structuredContent.documents).toEqual(
        expect.arrayContaining(
          ready.documents.map((doc: Record<string, unknown>) =>
            expect.objectContaining(doc),
          ),
        ),
      );
      expect(second.structuredContent.documents).toHaveLength(2);
      expect(second.structuredContent.observationId).not.toBe(
        first.structuredContent.observationId,
      );
      const observations = z.object({
        bridgeEpoch: z.string().uuid(),
        applicationRevision: z.number().int().nonnegative(),
        documents: z.array(
          z.object({
            name: z.string(),
            uid: z.string(),
            documentHandle: z.string().uuid(),
            revision: z.number().int().nonnegative(),
            touched: z.boolean(),
            modified: z.boolean(),
          }),
        ),
      });
      const initial = observations.parse(first.structuredContent);
      const unchanged = observations.parse(second.structuredContent);
      expect(unchanged).toEqual(initial);
      const saved = initial.documents.find((doc) => doc.name === "saved");
      if (!saved) throw new Error("缺少自有保存文档的打开句柄");
      const inspectTool = createCadTools(service).find(
        (entry) => entry.name === "cad_gui_inspect_document",
      );
      if (!inspectTool) throw new Error("缺少实际GUI对象读取工具");
      const target = {
        application,
        bridgeEpoch: initial.bridgeEpoch,
        documentHandle: saved.documentHandle,
        expectedApplicationRevision: initial.applicationRevision,
        expectedDocumentRevision: saved.revision,
      };
      const objectList = await executeCadTestTool(inspectTool, target, {
        ...context,
        toolCallId: "list-current-objects",
      });
      expect(objectList.isError, JSON.stringify(objectList)).not.toBe(true);
      expect(objectList.structuredContent.objects).toEqual([
        { name: "Box", label: "Box", typeId: "Part::Box" },
      ]);
      const inspected = await executeCadTestTool(
        inspectTool,
        { ...target, objectNames: ["Box"] },
        { ...context, toolCallId: "inspect-current-properties" },
      );
      expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
      const properties = z
        .object({
          objects: z.tuple([
            z.object({
              properties: z.array(
                z.object({
                  name: z.string(),
                  typeId: z.string(),
                  value: z.unknown().optional(),
                  editable: z.boolean(),
                  readOnly: z.boolean(),
                  immutable: z.boolean(),
                  expression: z.string().optional(),
                }),
              ),
            }),
          ]),
        })
        .parse(inspected.structuredContent).objects[0].properties;
      expect(properties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Length",
            typeId: "App::PropertyLength",
            editable: true,
            value: {
              kind: "quantity",
              value: 20,
              unitSignature: [1, 0, 0, 0, 0, 0, 0, 0],
            },
          }),
          expect.objectContaining({
            name: "Width",
            editable: false,
            expression: "Length * 2",
            value: {
              kind: "quantity",
              value: 40,
              unitSignature: [1, 0, 0, 0, 0, 0, 0, 0],
            },
          }),
          expect.objectContaining({
            name: "ReadOnlyCount",
            value: 4,
            readOnly: true,
            editable: false,
          }),
          expect.objectContaining({
            name: "Note",
            value: "自有验收属性",
            editable: true,
          }),
          expect.objectContaining({
            name: "FrozenNote",
            value: "不可修改",
            immutable: true,
            editable: false,
          }),
          expect.objectContaining({
            name: "Enabled",
            value: true,
            editable: true,
          }),
          expect.objectContaining({ name: "Choice", value: "B" }),
          expect.objectContaining({ name: "Shape", editable: false }),
        ]),
      );
      const missingObject = await executeCadTestTool(
        inspectTool,
        { ...target, objectNames: ["Missing"] },
        { ...context, toolCallId: "inspect-missing-object" },
      );
      expect(missingObject.isError).toBe(true);
      expect(missingObject.structuredContent).not.toHaveProperty("objects");
      const afterInspection = await executeCadTestTool(
        tool,
        { application },
        { ...context, toolCallId: "after-inspection" },
      );
      expect(observations.parse(afterInspection.structuredContent)).toEqual(
        initial,
      );
      let sequence = 0;
      const mutateFixture = async (source: string) => {
        sequence++;
        const receipt = join(root, `stage-${sequence}.json`);
        const macro = join(root, `stage-${sequence}.FCMacro`);
        await writeFile(
          macro,
          `import FreeCAD as App, FreeCADGui as Gui, builtins, json, os
from PySide import QtCore, QtWidgets
def apply_fixture_step():
    result={'pid':os.getpid(),'success':False}
    try:
        assert getattr(builtins,'__kfw_gui_metadata_nonce__',None)==${JSON.stringify(nonce)}
        assert QtCore.QThread.currentThread()==QtWidgets.QApplication.instance().thread()
        owned=builtins.__kfw_gui_metadata_fixture__
${source
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
        result['success']=True
    except Exception as error: result['error']=str(error)
    with open(${JSON.stringify(receipt)},'w') as stream: json.dump(result,stream)
QtCore.QTimer.singleShot(0,apply_fixture_step)
`,
          { mode: 0o600 },
        );
        if (!application) throw new Error("缺少已绑定的测试GUI");
        await createMacosCadGuiTransport().send(
          application,
          macro,
          probeContext,
        );
        expect(await waitJson(receipt)).toMatchObject({
          pid: application.pid,
          success: true,
        });
      };
      const observe = async () => {
        const result = await executeCadTestTool(
          tool,
          { application },
          { ...context, toolCallId: `observe-stage-${sequence}` },
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return observations.parse(result.structuredContent);
      };
      await mutateFixture(
        "doc=owned[0]\ndoc.openTransaction('KFW observer fixture')\ndoc.getObject('Box').Length=21\ndoc.recompute()\ndoc.commitTransaction()",
      );
      const changed = await observe();
      const changedSaved = changed.documents.find(
        (doc) => doc.documentHandle === saved.documentHandle,
      );
      expect(changed.bridgeEpoch).toBe(initial.bridgeEpoch);
      expect(changedSaved?.revision).toBeGreaterThan(saved.revision);
      expect(changed.applicationRevision).toBeGreaterThan(
        initial.applicationRevision,
      );
      const staleInspection = await executeCadTestTool(
        inspectTool,
        { ...target, objectNames: ["Box"] },
        { ...context, toolCallId: "inspect-stale-revision" },
      );
      expect(staleInspection.isError).toBe(true);
      expect(staleInspection.structuredContent).not.toHaveProperty("objects");
      await mutateFixture(
        "owned[0].undo()\nGui.getDocument(owned[0].Name).Modified=True",
      );
      const undone = await observe();
      expect(
        undone.documents.find(
          (doc) => doc.documentHandle === saved.documentHandle,
        )?.revision,
      ).toBeGreaterThan(changedSaved?.revision ?? -1);
      await mutateFixture("owned[0].recompute()");
      const beforeTouch = await observe();
      expect(
        beforeTouch.documents.find(
          (doc) => doc.documentHandle === saved.documentHandle,
        )?.touched,
      ).toBe(false);
      await mutateFixture("owned[0].getObject('Box').touch()");
      const touched = await observe();
      const touchedSaved = touched.documents.find(
        (doc) => doc.documentHandle === saved.documentHandle,
      );
      expect(touchedSaved?.touched).toBe(true);
      expect(touchedSaved?.revision).toBeGreaterThan(
        beforeTouch.documents.find(
          (doc) => doc.documentHandle === saved.documentHandle,
        )?.revision ?? -1,
      );
      expect(touchedSaved?.modified).toBe(true);
      await mutateFixture("Gui.getDocument(owned[0].Name).Modified=False");
      const cleared = await observe();
      const clearedSaved = cleared.documents.find(
        (doc) => doc.documentHandle === saved.documentHandle,
      );
      expect(clearedSaved?.modified).toBe(false);
      expect(clearedSaved?.revision).toBeGreaterThan(
        touchedSaved?.revision ?? -1,
      );
      await mutateFixture(
        `App.closeDocument(owned[0].Name)\nowned[0]=App.openDocument(${JSON.stringify(savedPath)})`,
      );
      const reopened = await observe();
      const reopenedSaved = reopened.documents.find(
        (doc) => doc.name === saved.name,
      );
      expect(reopenedSaved?.uid).toBe(saved.uid);
      expect(reopenedSaved?.documentHandle).not.toBe(saved.documentHandle);
      expect(reopened.documents.map((doc) => doc.documentHandle)).not.toContain(
        saved.documentHandle,
      );
      await mutateFixture(
        "doc=owned[0]\ndoc.clearDocument()\nassert App.getDocument(doc.Name) is doc, 'native clear replaced wrapper'",
      );
      const reset = await observe();
      const resetSaved = reset.documents.find((doc) => doc.name === saved.name);
      expect(resetSaved?.name).toBe(saved.name);
      expect(resetSaved?.documentHandle).not.toBe(
        reopenedSaved?.documentHandle,
      );
      expect(reset.documents.map((doc) => doc.documentHandle)).not.toContain(
        reopenedSaved?.documentHandle,
      );
      await mutateFixture(
        "doc=owned[0]\ndoc.addObject('Part::Box','Temporary')\ndoc.recompute()\ndoc.restore()\nassert App.getDocument(doc.Name) is doc, 'native restore replaced wrapper'\nassert abs(doc.getObject('Box').Length.Value-20)<1e-6, 'source model was not restored'",
      );
      const restored = await observe();
      const restoredSaved = restored.documents.find(
        (doc) => doc.name === saved.name,
      );
      expect(restoredSaved?.uid).toBe(saved.uid);
      expect(restoredSaved?.documentHandle).not.toBe(
        resetSaved?.documentHandle,
      );
      expect(restored.bridgeEpoch).toBe(initial.bridgeEpoch);
      expect(restored.documents.map((doc) => doc.documentHandle)).not.toContain(
        resetSaved?.documentHandle,
      );
      await mutateFixture(
        "if owned[1].HasPendingTransaction: owned[1].abortTransaction()\nApp.setActiveDocument(owned[0].Name)",
      );
      const setTool = createCadTools(service).find(
        (entry) => entry.name === "cad_gui_set_properties",
      );
      const statusTool = createCadTools(service).find(
        (entry) => entry.name === "cad_gui_operation_status",
      );
      if (!setTool || !statusTool)
        throw new Error("缺少受控写入或持久状态工具");
      let operationSequence = 0;
      const quantity = (value: number) => ({
        kind: "quantity",
        value,
        unitSignature: [1, 0, 0, 0, 0, 0, 0, 0],
      });
      const currentTarget = async (documentName = saved.name) => {
        const latest = await executeCadTestTool(
          tool,
          { application },
          { ...context, toolCallId: `edit-observe-${++operationSequence}` },
        );
        expect(latest.isError, JSON.stringify(latest)).not.toBe(true);
        const observation = observations.parse(latest.structuredContent);
        const document = observation.documents.find(
          (doc) => doc.name === documentName,
        );
        if (!document) throw new Error("自有编辑文档已离开实例");
        return {
          application,
          bridgeEpoch: observation.bridgeEpoch,
          documentHandle: document.documentHandle,
          expectedApplicationRevision: observation.applicationRevision,
          expectedDocumentRevision: document.revision,
        };
      };
      const editInput = {
        ...(await currentTarget()),
        operationId: randomUUID(),
        changes: [
          {
            objectName: "Box",
            propertyName: "Length",
            expectedValue: quantity(20),
            value: quantity(25),
          },
        ],
      };
      const changedProperties = await executeCadTestTool(setTool, editInput, {
        ...context,
        toolCallId: "set-gui-length",
      });
      expect(
        changedProperties.isError,
        JSON.stringify(changedProperties),
      ).not.toBe(true);
      expect(changedProperties.structuredContent).toMatchObject({
        operationId: editInput.operationId,
        outcome: "committed",
        state: "terminal",
        receipt: {
          mutationStarted: true,
          commitAttempted: true,
          commitObserved: true,
          transactionState: "none",
        },
      });
      await mutateFixture(
        "doc=owned[0]\nassert doc.getObject('Box').Length.Value==25\nassert doc.getObject('Box').Width.Value==50\nassert dict(doc.getObject('Box').ExpressionEngine).get('Width')=='Length * 2'\nassert not doc.HasPendingTransaction\nbuiltins.__kfw_edit_undo_count__=len(doc.UndoNames)",
      );
      const noOpInput = {
        ...(await currentTarget()),
        operationId: randomUUID(),
        changes: [
          {
            objectName: "Box",
            propertyName: "Length",
            expectedValue: quantity(25),
            value: quantity(25),
          },
        ],
      };
      const noOp = await executeCadTestTool(setTool, noOpInput, {
        ...context,
        toolCallId: "set-gui-noop",
      });
      expect(noOp.isError, JSON.stringify(noOp)).not.toBe(true);
      expect(noOp.structuredContent).toMatchObject({
        outcome: "no_op",
        receipt: {
          mutationStarted: false,
          commitAttempted: false,
          commitObserved: false,
        },
      });
      for (const changes of [
        [
          {
            objectName: "Box",
            propertyName: "Width",
            expectedValue: quantity(50),
            value: quantity(30),
          },
        ],
        [
          {
            objectName: "Box",
            propertyName: "ReadOnlyCount",
            expectedValue: 4,
            value: 7,
          },
        ],
        [
          {
            objectName: "Box",
            propertyName: "Length",
            expectedValue: quantity(25),
            value: quantity(30),
          },
          {
            objectName: "Box",
            propertyName: "FrozenNote",
            expectedValue: "不可修改",
            value: "替换",
          },
        ],
      ]) {
        const rejected = await executeCadTestTool(
          setTool,
          { ...(await currentTarget()), operationId: randomUUID(), changes },
          { ...context, toolCallId: `set-gui-reject-${++operationSequence}` },
        );
        expect(rejected.isError, JSON.stringify(rejected)).toBe(true);
        expect(rejected.structuredContent).toMatchObject({
          outcome: "rejected",
          receipt: { mutationStarted: false, commitObserved: false },
        });
      }
      const restarted = createCadService({
        sandbox: work,
        guiProbe: probe,
        guiOperationStore: createCadGuiOperationStore({ rootDirectory: root }),
        gate: async () => ({ ok: true }),
        resolveLimits: async () => ({
          limits: cadTestLimits,
          timeoutMs: 10_000,
        }),
      });
      activateCadTestService(restarted);
      try {
        const replay = createCadTools(restarted).find(
          (entry) => entry.name === "cad_gui_set_properties",
        );
        if (!replay) throw new Error("重启服务缺少受控修改工具");
        const replayed = await executeCadTestTool(replay, editInput, {
          ...context,
          toolCallId: "replay-gui-length",
        });
        expect(replayed.isError, JSON.stringify(replayed)).not.toBe(true);
        expect(replayed.structuredContent).toEqual(
          changedProperties.structuredContent,
        );
        const persisted = await executeCadTestTool(
          statusTool,
          { operationId: editInput.operationId },
          { ...context, toolCallId: "status-gui-length" },
        );
        expect(persisted.structuredContent).toEqual(
          changedProperties.structuredContent,
        );
      } finally {
        await restarted.dispose();
      }
      await mutateFixture(
        "doc=owned[0]\nassert doc.getObject('Box').Length.Value==25\nassert doc.getObject('Box').Width.Value==50\nassert not doc.HasPendingTransaction\nassert len(doc.UndoNames)==builtins.__kfw_edit_undo_count__, 'replay/noop/rejected operation changed undo history'",
      );
      await verifyGuiCopies({
        tools: createCadTools(service),
        context,
        target: currentTarget,
        mutate: mutateFixture,
      });
      await mutateFixture(
        "builtins.__kfw_edit_undo_count__=len(owned[0].UndoNames)",
      );
      const recoveryStore = createCadGuiOperationStore({ rootDirectory: root });
      const delayedInput = {
        ...(await currentTarget()),
        operationId: randomUUID(),
        recompute: true,
        changes: [
          {
            objectName: "Box",
            propertyName: "Length",
            expectedValue: quantity(25),
            value: quantity(30),
          },
        ],
      };
      const taskScope = context.scopeHandle?.describe();
      if (!taskScope) throw new Error("缺少自有Task作用域");
      // 模拟旧宿主在持久claim后退出；新宿主没有任何在途内存调用。
      const delayedRecord = await recoveryStore.prepare({
        operationId: delayedInput.operationId,
        binding: {
          instanceId: taskScope.instanceId,
          projectId: taskScope.projectId,
          taskId: taskScope.taskId,
          scopeGeneration: taskScope.generation,
          branchGeneration: 1,
          runId: "old-server-run",
          toolCallId: "old-queued-call",
        },
        payload: {
          operation: "set-properties",
          ...delayedInput,
          timeoutMs: 10_000,
        },
        buildMacro: buildCadGuiOperationMacro,
      });
      expect(await recoveryStore.claimDispatch(delayedRecord)).toBe(true);
      const cold = createCadService({
        sandbox: work,
        guiProbe: probe,
        guiOperationStore: recoveryStore,
        gate: async () => ({ ok: true }),
        resolveLimits: async () => ({
          limits: cadTestLimits,
          timeoutMs: 10_000,
        }),
      });
      activateCadTestService(cold);
      const revoking = {
        reason: "disable",
        previous: {
          id: "bundled__kenfutwork-cad",
          name: "kenfutwork-cad",
          enabled: true,
        },
        current: null,
      } as PluginStateRevokingEvent;
      try {
        await cold.pluginLifecycle.onStateRevoking?.(revoking);
        expect(await recoveryStore.readState(delayedRecord)).toMatchObject({
          cancelled: true,
          outcome: "unknown",
        });
        // 原官方队列迟到装载同一固定宏，取消标记须在首项原生修改前生效。
        await createMacosCadGuiTransport().send(
          application,
          delayedRecord.macroPath,
          probeContext,
        );
        expect(await waitJson(delayedRecord.receiptPath)).toMatchObject({
          outcome: "rejected",
          reason: "cancelled",
          mutationStarted: false,
        });
        cold.pluginLifecycle.afterStateChanged?.({
          reason: "enable",
          previous: revoking.previous,
          current: revoking.previous,
        });
        expect(
          await cold.guiOperationStatus(delayedInput.operationId, {
            ...context,
            toolCallId: "cold-cancel-status",
          }),
        ).toMatchObject({
          structuredContent: {
            operationId: delayedInput.operationId,
            cancellationRequested: true,
            outcome: "rejected",
          },
        });
      } finally {
        await cold.dispose();
      }
      await mutateFixture(
        "doc=owned[0]\nassert doc.getObject('Box').Length.Value==25\nassert doc.getObject('Box').Width.Value==50\nassert len(doc.UndoNames)==builtins.__kfw_edit_undo_count__\nassert not doc.HasPendingTransaction",
      );
      expect(
        createHash("sha256")
          .update(await readFile(savedPath))
          .digest("hex"),
      ).toBe(beforeHash);
      await delay(500);
      await probe.verify(application, {
        timeoutMs: 10_000,
        maxOutputBytes: 65536,
      });
      await service.dispose();
      await createMacosCadGuiTransport().send(application, cleanupPath, {
        timeoutMs: 10_000,
        maxOutputBytes: 65536,
      });
      expect(await waitJson(cleanupReceipt)).toEqual({
        pid: ready.pid,
        documents: [],
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const state = z
          .object({ alive: z.boolean() })
          .parse(
            await runJxa(
              `ObjC.import('AppKit'); const a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${application.pid}); JSON.stringify({alive:!a.isNil() && !Boolean(a.terminated)});`,
              5_000,
            ),
          );
        if (!state.alive) break;
        if (Date.now() > deadline) throw new Error("独立GUI尚未退出");
        await delay(100);
      }
      completed = true;
    } finally {
      if (!completed && application) {
        // 只向本次已绑定的实例请求固定清理，失联时交由自有超时宏处理。
        await createMacosCadGuiTransport()
          .send(application, cleanupPath, probeContext)
          .catch(() => {});
      }
      await work.close("gui_documents_fixture_cleanup");
      if (completed) await rm(root, { recursive: true, force: true });
      else console.error(`GUI文档原生验收诊断目录：${root}`);
    }
  },
  210_000,
);
