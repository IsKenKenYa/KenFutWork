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
import { runJxa } from "../computer-use/jxa.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { CadGuiApplication } from "./gui-document-contracts.js";
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
import { createCadTools } from "./tools.js";

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
  "独立GUI经真实Task工具查询保存及未保存文档，保留事务/脏状态/源字节且正常退出",
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
        saved=App.newDocument('KfwGuiSaved'); box=saved.addObject('Part::Box','Box'); box.Length=20; saved.recompute(); saved.saveAs(${JSON.stringify(savedPath)})
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
QtCore.QTimer.singleShot(45000,lambda:exec(compile(open(${JSON.stringify(cleanupPath)},encoding='utf-8').read(),'kfw-fixture-cleanup','exec'),{}))
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
        gate: async () => ({ ok: true }),
        resolveLimits: async () => ({
          limits: cadTestLimits,
          timeoutMs: 10_000,
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
        documents: ready.documents,
        currentDocumentControl: false,
      });
      const second = await executeCadTestTool(
        tool,
        { application },
        { ...context, toolCallId: "second-observation" },
      );
      expect(second.isError, JSON.stringify(second)).not.toBe(true);
      expect(second.structuredContent.documents).toEqual(ready.documents);
      expect(second.structuredContent.observationId).not.toBe(
        first.structuredContent.observationId,
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
  60_000,
);
