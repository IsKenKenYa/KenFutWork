import { CAD_GUI_DOCUMENT_FILE_SOURCE } from "./gui-document-file-source.js";

/** 固定文档副本入口；GUI 只写持久操作目录，Task 文件由宿主另行发布。 */
export const CAD_GUI_DOCUMENT_COPY_SOURCE =
  CAD_GUI_DOCUMENT_FILE_SOURCE +
  String.raw`


class _KfwCadCopyError(Exception):
    def __init__(self, code):
        self.code = code


def _kfw_cad_copy_record(paths):
    raw = _kfw_cad_read_operation_file(paths['requestPath'])
    manifest = _kfw_cad_json.loads(_kfw_cad_read_operation_file(paths['manifestPath']))
    request = _kfw_cad_json.loads(raw)
    if (not raw.endswith(b'\n') or manifest.get('version') != 1 or request.get('operation') != 'save-copy'
            or manifest.get('operationId') != request.get('operationId')
            or _kfw_cad_hashlib.sha256(raw[:-1]).hexdigest() != manifest.get('fingerprint')
            or request.get('application', {}).get('pid') != _kfw_cad_os.getpid()
            or type(manifest.get('preparedAt')) is not int or manifest['preparedAt'] < 0
            or type(request.get('timeoutMs')) is not int or not 0 < request['timeoutMs'] <= 2147483647):
        raise _KfwCadCopyError('invalid_operation_record')
    _kfw_cad_read_operation_file(paths['dispatchClaimPath'], _KFW_CAD_RECEIPT_LIMIT)
    return manifest, request


def _kfw_cad_copy_alive(ctx):
    bridge, doc = ctx['bridge'], ctx['copyDocument']
    if bridge is None or doc is None:
        return False
    record = bridge.find(doc)
    return (bridge.valid and bridge.epoch == ctx['request']['bridgeEpoch'] and record is not None
            and not record['closed'] and record['handle'] == ctx['request']['documentHandle']
            and bridge.listed(doc))


def _kfw_cad_copy_guard(ctx):
    # doc=None只复用既有磁盘/取消/过期屏障；copy允许显式选择非活动文档。
    _kfw_cad_mutation_guard(ctx)
    if ctx['copyDocument'] is None:
        return
    if not _kfw_cad_copy_alive(ctx):
        raise _KfwCadCopyError('stale_target')
    current = ctx['app'].listDocuments()
    expected = ctx['openDocuments']
    if (set(current) != set(expected) or any(current[name] is not expected[name] for name in expected)
            or ctx['app'].ActiveDocument is not ctx['activeDocument']):
        raise _KfwCadCopyError('source_state_changed')


def _kfw_cad_copy_read(ctx, getter):
    _kfw_cad_copy_guard(ctx)
    value = getter()
    _kfw_cad_copy_guard(ctx)
    return value


def _kfw_cad_copy_state(ctx):
    read = lambda getter: _kfw_cad_copy_read(ctx, getter)
    return _kfw_cad_native_document_state(ctx['app'], ctx['gui'], ctx['openDocuments'], read, _KfwCadCopyError)


def _kfw_cad_copy_check_links(ctx):
    read = lambda getter: _kfw_cad_copy_read(ctx, getter)
    _kfw_cad_native_document_links(ctx['app'], ctx['copyDocument'], ctx['openDocuments'], read, _KfwCadCopyError)


def _kfw_cad_copy_observer(ctx, base, surface):
    def capture(event):
        def callback(self, *args):
            try:
                if (surface == 'app' and ctx['phase'] == 'copy'
                        and event in ('slotStartSaveDocument', 'slotFinishSaveDocument')
                        and args and args[0] is ctx['copyDocument']):
                    ctx['saveEvents'][event] += 1
                else:
                    ctx['interference'] = True
            except BaseException:
                ctx['interference'] = True
        return callback
    return type('_KfwCadCopyTrace', (), {name: capture(name) for name in dir(base) if name.startswith('slot')})()


def _kfw_cad_copy_artifact(ctx, path):
    artifact = _kfw_cad_native_document_archive(path, lambda: _kfw_cad_copy_guard(ctx), _KfwCadCopyError, 'invalid_copy_artifact')
    return {'name': 'document.FCStd', **artifact}


def _kfw_cad_copy_snapshot(ctx):
    if ctx['controlLost'] or not _kfw_cad_copy_alive(ctx):
        return
    try:
        observation = ctx['bridge'].snapshot()
        document = next(row for row in observation['documents']
                        if row['documentHandle'] == ctx['request']['documentHandle'])
        ctx['receipt']['snapshot'] = {'bridgeEpoch': observation['bridgeEpoch'],
                                      'applicationRevision': observation['applicationRevision'], 'document': document}
    except BaseException:
        pass


def _kfw_cad_execute_copy(paths, app, gui):
    try:
        manifest, request = _kfw_cad_copy_record(paths)
        if _kfw_cad_os.path.lexists(paths['receiptPath']):
            return
        claim = _kfw_cad_json.dumps({'operationId': manifest['operationId'], 'fingerprint': manifest['fingerprint']}).encode('utf-8')
        if not _kfw_cad_publish_operation_file(paths['executionClaimPath'], claim):
            return
    except BaseException:
        return
    receipt = {'protocol': 'kfw-cad-gui-copy/1', 'operationId': manifest['operationId'],
               'fingerprint': manifest['fingerprint'], 'pid': _kfw_cad_os.getpid(),
               'guiThread': True, 'completed': True, 'outcome': 'rejected', 'copyStarted': False,
               'statePreserved': False}
    ctx = {'paths': paths, 'manifest': manifest, 'request': request, 'receipt': receipt,
           'app': app, 'gui': gui, 'bridge': None, 'doc': None, 'copyDocument': None,
           'openDocuments': {}, 'activeDocument': None, 'interference': False,
           'controlIdentities': {}, 'controlLost': False, 'phase': 'preflight',
           'saveEvents': {'slotStartSaveDocument': 0, 'slotFinishSaveDocument': 0}}
    registrations = []
    try:
        _kfw_cad_copy_guard(ctx)
        bridge = _kfw_cad_document_bridge(app, gui)
        ctx['bridge'] = bridge
        if getattr(bridge, 'active_mutation', None) is not None:
            raise _KfwCadCopyError('document_busy')
        bridge.active_mutation = ctx
        doc, unused_metadata, unused_observation = _kfw_cad_inspection_target(bridge, request)
        ctx['openDocuments'], ctx['activeDocument'] = app.listDocuments(), app.ActiveDocument
        ctx['copyDocument'] = doc
        _kfw_cad_copy_guard(ctx)
        for module, base, surface in ((app, _KfwCadAppObserver, 'app'), (gui, _KfwCadGuiObserver, 'gui')):
            observer = _kfw_cad_copy_observer(ctx, base, surface)
            module.addDocumentObserver(observer)
            registrations.append((module, observer))
        state = _kfw_cad_copy_state(ctx)
        _kfw_cad_copy_check_links(ctx)
        _kfw_cad_inspection_guard(bridge, doc, request)
        _kfw_cad_copy_guard(ctx)
        artifact_path = _kfw_cad_os.path.join(paths['directory'], 'document.FCStd')
        if _kfw_cad_os.path.lexists(artifact_path):
            raise _KfwCadCopyError('copy_artifact_exists')
        source_file = state[next(name for name, current in ctx['openDocuments'].items() if current is doc)]['fileName']
        if source_file and _kfw_cad_os.path.realpath(source_file) == _kfw_cad_os.path.realpath(artifact_path):
            raise _KfwCadCopyError('copy_destination_is_source')
        if _kfw_cad_copy_state(ctx) != state:
            raise _KfwCadCopyError('source_state_changed')
        ctx['phase'] = 'copy'
        receipt['copyStarted'] = True
        doc.saveCopy(artifact_path)
        _kfw_cad_copy_guard(ctx)
        if _kfw_cad_copy_state(ctx) != state:
            raise _KfwCadCopyError('source_state_changed')
        receipt['statePreserved'] = True
        try:
            artifact = _kfw_cad_copy_artifact(ctx, artifact_path)
        except (_KfwCadCopyError, _KfwCadMutationError):
            raise
        except BaseException:
            raise _KfwCadCopyError('invalid_copy_artifact')
        if _kfw_cad_copy_state(ctx) != state or any(count != 1 for count in ctx['saveEvents'].values()):
            receipt['statePreserved'] = False
            raise _KfwCadCopyError('source_state_changed')
        receipt.update(outcome='copied', artifact=artifact)
    except BaseException as error:
        receipt['outcome'] = 'partial' if receipt['copyStarted'] else 'rejected'
        receipt['reason'] = error.code if isinstance(error, (_KfwCadCopyError, _KfwCadMutationError, _KfwCadInspectionError)) else 'copy_failed'
        receipt.pop('artifact', None)
        if (ctx['controlLost'] or ctx['interference']
                or receipt['reason'] in ('source_state_changed', 'stale_target', 'document_busy', 'copy_failed')):
            receipt['statePreserved'] = False
    finally:
        for module, observer in reversed(registrations):
            try:
                module.removeDocumentObserver(observer)
            except BaseException:
                pass
        if ctx['bridge'] is not None and getattr(ctx['bridge'], 'active_mutation', None) is ctx:
            ctx['bridge'].active_mutation = None
    _kfw_cad_copy_snapshot(ctx)
    try:
        content = _kfw_cad_operation_bytes(receipt)
        if len(content) > _KFW_CAD_RECEIPT_LIMIT:
            receipt.pop('snapshot', None)
            content = _kfw_cad_operation_bytes(receipt)
        if len(content) <= _KFW_CAD_RECEIPT_LIMIT:
            _kfw_cad_publish_operation_file(paths['receiptPath'], content)
    except BaseException:
        pass


def _kfw_cad_copy_document(paths):
    import FreeCAD as App
    import FreeCADGui as Gui
    from PySide import QtCore, QtWidgets

    def execute():
        qapp = QtWidgets.QApplication.instance()
        if qapp is None or QtCore.QThread.currentThread() != qapp.thread():
            return
        _kfw_cad_execute_copy(paths, App, Gui)
    QtCore.QTimer.singleShot(0, execute)
`;
