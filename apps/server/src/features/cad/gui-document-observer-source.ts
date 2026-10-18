/** 固定进程内观察器；仅保留文档打开身份和观察计数，不授予编辑权限。 */
export const CAD_GUI_DOCUMENT_OBSERVER_SOURCE = `
import builtins as _kfw_cad_builtins
import uuid as _kfw_cad_uuid

_KFW_CAD_BRIDGE_KEY = '__kfw_cad_document_observer_v2__'
_KFW_CAD_BRIDGE_PROTOCOL = 'kfw-cad-document-observer/1'
_KFW_CAD_MAX_REVISION = 9007199254740991


class _KfwCadDocumentBridge:
    def __init__(self, app, gui):
        self.protocol = _KFW_CAD_BRIDGE_PROTOCOL
        self.app = app
        self.gui = gui
        self.epoch = str(_kfw_cad_uuid.uuid4())
        self.application_revision = 0
        self.documents = {}
        self.observed = False
        self.valid = True
        self.app_registered = False
        self.gui_registered = False
        self.app_observer = _KfwCadAppObserver(self)
        self.gui_observer = _KfwCadGuiObserver(self)

    def install(self):
        self.app.addDocumentObserver(self.app_observer)
        self.app_registered = True
        self.gui.addDocumentObserver(self.gui_observer)
        self.gui_registered = True

    def dispose(self):
        self.valid = False
        self.documents.clear()
        for module, attribute, observer in (
                (self.app, 'app_registered', self.app_observer),
                (self.gui, 'gui_registered', self.gui_observer)):
            if getattr(self, attribute):
                try:
                    module.removeDocumentObserver(observer)
                    setattr(self, attribute, False)
                except BaseException:
                    pass
        return not self.app_registered and not self.gui_registered

    def require_valid(self):
        if not self.valid:
            raise RuntimeError('document observer invalid')

    def advance(self, value):
        if value >= _KFW_CAD_MAX_REVISION:
            self.valid = False
            raise RuntimeError('document observation exhausted')
        return value + 1

    def application_event(self, *unused):
        self.application_revision = self.advance(self.application_revision)

    def find(self, doc):
        record = self.documents.get(id(doc))
        return record if record is not None and record['object'] is doc else None

    def listed(self, doc):
        return any(current is doc for current in self.app.listDocuments().values())

    def register(self, doc):
        record = self.find(doc)
        if record is not None:
            return None if record['closed'] else record
        if not self.listed(doc):
            return None
        record = {'object': doc, 'closed': False, 'handle': str(_kfw_cad_uuid.uuid4()),
                  'revision': 0, 'metadata': None}
        self.documents[id(doc)] = record
        return record

    def document_event(self, doc, *unused):
        self.application_event()
        if doc is None:
            return
        record = self.register(doc)
        if record is not None and self.listed(doc):
            record['revision'] = self.advance(record['revision'])

    def created_document(self, doc, *unused):
        # clearDocument 可复用同一wrapper；只有显式 Created 允许开启新的文档代际。
        record = self.find(doc)
        if record is not None and record['closed']:
            del self.documents[id(doc)]
        self.document_event(doc, *unused)

    def deleted_document(self, doc, *unused):
        # 此信号可能发生在原生 DocMap 删除前。先墓碑，不枚举、不读失效代理。
        record = self.find(doc)
        if record is None:
            record = {'object': doc, 'closed': True, 'handle': None,
                      'revision': 0, 'metadata': None}
            self.documents[id(doc)] = record
            was_open = False
        else:
            was_open = not record['closed']
            record['closed'] = True
        self.application_event()
        if was_open:
            record['revision'] = self.advance(record['revision'])

    def reconcile(self, current):
        for key, record in list(self.documents.items()):
            if any(doc is record['object'] for doc in current):
                continue
            if not record['closed']:
                record['closed'] = True
                self.application_event()
            # 原对象已不在清单；释放代理，旧handle不再位于活动表，也不会重新签发。
            del self.documents[key]

    def snapshot(self):
        self.require_valid()
        current = self.app.listDocuments()
        self.reconcile(list(current.values()))
        rows = []
        records = []
        for name, doc in current.items():
            existed = self.find(doc) is not None
            record = self.register(doc)
            if record is None or not self.listed(doc):
                continue
            if not existed and self.observed:
                self.application_event()
            metadata = {'name': name, 'label': doc.Label, 'fileName': doc.FileName,
                        'uid': str(doc.Uid), 'modified': bool(self.gui.getDocument(name).Modified),
                        'touched': bool(doc.isTouched()),
                        'pendingTransaction': bool(doc.HasPendingTransaction),
                        'active': doc is self.app.ActiveDocument}
            if record['metadata'] is not None and record['metadata'] != metadata:
                record['revision'] = self.advance(record['revision'])
                self.application_event()
            record['metadata'] = metadata.copy()
            rows.append(dict(metadata, documentHandle=record['handle'], revision=record['revision']))
            records.append(record)
        self.require_valid()
        for record in records:
            if record['closed'] or not self.listed(record['object']):
                raise RuntimeError('document changed during observation')
        self.observed = True
        return {'bridgeEpoch': self.epoch, 'applicationRevision': self.application_revision,
                'documents': rows}


class _KfwCadAppObserver:
    def __init__(self, bridge):
        self.bridge = bridge


class _KfwCadGuiObserver:
    def __init__(self, bridge):
        self.bridge = bridge


def _kfw_cad_observer_callback(action):
    def callback(self, *args):
        try:
            if self.bridge.valid:
                getattr(self.bridge, action)(*args)
        except BaseException:
            # FreeCAD会把逃逸的回调异常写到Report；此处仅使旧epoch失效。
            self.bridge.valid = False
    return callback


for _kfw_name in (
        'slotRelabelDocument', 'slotActivateDocument',
        'slotBeforeChangeDocument', 'slotChangedDocument',
        'slotBeforeRecomputeDocument', 'slotRecomputedDocument',
        'slotOpenTransaction', 'slotCommitTransaction', 'slotAbortTransaction',
        'slotUndoDocument', 'slotRedoDocument',
        'slotStartSaveDocument', 'slotFinishSaveDocument'):
    setattr(_KfwCadAppObserver, _kfw_name, _kfw_cad_observer_callback('document_event'))
setattr(_KfwCadAppObserver, 'slotCreatedDocument', _kfw_cad_observer_callback('created_document'))
setattr(_KfwCadAppObserver, 'slotDeletedDocument', _kfw_cad_observer_callback('deleted_document'))
for _kfw_name in (
        'slotCreatedObject', 'slotDeletedObject', 'slotBeforeChangeObject',
        'slotChangedObject', 'slotRecomputedObject', 'slotUndo', 'slotRedo',
        'slotBeforeCloseTransaction', 'slotCloseTransaction',
        'slotAppendDynamicProperty', 'slotRemoveDynamicProperty',
        'slotBeforeAddingDynamicExtension', 'slotAddedDynamicExtension'):
    setattr(_KfwCadAppObserver, _kfw_name, _kfw_cad_observer_callback('application_event'))
for _kfw_name in (
        'slotCreatedDocument', 'slotDeletedDocument', 'slotRelabelDocument',
        'slotRenameDocument', 'slotActivateDocument', 'slotCreatedObject',
        'slotDeletedObject', 'slotBeforeChangeObject', 'slotChangedObject',
        'slotInEdit', 'slotResetEdit'):
    # Gui回调可能携带正在销毁的代理。完全不解引用，只更新全局观察计数。
    setattr(_KfwCadGuiObserver, _kfw_name, _kfw_cad_observer_callback('application_event'))


def _kfw_cad_document_bridge(app, gui):
    bridge = getattr(_kfw_cad_builtins, _KFW_CAD_BRIDGE_KEY, None)
    if bridge is not None:
        if getattr(bridge, 'protocol', None) != _KFW_CAD_BRIDGE_PROTOCOL:
            raise RuntimeError('document observer protocol unavailable')
        if bridge.app is not app or bridge.gui is not gui:
            bridge.valid = False
        if bridge.valid:
            return bridge
        if not bridge.dispose():
            raise RuntimeError('previous document observer not detached')
    bridge = _KfwCadDocumentBridge(app, gui)
    setattr(_kfw_cad_builtins, _KFW_CAD_BRIDGE_KEY, bridge)
    try:
        bridge.install()
    except BaseException:
        bridge.valid = False
        bridge.dispose()
        raise
    return bridge
`;
