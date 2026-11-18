import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { CAD_GUI_DOCUMENT_OBSERVER_SOURCE } from "./gui-document-observer-source.js";
import { CAD_GUI_PROPERTY_MUTATION_SOURCE } from "./gui-property-mutation-source.js";
import { CAD_GUI_PROPERTY_INSPECTION_SOURCE } from "./gui-property-source.js";
import {
  cadGuiUndoOperationInputSchema,
  cadGuiUndoOperationReceiptSchema,
  cadGuiUndoSourceSchema,
} from "./gui-undo-contracts.js";
import { CAD_GUI_UNDO_SOURCE } from "./gui-undo-source.js";

const execute = promisify(execFile);
const fixtureSource = String.raw`
import hashlib, io, json, os, sys, tempfile, time, types, zipfile

calls = []
transaction_name = 'KFW CAD d875c286-cb7c-41ba-947b-59616005b9a6'
class NativeObject:
    Name, Label, TypeId = 'Box', '盒子', 'Part::Box'
    def __init__(self):
        self.ViewObject = object()
        self.values = {'Length': ('App::PropertyFloat', 25.0),
                       'Width': ('App::PropertyFloat', 50.0),
                       'Note': ('App::PropertyString', '说明'),
                       'ExpressionEngine': ('App::PropertyExpressionEngine', [('Width', 'Length * 2')])}
        self.PropertiesList = list(self.values)
        self.linkFiles = {}
    def getTypeIdOfProperty(self, name):
        return self.values[name][0]
    def getEditorMode(self, name):
        return []
    def getPropertyStatus(self, name):
        return []
    def getPropertyByName(self, name, mode=0):
        return (self, self.values[name][1]) if mode == 2 else self.values[name][1]
    def dumpPropertyContent(self, name, Compression=0):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('Persistence.xml', '<Content><XLink file="' + self.linkFiles.get(name, '') + '"/></Content>')
        return bytearray(output.getvalue())
    def change(self, name, value):
        App.emit('slotBeforeChangeObject', self, name)
        self.values[name] = (self.values[name][0], value)
        App.emit('slotChangedObject', self, name)

class NativeDocument:
    Name, Label, FileName, Uid = 'Part', '零件', '', 'native-uid'
    HasPendingTransaction, UndoMode = False, 1
    Restoring = Partial = Importing = Recomputing = Transacting = RecomputesFrozen = False
    InList, OutList = [], []
    def __init__(self):
        self.UndoNames = [transaction_name, '用户之前的操作🧩']
        self.RedoNames = []
        self.Objects = [NativeObject()]
    @property
    def UndoCount(self):
        return len(self.UndoNames)
    @property
    def RedoCount(self):
        return len(self.RedoNames)
    def getObject(self, name):
        return next((obj for obj in self.Objects if obj.Name == name), None)
    def isTouched(self):
        return False
    def undo(self):
        calls.append('undo')
        self.Objects[0].change('Length', 10.0)
        self.Objects[0].change('Width', 20.0)
        App.emit('slotBeforeChangeObject', self.Objects[0], 'Shape')
        App.emit('slotChangedObject', self.Objects[0], 'Shape')
        Gui.emit('slotChangedObject', self.Objects[0].ViewObject, 'Visibility')
        self.RedoNames.insert(0, self.UndoNames.pop(0))
        App.emit('slotUndoDocument', self)
    def recompute(self):
        calls.append('recompute')
    def redo(self):
        calls.append('redo')
    def commitTransaction(self):
        calls.append('commit')
    def abortTransaction(self):
        calls.append('abort')

class Application(types.ModuleType):
    def __init__(self):
        super().__init__('FreeCAD')
        self.observers, self.active = [], None
        self.Base = types.SimpleNamespace(TypeId=types.SimpleNamespace(fromName=lambda name: types.SimpleNamespace(
            isBad=lambda: False, isDerivedFrom=lambda base: (name == 'App::PropertyXLink' and base == 'App::PropertyXLink')
            or (name == 'App::PropertyExpressionEngine' and base == 'App::PropertyXLinkContainer'))))
    def listDocuments(self):
        return documents
    def getActiveTransaction(self):
        return self.active
    def addDocumentObserver(self, observer):
        self.observers.append(observer)
    def removeDocumentObserver(self, observer):
        self.observers.remove(observer)
    def emit(self, name, *args):
        bridge.application_revision += 1
        bridge.record['revision'] += 1
        for observer in tuple(self.observers):
            callback = getattr(observer, name, None)
            if callback is not None:
                callback(*args)

App = Application()
doc = NativeDocument()
documents = {doc.Name: doc}
App.ActiveDocument = doc
Gui = types.ModuleType('FreeCADGui')
Gui.observers = []
Gui.addDocumentObserver = Gui.observers.append
Gui.removeDocumentObserver = Gui.observers.remove
Gui.getDocument = lambda name: types.SimpleNamespace(Modified=True, getInEdit=lambda: None, Transacting=False)
def gui_emit(name, *args):
    bridge.application_revision += 1
    for observer in tuple(Gui.observers):
        callback = getattr(observer, name, None)
        if callback is not None:
            callback(*args)
Gui.emit = gui_emit
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
                               'uid': doc.Uid, 'modified': True, 'touched': False,
                               'pendingTransaction': doc.HasPendingTransaction, 'active': App.ActiveDocument is doc,
                               'documentHandle': self.record['handle'], 'revision': self.record['revision']}]}
    def require_valid(self):
        assert self.valid
    def find(self, target):
        return self.record if target is doc else None
    def listed(self, target):
        return any(target is current for current in documents.values())

bridge = Bridge()
_kfw_cad_document_bridge = lambda app, gui: bridge
application = {'pid': os.getpid(), 'bundleId': 'org.freecad.FreeCAD', 'name': 'FreeCAD',
               'bundlePath': '/Applications/FreeCAD.app',
               'executablePath': '/Applications/FreeCAD.app/Contents/Resources/bin/freecad',
               'launchedAt': 1000, 'birth': {'startSeconds': 1, 'startMicroseconds': 2}}
source_input = {'application': application, 'operationId': 'b357cc8d-e5a1-4a3e-b23f-c145e99f163d',
                'bridgeEpoch': bridge.epoch, 'documentHandle': bridge.record['handle'],
                'expectedApplicationRevision': 1, 'expectedDocumentRevision': 1,
                'changes': [{'objectName': 'Box', 'propertyName': 'Length', 'expectedValue': 10.0, 'value': 25.0}],
                'recompute': True}
source_receipt = {'protocol': 'kfw-cad-gui-operation/1', 'operationId': source_input['operationId'],
                  'fingerprint': 'a' * 64, 'pid': os.getpid(), 'guiThread': True, 'completed': True,
                  'outcome': 'committed', 'mutationStarted': True, 'commitAttempted': True,
                  'commitObserved': True, 'transactionState': 'none',
                  'changes': [{'objectName': 'Box', 'propertyName': 'Length', 'before': 10.0,
                               'requested': 25.0, 'observed': 25.0, 'changed': True}],
                  'undoProvenance': {'transactionName': transaction_name,
                                     'undoHistory': _kfw_cad_history_summary(doc.UndoNames),
                                     'redoHistory': _kfw_cad_history_summary(doc.RedoNames)},
                  'snapshot': dict(bridge.snapshot(), document=bridge.snapshot()['documents'][0])}
source_receipt['snapshot'].pop('documents')
request = dict(application=application, operation='undo', operationId='f8e43257-bb5d-4854-8135-1a0c552f6003',
               sourceOperationId=source_input['operationId'], bridgeEpoch=bridge.epoch,
               documentHandle=bridge.record['handle'], expectedApplicationRevision=2, expectedDocumentRevision=3,
               timeoutMs=10000, undoSource={'input': source_input, 'receipt': source_receipt})

def prepare(directory):
    names = {'manifestPath': 'manifest.json', 'requestPath': 'request.json', 'macroPath': 'operation.FCMacro',
             'receiptPath': 'receipt.json', 'cancelledPath': 'cancelled', 'executionClaimPath': 'execute.claim',
             'dispatchClaimPath': 'dispatch.claim'}
    paths = dict(directory=directory, **{key: os.path.join(directory, name) for key, name in names.items()})
    raw = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    manifest = {'version': 1, 'operationId': request['operationId'], 'preparedAt': int(time.time() * 1000),
                'payload': request, 'fingerprint': hashlib.sha256(raw).hexdigest()}
    for path, content in ((paths['requestPath'], raw + b'\n'),
                          (paths['manifestPath'], json.dumps(manifest).encode('utf-8')),
                          (paths['dispatchClaimPath'], b'host-claimed\n')):
        with open(path, 'wb') as stream:
            stream.write(content)
    return paths
`;

async function runUndo(setup = "", after = "") {
  const result = await execute(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `${CAD_GUI_DOCUMENT_OBSERVER_SOURCE}\n${CAD_GUI_PROPERTY_INSPECTION_SOURCE}\n${CAD_GUI_PROPERTY_MUTATION_SOURCE}\n${CAD_GUI_UNDO_SOURCE}\n${fixtureSource}\n${setup}\nwith tempfile.TemporaryDirectory() as directory:\n    paths = prepare(directory)\n    _kfw_cad_undo_operation(paths)\n${after
        .split("\n")
        .map((line) => `    ${line}`)
        .join(
          "\n",
        )}\n    receipt = None\n    if os.path.exists(paths['receiptPath']):\n        with open(paths['receiptPath']) as stream:\n            receipt = json.load(stream)\n    print(json.dumps({'receipt': receipt, 'calls': calls, 'length': doc.Objects[0].values['Length'][1], 'source': request['undoSource'], 'input': {key: value for key, value in request.items() if key not in ('operation', 'timeoutMs', 'undoSource')}, 'observers': len(App.observers) + len(Gui.observers)}))`,
    ],
    { timeout: 10_000, maxBuffer: 100_000 },
  );
  return JSON.parse(result.stdout);
}

test("受控撤销只调用一次原生undo并核对历史及完整属性结果", async () => {
  const result = await runUndo();
  const receipt = cadGuiUndoOperationReceiptSchema.parse(result.receipt);
  expect(receipt).toMatchObject({
    outcome: "undone",
    undoStarted: true,
    undoObserved: true,
    historyVerified: true,
    transactionName: "KFW CAD d875c286-cb7c-41ba-947b-59616005b9a6",
    changes: [
      {
        objectName: "Box",
        propertyName: "Length",
        before: 25,
        observed: 10,
        changed: true,
      },
    ],
  });
  expect(result).toMatchObject({ calls: ["undo"], length: 10, observers: 0 });
});

test("源完成快照后发生变化，即使新检查值正确也不得刷新后撤销", async () => {
  const result = await runUndo(`
bridge.application_revision += 2
bridge.record['revision'] += 2
request['expectedApplicationRevision'] = bridge.application_revision
request['expectedDocumentRevision'] = bridge.record['revision']
`);
  expect(cadGuiUndoOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    undoStarted: false,
  });
  expect(result).toMatchObject({ calls: [], length: 25, observers: 0 });
});

test("公开输入拒绝模型提供证明及路径，内部证明必须来自完整成功记录", async () => {
  const result = await runUndo();
  expect(cadGuiUndoOperationInputSchema.parse(result.input)).toEqual(
    result.input,
  );
  expect(cadGuiUndoSourceSchema.parse(result.source)).toEqual(result.source);
  for (const extra of [
    { undoSource: result.source },
    { proof: result.source.receipt },
    { source: "doc.undo()" },
    { path: "/tmp/result.FCStd" },
    { objectNames: ["Box"] },
  ]) {
    expect(
      cadGuiUndoOperationInputSchema.safeParse({ ...result.input, ...extra })
        .success,
    ).toBe(false);
  }
  const oldReceipt = structuredClone(result.source);
  delete oldReceipt.receipt.undoProvenance;
  expect(cadGuiUndoSourceSchema.safeParse(oldReceipt).success).toBe(false);
});

test.each([
  ["空历史", "doc.UndoNames = []", "history_changed"],
  ["后续事务", "doc.UndoNames.insert(0, '用户后续事务')", "history_changed"],
  [
    "相同数量但更深历史变化",
    "doc.UndoNames[1] = '更改后的旧事务'",
    "history_changed",
  ],
  ["Redo历史变化", "doc.RedoNames = ['用户Redo事务']", "history_changed"],
  [
    "原生计数无法对账",
    "NativeDocument.UndoCount = property(lambda self: len(self.UndoNames) + 1)",
    "history_changed",
  ],
  [
    "当前值变化",
    "doc.Objects[0].values['Length'] = ('App::PropertyFloat', 30.0)",
    "value_changed",
  ],
  [
    "旧回执无证明",
    "source_receipt.pop('undoProvenance')",
    "invalid_undo_source",
  ],
  [
    "原操作值证明不一致",
    "source_receipt['changes'][0]['before'] = 11",
    "invalid_undo_source",
  ],
  [
    "原应用身份不一致",
    "request['application'] = dict(application, launchedAt=2000)",
    "invalid_undo_source",
  ],
  ["原生事务正在使用", "App.active = ('用户事务', 4)", "document_busy"],
  ["正在重算", "doc.Recomputing = True", "document_busy"],
  [
    "正在编辑",
    "Gui.getDocument = lambda name: types.SimpleNamespace(Modified=True, getInEdit=lambda: object(), Transacting=False)",
    "document_busy",
  ],
  [
    "GUI事务正在使用",
    "Gui.getDocument = lambda name: types.SimpleNamespace(Modified=True, getInEdit=lambda: None, Transacting=True)",
    "document_busy",
  ],
  ["重算被冻结", "doc.RecomputesFrozen = True", "document_busy"],
  ["Undo已关闭", "doc.UndoMode = 0", "document_busy"],
  [
    "已有已加载incoming引用",
    "doc.InList = ['Other']",
    "incoming_external_reference",
  ],
  [
    "取消先于执行",
    "original_prepare = prepare\ndef prepare(directory):\n    paths = original_prepare(directory)\n    open(paths['cancelledPath'], 'w').close()\n    return paths",
    "cancelled",
  ],
  [
    "操作已经过期",
    "original_prepare = prepare\ndef prepare(directory):\n    paths = original_prepare(directory)\n    with open(paths['manifestPath']) as stream:\n        manifest = json.load(stream)\n    manifest['preparedAt'] = 0\n    with open(paths['manifestPath'], 'w') as stream:\n        json.dump(manifest, stream)\n    return paths",
    "operation_expired",
  ],
])("%s在原生undo前拒绝，保留原场景", async (_name, setup, reason) => {
  const result = await runUndo(setup);
  expect(cadGuiUndoOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    undoStarted: false,
    undoObserved: false,
    historyVerified: false,
    reason,
  });
  expect(result).toMatchObject({ calls: [], observers: 0 });
});

test.each([
  [
    "未信号化的往返修改",
    "bridge.application_revision += 2\nbridge.record['revision'] += 2",
  ],
  ["桥代际已替换", "bridge.epoch = '4c2579b0-8815-4f79-baa8-3948a355398c'"],
  ["活动文档已切换", "App.ActiveDocument = None"],
  ["当前文档已有事务", "doc.HasPendingTransaction = True"],
])("%s不能使用旧完成快照", async (_name, setup) => {
  const result = await runUndo(setup);
  expect(cadGuiUndoOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    undoStarted: false,
  });
  expect(result).toMatchObject({ calls: [], length: 25, observers: 0 });
});

test.each([
  ["Undo历史移除不精确", "doc.UndoNames.append('意外残留')", "history_changed"],
  ["Redo历史新增不精确", "doc.RedoNames.append('意外残留')", "history_changed"],
  [
    "实际值未恢复",
    "doc.Objects[0].values['Length'] = ('App::PropertyFloat', 11.0)",
    "undo_value_unconfirmed",
  ],
  [
    "未声明属性变化",
    "doc.Objects[0].change('Note', '意外修改')",
    "interference_detected",
  ],
  [
    "发生其它文档事件",
    "App.emit('slotCreatedDocument', doc)",
    "interference_detected",
  ],
  ["原生Undo仍留下事务", "doc.HasPendingTransaction = True", "document_busy"],
  ["原对象被替换", "doc.Objects = [NativeObject()]", "stale_target"],
  [
    "取消发生在执行后",
    "open(paths['cancelledPath'], 'w').close()",
    "cancelled",
  ],
])("%s保留现场并报告partial，绝不补偿或重算", async (_name, effect, reason) => {
  const result = await runUndo(`
original_undo = doc.undo
def undo():
    original_undo()
${effect
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
doc.undo = undo
`);
  expect(cadGuiUndoOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    undoStarted: true,
    reason,
  });
  expect(result).toMatchObject({ calls: ["undo"], observers: 0 });
});

test("没有目标UndoDocument信号不能根据返回None或值变化宣称撤销成功", async () => {
  const result = await runUndo(`
original_emit = App.emit
def emit(name, *args):
    if name != 'slotUndoDocument':
        original_emit(name, *args)
App.emit = emit
`);
  expect(cadGuiUndoOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    undoStarted: true,
    undoObserved: false,
    historyVerified: false,
    reason: "undo_unconfirmed",
  });
  expect(result).toMatchObject({ calls: ["undo"], length: 10, observers: 0 });
});

test("原生undo内部临时事务允许正常结束，既定派生及view变化可观察", async () => {
  const result = await runUndo(`
original_undo = doc.undo
def undo():
    doc.Transacting, doc.HasPendingTransaction = True, True
    for name in ('AddSubShape', 'Placement', 'Direction', 'SuppressedShape'):
        App.emit('slotBeforeChangeObject', doc.Objects[0], name)
        App.emit('slotChangedObject', doc.Objects[0], name)
    original_undo()
    doc.Transacting, doc.HasPendingTransaction = False, False
doc.undo = undo
`);
  expect(cadGuiUndoOperationReceiptSchema.parse(result.receipt).outcome).toBe(
    "undone",
  );
  expect(result).toMatchObject({ calls: ["undo"], length: 10, observers: 0 });
});

test("全批包含原值不变项，成功回执仍覆盖每一对属性", async () => {
  const result = await runUndo(`
source_input['changes'].append({'objectName': 'Box', 'propertyName': 'Note', 'expectedValue': '说明', 'value': '说明'})
source_receipt['changes'].append({'objectName': 'Box', 'propertyName': 'Note', 'before': '说明',
                                  'requested': '说明', 'observed': '说明', 'changed': False})
`);
  const receipt = cadGuiUndoOperationReceiptSchema.parse(result.receipt);
  expect(receipt.outcome).toBe("undone");
  expect(receipt.changes).toEqual([
    {
      objectName: "Box",
      propertyName: "Length",
      before: 25,
      observed: 10,
      changed: true,
    },
    {
      objectName: "Box",
      propertyName: "Note",
      before: "说明",
      observed: "说明",
      changed: false,
    },
  ]);
  expect(result).toMatchObject({ calls: ["undo"], observers: 0 });
});

test("同一操作重复请求复用落盘回执，丢失ACK也不重发已claim撤销", async () => {
  const replay = await runUndo("", "_kfw_cad_undo_operation(paths)");
  expect(cadGuiUndoOperationReceiptSchema.parse(replay.receipt).outcome).toBe(
    "undone",
  );
  expect(replay).toMatchObject({ calls: ["undo"], length: 10, observers: 0 });
  const lost = await runUndo(
    "",
    "os.unlink(paths['receiptPath'])\n_kfw_cad_undo_operation(paths)",
  );
  expect(lost).toMatchObject({
    receipt: null,
    calls: ["undo"],
    length: 10,
    observers: 0,
  });
});

test("其它文档有事务时拒绝，正常其它文档在撤销前后保持状态", async () => {
  const setup = `
other = NativeDocument()
other.Name, other.Label = 'Other', '其它文档'
documents[other.Name] = other
`;
  const busy = await runUndo(`${setup}\nother.HasPendingTransaction = True`);
  expect(cadGuiUndoOperationReceiptSchema.parse(busy.receipt)).toMatchObject({
    outcome: "rejected",
    reason: "document_busy",
  });
  expect(busy.calls).toEqual([]);
  const normal = await runUndo(setup);
  expect(cadGuiUndoOperationReceiptSchema.parse(normal.receipt).outcome).toBe(
    "undone",
  );
  const changed = await runUndo(`${setup}
original_undo = doc.undo
def undo():
    original_undo()
    other.Label = '意外改名'
doc.undo = undo
`);
  expect(cadGuiUndoOperationReceiptSchema.parse(changed.receipt)).toMatchObject(
    {
      outcome: "partial",
      reason: "source_state_changed",
    },
  );
  expect(changed.calls).toEqual(["undo"]);
});

test("持久XML发现其他文档incoming链接；目标outgoing读取依赖不一概封禁", async () => {
  const incoming = await runUndo(`
doc.FileName = '/tmp/kfw-target.FCStd'
source_receipt['snapshot']['document']['fileName'] = doc.FileName
other = NativeDocument()
other.Name, other.FileName = 'Other', '/tmp/nonexistent-owner.FCStd'
obj = other.Objects[0]
obj.values['Link'] = ('App::PropertyXLink', None)
obj.PropertiesList.append('Link')
obj.linkFiles['Link'] = 'kfw-target.FCStd'
documents[other.Name] = other
`);
  expect(
    cadGuiUndoOperationReceiptSchema.parse(incoming.receipt),
  ).toMatchObject({
    outcome: "rejected",
    reason: "incoming_external_reference",
    undoStarted: false,
  });
  expect(incoming.calls).toEqual([]);
  const outgoing = await runUndo(`
doc.OutList = ['Other']
obj = doc.Objects[0]
obj.values['Link'] = ('App::PropertyXLink', None)
obj.PropertiesList.append('Link')
obj.linkFiles['Link'] = '/tmp/external.FCStd'
`);
  expect(cadGuiUndoOperationReceiptSchema.parse(outgoing.receipt).outcome).toBe(
    "undone",
  );
  expect(outgoing.calls).toEqual(["undo"]);
});
