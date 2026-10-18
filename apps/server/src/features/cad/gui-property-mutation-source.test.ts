import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { CAD_GUI_DOCUMENT_OBSERVER_SOURCE } from "./gui-document-observer-source.js";
import {
  cadGuiOperationReceiptSchema,
  cadGuiSetPropertiesInputSchema,
} from "./gui-operation-contracts.js";
import { CAD_GUI_PROPERTY_MUTATION_SOURCE } from "./gui-property-mutation-source.js";
import { CAD_GUI_PROPERTY_INSPECTION_SOURCE } from "./gui-property-source.js";

const execute = promisify(execFile);
const fixtureSource = `
import hashlib, json, os, sys, tempfile, time, types

calls, writes = [], []
class Unit:
    Signature = (1, 0, 0, 0, 0, 0, 0, 0)

class Quantity:
    def __init__(self, value, unit=None):
        self.Value, self.Unit = float(value), unit or Unit()

class NativeObject:
    Name, Label, TypeId = 'Box', '盒子', 'Part::Box'
    def __init__(self, doc):
        self.doc = doc
        self.ViewObject = object()
        self.values = {
            'Length': ('App::PropertyLength', Quantity(10)),
            'Width': ('App::PropertyLength', Quantity(20)),
            'Note': ('App::PropertyString', '说明'),
            'ExpressionEngine': ('App::PropertyExpressionEngine', [('Width', 'Length * 2')]),
        }
        self.PropertiesList = list(self.values)
    def __getattr__(self, name):
        if name in self.values:
            return self.values[name][1]
        raise AttributeError(name)
    def __setattr__(self, name, value):
        if name not in self.__dict__.get('values', {}):
            object.__setattr__(self, name, value)
            return
        if App.active is not None and not self.doc.HasPendingTransaction:
            self.doc.HasPendingTransaction = True
            self.doc.UndoNames = [App.active[0]] + self.doc.UndoNames
            App.emit('slotOpenTransaction', self.doc, App.active[0])
        App.emit('slotBeforeChangeObject', self, name)
        type_id, previous = self.values[name]
        self.values[name] = (type_id, value if not isinstance(previous, Quantity) else
                             value if isinstance(value, Quantity) else Quantity(value))
        writes.append(name)
        App.emit('slotChangedObject', self, name)
    def getTypeIdOfProperty(self, name):
        return self.values[name][0]
    def getEditorMode(self, name):
        return []
    def getPropertyStatus(self, name):
        return []
    def getTypeOfProperty(self, name):
        return []
    def getPropertyByName(self, name, mode=0):
        return (self, self.values[name][1]) if mode == 2 else self.values[name][1]

class NativeDocument:
    Name, Label, FileName, Uid = 'Part', '零件', '', 'native-uid'
    HasPendingTransaction, UndoMode = False, 1
    Restoring = Partial = Importing = Recomputing = Transacting = False
    RecomputesFrozen = False
    def __init__(self):
        self.UndoNames = []
        self.Objects = [NativeObject(self)]
    def getObject(self, name):
        return next((obj for obj in self.Objects if obj.Name == name), None)
    def isTouched(self):
        return False
    def recompute(self):
        calls.append('recompute')
        App.emit('slotBeforeRecomputeDocument', self)
        self.Objects[0].Width = Quantity(self.Objects[0].Length.Value * 2)
        App.emit('slotRecomputedObject', self.Objects[0])
        App.emit('slotRecomputedDocument', self)
        return True
    def commitTransaction(self):
        calls.append('commit')
        App.active = None
        App.emit('slotBeforeCloseTransaction', False)
        self.HasPendingTransaction = False
        App.emit('slotCommitTransaction', self)
        App.emit('slotCloseTransaction', False)

class Application(types.ModuleType):
    def __init__(self):
        super().__init__('FreeCAD')
        self.observers, self.active = [], None
        self.Units = types.SimpleNamespace(Quantity=Quantity)
    def listDocuments(self):
        return {doc.Name: doc}
    def getActiveTransaction(self):
        return self.active
    def setActiveTransaction(self, name, persist=False):
        calls.append('begin')
        self.active = (name, 91)
        return 91
    def addDocumentObserver(self, observer):
        self.observers.append(observer)
    def removeDocumentObserver(self, observer):
        self.observers.remove(observer)
    def emit(self, name, *args):
        bridge.application_revision += 1
        if name in ('slotOpenTransaction', 'slotCommitTransaction', 'slotBeforeRecomputeDocument', 'slotRecomputedDocument'):
            bridge.record['revision'] += 1
        for observer in tuple(self.observers):
            callback = getattr(observer, name, None)
            if callback is not None:
                callback(*args)

App = Application()
doc = NativeDocument()
App.ActiveDocument = doc
Gui = types.ModuleType('FreeCADGui')
Gui.observers = []
Gui.addDocumentObserver = Gui.observers.append
Gui.removeDocumentObserver = Gui.observers.remove
Gui.getDocument = lambda name: types.SimpleNamespace(Modified=True, getObject=lambda name: doc.getObject(name).ViewObject)
Gui.activeDocument = lambda: Gui.getDocument(doc.Name)
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
                               'pendingTransaction': doc.HasPendingTransaction, 'active': True,
                               'documentHandle': self.record['handle'], 'revision': self.record['revision']}]}
    def require_valid(self):
        assert self.valid
    def find(self, target):
        return self.record if target is doc else None
    def listed(self, target):
        return target is doc

bridge = Bridge()
_kfw_cad_document_bridge = lambda app, gui: bridge
request = {
    'operation': 'set-properties', 'operationId': 'b357cc8d-e5a1-4a3e-b23f-c145e99f163d',
    'application': {'pid': os.getpid(), 'bundleId': 'org.freecad.FreeCAD', 'name': 'FreeCAD',
                    'bundlePath': '/Applications/FreeCAD.app',
                    'executablePath': '/Applications/FreeCAD.app/Contents/Resources/bin/freecad',
                    'launchedAt': 1000, 'birth': {'startSeconds': 1, 'startMicroseconds': 2}},
    'bridgeEpoch': bridge.epoch, 'documentHandle': bridge.record['handle'],
    'expectedApplicationRevision': 2, 'expectedDocumentRevision': 3,
    'changes': [{'objectName': 'Box', 'propertyName': 'Length',
                 'expectedValue': {'kind': 'quantity', 'value': 10, 'unitSignature': list(Unit.Signature)},
                 'value': {'kind': 'quantity', 'value': 25, 'unitSignature': list(Unit.Signature)}}],
    'recompute': True, 'timeoutMs': 10000,
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
    for path, content in ((paths['requestPath'], raw + b'\\n'),
                          (paths['manifestPath'], json.dumps(manifest).encode('utf-8')),
                          (paths['macroPath'], b'fixed source'),
                          (paths['dispatchClaimPath'], b'host-claimed\\n')):
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
      `${CAD_GUI_DOCUMENT_OBSERVER_SOURCE}\n${CAD_GUI_PROPERTY_INSPECTION_SOURCE}\n${CAD_GUI_PROPERTY_MUTATION_SOURCE}\n${fixtureSource}\n${source}`,
    ],
    { timeout: 10_000, maxBuffer: 100_000 },
  );
  return JSON.parse(result.stdout);
}

async function runMutation(setup = "", after = "") {
  return evaluate(`
${setup}
with tempfile.TemporaryDirectory() as directory:
    paths = prepare(directory)
    tracked = doc.Objects[0]
    _kfw_cad_set_properties(paths)
${after
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
    receipt = None
    if os.path.exists(paths['receiptPath']):
        with open(paths['receiptPath']) as stream:
            receipt = json.load(stream)
    print(json.dumps({'receipt': receipt, 'calls': calls, 'writes': writes,
                      'length': tracked.values['Length'][1].Value,
                      'width': tracked.values['Width'][1].Value,
                      'active': App.active, 'pending': doc.HasPendingTransaction,
                      'claim': os.path.getsize(paths['executionClaimPath']),
                      'observers': len(App.observers) + len(Gui.observers)}))
`);
}

test("固定属性编辑真正赋值重算并提交，保留驱动关系且落持久回执", async () => {
  const result = await evaluate(`
with tempfile.TemporaryDirectory() as directory:
    paths = prepare(directory)
    _kfw_cad_set_properties(paths)
    with open(paths['receiptPath']) as stream:
        receipt = json.load(stream)
    print(json.dumps({'receipt': receipt, 'calls': calls, 'writes': writes,
                      'length': doc.Objects[0].Length.Value, 'width': doc.Objects[0].Width.Value,
                      'expressions': doc.Objects[0].ExpressionEngine,
                      'observers': len(App.observers) + len(Gui.observers)}))
`);
  const receipt = cadGuiOperationReceiptSchema.parse(result.receipt);
  expect(receipt).toMatchObject({
    outcome: "committed",
    mutationStarted: true,
    commitAttempted: true,
    commitObserved: true,
    transactionState: "none",
  });
  expect(result).toMatchObject({
    calls: ["begin", "recompute", "commit"],
    writes: ["Length", "Width"],
    length: 25,
    width: 50,
    expressions: [["Width", "Length * 2"]],
    observers: 0,
  });
});

test("相同值只返回no_op，不开事务、不重算或写入", async () => {
  const result = await runMutation(
    "request['changes'][0]['value']['value'] = 10",
  );
  expect(cadGuiOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "no_op",
    mutationStarted: false,
    commitAttempted: false,
    commitObserved: false,
    transactionState: "none",
    changes: [{ changed: false }],
  });
  expect(result).toMatchObject({
    calls: [],
    writes: [],
    pending: false,
    observers: 0,
  });
});

test.each([
  [
    "expected值过时",
    "request['changes'][0]['expectedValue']['value'] = 9",
    "value_changed",
  ],
  [
    "目标有绑定",
    "request['changes'][0].update(propertyName='Width', expectedValue=dict(request['changes'][0]['expectedValue'], value=20))",
    "expression_bound",
  ],
  [
    "只读属性",
    "NativeObject.getEditorMode = lambda self, name: ['ReadOnly'] if name == 'Length' else []",
    "read_only",
  ],
  [
    "Immutable属性",
    "NativeObject.getPropertyStatus = lambda self, name: ['Immutable', 21] if name == 'Length' else [21]",
    "immutable",
  ],
  [
    "维度不符",
    "request['changes'][0]['value']['unitSignature'] = [0, 0, 0, 0, 0, 0, 0, 1]",
    "invalid_property_value",
  ],
  [
    "对象缺失",
    "request['changes'][0]['objectName'] = 'Missing'",
    "object_missing",
  ],
  [
    "第二项无效",
    "request['changes'].append(dict(objectName='Box', propertyName='Missing', expectedValue=1, value=2))",
    "unsupported_property",
  ],
  ["文档已有事务", "App.active = ('用户事务', 77)", "document_busy"],
])("%s在全批preflight拒绝，任何属性都未写入", async (_label, setup, reason) => {
  const result = await runMutation(setup);
  expect(cadGuiOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    reason,
    mutationStarted: false,
    commitAttempted: false,
    changes: [],
  });
  expect(result).toMatchObject({
    calls: [],
    writes: [],
    length: 10,
    width: 20,
    observers: 0,
  });
});

test("原生夹取不能冒充成功，保留自己的待提交事务与实际读回值", async () => {
  const result = await runMutation(`
original_setter = NativeObject.__setattr__
def clamping(self, name, value):
    if name == 'Length' and isinstance(value, Quantity):
        value = Quantity(min(value.Value, 20))
    original_setter(self, name, value)
NativeObject.__setattr__ = clamping
`);
  expect(cadGuiOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    reason: "property_not_applied",
    mutationStarted: true,
    commitAttempted: false,
    transactionState: "own_pending",
    changes: [{ observed: { kind: "quantity", value: 20 }, changed: true }],
  });
  expect(result).toMatchObject({
    calls: ["begin"],
    writes: ["Length"],
    pending: true,
    observers: 0,
  });
});

test("明确关闭recompute时仍提交实际写入，表达式留待后续重算", async () => {
  const result = await runMutation("request['recompute'] = False");
  expect(cadGuiOperationReceiptSchema.parse(result.receipt).outcome).toBe(
    "committed",
  );
  expect(result).toMatchObject({
    calls: ["begin", "commit"],
    length: 25,
    width: 20,
  });
});

test("重复固定宏只执行一次，已发布回执不会被改写", async () => {
  const result = await runMutation(
    "",
    `
with open(paths['receiptPath'], 'rb') as stream:
    first_receipt = stream.read()
_kfw_cad_set_properties(paths)
with open(paths['receiptPath'], 'rb') as stream:
    assert stream.read() == first_receipt
`,
  );
  expect(cadGuiOperationReceiptSchema.parse(result.receipt).outcome).toBe(
    "committed",
  );
  expect(result).toMatchObject({
    calls: ["begin", "recompute", "commit"],
    writes: ["Length", "Width"],
  });
  expect(result.claim).toBeGreaterThan(0);
});

test("提交后无法落盘回执时不执行第二次，也不撤销或关闭用户应用", async () => {
  const result = await runMutation(
    `
original_publish = _kfw_cad_publish_operation_file
def failing_receipt(path, content):
    if path.endswith('receipt.json'):
        raise OSError('disk unavailable')
    return original_publish(path, content)
_kfw_cad_publish_operation_file = failing_receipt
`,
    "_kfw_cad_set_properties(paths)",
  );
  expect(result).toMatchObject({
    receipt: null,
    calls: ["begin", "recompute", "commit"],
    writes: ["Length", "Width"],
    pending: false,
    observers: 0,
  });
});

test("commit回调开始的后来事务不会被工具关闭", async () => {
  const result = await runMutation(`
original_commit = doc.commitTransaction
def reenter_commit():
    original_commit()
    App.setActiveTransaction('later-user-transaction', True)
doc.commitTransaction = reenter_commit
`);
  expect(cadGuiOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    reason: "transaction_changed",
    commitAttempted: true,
    commitObserved: true,
    transactionState: "changed",
  });
  expect(result.active[0]).toBe("later-user-transaction");
  expect(result.calls).toEqual(["begin", "recompute", "commit", "begin"]);
});

test("recompute中的未声明输入修改标为partial并保留现场", async () => {
  const result = await runMutation(`
original_recompute = doc.recompute
def interfering_recompute():
    result = original_recompute()
    doc.Objects[0].Note = '用户迟到编辑'
    return result
doc.recompute = interfering_recompute
`);
  expect(cadGuiOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    reason: "interference_detected",
    commitAttempted: false,
    transactionState: "own_pending",
  });
  expect(result).toMatchObject({
    calls: ["begin", "recompute"],
    pending: true,
    observers: 0,
  });
});

test.each(["missing", "symlink"])(
  "setter之后控制request变为%s时立即停止，不重算、提交或撤销",
  async (replacement) => {
    const result = await runMutation(`
original_setter = NativeObject.__setattr__
def losing_control(self, name, value):
    original_setter(self, name, value)
    if name == 'Length':
        os.unlink(paths['requestPath'])
        if ${JSON.stringify(replacement)} == 'symlink':
            os.symlink(paths['manifestPath'], paths['requestPath'])
NativeObject.__setattr__ = losing_control
`);
    expect(cadGuiOperationReceiptSchema.parse(result.receipt)).toMatchObject({
      outcome: "partial",
      reason: "operation_control_lost",
      mutationStarted: true,
      commitAttempted: false,
      transactionState: "unknown",
    });
    expect(result).toMatchObject({
      calls: ["begin"],
      writes: ["Length"],
      length: 25,
      width: 20,
      pending: true,
      observers: 0,
    });
  },
);

test("迟到取消和过期宏不接触文档或写入属性", async () => {
  for (const setup of [
    "with open(paths['cancelledPath'], 'w') as stream:\n    stream.write('cancelled')",
    "with open(paths['manifestPath']) as stream:\n    manifest = json.load(stream)\nmanifest['preparedAt'] -= 20000\nwith open(paths['manifestPath'], 'w') as stream:\n    json.dump(manifest, stream)",
  ]) {
    const result = await evaluate(`
with tempfile.TemporaryDirectory() as directory:
    paths = prepare(directory)
${setup
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
    _kfw_cad_set_properties(paths)
    with open(paths['receiptPath']) as stream:
        receipt = json.load(stream)
    print(json.dumps({'receipt': receipt, 'calls': calls, 'writes': writes}))
`);
    expect(cadGuiOperationReceiptSchema.parse(result.receipt)).toMatchObject({
      outcome: "rejected",
      mutationStarted: false,
      reason: expect.stringMatching(/^(cancelled|operation_expired)$/u),
    });
    expect(result).toMatchObject({ calls: [], writes: [] });
  }
});

test("超过回执协议长度的请求在读取文档前以小型rejected回执拒绝", async () => {
  const result = await runMutation(`
request['changes'] = [dict(objectName='Box', propertyName='Note', expectedValue='x' * 25000, value='y' * 25000)]
def unexpected_document_read(app, gui):
    raise AssertionError('document must not be read')
_kfw_cad_document_bridge = unexpected_document_read
`);
  expect(cadGuiOperationReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    reason: "receipt_too_large",
    changes: [],
    mutationStarted: false,
  });
  expect(result).toMatchObject({ calls: [], writes: [] });
});

test("写入参数规范化编号和默认重算，拒绝重复属性及任意代码", async () => {
  const request = await evaluate("print(json.dumps(request))");
  const {
    operation: _operation,
    timeoutMs: _timeout,
    recompute: _recompute,
    ...input
  } = request;
  const parsed = cadGuiSetPropertiesInputSchema.parse({
    ...input,
    operationId: input.operationId.toUpperCase(),
  });
  expect(parsed.operationId).toBe(input.operationId);
  expect(parsed.recompute).toBe(true);
  for (const invalid of [
    { ...input, changes: [...input.changes, ...input.changes] },
    { ...input, source: "unsafe()" },
    { ...input, changes: [] },
  ]) {
    expect(cadGuiSetPropertiesInputSchema.safeParse(invalid).success).toBe(
      false,
    );
  }
});
