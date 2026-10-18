import { CAD_GUI_OPERATION_RECEIPT_MAX_BYTES } from "./gui-operation-store.js";

/** 固定当前文档属性编辑入口；路径只能由宿主的持久操作记录生成。 */
export const CAD_GUI_PROPERTY_MUTATION_SOURCE = String.raw`
import errno as _kfw_cad_errno
import hashlib as _kfw_cad_hashlib
import json as _kfw_cad_json
import os as _kfw_cad_os
import stat as _kfw_cad_stat
import time as _kfw_cad_time

_KFW_CAD_RECEIPT_LIMIT = ${CAD_GUI_OPERATION_RECEIPT_MAX_BYTES}


class _KfwCadMutationError(Exception):
    def __init__(self, code):
        self.code = code


def _kfw_cad_read_operation_file(path, maximum=4194304):
    descriptor = _kfw_cad_os.open(path, _kfw_cad_os.O_RDONLY | _kfw_cad_os.O_NOFOLLOW | _kfw_cad_os.O_NONBLOCK)
    with _kfw_cad_os.fdopen(descriptor, 'rb') as stream:
        info = _kfw_cad_os.fstat(stream.fileno())
        if not _kfw_cad_stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise _KfwCadMutationError('invalid_operation_record')
        content = stream.read(maximum + 1)
        if len(content) > maximum:
            raise _KfwCadMutationError('invalid_operation_record')
        return content


def _kfw_cad_sync_operation_directory(path):
    descriptor = _kfw_cad_os.open(path, _kfw_cad_os.O_RDONLY | _kfw_cad_os.O_DIRECTORY | _kfw_cad_os.O_NOFOLLOW)
    try:
        _kfw_cad_os.fsync(descriptor)
    finally:
        _kfw_cad_os.close(descriptor)


def _kfw_cad_publish_operation_file(path, content):
    directory = _kfw_cad_os.path.dirname(path)
    temporary = _kfw_cad_os.path.join(directory, '.gui-' + str(_kfw_cad_uuid.uuid4()) + '.tmp')
    descriptor = _kfw_cad_os.open(temporary, _kfw_cad_os.O_WRONLY | _kfw_cad_os.O_CREAT |
                                  _kfw_cad_os.O_EXCL | _kfw_cad_os.O_NOFOLLOW, 0o600)
    try:
        with _kfw_cad_os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            _kfw_cad_os.fsync(stream.fileno())
        _kfw_cad_sync_operation_directory(directory)
        try:
            _kfw_cad_os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            return False
        _kfw_cad_sync_operation_directory(directory)
        return True
    finally:
        _kfw_cad_os.unlink(temporary)
        _kfw_cad_sync_operation_directory(directory)


def _kfw_cad_operation_record(paths):
    raw = _kfw_cad_read_operation_file(paths['requestPath'])
    manifest = _kfw_cad_json.loads(_kfw_cad_read_operation_file(paths['manifestPath']))
    if not raw.endswith(b'\n'):
        raise _KfwCadMutationError('invalid_operation_record')
    request = _kfw_cad_json.loads(raw)
    if (manifest.get('version') != 1 or request.get('operation') != 'set-properties'
            or manifest.get('operationId') != request.get('operationId')
            or _kfw_cad_hashlib.sha256(raw[:-1]).hexdigest() != manifest.get('fingerprint')
            or request.get('application', {}).get('pid') != _kfw_cad_os.getpid()
            or type(manifest.get('preparedAt')) is not int or manifest['preparedAt'] < 0
            or type(request.get('timeoutMs')) is not int or not 0 < request['timeoutMs'] <= 2147483647):
        raise _KfwCadMutationError('invalid_operation_record')
    _kfw_cad_read_operation_file(paths['dispatchClaimPath'], _KFW_CAD_RECEIPT_LIMIT)
    return manifest, request


def _kfw_cad_mutation_alive(ctx):
    bridge, doc = ctx['bridge'], ctx['doc']
    if bridge is None or doc is None:
        return False
    record = bridge.find(doc)
    return (bridge.valid and bridge.epoch == ctx['request']['bridgeEpoch'] and record is not None
            and not record['closed'] and record['handle'] == ctx['request']['documentHandle']
            and bridge.listed(doc))


def _kfw_cad_mutation_guard(ctx):
    for key in ('manifestPath', 'requestPath', 'executionClaimPath'):
        try:
            info = _kfw_cad_os.lstat(ctx['paths'][key])
            identity = (info.st_dev, info.st_ino)
            known = ctx['controlIdentities'].get(key)
            if not _kfw_cad_stat.S_ISREG(info.st_mode) or (known is not None and known != identity):
                raise OSError('operation control replaced')
            ctx['controlIdentities'][key] = identity
        except OSError:
            ctx['controlLost'] = True
            raise _KfwCadMutationError('operation_control_lost')
    if _kfw_cad_os.path.lexists(ctx['paths']['cancelledPath']):
        raise _KfwCadMutationError('cancelled')
    if _kfw_cad_time.time() * 1000 > ctx['manifest']['preparedAt'] + ctx['request']['timeoutMs']:
        raise _KfwCadMutationError('operation_expired')
    if ctx.get('interference'):
        raise _KfwCadMutationError('interference_detected')
    if ctx['doc'] is None:
        return
    if not _kfw_cad_mutation_alive(ctx) or ctx['app'].ActiveDocument is not ctx['doc']:
        raise _KfwCadMutationError('stale_target')
    for name, obj in ctx['objects'].items():
        if ctx['doc'].getObject(name) is not obj:
            raise _KfwCadMutationError('stale_target')
    if ctx['transactionId'] is not None:
        active = ctx['app'].getActiveTransaction()
        if ctx['phase'] == 'closed':
            if active is not None or ctx['doc'].HasPendingTransaction:
                raise _KfwCadMutationError('transaction_changed')
        elif active != (ctx['transactionName'], ctx['transactionId']):
            raise _KfwCadMutationError('transaction_changed')
    for other in ctx['app'].listDocuments().values():
        if other is not ctx['doc'] and other.HasPendingTransaction:
            raise _KfwCadMutationError('transaction_changed')


def _kfw_cad_mutation_trace(ctx, surface, event, args):
    phase, doc = ctx['phase'], ctx['doc']
    allowed = False
    if surface == 'app':
        if event == 'slotOpenTransaction':
            allowed = (phase in ('begin', 'assign') and len(args) >= 2 and args[0] is doc
                       and args[1] == ctx['transactionName'])
        elif event in ('slotBeforeCloseTransaction', 'slotCloseTransaction'):
            allowed = phase == 'commit' and len(args) == 1 and args[0] is False
        elif event == 'slotCommitTransaction':
            allowed = phase == 'commit' and len(args) >= 1 and args[0] is doc
            if allowed:
                ctx['receipt']['commitObserved'] = True
        elif event in ('slotBeforeRecomputeDocument', 'slotRecomputedDocument'):
            allowed = phase == 'recompute' and len(args) >= 1 and args[0] is doc
        elif event == 'slotRecomputedObject':
            allowed = phase == 'recompute' and len(args) >= 1 and any(args[0] is obj for obj in ctx['documentObjects'])
        elif event in ('slotBeforeChangeObject', 'slotChangedObject') and len(args) >= 2:
            obj, name = args[0], args[1]
            in_document = any(obj is current for current in ctx['documentObjects'])
            current = ctx.get('current')
            declared = current is not None and obj is current['object'] and name == current['propertyName']
            bound = any(obj is owner and name in names for owner, names in ctx['boundProperties'])
            allowed = (phase in ('assign', 'recompute') and in_document
                       and (name == 'Shape' or bound or (phase == 'assign' and declared)))
    elif event in ('slotBeforeChangeObject', 'slotChangedObject'):
        allowed = (phase in ('assign', 'recompute') and len(args) >= 1
                   and any(args[0] is view for view in ctx['views']))
    if not allowed:
        ctx['interference'] = True


def _kfw_cad_trace_observer(ctx, base, surface):
    def capture(event):
        def callback(self, *args):
            try:
                _kfw_cad_mutation_trace(ctx, surface, event, args)
            except BaseException:
                ctx['interference'] = True
        return callback
    methods = {name: capture(name) for name in dir(base) if name.startswith('slot')}
    return type('_KfwCadMutationTrace', (), methods)()


def _kfw_cad_mutation_value(kind, value, current):
    if kind == 'boolean' and type(value) is bool:
        return value
    if kind == 'integer' and type(value) is int and abs(value) <= _KFW_CAD_MAX_REVISION:
        return value
    if kind == 'number' and type(value) in (int, float) and _kfw_cad_math.isfinite(value):
        return float(value)
    if kind == 'string' and type(value) is str and '\0' not in value:
        value.encode('utf-8')
        return value
    if (kind == 'quantity' and type(value) is dict and set(value) == {'kind', 'value', 'unitSignature'}
            and value['kind'] == 'quantity' and type(value['value']) in (int, float)
            and _kfw_cad_math.isfinite(value['value']) and type(value['unitSignature']) is list
            and len(value['unitSignature']) == 8
            and all(type(part) is int for part in value['unitSignature'])
            and value['unitSignature'] == current['unitSignature']):
        return {'kind': 'quantity', 'value': float(value['value']), 'unitSignature': list(value['unitSignature'])}
    raise _KfwCadMutationError('invalid_property_value')


def _kfw_cad_mutation_preflight(ctx):
    request, bridge = ctx['request'], ctx['bridge']
    doc, unused_metadata, unused_observation = _kfw_cad_inspection_target(bridge, request)
    ctx['doc'] = doc
    guard = lambda: (_kfw_cad_mutation_guard(ctx), _kfw_cad_inspection_guard(bridge, doc, request))
    guard()
    if (doc.Restoring or doc.Partial or doc.Importing or doc.Recomputing or doc.Transacting
            or doc.RecomputesFrozen or doc.UndoMode <= 0
            or ctx['app'].getActiveTransaction() is not None
            or any(current.HasPendingTransaction for current in ctx['app'].listDocuments().values())):
        raise _KfwCadMutationError('document_busy')
    entries, expressions = [], {}
    for change in request['changes']:
        guard()
        obj = doc.getObject(change['objectName'])
        guard()
        if obj is None:
            raise _KfwCadMutationError('object_missing')
        names = list(obj.PropertiesList)
        guard()
        if change['propertyName'] not in names or 'Proxy' in names:
            raise _KfwCadMutationError('unsupported_property')
        ctx['objects'][change['objectName']] = obj
        if id(obj) not in expressions:
            expressions[id(obj)] = (obj, names, _kfw_cad_object_expressions(obj, names, guard))
        bindings = expressions[id(obj)][2]
        row = _kfw_cad_inspect_property(obj, change['propertyName'], bindings, None, guard)
        if not row['editable']:
            reason = ('read_only' if row['readOnly'] else 'immutable' if row['immutable'] else
                      'expression_bound' if 'expression' in row else 'unsupported_property')
            raise _KfwCadMutationError(reason)
        status = obj.getPropertyStatus(change['propertyName'])
        guard()
        if 18 in status or 'DisableNotify' in status:
            raise _KfwCadMutationError('unsupported_property')
        kind = _KFW_CAD_SCALAR_TYPES.get(row['typeId'])
        before = row['value']
        expected = _kfw_cad_mutation_value(kind, change['expectedValue'], before)
        requested = _kfw_cad_mutation_value(kind, change['value'], before)
        if before != expected:
            raise _KfwCadMutationError('value_changed')
        entries.append({'object': obj, 'propertyName': change['propertyName'], 'typeId': row['typeId'],
                        'kind': kind, 'wanted': before,
                        'receipt': {'objectName': change['objectName'], 'propertyName': change['propertyName'],
                                    'before': before, 'requested': requested, 'observed': before, 'changed': False}})
    ctx['entries'], ctx['expressions'] = entries, list(expressions.values())
    ctx['receipt']['changes'] = [entry['receipt'] for entry in entries]
    guard()


def _kfw_cad_validate_mutation_targets(ctx):
    guard = lambda: _kfw_cad_mutation_guard(ctx)
    guard()
    for obj, names, expressions in ctx['expressions']:
        if _kfw_cad_object_expressions(obj, names, guard) != expressions:
            raise _KfwCadMutationError('expression_changed')
    for entry in ctx['entries']:
        obj, name = entry['object'], entry['propertyName']
        row = _kfw_cad_inspect_property(obj, name, [], None, guard)
        if row['typeId'] != entry['typeId'] or row['readOnly'] or row['immutable'] or not row['editable']:
            raise _KfwCadMutationError('property_changed')
        entry['receipt']['observed'] = row['value']
        entry['receipt']['changed'] = row['value'] != entry['receipt']['before']
        if row['value'] != entry['wanted']:
            raise _KfwCadMutationError('property_not_applied')
    guard()


def _kfw_cad_mutation_transaction_state(ctx):
    try:
        if not _kfw_cad_mutation_alive(ctx):
            return 'unknown'
        active = ctx['app'].getActiveTransaction()
        if active is None and not ctx['doc'].HasPendingTransaction:
            return 'none'
        if ctx['transactionId'] is not None and active == (ctx['transactionName'], ctx['transactionId']):
            return 'own_pending'
        return 'changed'
    except BaseException:
        return 'unknown'


def _kfw_cad_mutation_snapshot(ctx):
    if not _kfw_cad_mutation_alive(ctx):
        return
    try:
        snapshot = ctx['bridge'].snapshot()
        document = next(row for row in snapshot['documents']
                        if row['documentHandle'] == ctx['request']['documentHandle'])
        ctx['receipt']['snapshot'] = {'bridgeEpoch': snapshot['bridgeEpoch'],
                                      'applicationRevision': snapshot['applicationRevision'], 'document': document}
    except BaseException:
        pass


def _kfw_cad_apply_mutation(ctx):
    changing = [entry for entry in ctx['entries'] if entry['receipt']['before'] != entry['receipt']['requested']]
    if not changing:
        ctx['receipt']['outcome'] = 'no_op'
        return
    ctx['documentObjects'] = list(ctx['doc'].Objects)
    _kfw_cad_mutation_guard(ctx)
    ctx['views'] = [obj.ViewObject for obj in ctx['documentObjects']]
    _kfw_cad_mutation_guard(ctx)
    ctx['boundProperties'] = [(obj, {path.lstrip('.') for path, expression in expressions if expression is not None})
                               for obj, names, expressions in ctx['expressions']]
    ctx['phase'] = 'begin'
    ctx['receipt']['mutationStarted'] = True
    ctx['transactionId'] = ctx['app'].setActiveTransaction(ctx['transactionName'], True)
    _kfw_cad_mutation_guard(ctx)
    for entry in changing:
        ctx['phase'] = 'checking'
        _kfw_cad_validate_mutation_targets(ctx)
        ctx['phase'], ctx['current'] = 'assign', entry
        value = entry['receipt']['requested']
        if entry['kind'] == 'quantity':
            owner, current = entry['object'].getPropertyByName(entry['propertyName'], 2)
            _kfw_cad_mutation_guard(ctx)
            if owner is not entry['object']:
                raise _KfwCadMutationError('property_changed')
            unit = current.Unit
            _kfw_cad_mutation_guard(ctx)
            value = ctx['app'].Units.Quantity(value['value'], unit)
            _kfw_cad_mutation_guard(ctx)
        setattr(entry['object'], entry['propertyName'], value)
        entry['wanted'] = entry['receipt']['requested']
        _kfw_cad_mutation_guard(ctx)
        ctx['phase'] = 'checking'
        _kfw_cad_validate_mutation_targets(ctx)
    if ctx['request']['recompute']:
        ctx['phase'] = 'recompute'
        if ctx['doc'].recompute() is False:
            raise _KfwCadMutationError('recompute_failed')
        _kfw_cad_mutation_guard(ctx)
    ctx['phase'] = 'checking'
    _kfw_cad_validate_mutation_targets(ctx)
    if (not ctx['doc'].HasPendingTransaction or not ctx['doc'].UndoNames
            or ctx['doc'].UndoNames[0] != ctx['transactionName']):
        raise _KfwCadMutationError('transaction_changed')
    _kfw_cad_mutation_guard(ctx)
    ctx['phase'] = 'commit'
    ctx['receipt']['commitAttempted'] = True
    ctx['doc'].commitTransaction()
    ctx['phase'] = 'closed'
    _kfw_cad_validate_mutation_targets(ctx)
    if not ctx['receipt']['commitObserved']:
        raise _KfwCadMutationError('commit_unconfirmed')
    ctx['receipt'].update(outcome='committed', transactionState='none')


def _kfw_cad_operation_bytes(receipt):
    return _kfw_cad_json.dumps(receipt, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8') + b'\n'


def _kfw_cad_execute_mutation(paths, app, gui):
    try:
        manifest, request = _kfw_cad_operation_record(paths)
        if _kfw_cad_os.path.lexists(paths['receiptPath']):
            return
        claim = _kfw_cad_json.dumps({'operationId': manifest['operationId'], 'fingerprint': manifest['fingerprint']}).encode('utf-8')
        if not _kfw_cad_publish_operation_file(paths['executionClaimPath'], claim):
            return
    except BaseException:
        return
    receipt = {'protocol': 'kfw-cad-gui-operation/1', 'operationId': manifest['operationId'],
               'fingerprint': manifest['fingerprint'], 'pid': _kfw_cad_os.getpid(),
               'guiThread': True, 'completed': True, 'outcome': 'rejected', 'mutationStarted': False,
               'commitAttempted': False, 'commitObserved': False, 'changes': [], 'transactionState': 'none'}
    ctx = {'paths': paths, 'manifest': manifest, 'request': request, 'receipt': receipt,
           'app': app, 'gui': gui, 'bridge': None, 'doc': None, 'objects': {},
           'entries': [], 'expressions': [], 'documentObjects': [], 'views': [], 'boundProperties': [],
           'transactionId': None, 'transactionName': 'KFW CAD ' + str(_kfw_cad_uuid.uuid4()),
           'phase': 'preflight', 'interference': False, 'controlIdentities': {}, 'controlLost': False}
    registrations = []
    try:
        estimate = dict(receipt, changes=[{'objectName': change['objectName'], 'propertyName': change['propertyName'],
                        'before': change['expectedValue'], 'requested': change['value'],
                        'observed': change['value'], 'changed': True} for change in request['changes']])
        if len(_kfw_cad_operation_bytes(estimate)) + 1024 > _KFW_CAD_RECEIPT_LIMIT:
            raise _KfwCadMutationError('receipt_too_large')
        _kfw_cad_mutation_guard(ctx)
        bridge = _kfw_cad_document_bridge(app, gui)
        ctx['bridge'] = bridge
        if getattr(bridge, 'active_mutation', None) is not None:
            raise _KfwCadMutationError('document_busy')
        bridge.active_mutation = ctx
        _kfw_cad_mutation_preflight(ctx)
        for module, base, surface in ((app, _KfwCadAppObserver, 'app'), (gui, _KfwCadGuiObserver, 'gui')):
            observer = _kfw_cad_trace_observer(ctx, base, surface)
            module.addDocumentObserver(observer)
            registrations.append((module, observer))
        _kfw_cad_mutation_guard(ctx)
        _kfw_cad_apply_mutation(ctx)
    except BaseException as error:
        receipt['outcome'] = 'partial' if receipt['mutationStarted'] else 'rejected'
        receipt['reason'] = error.code if isinstance(error, (_KfwCadMutationError, _KfwCadInspectionError)) else 'native_operation_failed'
        if receipt['mutationStarted']:
            receipt['transactionState'] = 'unknown' if ctx['controlLost'] else _kfw_cad_mutation_transaction_state(ctx)
        else:
            receipt['changes'] = []
    finally:
        for module, observer in reversed(registrations):
            try:
                module.removeDocumentObserver(observer)
            except BaseException:
                pass
        if ctx['bridge'] is not None and getattr(ctx['bridge'], 'active_mutation', None) is ctx:
            ctx['bridge'].active_mutation = None
    if not ctx['controlLost']:
        _kfw_cad_mutation_snapshot(ctx)
    try:
        content = _kfw_cad_operation_bytes(receipt)
        if len(content) > _KFW_CAD_RECEIPT_LIMIT:
            receipt.pop('snapshot', None)
            content = _kfw_cad_operation_bytes(receipt)
        if len(content) <= _KFW_CAD_RECEIPT_LIMIT:
            _kfw_cad_publish_operation_file(paths['receiptPath'], content)
    except BaseException:
        # 提交和磁盘回执不构成原子事务；缺回执由宿主报告unknown，永不重放。
        pass


def _kfw_cad_set_properties(paths):
    import FreeCAD as App
    import FreeCADGui as Gui
    from PySide import QtCore, QtWidgets

    def execute():
        qapp = QtWidgets.QApplication.instance()
        if qapp is None or QtCore.QThread.currentThread() != qapp.thread():
            return
        _kfw_cad_execute_mutation(paths, App, Gui)
    QtCore.QTimer.singleShot(0, execute)
`;
