import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { CAD_GUI_DOCUMENT_OBSERVER_SOURCE } from "./gui-document-observer-source.js";
import {
  cadGuiSaveDocumentInputSchema,
  cadGuiSaveDocumentReceiptSchema,
} from "./gui-document-save-contracts.js";
import { CAD_GUI_DOCUMENT_SAVE_SOURCE } from "./gui-document-save-source.js";
import { CAD_GUI_DOCUMENT_TEST_FIXTURE } from "./gui-document-source-test-fixture.js";
import { CAD_GUI_PROPERTY_MUTATION_SOURCE } from "./gui-property-mutation-source.js";
import { CAD_GUI_PROPERTY_INSPECTION_SOURCE } from "./gui-property-source.js";

const execute = promisify(execFile);
const saveFixture = `
import stat

save_returned = False
preferences = {'BackupPolicy': True, 'CreateBackupFiles': True, 'CountBackupFiles': 1,
               'UseFCBakExtension': True, 'SaveBackupDateFormat': '%Y%m%d-%H%M%S'}
class DocumentParameters:
    def GetBool(self, name, default):
        return preferences.get(name, default)
    def GetInt(self, name, default):
        return preferences.get(name, default)
    def GetString(self, name, default):
        return preferences.get(name, default)
    def SetBool(self, *args):
        raise AssertionError('save must not change native preferences')
    SetInt = SetString = SetBool

def parameters(path):
    assert path == 'User parameter:BaseApp/Preferences/Document'
    return DocumentParameters()
App.ParamGet = parameters
App.ActiveDocument = doc
gui_documents = {
    target.Name: types.SimpleNamespace(Document=target, Modified=True, Transacting=False, getInEdit=lambda: None)
    for target in (doc, other)
}
Gui.getDocument = lambda name: gui_documents[name]
Gui.activeDocument = lambda: gui_documents[App.ActiveDocument.Name]

original_snapshot = bridge.snapshot
def current_snapshot():
    value = original_snapshot()
    for row in value['documents']:
        row['active'] = App.ActiveDocument is doc
        row['modified'] = gui_documents[doc.Name].Modified
    return value
bridge.snapshot = current_snapshot

def forbidden(*args, **kwargs):
    raise AssertionError('save must not use SaveAs/GUI command/undo/recompute')
NativeDocument.saveAs = forbidden
NativeDocument.saveCopy = forbidden
NativeDocument.undo = NativeDocument.redo = NativeDocument.clearUndos = forbidden
Gui.runCommand = Gui.saveDocument = forbidden

def write_project(path, stage='after', gui=True):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr('Document.xml', '<Document stage="' + stage + '"/>')
        if gui:
            archive.writestr('GuiDocument.xml', '<GuiDocument/>')
        archive.writestr('data.bin', b'actual member bytes')

def native_save(self):
    global save_returned
    calls.append(['save', self.FileName])
    try:
        assert not os.path.exists(paths['receiptPath']), 'ACK preceded native save'
        App.emit('slotStartSaveDocument', self)
        self.LastModifiedDate = 'native save changed metadata'
        App.emit('slotChangedDocument', self, 'LastModifiedDate')
        # Finish event deliberately precedes the bytes: it is not a completion oracle.
        App.emit('slotFinishSaveDocument', self)
        assert not os.path.exists(paths['receiptPath']), 'Finish event was treated as write completion'
        write_project(self.FileName)
        return None
    finally:
        save_returned = True
NativeDocument.save = native_save

def prepare_source(directory):
    source_directory = os.path.join(directory, 'source')
    os.mkdir(source_directory)
    filename = os.path.realpath(os.path.join(source_directory, 'project.FCStd'))
    write_project(filename, 'before')
    doc.FileName = filename
    request.pop('outputPath', None)
    request.update(operation='save-document', expectedFileName=filename,
                   canonicalPath=os.path.realpath(filename), writeRoots=[os.path.realpath(source_directory)])
    return filename

def file_summary(path):
    result = {'exists': os.path.lexists(path), 'regular': False, 'zipValid': False}
    if not result['exists']:
        return result
    info = os.lstat(path)
    result['regular'] = stat.S_ISREG(info.st_mode)
    if not result['regular']:
        return result
    with open(path, 'rb') as stream:
        data = stream.read()
    result.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            result['members'] = archive.namelist()
            result['zipValid'] = archive.testzip() is None
    except Exception as error:
        result['zipError'] = type(error).__name__
    return result
`;

function indent(value: string) {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

async function runSave({
  setup = "",
  beforePrepare = "",
  beforeDispatch = "",
  after = "",
}: {
  setup?: string;
  beforePrepare?: string;
  beforeDispatch?: string;
  after?: string;
} = {}) {
  const result = await execute(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `${CAD_GUI_DOCUMENT_OBSERVER_SOURCE}
${CAD_GUI_PROPERTY_INSPECTION_SOURCE}
${CAD_GUI_PROPERTY_MUTATION_SOURCE}
${CAD_GUI_DOCUMENT_SAVE_SOURCE}
${CAD_GUI_DOCUMENT_TEST_FIXTURE}
${saveFixture}
${setup}
with tempfile.TemporaryDirectory() as directory:
    source_path = prepare_source(directory)
${indent(beforePrepare)}
    paths = prepare(directory)
${indent(beforeDispatch)}
    before = file_summary(source_path)
    before_preferences = dict(preferences)
    original_doc = doc
    original_active_mutation = getattr(bridge, 'active_mutation', None)
    _kfw_cad_save_document(paths)
${indent(after)}
    receipt = None
    if os.path.exists(paths['receiptPath']):
        with open(paths['receiptPath']) as stream:
            receipt = json.load(stream)
    print(json.dumps({'receipt': receipt, 'calls': [kind for kind, path in calls],
                      'callPaths': [path for kind, path in calls], 'sourcePath': source_path,
                      'before': before, 'after': file_summary(source_path), 'saveReturned': save_returned,
                      'sameDocument': doc is original_doc, 'active': App.ActiveDocument.Name,
                      'filename': doc.FileName, 'uid': doc.Uid, 'label': doc.Label,
                      'undo': doc.UndoNames, 'redo': doc.RedoNames,
                      'modified': gui_documents[doc.Name].Modified, 'touched': doc.isTouched(),
                      'preferencesUnchanged': preferences == before_preferences,
                      'foreignMutationRetained': original_active_mutation is None or getattr(bridge, 'active_mutation', None) is original_active_mutation,
                      'observers': len(App.observers) + len(Gui.observers)}))
`,
    ],
    { timeout: 10_000, maxBuffer: 150_000 },
  );
  return JSON.parse(result.stdout);
}

const input = {
  application: {
    pid: 24,
    bundleId: "org.freecad.FreeCAD",
    name: "FreeCAD",
    bundlePath: "/Applications/FreeCAD.app",
    executablePath: "/Applications/FreeCAD.app/Contents/Resources/bin/freecad",
    launchedAt: 1000,
    birth: { startSeconds: 1, startMicroseconds: 2 },
  },
  bridgeEpoch: "b1ff2ef8-0854-40c9-9da8-c9ff07bfb219",
  documentHandle: "28686cba-59d6-44c3-a30c-bbca88a7d737",
  operationId: "b357cc8d-e5a1-4a3e-b23f-c145e99f163d",
  expectedApplicationRevision: 2,
  expectedDocumentRevision: 3,
  expectedFileName: "/projects/source.FCStd",
};

test("原位保存契约仅接收最新绝对FCStd路径，不公开另存或备份配置", () => {
  expect(cadGuiSaveDocumentInputSchema.parse(input)).toMatchObject(input);
  for (const expectedFileName of [
    "",
    "source.FCStd",
    "/projects/source.txt",
    "/projects/source.FCStd\n",
    "/projects/source\0.FCStd",
  ])
    expect(
      cadGuiSaveDocumentInputSchema.safeParse({ ...input, expectedFileName })
        .success,
    ).toBe(false);
  for (const extra of [
    { outputPath: "/projects/other.FCStd" },
    { backupDirectories: ["/backups"] },
    { canonicalPath: input.expectedFileName },
    { writeRoots: ["/projects"] },
    { objectNames: ["Box"] },
  ])
    expect(
      cadGuiSaveDocumentInputSchema.safeParse({ ...input, ...extra }).success,
    ).toBe(false);
});

test("回执必须确认原生写入已返回，saved必须有完整文件证据", () => {
  const receipt = {
    protocol: "kfw-cad-gui-save/1",
    operationId: input.operationId,
    fingerprint: "a".repeat(64),
    pid: 24,
    guiThread: true,
    completed: true,
    outcome: "saved",
    saveStarted: true,
    writeFinished: true,
    artifact: {
      canonicalPath: input.expectedFileName,
      size: 256,
      sha256: "b".repeat(64),
      hasGuiDocument: true,
    },
  };
  expect(cadGuiSaveDocumentReceiptSchema.safeParse(receipt).success).toBe(true);
  for (const changes of [
    { writeFinished: false },
    { writeFinished: undefined },
    { artifact: undefined },
    { saveStarted: false },
    { artifact: { ...receipt.artifact, hasGuiDocument: false } },
    { artifact: { ...receipt.artifact, canonicalPath: "source.FCStd" } },
  ])
    expect(
      cadGuiSaveDocumentReceiptSchema.safeParse({ ...receipt, ...changes })
        .success,
    ).toBe(false);
  expect(
    cadGuiSaveDocumentReceiptSchema.safeParse({
      ...receipt,
      outcome: "rejected",
      saveStarted: false,
    }).success,
  ).toBe(false);
  expect(
    cadGuiSaveDocumentReceiptSchema.safeParse({
      ...receipt,
      outcome: "partial",
      saveStarted: false,
    }).success,
  ).toBe(false);
});

test("App.save恰一次并校验真实ZIP，保留原位身份、历史与未清除的GUI脏标", async () => {
  const result = await runSave();
  expect(result.calls).toEqual(["save"]);
  const receipt = cadGuiSaveDocumentReceiptSchema.parse(result.receipt);
  expect(receipt).toMatchObject({
    outcome: "saved",
    saveStarted: true,
    writeFinished: true,
    artifact: {
      canonicalPath: result.sourcePath,
      size: result.after.size,
      sha256: result.after.sha256,
      hasGuiDocument: true,
    },
    snapshot: {
      document: { fileName: result.sourcePath, modified: true, active: true },
    },
  });
  expect(result.after).toMatchObject({
    zipValid: true,
    members: ["Document.xml", "GuiDocument.xml", "data.bin"],
  });
  expect(result.after.sha256).not.toBe(result.before.sha256);
  expect(result).toMatchObject({
    callPaths: [result.sourcePath],
    saveReturned: true,
    sameDocument: true,
    active: "Part",
    filename: result.sourcePath,
    uid: "uid-Part",
    label: "未保存工程",
    undo: ["用户原有操作"],
    redo: ["用户可重做操作"],
    modified: true,
    touched: true,
    preferencesUnchanged: true,
    observers: 0,
  });
});

test("相同operation重放复用回执，不再次调用save或重写源文件", async () => {
  const result = await runSave({
    after: `
with open(paths['receiptPath'], 'rb') as stream:
    first_receipt = stream.read()
first_file = file_summary(source_path)
_kfw_cad_save_document(paths)
with open(paths['receiptPath'], 'rb') as stream:
    assert stream.read() == first_receipt
assert file_summary(source_path) == first_file
`,
  });
  expect(result.calls).toEqual(["save"]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt).outcome).toBe(
    "saved",
  );
});

test.each([
  ["非活动文档", "App.ActiveDocument = other", "stale_target"],
  [
    "GUI活动目标不同",
    "Gui.activeDocument = lambda: gui_documents[other.Name]",
    "stale_target",
  ],
  ["陈旧文档修订", "bridge.record['revision'] += 1", "stale_target"],
  ["陈旧应用修订", "bridge.application_revision += 1", "stale_target"],
  ["待提交事务", "doc.HasPendingTransaction = True", "document_busy"],
  ["正在恢复", "doc.Restoring = True", "document_busy"],
  ["部分文档", "doc.Partial = True", "document_busy"],
  ["正在导入", "doc.Importing = True", "document_busy"],
  ["正在重算", "doc.Recomputing = True", "document_busy"],
  [
    "活动编辑",
    "gui_documents[doc.Name].getInEdit = lambda: object()",
    "document_busy",
  ],
  ["重入操作", "bridge.active_mutation = object()", "document_busy"],
  ["已加载外部依赖", "doc.OutList = [other]", "external_dependencies"],
  [
    "隐藏外部依赖",
    "doc.Objects = [NativePropertyObject('App::PropertyXLink', '<Content><XLink file=\"/outside/model.FCStd\" name=\"Box\"/></Content>')]",
    "external_dependencies",
  ],
])(
  "%s在写入前拒绝，原文件和配置保持",
  async (_label, beforeDispatch, reason) => {
    const result = await runSave({ beforeDispatch });
    expect(result.calls).toEqual([]);
    expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject(
      {
        outcome: "rejected",
        saveStarted: false,
        writeFinished: true,
        reason,
      },
    );
    expect(result.after).toEqual(result.before);
    expect(result).toMatchObject({
      preferencesUnchanged: true,
      foreignMutationRetained: true,
      observers: 0,
    });
  },
);

test.each([
  ["未保存工程", "doc.FileName = ''"],
  [
    "FileName已改变",
    "doc.FileName = os.path.join(directory, 'different.FCStd')",
  ],
  [
    "错误的宿主canonicalPath",
    "request['canonicalPath'] = os.path.join(directory, 'different.FCStd')",
  ],
  ["文件已删除", "os.unlink(source_path)"],
  ["目标变成目录", "os.unlink(source_path)\nos.mkdir(source_path)"],
  ["空写域", "request['writeRoots'] = []"],
  ["写域不覆盖目标", "request['writeRoots'] = [directory + '/elsewhere']"],
])("%s不能调用原生save", async (_label, beforePrepare) => {
  const result = await runSave({ beforePrepare });
  expect(result.calls).toEqual([]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    saveStarted: false,
    writeFinished: true,
    reason: "unsupported_save_target",
  });
  expect(result.after).toEqual(result.before);
  expect(result.preferencesUnchanged).toBe(true);
});

test.each([
  [
    "取消",
    "with open(paths['cancelledPath'], 'wb') as stream: stream.write(b'cancelled')",
    "cancelled",
  ],
  [
    "过期",
    "with open(paths['manifestPath']) as stream: manifest = json.load(stream)\nmanifest['preparedAt'] = 0\nwith open(paths['manifestPath'], 'w') as stream: json.dump(manifest, stream)",
    "operation_expired",
  ],
])("预检%s不开始写入", async (_label, beforeDispatch, reason) => {
  const result = await runSave({ beforeDispatch });
  expect(result.calls).toEqual([]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    saveStarted: false,
    writeFinished: true,
    reason,
  });
  expect(result.after).toEqual(result.before);
});

test("日期备份经过已有符号链接指向冻结目录外时拒绝，不改用户偏好", async () => {
  const result = await runSave({
    beforePrepare: `
outside = os.path.join(directory, 'outside')
os.mkdir(outside)
os.symlink(outside, os.path.join(os.path.dirname(source_path), 'project.archive'))
preferences['SaveBackupDateFormat'] = 'archive/%Y%m%d'
`,
  });
  expect(result.calls).toEqual([]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "rejected",
    saveStarted: false,
    writeFinished: true,
    reason: "unsupported_backup_path",
  });
  expect(result.after).toEqual(result.before);
  expect(result.preferencesUnchanged).toBe(true);
});

test.each([
  ["缺GUI成员", "write_project(self.FileName, gui=False)"],
  [
    "不是ZIP",
    "with open(self.FileName, 'wb') as stream: stream.write(b'not a project')",
  ],
  [
    "成员CRC损坏",
    "native_save(self)\nwith open(self.FileName, 'r+b') as stream:\n    content = stream.read()\n    offset = content.index(b'actual member bytes')\n    stream.seek(offset)\n    stream.write(b'ACTUAL')",
  ],
])("save返回后%s不能给saved回执", async (_label, body) => {
  const result = await runSave({
    setup: `
def invalid_save(self):
    global save_returned
${body.includes("native_save") ? "" : "    calls.append(['save', self.FileName])"}
    try:
${body
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
        return None
    finally:
        save_returned = True
NativeDocument.save = invalid_save
`,
  });
  expect(result.calls).toEqual(["save"]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    saveStarted: true,
    writeFinished: true,
    reason: "invalid_save_artifact",
  });
  expect(result.receipt).not.toHaveProperty("artifact");
  expect(result.saveReturned).toBe(true);
});

test("原生写入后抛错仍报告partial和writeFinished，不恢复文件、不重试", async () => {
  const result = await runSave({
    setup: `
def save_then_raise(self):
    native_save(self)
    raise RuntimeError('native save failed after writing')
NativeDocument.save = save_then_raise
`,
    after: "_kfw_cad_save_document(paths)",
  });
  expect(result.calls).toEqual(["save"]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    saveStarted: true,
    writeFinished: true,
    reason: "save_failed",
  });
  expect(result.after.sha256).not.toBe(result.before.sha256);
  expect(result.after.zipValid).toBe(true);
  expect(result).toMatchObject({
    saveReturned: true,
    filename: result.sourcePath,
    observers: 0,
  });
});

test("保存中的取消只在原生调用返回后给partial完成证据", async () => {
  const result = await runSave({
    setup: `
def save_then_cancel(self):
    native_save(self)
    with open(paths['cancelledPath'], 'wb') as stream:
        stream.write(b'cancelled')
NativeDocument.save = save_then_cancel
`,
  });
  expect(result.calls).toEqual(["save"]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    saveStarted: true,
    writeFinished: true,
    reason: "cancelled",
  });
  expect(result.saveReturned).toBe(true);
  expect(result.after.zipValid).toBe(true);
});

test("保存不清除或恢复GUI.Modified，回执保留原生最新观测", async () => {
  const result = await runSave({
    setup: `
def save_native_cleans(self):
    native_save(self)
    gui_documents[self.Name].Modified = False
NativeDocument.save = save_native_cleans
`,
  });
  expect(result.calls).toEqual(["save"]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "saved",
    writeFinished: true,
    snapshot: { document: { modified: false } },
  });
  expect(result.modified).toBe(false);
});

test("保存改写同计数历史时保留现场并报告partial", async () => {
  const result = await runSave({
    setup: `
def save_changes_history(self):
    native_save(self)
    self.UndoNames[0] = '被原生扩展改写的历史'
NativeDocument.save = save_changes_history
`,
  });
  expect(result.calls).toEqual(["save"]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    saveStarted: true,
    writeFinished: true,
    reason: "source_state_changed",
  });
  expect(result.undo).toEqual(["被原生扩展改写的历史"]);
});

test("保存回调中的普通参数新编辑保留并报告partial，不再次保存或补偿", async () => {
  const result = await runSave({
    setup: `
edited = NativePropertyObject('App::PropertyFloat')
edited.Name, edited.Document, edited.Length = 'EditedBox', doc, 1
edited.PropertiesList = ['Length']
doc.Objects = [edited]
NativeDocument.getObject = lambda self, name: next((obj for obj in self.Objects if obj.Name == name), None)
def save_with_new_edit(self):
    native_save(self)
    assert not os.path.exists(paths['receiptPath'])
    edited.Length = 2
    gui_documents[self.Name].Modified = True
    App.emit('slotChangedObject', edited, 'Length')
NativeDocument.save = save_with_new_edit
`,
    after: "assert edited.Length == 2, 'new user edit was compensated'",
  });
  expect(result.calls).toEqual(["save"]);
  expect(cadGuiSaveDocumentReceiptSchema.parse(result.receipt)).toMatchObject({
    outcome: "partial",
    saveStarted: true,
    writeFinished: true,
    reason: "interference_detected",
  });
  expect(result).toMatchObject({ saveReturned: true, modified: true });
  expect(result.after.zipValid).toBe(true);
});

test("坏指纹记录不写入，也不伪造writeFinished回执", async () => {
  const result = await runSave({
    beforeDispatch: `
with open(paths['requestPath'], 'ab') as stream:
    stream.write(b'changed')
`,
  });
  expect(result.calls).toEqual([]);
  expect(result.receipt).toBeNull();
  expect(result.after).toEqual(result.before);
});
