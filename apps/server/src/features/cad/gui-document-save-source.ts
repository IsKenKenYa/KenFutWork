import { CAD_GUI_DOCUMENT_FILE_SOURCE } from "./gui-document-file-source.js";

/** 固定原位保存；只调用一次 App Document.save，沿用既有 GUI 操作控制屏障。 */
export const CAD_GUI_DOCUMENT_SAVE_SOURCE =
  CAD_GUI_DOCUMENT_FILE_SOURCE +
  String.raw`
class _KfwCadSaveError(Exception):
    def __init__(self, code):
        self.code = code


def _kfw_cad_save_record(paths):
    raw = _kfw_cad_read_operation_file(paths['requestPath'])
    manifest = _kfw_cad_json.loads(_kfw_cad_read_operation_file(paths['manifestPath']))
    request = _kfw_cad_json.loads(raw)
    if (not raw.endswith(b'\n') or manifest.get('version') != 1 or request.get('operation') != 'save-document'
            or manifest.get('operationId') != request.get('operationId')
            or _kfw_cad_hashlib.sha256(raw[:-1]).hexdigest() != manifest.get('fingerprint')
            or request.get('application', {}).get('pid') != _kfw_cad_os.getpid()
            or type(manifest.get('preparedAt')) is not int or manifest['preparedAt'] < 0
            or type(request.get('timeoutMs')) is not int or not 0 < request['timeoutMs'] <= 2147483647):
        raise _KfwCadSaveError('invalid_operation_record')
    _kfw_cad_read_operation_file(paths['dispatchClaimPath'], _KFW_CAD_RECEIPT_LIMIT)
    return manifest, request


def _kfw_cad_save_alive(ctx):
    bridge, doc = ctx['bridge'], ctx['saveDocument']
    if bridge is None or doc is None:
        return False
    record = bridge.find(doc)
    return (bridge.valid and bridge.epoch == ctx['request']['bridgeEpoch'] and record is not None
            and not record['closed'] and record['handle'] == ctx['request']['documentHandle']
            and bridge.listed(doc))


def _kfw_cad_save_guard(ctx):
    _kfw_cad_mutation_guard(ctx)
    if ctx['saveDocument'] is None:
        return
    if (not _kfw_cad_save_alive(ctx) or ctx['app'].ActiveDocument is not ctx['saveDocument']
            or ctx['gui'].activeDocument() is not ctx['guiDocument']):
        raise _KfwCadSaveError('stale_target')
    current = ctx['app'].listDocuments()
    expected = ctx['openDocuments']
    if set(current) != set(expected) or any(current[name] is not expected[name] for name in expected):
        raise _KfwCadSaveError('source_state_changed')
    if ctx['rootIdentity'] is not None:
        root, identity = ctx['rootIdentity']
        try:
            info = _kfw_cad_os.lstat(root)
            if (_kfw_cad_os.path.realpath(root) != root or not _kfw_cad_stat.S_ISDIR(info.st_mode)
                    or (info.st_dev, info.st_ino) != identity):
                raise OSError('save root changed')
        except OSError:
            raise _KfwCadSaveError('unsupported_save_target')


def _kfw_cad_save_read(ctx, getter):
    _kfw_cad_save_guard(ctx)
    value = getter()
    _kfw_cad_save_guard(ctx)
    return value


def _kfw_cad_save_state(ctx):
    read = lambda getter: _kfw_cad_save_read(ctx, getter)
    return _kfw_cad_native_document_state(ctx['app'], ctx['gui'], ctx['openDocuments'], read, _KfwCadSaveError)


def _kfw_cad_save_check_state(ctx):
    actual = _kfw_cad_save_state(ctx)
    for name, before in ctx['state'].items():
        after = actual[name]
        # 原生保存可以改变脏标／Touched；只观测，不清除，也不恢复它们。
        ignored = {'modified', 'touched'} if ctx['openDocuments'][name] is ctx['saveDocument'] else set()
        if {key: value for key, value in before.items() if key not in ignored} != {
                key: value for key, value in after.items() if key not in ignored}:
            raise _KfwCadSaveError('source_state_changed')


def _kfw_cad_save_target(ctx):
    request = ctx['request']
    expected, canonical, roots = (request.get(name) for name in ('expectedFileName', 'canonicalPath', 'writeRoots'))
    if (type(expected) is not str or '\0' in expected or not _kfw_cad_os.path.isabs(expected)
            or not expected.lower().endswith('.fcstd') or type(canonical) is not str
            or type(roots) is not list or len(roots) != 1 or type(roots[0]) is not str
            or _kfw_cad_save_read(ctx, lambda: ctx['saveDocument'].FileName) != expected):
        raise _KfwCadSaveError('unsupported_save_target')
    try:
        root = _kfw_cad_os.path.dirname(canonical)
        if (not _kfw_cad_os.path.isabs(canonical) or '\0' in canonical
                or not canonical.lower().endswith('.fcstd')
                or _kfw_cad_os.path.realpath(expected) != canonical
                or _kfw_cad_os.path.realpath(canonical) != canonical or roots != [root]
                or _kfw_cad_os.path.realpath(root) != root):
            raise OSError('save path is not frozen canonical target')
        info, directory = _kfw_cad_os.lstat(canonical), _kfw_cad_os.lstat(root)
        if not _kfw_cad_stat.S_ISREG(info.st_mode) or not _kfw_cad_stat.S_ISDIR(directory.st_mode):
            raise OSError('save target is not existing regular file')
    except (OSError, ValueError):
        raise _KfwCadSaveError('unsupported_save_target')
    identity = (root, (directory.st_dev, directory.st_ino))
    if ctx['rootIdentity'] is not None and ctx['rootIdentity'] != identity:
        raise _KfwCadSaveError('unsupported_save_target')
    ctx['rootIdentity'] = identity
    return info


def _kfw_cad_save_preferences(ctx):
    read = lambda getter: _kfw_cad_save_read(ctx, getter)
    params = read(lambda: ctx['app'].ParamGet('User parameter:BaseApp/Preferences/Document'))
    return {
        'policy': read(lambda: params.GetBool('BackupPolicy', True)),
        'create': read(lambda: params.GetBool('CreateBackupFiles', True)),
        'count': read(lambda: params.GetInt('CountBackupFiles', 1)),
        'extension': read(lambda: params.GetBool('UseFCBakExtension', True)),
        'format': read(lambda: params.GetString('SaveBackupDateFormat', '%Y%m%d-%H%M%S')),
    }


def _kfw_cad_save_backup_domain(ctx, info, preferences):
    if not preferences['policy'] or not preferences['create'] or preferences['count'] <= 0 or not preferences['extension']:
        return
    try:
        format_string = preferences['format'].replace('.', '-')
        if '\0' in format_string:
            raise ValueError('backup format contains NUL')
        modified = _kfw_cad_time.localtime(info.st_mtime_ns // 1000000000)
        stamp = _kfw_cad_time.strftime(format_string, modified)
        # 固定 1.1.4 的 std::strftime 128 字节缓冲与官方失败回退格式。
        if not stamp or len(stamp.encode('utf-8')) >= 128:
            stamp = _kfw_cad_time.strftime('%Y-%m-%d_%H-%M-%S', modified)
        canonical = ctx['request']['canonicalPath']
        base = canonical[:canonical.rfind('.') + 1] + stamp
        if base.endswith(' '):
            candidates = [base[:-1] + '1.FCBak']
        elif base.endswith('-'):
            candidates = [base + '1.FCBak']
        else:
            candidates = [base + '.FCBak', base + '-1.FCBak']
        root = ctx['request']['writeRoots'][0]
        for candidate in candidates:
            parent = _kfw_cad_os.path.realpath(_kfw_cad_os.path.dirname(candidate))
            if _kfw_cad_os.path.commonpath((root, parent)) != root:
                raise ValueError('backup outside frozen root')
    except (OSError, ValueError, TypeError, OverflowError, UnicodeError):
        raise _KfwCadSaveError('unsupported_backup_path')
    _kfw_cad_save_guard(ctx)


def _kfw_cad_save_observer(ctx, base, surface):
    def capture(event):
        def callback(self, *args):
            try:
                own = surface == 'app' and ctx['phase'] == 'save' and args and args[0] is ctx['saveDocument']
                if own and event in ('slotStartSaveDocument', 'slotFinishSaveDocument'):
                    return
                if (own and event in ('slotBeforeChangeDocument', 'slotChangedDocument') and len(args) >= 2
                        and args[1] in ('LastModifiedDate', 'LastModifiedBy', 'TipName')):
                    return
                ctx['interference'] = True
            except BaseException:
                ctx['interference'] = True
        return callback
    return type('_KfwCadSaveTrace', (), {name: capture(name) for name in dir(base) if name.startswith('slot')})()


def _kfw_cad_save_snapshot(ctx):
    if ctx['controlLost'] or not _kfw_cad_save_alive(ctx):
        return
    try:
        observation = ctx['bridge'].snapshot()
        document = next(row for row in observation['documents']
                        if row['documentHandle'] == ctx['request']['documentHandle'])
        ctx['receipt']['snapshot'] = {'bridgeEpoch': observation['bridgeEpoch'],
                                      'applicationRevision': observation['applicationRevision'], 'document': document}
    except BaseException:
        pass


def _kfw_cad_save_preflight(ctx):
    request, bridge = ctx['request'], ctx['bridge']
    doc = ctx['saveDocument']
    ctx['state'] = _kfw_cad_save_state(ctx)
    read = lambda getter: _kfw_cad_save_read(ctx, getter)
    _kfw_cad_native_document_links(ctx['app'], doc, ctx['openDocuments'], read, _KfwCadSaveError)
    info = _kfw_cad_save_target(ctx)
    ctx['preferences'] = _kfw_cad_save_preferences(ctx)
    _kfw_cad_save_backup_domain(ctx, info, ctx['preferences'])
    _kfw_cad_inspection_guard(bridge, doc, request)
    _kfw_cad_save_check_state(ctx)
    # 在紧邻原生调用处再次读取当前偏好与旧文件mtime，不使用磁盘配置缓存。
    info = _kfw_cad_save_target(ctx)
    current_preferences = _kfw_cad_save_preferences(ctx)
    if current_preferences != ctx['preferences']:
        raise _KfwCadSaveError('source_state_changed')
    _kfw_cad_save_backup_domain(ctx, info, current_preferences)
    _kfw_cad_inspection_guard(bridge, doc, request)
    _kfw_cad_save_guard(ctx)


def _kfw_cad_save_native(ctx):
    receipt = ctx['receipt']
    ctx['phase'] = 'save'
    receipt.update(saveStarted=True, writeFinished=False)
    try:
        ctx['saveDocument'].save()
    finally:
        # 只有同步原生函数正常或异常返回后才成立；Finish事件不设置此事实。
        receipt['writeFinished'] = True
    ctx['phase'] = 'verify'
    _kfw_cad_save_guard(ctx)
    _kfw_cad_save_check_state(ctx)
    if _kfw_cad_save_preferences(ctx) != ctx['preferences']:
        raise _KfwCadSaveError('source_state_changed')
    try:
        artifact = _kfw_cad_native_document_archive(ctx['request']['canonicalPath'],
                    lambda: _kfw_cad_save_guard(ctx), _KfwCadSaveError, 'invalid_save_artifact')
    except (_KfwCadSaveError, _KfwCadMutationError):
        raise
    except BaseException:
        raise _KfwCadSaveError('invalid_save_artifact')
    _kfw_cad_save_check_state(ctx)
    _kfw_cad_save_snapshot(ctx)
    _kfw_cad_save_guard(ctx)
    receipt.update(outcome='saved', artifact={'canonicalPath': ctx['request']['canonicalPath'], **artifact})


def _kfw_cad_execute_save(paths, app, gui):
    try:
        manifest, request = _kfw_cad_save_record(paths)
        if _kfw_cad_os.path.lexists(paths['receiptPath']):
            return
        claim = _kfw_cad_json.dumps({'operationId': manifest['operationId'], 'fingerprint': manifest['fingerprint']}).encode('utf-8')
        if not _kfw_cad_publish_operation_file(paths['executionClaimPath'], claim):
            return
    except BaseException:
        return
    receipt = {'protocol': 'kfw-cad-gui-save/1', 'operationId': manifest['operationId'],
               'fingerprint': manifest['fingerprint'], 'pid': _kfw_cad_os.getpid(), 'guiThread': True,
               'completed': True, 'outcome': 'rejected', 'saveStarted': False, 'writeFinished': True}
    ctx = {'paths': paths, 'manifest': manifest, 'request': request, 'receipt': receipt,
           'app': app, 'gui': gui, 'bridge': None, 'doc': None, 'saveDocument': None, 'guiDocument': None,
           'openDocuments': {}, 'state': {}, 'rootIdentity': None, 'preferences': None,
           'interference': False, 'controlIdentities': {}, 'controlLost': False, 'phase': 'preflight'}
    registrations = []
    try:
        _kfw_cad_save_guard(ctx)
        bridge = _kfw_cad_document_bridge(app, gui)
        ctx['bridge'] = bridge
        if getattr(bridge, 'active_mutation', None) is not None:
            raise _KfwCadSaveError('document_busy')
        bridge.active_mutation = ctx
        doc, unused_metadata, unused_observation = _kfw_cad_inspection_target(bridge, request)
        ctx['openDocuments'] = app.listDocuments()
        ctx['saveDocument'], ctx['guiDocument'] = doc, gui.getDocument(doc.Name)
        _kfw_cad_save_guard(ctx)
        for module, base, surface in ((app, _KfwCadAppObserver, 'app'), (gui, _KfwCadGuiObserver, 'gui')):
            observer = _kfw_cad_save_observer(ctx, base, surface)
            module.addDocumentObserver(observer)
            registrations.append((module, observer))
        _kfw_cad_save_preflight(ctx)
        _kfw_cad_save_native(ctx)
    except BaseException as error:
        receipt['outcome'] = 'partial' if receipt['saveStarted'] else 'rejected'
        receipt['reason'] = error.code if isinstance(error, (_KfwCadSaveError, _KfwCadMutationError, _KfwCadInspectionError)) else 'save_failed'
        receipt.pop('artifact', None)
        _kfw_cad_save_snapshot(ctx)
    finally:
        for module, observer in reversed(registrations):
            try:
                module.removeDocumentObserver(observer)
            except BaseException:
                pass
        if ctx['bridge'] is not None and getattr(ctx['bridge'], 'active_mutation', None) is ctx:
            ctx['bridge'].active_mutation = None
    try:
        content = _kfw_cad_operation_bytes(receipt)
        if len(content) > _KFW_CAD_RECEIPT_LIMIT:
            receipt.pop('snapshot', None)
            content = _kfw_cad_operation_bytes(receipt)
        if receipt['writeFinished'] and len(content) <= _KFW_CAD_RECEIPT_LIMIT:
            _kfw_cad_publish_operation_file(paths['receiptPath'], content)
    except BaseException:
        pass


def _kfw_cad_save_document(paths):
    import FreeCAD as App
    import FreeCADGui as Gui
    from PySide import QtCore, QtWidgets

    def execute():
        qapp = QtWidgets.QApplication.instance()
        if qapp is None or QtCore.QThread.currentThread() != qapp.thread():
            return
        _kfw_cad_execute_save(paths, App, Gui)
    QtCore.QTimer.singleShot(0, execute)
`;
