import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  cadGuiCopyDocumentInputSchema,
  cadGuiCopyDocumentReceiptSchema,
} from "./gui-document-copy-contracts.js";
import { CAD_GUI_DOCUMENT_COPY_SOURCE } from "./gui-document-copy-source.js";
import { CAD_GUI_DOCUMENT_OBSERVER_SOURCE } from "./gui-document-observer-source.js";
import { CAD_GUI_PROPERTY_MUTATION_SOURCE } from "./gui-property-mutation-source.js";
import { CAD_GUI_PROPERTY_INSPECTION_SOURCE } from "./gui-property-source.js";

const execute = promisify(execFile);
const fixtureSource = String.raw`
import hashlib, io, json, os, sys, tempfile, time, types, zipfile

calls, dumped = [], []
class PropertyKind:
    def __init__(self, name):
        self.name = name
    def isBad(self):
        return self.name == 'Unknown'
    def isDerivedFrom(self, base):
        return self.name == base or (base == 'App::PropertyXLinkContainer' and
                                    self.name in ('App::PropertyExpressionEngine', 'Spreadsheet::PropertySheet'))

class NativePropertyObject:
    PropertiesList = ['Property']
    def __init__(self, kind, xml='<Content/>'):
        self.kind, self.xml = kind, xml
    def getTypeIdOfProperty(self, name):
        return self.kind
    def getPropertyByName(self, *args):
        raise AssertionError('link getter must not be used as dependency evidence')
    def dumpPropertyContent(self, name, Compression):
        assert Compression == 0
        dumped.append(self.kind)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('Persistence.xml', self.xml)
        return bytearray(stream.getvalue())

class NativeDocument:
    HasPendingTransaction, UndoMode = False, 1
    Restoring = Partial = Importing = Recomputing = Transacting = False
    RecomputesFrozen = False
    InList, OutList = [], []
    def __init__(self, name):
        self.Name, self.Label, self.FileName, self.Uid = name, '未保存工程', '', 'uid-' + name
        self.UndoNames, self.RedoNames = ['用户原有操作'], ['用户可重做操作']
        self.UndoCount, self.RedoCount, self.UndoRedoMemSize = 1, 1, 512
        self.Objects = []
    def isTouched(self):
        return True
    def saveCopy(self, path):
        calls.append(['copy', path])
        App.emit('slotStartSaveDocument', self)
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('Document.xml', '<Document/>')
            archive.writestr('GuiDocument.xml', '<GuiDocument/>')
        App.emit('slotFinishSaveDocument', self)
        return None
    def recompute(self):
        raise AssertionError('copy must not recompute')
    def commitTransaction(self):
        raise AssertionError('copy must not commit')
    def abortTransaction(self):
        raise AssertionError('copy must not abort')

class Application(types.ModuleType):
    def __init__(self):
        super().__init__('FreeCAD')
        self.observers = []
        self.Base = types.SimpleNamespace(TypeId=types.SimpleNamespace(fromName=PropertyKind))
    def listDocuments(self):
        return {doc.Name: doc, other.Name: other}
    def getActiveTransaction(self):
        return None
    def addDocumentObserver(self, observer):
        self.observers.append(observer)
    def removeDocumentObserver(self, observer):
        self.observers.remove(observer)
    def emit(self, name, *args):
        bridge.application_revision += 1
        if args and args[0] is doc:
            bridge.record['revision'] += 1
        for observer in tuple(self.observers):
            callback = getattr(observer, name, None)
            if callback is not None:
                callback(*args)

doc, other = NativeDocument('Part'), NativeDocument('Other')
App = Application()
App.ActiveDocument = other
Gui = types.ModuleType('FreeCADGui')
Gui.observers = []
Gui.addDocumentObserver = Gui.observers.append
Gui.removeDocumentObserver = Gui.observers.remove
Gui.getDocument = lambda name: types.SimpleNamespace(Modified=True, Transacting=False, getInEdit=lambda: None)
Gui.activeDocument = lambda: Gui.getDocument(other.Name)
sys.modules.update(FreeCAD=App, FreeCADGui=Gui)
qapp = types.SimpleNamespace(thread=lambda: 'gui-thread')
qt = types.ModuleType('PySide')
qt.QtWidgets = types.SimpleNamespace(QApplication=types.SimpleNamespace(instance=lambda: qapp))
qt.QtCore = types.SimpleNamespace(QThread=types.SimpleNamespace(currentThread=lambda: 'gui-thread'),
                                  QTimer=types.SimpleNamespace(singleShot=lambda ms, callback: callback()))
sys.modules['PySide'] = qt

class Bridge:
    epoch, application_revision, valid = 'b1ff2ef8-0854-40c9-9da8-c9ff07bfb219', 2, True
    def __init__(self):
        self.record = {'object': doc, 'closed': False,
                       'handle': '28686cba-59d6-44c3-a30c-bbca88a7d737', 'revision': 3}
        self.documents = {id(doc): self.record}
    def snapshot(self):
        return {'bridgeEpoch': self.epoch, 'applicationRevision': self.application_revision,
                'documents': [{'name': doc.Name, 'label': doc.Label, 'fileName': doc.FileName,
                               'uid': doc.Uid, 'modified': True, 'touched': doc.isTouched(),
                               'pendingTransaction': doc.HasPendingTransaction, 'active': False,
                               'documentHandle': self.record['handle'], 'revision': self.record['revision']}]}
    def require_valid(self):
        assert self.valid
    def find(self, target):
        return self.record if target is doc else None
    def listed(self, target):
        return any(target is current for current in App.listDocuments().values())

bridge = Bridge()
_kfw_cad_document_bridge = lambda app, gui: bridge
request = {
    'operation': 'save-copy', 'operationId': 'b357cc8d-e5a1-4a3e-b23f-c145e99f163d',
    'application': {'pid': os.getpid(), 'bundleId': 'org.freecad.FreeCAD', 'name': 'FreeCAD',
                    'bundlePath': '/Applications/FreeCAD.app',
                    'executablePath': '/Applications/FreeCAD.app/Contents/Resources/bin/freecad',
                    'launchedAt': 1000, 'birth': {'startSeconds': 1, 'startMicroseconds': 2}},
    'bridgeEpoch': bridge.epoch, 'documentHandle': bridge.record['handle'],
    'expectedApplicationRevision': 2, 'expectedDocumentRevision': 3,
    'outputPath': 'project/result.FCStd', 'timeoutMs': 10000,
}

def prepare(directory):
    names = {'manifestPath': 'manifest.json', 'requestPath': 'request.json',
             'macroPath': 'operation.FCMacro', 'receiptPath': 'receipt.json',
             'cancelledPath': 'cancelled', 'executionClaimPath': 'execute.claim',
             'dispatchClaimPath': 'dispatch.claim'}
    paths = dict(directory=directory, **{key: os.path.join(directory, name) for key, name in names.items()})
    raw = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    manifest = {'version': 1, 'operationId': request['operationId'],
                'preparedAt': int(time.time() * 1000),
                'binding': {'instanceId': 'instance-1', 'projectId': 'project-1', 'taskId': 'task-1',
                            'scopeGeneration': 1, 'branchGeneration': 1, 'runId': 'run-1', 'toolCallId': 'tool-1'},
                'payload': request, 'fingerprint': hashlib.sha256(raw).hexdigest(),
                'sourceHash': hashlib.sha256(b'fixed source').hexdigest()}
    for path, content in ((paths['requestPath'], raw + b'\n'),
                          (paths['manifestPath'], json.dumps(manifest).encode('utf-8')),
                          (paths['macroPath'], b'fixed source'),
                          (paths['dispatchClaimPath'], b'host-claimed\n')):
        with open(path, 'wb') as stream:
            stream.write(content)
    return paths
`;

async function evaluate(source: string) {
  const result = await execute(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `${CAD_GUI_DOCUMENT_OBSERVER_SOURCE}\n${CAD_GUI_PROPERTY_INSPECTION_SOURCE}\n${CAD_GUI_PROPERTY_MUTATION_SOURCE}\n${CAD_GUI_DOCUMENT_COPY_SOURCE}\n${fixtureSource}\n${source}`,
    ],
    { timeout: 10_000, maxBuffer: 100_000 },
  );
  return JSON.parse(result.stdout);
}

async function runCopy(setup = "", before = "", after = "") {
  return evaluate(`
${setup}
with tempfile.TemporaryDirectory() as directory:
    paths = prepare(directory)
${before
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
    _kfw_cad_copy_document(paths)
${after
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
    receipt = None
    if os.path.exists(paths['receiptPath']):
        with open(paths['receiptPath']) as stream:
            receipt = json.load(stream)
    print(json.dumps({'receipt': receipt, 'calls': [name for name, path in calls],
                      'fixedPaths': all(path == os.path.join(directory, 'document.FCStd') for name, path in calls),
                      'active': App.ActiveDocument.Name, 'filename': doc.FileName,
                      'undoCount': len(doc.UndoNames), 'redoCount': len(doc.RedoNames),
                      'dumped': dumped, 'claim': os.path.getsize(paths['executionClaimPath']),
                      'receiptBytes': os.path.getsize(paths['receiptPath']) if receipt is not None else 0,
                      'observers': len(App.observers) + len(Gui.observers)}))
`);
}

test("复制非活动文档只写固定私有FCStd，保留当前工程状态及活动文档", async () => {
  const result = await evaluate(`
with tempfile.TemporaryDirectory() as directory:
    paths = prepare(directory)
    _kfw_cad_copy_document(paths)
    with open(paths['receiptPath']) as stream:
        receipt = json.load(stream)
    artifact = os.path.join(directory, 'document.FCStd')
    with zipfile.ZipFile(artifact) as archive:
        members = archive.namelist()
    with open(artifact, 'rb') as stream:
        checksum = hashlib.sha256(stream.read()).hexdigest()
    print(json.dumps({'receipt': receipt, 'calls': [name for name, path in calls],
                      'fixedPath': calls[0][1] == artifact,
                      'active': App.ActiveDocument.Name, 'filename': doc.FileName,
                      'undo': doc.UndoNames, 'redo': doc.RedoNames, 'touched': doc.isTouched(),
                      'members': members, 'sha256': checksum,
                      'observers': len(App.observers) + len(Gui.observers)}))
`);
  const receipt = cadGuiCopyDocumentReceiptSchema.parse(result.receipt);
  expect(receipt).toMatchObject({
    outcome: "copied",
    copyStarted: true,
    statePreserved: true,
    artifact: {
      name: "document.FCStd",
      hasGuiDocument: true,
      sha256: result.sha256,
    },
  });
  expect(result).toMatchObject({
    calls: ["copy"],
    fixedPath: true,
    active: "Other",
    filename: "",
    undo: ["用户原有操作"],
    redo: ["用户可重做操作"],
    touched: true,
    members: ["Document.xml", "GuiDocument.xml"],
    observers: 0,
  });
});

test.each([
  ["已加载依赖", "doc.OutList = [other]", "external_dependencies"],
  [
    "隐藏未加载外链",
    "doc.Objects = [NativePropertyObject('App::PropertyXLink', '<Content><XLink file=\"/outside/part.FCStd\" name=\"Box\"/></Content>')]",
    "external_dependencies",
  ],
  [
    "隐藏Spreadsheet引用者",
    "doc.FileName = '/projects/source.FCStd'\nother.FileName = '/projects/referrer.FCStd'\nother.Objects = [NativePropertyObject('Spreadsheet::PropertySheet', '<Content><XLinks count=\"1\"><XLink file=\"source.FCStd\"/></XLinks></Content>')]",
    "external_referrers",
  ],
  [
    "无法解释的外链",
    "doc.Objects = [NativePropertyObject('App::PropertyExpressionEngine', '<Content><XLinks count=\"1\"/></Content>')]",
    "unsupported_external_reference",
  ],
  [
    "未保存目标的外链引用无法确定",
    "other.FileName = '/projects/referrer.FCStd'\nother.Objects = [NativePropertyObject('App::PropertyXLink', '<Content><XLink file=\"/projects/other.FCStd\" name=\"Box\"/></Content>')]",
    "unsupported_external_reference",
  ],
  [
    "未知运行时类型",
    "doc.Objects = [NativePropertyObject('Unknown')]",
    "unsupported_external_reference",
  ],
  ["已有事务", "doc.HasPendingTransaction = True", "document_busy"],
  [
    "活动编辑",
    "Gui.getDocument = lambda name: types.SimpleNamespace(Modified=True, Transacting=False, getInEdit=lambda: object())",
    "document_busy",
  ],
  ["过时revision", "request['expectedDocumentRevision'] = 2", "stale_target"],
])("%s在saveCopy之前拒绝，不写私有副本", async (_label, setup, reason) => {
  const result = await runCopy(setup);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    copyStarted: false,
    reason,
  });
  expect(result.receipt).not.toHaveProperty("artifact");
  expect(result).toMatchObject({ calls: [], active: "Other", observers: 0 });
});

test("Shape和Proxy不dump或一概拒绝，正常序列化仍可保存", async () => {
  const result = await runCopy(`
doc.Objects = [NativePropertyObject('Part::PropertyPartShape'), NativePropertyObject('App::PropertyPythonObject')]
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt).outcome).toBe(
    "copied",
  );
  expect(result).toMatchObject({
    calls: ["copy"],
    dumped: [],
    fixedPaths: true,
  });
});

test("引用文档文件本身为符号链接时，在saveCopy前识别隐藏引用并保留引用方", async () => {
  const result = await evaluate(`
with tempfile.TemporaryDirectory() as directory:
    paths = prepare(directory)
    original_directory = os.path.join(directory, 'original')
    alias_directory = os.path.join(directory, 'aliases')
    os.mkdir(original_directory)
    os.mkdir(alias_directory)
    source_path = os.path.join(original_directory, 'source.FCStd')
    referrer_path = os.path.join(original_directory, 'referrer.FCStd')
    for path, content in ((source_path, b'original source'), (referrer_path, b'original referrer')):
        with open(path, 'wb') as stream:
            stream.write(content)
    doc.FileName = source_path
    other.FileName = os.path.join(alias_directory, 'referrer.FCStd')
    os.symlink(referrer_path, other.FileName)
    assert os.path.islink(other.FileName) and not os.path.islink(alias_directory)
    assert not doc.InList and not doc.OutList
    other.Objects = [NativePropertyObject('App::PropertyExpressionEngine',
        '<Content><XLinks count="1" hidden="0 "><XLink file="source.FCStd" name="Box"/></XLinks></Content>')]
    touched_referrers = []
    original_copy = NativeDocument.saveCopy
    def touching_referrer(self, path):
        original_copy(self, path)
        touched_referrers.append(other.Name)
        App.emit('slotChangedDocument', other, 'Comment')
    NativeDocument.saveCopy = touching_referrer
    _kfw_cad_copy_document(paths)
    with open(paths['receiptPath']) as stream:
        receipt = json.load(stream)
    with open(source_path, 'rb') as stream:
        source_unchanged = stream.read() == b'original source'
    with open(referrer_path, 'rb') as stream:
        referrer_unchanged = stream.read() == b'original referrer'
    print(json.dumps({'receipt': receipt, 'calls': [name for name, path in calls],
                      'touchedReferrers': touched_referrers,
                      'sourceUnchanged': source_unchanged, 'referrerUnchanged': referrer_unchanged,
                      'active': App.ActiveDocument.Name,
                      'observers': len(App.observers) + len(Gui.observers)}))
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    copyStarted: false,
    reason: "external_referrers",
  });
  expect(result.receipt).not.toHaveProperty("artifact");
  expect(result).toMatchObject({
    calls: [],
    touchedReferrers: [],
    sourceUnchanged: true,
    referrerUnchanged: true,
    active: "Other",
    observers: 0,
  });
});

test("本地表达式的空XLinks不会挡住正常副本", async () => {
  const result = await runCopy(`
doc.Objects = [NativePropertyObject('App::PropertyExpressionEngine', '<Content><ExpressionEngine/><XLinks count="0"/></Content>')]
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt).outcome).toBe(
    "copied",
  );
  expect(result.dumped).toEqual(["App::PropertyExpressionEngine"]);
});

test("空file的本地XLink及未解析本地名称按原貌复制", async () => {
  const result = await runCopy(`
doc.Objects = [NativePropertyObject('App::PropertyXLink', '<Content><XLink file="" name="MissingLocalObject"/></Content>')]
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt).outcome).toBe(
    "copied",
  );
});

test("XLinks的DocMap不计为外链项，也不把https当作本地相对路径", async () => {
  const local = await runCopy(`
doc.Objects = [NativePropertyObject('App::PropertyExpressionEngine', '<Content><XLinks count="0"><DocMap/></XLinks></Content>')]
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(local.receipt).outcome).toBe(
    "copied",
  );
  const remote = await runCopy(`
doc.FileName = '/projects/source.FCStd'
other.FileName = '/projects/referrer.FCStd'
other.Objects = [NativePropertyObject('App::PropertyXLink', '<Content><XLink file="https://example.test/source.FCStd" name="Box"/></Content>')]
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(remote.receipt)).toMatchObject({
    outcome: "rejected",
    copyStarted: false,
    reason: "unsupported_external_reference",
  });
});

test("同一个复制宏重放只保存一次且不覆盖回执", async () => {
  const result = await runCopy(
    "",
    "",
    `
with open(paths['receiptPath'], 'rb') as stream:
    original_receipt = stream.read()
_kfw_cad_copy_document(paths)
with open(paths['receiptPath'], 'rb') as stream:
    assert stream.read() == original_receipt
`,
  );
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt).outcome).toBe(
    "copied",
  );
  expect(result.calls).toEqual(["copy"]);
  expect(result.claim).toBeGreaterThan(0);
});

test.each([
  ["未产生文件", "pass"],
  [
    "不是ZIP",
    "with open(path, 'wb') as stream:\n    stream.write(b'not a project')",
  ],
  [
    "缺GuiDocument",
    "with zipfile.ZipFile(path, 'w') as archive:\n    archive.writestr('Document.xml', '<Document/>')",
  ],
])("saveCopy返回None但%s时不声称copied", async (_label, body) => {
  const result = await runCopy(`
def incomplete_copy(self, path):
    calls.append(['copy', path])
    App.emit('slotStartSaveDocument', self)
${body
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
    App.emit('slotFinishSaveDocument', self)
    return None
NativeDocument.saveCopy = incomplete_copy
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    copyStarted: true,
    reason: "invalid_copy_artifact",
  });
  expect(result.receipt).not.toHaveProperty("artifact");
  expect(result.calls).toEqual(["copy"]);
});

test("复制改变历史时保留现场并报告partial，不用计数相同冒充历史未变", async () => {
  const result = await runCopy(`
original_copy = NativeDocument.saveCopy
def history_change(self, path):
    original_copy(self, path)
    self.UndoNames[0] = '被provider改写的历史'
NativeDocument.saveCopy = history_change
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    copyStarted: true,
    statePreserved: false,
    reason: "source_state_changed",
  });
  expect(result).toMatchObject({ calls: ["copy"], undoCount: 1, redoCount: 1 });
});

test("provider意外修改其它文档时不发布副本或强行恢复用户状态", async () => {
  const result = await runCopy(`
original_copy = NativeDocument.saveCopy
def foreign_change(self, path):
    original_copy(self, path)
    App.emit('slotChangedDocument', other, 'Comment')
    App.ActiveDocument = self
NativeDocument.saveCopy = foreign_change
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    statePreserved: false,
    copyStarted: true,
  });
  expect(result.receipt).not.toHaveProperty("artifact");
  expect(result).toMatchObject({
    calls: ["copy"],
    active: "Part",
    observers: 0,
  });
});

test("超过4MB的完整工程按流验证，不套控制记录字节上限", async () => {
  const result = await runCopy(`
def large_copy(self, path):
    calls.append(['copy', path])
    App.emit('slotStartSaveDocument', self)
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('Document.xml', '<Document/>')
        archive.writestr('GuiDocument.xml', '<GuiDocument/>')
        archive.writestr('Shape.brp', b'x' * 5242880)
    App.emit('slotFinishSaveDocument', self)
NativeDocument.saveCopy = large_copy
`);
  const receipt = cadGuiCopyDocumentReceiptSchema.parse(result.receipt);
  expect(receipt.outcome).toBe("copied");
  expect(receipt.artifact?.size).toBeGreaterThan(5 * 1024 * 1024);
});

test("大量UndoNames不进入回执，历史摘要验证后仍可完成复制", async () => {
  const result = await runCopy("doc.UndoNames = ['用户原有操作' * 10000] * 8");
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt).outcome).toBe(
    "copied",
  );
  expect(result.receiptBytes).toBeLessThan(4096);
  expect(JSON.stringify(result.receipt)).not.toContain("用户原有操作");
});

test("复制后丢失控制文件立即停止，不再检查源或发布artifact", async () => {
  const result = await runCopy(`
original_copy = NativeDocument.saveCopy
def lose_control(self, path):
    original_copy(self, path)
    os.unlink(paths['requestPath'])
NativeDocument.saveCopy = lose_control
`);
  expect(cadGuiCopyDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    copyStarted: true,
    statePreserved: false,
    reason: "operation_control_lost",
  });
  expect(result.receipt).not.toHaveProperty("artifact");
});

test("复制输入只接受FCStd发布路径，不接任意宏、私有路径或对象选择", async () => {
  const request = await evaluate("print(json.dumps(request))");
  const { operation: _operation, timeoutMs: _timeout, ...input } = request;
  expect(
    cadGuiCopyDocumentInputSchema.parse({
      ...input,
      operationId: input.operationId.toUpperCase(),
      outputPath: "/allowed/output.FCStd",
    }).operationId,
  ).toBe(input.operationId);
  for (const extra of [
    { outputPath: "file.step" },
    { source: "unsafe()" },
    { privatePath: "/tmp/other.FCStd" },
    { objectNames: ["Box"] },
  ]) {
    expect(
      cadGuiCopyDocumentInputSchema.safeParse({ ...input, ...extra }).success,
    ).toBe(false);
  }
});
