import { CAD_GUI_NATIVE_STATE_SOURCE } from "./gui-native-state-source.js";

/** 固定受控撤销入口；证明与路径只从宿主的持久操作记录读取。 */
export const CAD_GUI_UNDO_SOURCE =
  CAD_GUI_NATIVE_STATE_SOURCE +
  String.raw`
class _KfwCadUndoError(Exception):
    def __init__(self, code):
        self.code = code


def _kfw_cad_undo_record(paths):
    raw = _kfw_cad_read_operation_file(paths['requestPath'])
    manifest = _kfw_cad_json.loads(_kfw_cad_read_operation_file(paths['manifestPath']))
    request = _kfw_cad_json.loads(raw)
    source = request.get('undoSource', {}).get('receipt', {})
    if (not raw.endswith(b'\n') or manifest.get('version') != 1 or request.get('operation') != 'undo'
            or manifest.get('operationId') != request.get('operationId')
            or _kfw_cad_hashlib.sha256(raw[:-1]).hexdigest() != manifest.get('fingerprint')
            or request.get('application', {}).get('pid') != _kfw_cad_os.getpid()
            or type(manifest.get('preparedAt')) is not int or manifest['preparedAt'] < 0
            or type(request.get('timeoutMs')) is not int or not 0 < request['timeoutMs'] <= 2147483647
            or type(source.get('fingerprint')) is not str or len(source['fingerprint']) != 64
            or any(part not in '0123456789abcdef' for part in source['fingerprint'])):
        raise _KfwCadUndoError('invalid_operation_record')
    for name in ('operationId', 'sourceOperationId'):
        value = request.get(name)
        if type(value) is not str or str(_kfw_cad_uuid.UUID(value)) != value:
            raise _KfwCadUndoError('invalid_operation_record')
    _kfw_cad_read_operation_file(paths['dispatchClaimPath'], _KFW_CAD_RECEIPT_LIMIT)
    return manifest, request


def _kfw_cad_undo_same(left, right):
    if type(left) is bool or type(right) is bool:
        return type(left) is bool and type(right) is bool and left == right
    if type(left) in (int, float) and type(right) in (int, float):
        return _kfw_cad_math.isfinite(left) and _kfw_cad_math.isfinite(right) and left == right
    if type(left) is str or type(right) is str:
        return type(left) is str and type(right) is str and left == right
    if type(left) is dict and type(right) is dict:
        return set(left) == set(right) and all(_kfw_cad_undo_same(left[key], right[key]) for key in left)
    if type(left) in (list, tuple) and type(right) in (list, tuple):
        return len(left) == len(right) and all(_kfw_cad_undo_same(a, b) for a, b in zip(left, right))
    return False


def _kfw_cad_undo_source(request):
    source = request['undoSource']
    original, receipt = source['input'], source['receipt']
    proof, snapshot = receipt.get('undoProvenance'), receipt.get('snapshot')
    if (receipt.get('outcome') != 'committed' or receipt.get('commitObserved') is not True
            or receipt.get('transactionState') != 'none' or type(proof) is not dict or type(snapshot) is not dict
            or original.get('application') != request['application']
            or receipt.get('pid') != request['application']['pid']
            or original.get('operationId') != request['sourceOperationId']
            or receipt.get('operationId') != request['sourceOperationId']
            or request['operationId'] == request['sourceOperationId']):
        raise _KfwCadUndoError('invalid_undo_source')
    document = snapshot['document']
    if (request['bridgeEpoch'] != snapshot['bridgeEpoch'] or request['documentHandle'] != document['documentHandle']
            or request['expectedApplicationRevision'] != snapshot['applicationRevision']
            or request['expectedDocumentRevision'] != document['revision']
            or original['bridgeEpoch'] != snapshot['bridgeEpoch'] or original['documentHandle'] != document['documentHandle']
            or snapshot['applicationRevision'] < original['expectedApplicationRevision']
            or document['revision'] < original['expectedDocumentRevision']
            or document['active'] is not True or document['pendingTransaction'] is not False):
        raise _KfwCadUndoError('source_snapshot_changed')
    name = proof.get('transactionName')
    if type(name) is not str or not name.startswith('KFW CAD ') or str(_kfw_cad_uuid.UUID(name[8:])) != name[8:]:
        raise _KfwCadUndoError('invalid_undo_source')
    rows = {(row['objectName'], row['propertyName']): row for row in receipt['changes']}
    pairs = {(row['objectName'], row['propertyName']) for row in original['changes']}
    if (not pairs or len(rows) != len(receipt['changes']) or len(pairs) != len(original['changes'])
            or set(rows) != pairs or not any(row['changed'] is True for row in rows.values())):
        raise _KfwCadUndoError('invalid_undo_source')
    for change in original['changes']:
        row = rows[(change['objectName'], change['propertyName'])]
        if (not _kfw_cad_undo_same(row['before'], change['expectedValue'])
                or not _kfw_cad_undo_same(row['requested'], change['value'])
                or not _kfw_cad_undo_same(row.get('observed'), change['value'])
                or type(row['changed']) is not bool
                or row['changed'] != (not _kfw_cad_undo_same(row['before'], row['observed']))):
            raise _KfwCadUndoError('invalid_undo_source')
    return original, receipt, proof


def _kfw_cad_undo_guard(ctx):
    # doc=None仅复用持久控制文件、取消和过期检查，原生undo内部可暂有事务。
    _kfw_cad_mutation_guard(ctx)
    doc, bridge = ctx['undoDocument'], ctx['bridge']
    if doc is None:
        return
    record = bridge.find(doc)
    current, expected = ctx['app'].listDocuments(), ctx['openDocuments']
    if (not bridge.valid or bridge.epoch != ctx['request']['bridgeEpoch'] or record is None
            or record['closed'] or record['handle'] != ctx['request']['documentHandle'] or not bridge.listed(doc)
            or set(current) != set(expected) or any(current[name] is not expected[name] for name in expected)
            or ctx['app'].ActiveDocument is not doc):
        raise _KfwCadUndoError('stale_target')
    for name, obj in ctx['objects'].items():
        if doc.getObject(name) is not obj:
            raise _KfwCadUndoError('stale_target')
    if ctx['documentObjects']:
        objects = list(doc.Objects)
        if len(objects) != len(ctx['documentObjects']) or any(a is not b for a, b in zip(objects, ctx['documentObjects'])):
            raise _KfwCadUndoError('stale_target')
    if not ctx['receipt']['undoStarted']:
        _kfw_cad_inspection_guard(bridge, doc, ctx['request'])


def _kfw_cad_undo_read(ctx, getter):
    _kfw_cad_undo_guard(ctx)
    value = getter()
    _kfw_cad_undo_guard(ctx)
    return value


def _kfw_cad_undo_trace(ctx, surface, event, args):
    allowed = False
    if ctx['phase'] == 'undo':
        if surface == 'app' and event == 'slotUndoDocument':
            allowed = bool(args) and args[0] is ctx['undoDocument'] and not ctx['receipt']['undoObserved']
            if allowed:
                ctx['receipt']['undoObserved'] = True
        elif surface == 'app' and event in ('slotBeforeChangeObject', 'slotChangedObject') and len(args) >= 2:
            obj, name = args[0], args[1]
            derived = name in ('Shape', 'AddSubShape', 'Placement', 'Direction', 'SuppressedShape')
            declared = any(obj is entry['object'] and name == entry['propertyName'] for entry in ctx['entries'])
            bound = any(obj is owner and name in names for owner, names in ctx['boundProperties'])
            allowed = any(obj is current for current in ctx['documentObjects']) and (derived or declared or bound)
        elif surface == 'gui' and event in ('slotBeforeChangeObject', 'slotChangedObject') and args:
            allowed = any(args[0] is view for view in ctx['views'])
    if not allowed:
        ctx['interference'] = True


def _kfw_cad_undo_observer(ctx, base, surface):
    def capture(event):
        def callback(self, *args):
            try:
                _kfw_cad_undo_trace(ctx, surface, event, args)
            except BaseException:
                ctx['interference'] = True
        return callback
    return type('_KfwCadUndoTrace', (), {name: capture(name) for name in dir(base) if name.startswith('slot')})()


def _kfw_cad_undo_check_incoming(ctx):
    read = lambda getter: _kfw_cad_undo_read(ctx, getter)
    target = ctx['undoDocument']
    if read(lambda: target.InList):
        raise _KfwCadUndoError('incoming_external_reference')
    target_file = read(lambda: target.FileName)
    target_path = _kfw_cad_os.path.realpath(target_file) if target_file else None
    for doc in ctx['openDocuments'].values():
        if doc is target:
            continue
        for obj, name in _kfw_cad_native_link_properties(ctx['app'], doc, read, _KfwCadUndoError):
            files = _kfw_cad_native_link_files(obj, name, read, _KfwCadUndoError)
            for file_name in files:
                if target_path is None:
                    raise _KfwCadUndoError('unsupported_external_reference')
                if '://' in file_name or '://' in target_file:
                    if file_name == target_file:
                        raise _KfwCadUndoError('incoming_external_reference')
                    raise _KfwCadUndoError('unsupported_external_reference')
                if not _kfw_cad_os.path.isabs(file_name):
                    owner_file = read(lambda: doc.FileName)
                    if not owner_file:
                        raise _KfwCadUndoError('unsupported_external_reference')
                    file_name = _kfw_cad_os.path.join(_kfw_cad_os.path.dirname(_kfw_cad_os.path.realpath(owner_file)), file_name)
                matches = _kfw_cad_os.path.realpath(file_name) == target_path
                if not matches:
                    try:
                        matches = _kfw_cad_os.path.samefile(file_name, target_path)
                    except OSError:
                        pass
                if matches:
                    raise _KfwCadUndoError('incoming_external_reference')
    _kfw_cad_undo_guard(ctx)


def _kfw_cad_undo_targets(ctx):
    read = lambda getter: _kfw_cad_undo_read(ctx, getter)
    ctx['documentObjects'] = read(lambda: list(ctx['undoDocument'].Objects))
    ctx['views'] = [read(lambda obj=obj: obj.ViewObject) for obj in ctx['documentObjects']]
    for obj in ctx['documentObjects']:
        name = read(lambda: obj.Name)
        if name in ctx['objects']:
            raise _KfwCadUndoError('stale_target')
        ctx['objects'][name] = obj
        names = read(lambda: list(obj.PropertiesList))
        bindings = _kfw_cad_object_expressions(obj, names, lambda: _kfw_cad_undo_guard(ctx))
        ctx['expressions'].append((obj, names, bindings))
        ctx['boundProperties'].append((obj, {path.lstrip('.') for path, expression in bindings if expression is not None}))
    for change in ctx['sourceReceipt']['changes']:
        obj = ctx['objects'].get(change['objectName'])
        if obj is None:
            raise _KfwCadUndoError('object_missing')
        names, bindings = next((names, bindings) for owner, names, bindings in ctx['expressions'] if owner is obj)
        if change['propertyName'] not in names or 'Proxy' in names:
            raise _KfwCadUndoError('unsupported_property')
        row = _kfw_cad_inspect_property(obj, change['propertyName'], bindings, None, lambda: _kfw_cad_undo_guard(ctx))
        if not row['editable'] or not _kfw_cad_undo_same(row.get('value'), change['observed']):
            raise _KfwCadUndoError('value_changed')
        status = read(lambda: obj.getPropertyStatus(change['propertyName']))
        if 18 in status or 'DisableNotify' in status:
            raise _KfwCadUndoError('unsupported_property')
        item = {'objectName': change['objectName'], 'propertyName': change['propertyName'], 'before': row['value']}
        ctx['entries'].append({'object': obj, 'propertyName': change['propertyName'],
                               'typeId': row['typeId'], 'expected': change['before'], 'receipt': item})
    ctx['receipt']['changes'] = [entry['receipt'] for entry in ctx['entries']]


def _kfw_cad_undo_histories(ctx):
    read = lambda getter: _kfw_cad_undo_read(ctx, getter)
    doc = ctx['undoDocument']
    undo, redo = read(lambda: list(doc.UndoNames)), read(lambda: list(doc.RedoNames))
    summaries = (_kfw_cad_history_summary(undo), _kfw_cad_history_summary(redo))
    counts = (read(lambda: doc.UndoCount), read(lambda: doc.RedoCount))
    if any(type(count) is not int or count != summary['count'] for count, summary in zip(counts, summaries)):
        raise _KfwCadUndoError('history_changed')
    return undo, redo, summaries


def _kfw_cad_undo_validate_values(ctx, completed):
    guard = lambda: _kfw_cad_undo_guard(ctx)
    for obj, names, bindings in ctx['expressions']:
        if list(obj.PropertiesList) != names or _kfw_cad_object_expressions(obj, names, guard) != bindings:
            raise _KfwCadUndoError('expression_changed')
        guard()
    for entry in ctx['entries']:
        row = _kfw_cad_inspect_property(entry['object'], entry['propertyName'], [], None, guard)
        if row['typeId'] != entry['typeId'] or not row['editable']:
            raise _KfwCadUndoError('property_changed')
        if completed:
            entry['receipt']['observed'] = row['value']
            entry['receipt']['changed'] = not _kfw_cad_undo_same(row['value'], entry['receipt']['before'])
        expected = entry['expected'] if completed else entry['receipt']['before']
        if not _kfw_cad_undo_same(row.get('value'), expected):
            raise _KfwCadUndoError('undo_value_unconfirmed' if completed else 'value_changed')
    guard()


def _kfw_cad_undo_state(ctx):
    return _kfw_cad_native_document_state(ctx['app'], ctx['gui'], ctx['openDocuments'],
                                          lambda getter: _kfw_cad_undo_read(ctx, getter), _KfwCadUndoError)


def _kfw_cad_apply_undo(ctx):
    state = _kfw_cad_undo_state(ctx)
    target_name = next(name for name, doc in ctx['openDocuments'].items() if doc is ctx['undoDocument'])
    if state[target_name]['frozen'] or type(state[target_name]['undoMode']) is not int or state[target_name]['undoMode'] <= 0:
        raise _KfwCadUndoError('document_busy')
    _kfw_cad_undo_check_incoming(ctx)
    _kfw_cad_undo_targets(ctx)
    undo, redo, summaries = _kfw_cad_undo_histories(ctx)
    proof = ctx['sourceProof']
    if (not undo or undo[0] != proof['transactionName']
            or summaries != (proof['undoHistory'], proof['redoHistory'])):
        raise _KfwCadUndoError('history_changed')
    _kfw_cad_undo_validate_values(ctx, False)
    if _kfw_cad_undo_state(ctx) != state:
        raise _KfwCadUndoError('source_state_changed')
    _kfw_cad_inspection_guard(ctx['bridge'], ctx['undoDocument'], ctx['request'])
    _kfw_cad_undo_guard(ctx)
    ctx['phase'] = 'undo'
    ctx['receipt']['undoStarted'] = True
    ctx['undoDocument'].undo()
    ctx['phase'] = 'verifying'
    _kfw_cad_undo_guard(ctx)
    after = _kfw_cad_undo_state(ctx)
    for name, previous in state.items():
        current = after[name]
        keys = ('fileName', 'label', 'uid', 'flags', 'frozen', 'undoMode') if name == target_name else previous.keys()
        if any(previous[key] != current[key] for key in keys):
            raise _KfwCadUndoError('source_state_changed')
    actual_undo, actual_redo, actual_summaries = _kfw_cad_undo_histories(ctx)
    if actual_undo != undo[1:] or actual_redo != [proof['transactionName']] + redo:
        raise _KfwCadUndoError('history_changed')
    if not ctx['receipt']['undoObserved']:
        raise _KfwCadUndoError('undo_unconfirmed')
    ctx['receipt'].update(historyVerified=True, undoHistory=actual_summaries[0], redoHistory=actual_summaries[1])
    _kfw_cad_undo_validate_values(ctx, True)
    if not any(entry['receipt']['changed'] for entry in ctx['entries']):
        raise _KfwCadUndoError('undo_value_unconfirmed')
    observation = ctx['bridge'].snapshot()
    document = next(row for row in observation['documents'] if row['documentHandle'] == ctx['request']['documentHandle'])
    _kfw_cad_undo_guard(ctx)
    if (not document['active'] or document['pendingTransaction']
            or ctx['bridge'].application_revision != observation['applicationRevision']
            or ctx['bridge'].find(ctx['undoDocument'])['revision'] != document['revision']):
        raise _KfwCadUndoError('source_state_changed')
    ctx['receipt'].update(outcome='undone', snapshot={'bridgeEpoch': observation['bridgeEpoch'],
                         'applicationRevision': observation['applicationRevision'], 'document': document})


def _kfw_cad_execute_undo(paths, app, gui):
    try:
        manifest, request = _kfw_cad_undo_record(paths)
        if _kfw_cad_os.path.lexists(paths['receiptPath']):
            return
        claim = _kfw_cad_json.dumps({'operationId': manifest['operationId'], 'fingerprint': manifest['fingerprint']}).encode('utf-8')
        if not _kfw_cad_publish_operation_file(paths['executionClaimPath'], claim):
            return
    except BaseException:
        return
    receipt = {'protocol': 'kfw-cad-gui-undo/1', 'operationId': request['operationId'],
               'fingerprint': manifest['fingerprint'], 'pid': _kfw_cad_os.getpid(),
               'sourceOperationId': request['sourceOperationId'], 'sourceFingerprint': request['undoSource']['receipt']['fingerprint'],
               'guiThread': True, 'completed': True, 'outcome': 'rejected', 'undoStarted': False,
               'undoObserved': False, 'historyVerified': False, 'changes': []}
    ctx = {'paths': paths, 'manifest': manifest, 'request': request, 'receipt': receipt, 'app': app, 'gui': gui,
           'doc': None, 'bridge': None, 'undoDocument': None, 'openDocuments': {}, 'objects': {}, 'entries': [],
           'expressions': [], 'documentObjects': [], 'views': [], 'boundProperties': [],
           'phase': 'preflight', 'interference': False, 'controlIdentities': {}, 'controlLost': False}
    registrations = []
    try:
        _kfw_cad_undo_guard(ctx)
        unused_original, source_receipt, proof = _kfw_cad_undo_source(request)
        ctx.update(sourceReceipt=source_receipt, sourceProof=proof)
        receipt['transactionName'] = proof['transactionName']
        if len(_kfw_cad_operation_bytes(dict(receipt, changes=source_receipt['changes']))) + 2048 > _KFW_CAD_RECEIPT_LIMIT:
            raise _KfwCadUndoError('receipt_too_large')
        bridge = _kfw_cad_document_bridge(app, gui)
        ctx['bridge'] = bridge
        if getattr(bridge, 'active_mutation', None) is not None:
            raise _KfwCadUndoError('document_busy')
        bridge.active_mutation = ctx
        doc, metadata, unused_observation = _kfw_cad_inspection_target(bridge, request)
        if metadata != source_receipt['snapshot']['document']:
            raise _KfwCadUndoError('source_state_changed')
        ctx['undoDocument'], ctx['openDocuments'] = doc, dict(app.listDocuments())
        for module, base, surface in ((app, _KfwCadAppObserver, 'app'), (gui, _KfwCadGuiObserver, 'gui')):
            observer = _kfw_cad_undo_observer(ctx, base, surface)
            module.addDocumentObserver(observer)
            registrations.append((module, observer))
        _kfw_cad_apply_undo(ctx)
    except BaseException as error:
        receipt['outcome'] = 'partial' if receipt['undoStarted'] else 'rejected'
        receipt['reason'] = error.code if isinstance(error, (_KfwCadUndoError, _KfwCadMutationError, _KfwCadInspectionError)) else 'undo_failed'
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
        if len(content) <= _KFW_CAD_RECEIPT_LIMIT:
            _kfw_cad_publish_operation_file(paths['receiptPath'], content)
    except BaseException:
        # 撤销与回执落盘不构成原子事务；缺回执必须报告unknown，不得自动重发。
        pass


def _kfw_cad_undo_operation(paths):
    import FreeCAD as App
    import FreeCADGui as Gui
    from PySide import QtCore, QtWidgets

    def execute():
        qapp = QtWidgets.QApplication.instance()
        if qapp is None or QtCore.QThread.currentThread() != qapp.thread():
            return
        _kfw_cad_execute_undo(paths, App, Gui)
    QtCore.QTimer.singleShot(0, execute)
`;
