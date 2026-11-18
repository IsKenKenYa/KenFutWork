/** GUI 文档操作的共用原生仿真对象；copy/save 测试不另建重复模型。 */
export const CAD_GUI_DOCUMENT_TEST_FIXTURE = String.raw`
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
