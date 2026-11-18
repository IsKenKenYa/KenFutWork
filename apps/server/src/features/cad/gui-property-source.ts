/** 固定只读属性投影；仅调用已核对的原生属性 API，不执行表达式。 */
export const CAD_GUI_PROPERTY_INSPECTION_SOURCE = `
import math as _kfw_cad_math

_KFW_CAD_SCALAR_TYPES = {
    'App::PropertyBool': 'boolean',
    'App::PropertyInteger': 'integer',
    'App::PropertyIntegerConstraint': 'integer',
    'App::PropertyPercent': 'integer',
    'App::PropertyFloat': 'number',
    'App::PropertyFloatConstraint': 'number',
    'App::PropertyString': 'string',
    'App::PropertyEnumeration': 'enumeration',
    'App::PropertyQuantity': 'quantity',
    'App::PropertyQuantityConstraint': 'quantity',
    'App::PropertyLength': 'quantity',
    'App::PropertyDistance': 'quantity',
    'App::PropertyAngle': 'quantity',
    'App::PropertyArea': 'quantity',
    'App::PropertyVolume': 'quantity',
}


class _KfwCadInspectionError(Exception):
    def __init__(self, code):
        self.code = code


def _kfw_cad_inspection_target(bridge, request):
    observation = bridge.snapshot()
    if (observation['bridgeEpoch'] != request['bridgeEpoch']
            or observation['applicationRevision'] != request['expectedApplicationRevision']):
        raise _KfwCadInspectionError('stale_target')
    document = next((row for row in observation['documents']
                     if row['documentHandle'] == request['documentHandle']), None)
    if document is None or document['revision'] != request['expectedDocumentRevision']:
        raise _KfwCadInspectionError('stale_target')
    record = next((record for record in bridge.documents.values()
                   if not record['closed'] and record['handle'] == request['documentHandle']), None)
    if record is None or not bridge.listed(record['object']):
        raise _KfwCadInspectionError('stale_target')
    return record['object'], document, observation


def _kfw_cad_inspection_guard(bridge, doc, request):
    bridge.require_valid()
    record = bridge.find(doc)
    if (bridge.epoch != request['bridgeEpoch']
            or bridge.application_revision != request['expectedApplicationRevision']
            or record is None or record['closed']
            or record['handle'] != request['documentHandle']
            or record['revision'] != request['expectedDocumentRevision']
            or not bridge.listed(doc)):
        raise _KfwCadInspectionError('stale_target')


def _kfw_cad_native_value(kind, value, guard):
    if kind == 'boolean' and type(value) is bool:
        return value
    if kind in ('string', 'enumeration') and type(value) is str:
        return value
    if kind == 'integer' and type(value) is int and abs(value) <= _KFW_CAD_MAX_REVISION:
        return value
    if kind == 'number' and type(value) in (int, float) and _kfw_cad_math.isfinite(value):
        return float(value)
    if kind == 'quantity':
        number = value.Value
        guard()
        unit = value.Unit
        guard()
        signature = unit.Signature
        guard()
        if (type(number) in (int, float) and _kfw_cad_math.isfinite(number)
                and type(signature) in (list, tuple) and len(signature) == 8
                and all(type(part) is int and abs(part) <= _KFW_CAD_MAX_REVISION for part in signature)):
            return {'kind': 'quantity', 'value': float(number), 'unitSignature': list(signature)}
    raise _KfwCadInspectionError('unsupported_value')


def _kfw_cad_object_expressions(obj, names, guard):
    if 'ExpressionEngine' not in names:
        return []
    type_id = obj.getTypeIdOfProperty('ExpressionEngine')
    guard()
    if type_id != 'App::PropertyExpressionEngine':
        raise _KfwCadInspectionError('unsupported_expression_engine')
    owner, expressions = obj.getPropertyByName('ExpressionEngine', 2)
    guard()
    if owner is not obj or type(expressions) is not list:
        raise _KfwCadInspectionError('unsupported_expression_engine')
    for item in expressions:
        if (type(item) not in (list, tuple) or len(item) != 2
                or type(item[0]) is not str
                or (item[1] is not None and type(item[1]) is not str)):
            raise _KfwCadInspectionError('unsupported_expression_engine')
    return expressions


def _kfw_cad_inspect_property(obj, name, expressions, expression_error, guard):
    guard()
    type_id = obj.getTypeIdOfProperty(name)
    guard()
    editor = obj.getEditorMode(name)
    guard()
    status = obj.getPropertyStatus(name)
    guard()
    row = {'name': name, 'typeId': type_id,
           'readOnly': 'ReadOnly' in editor or 'ReadOnly' in status,
           'immutable': 'Immutable' in status, 'editable': False}
    kind = _KFW_CAD_SCALAR_TYPES.get(type_id)
    if kind is None:
        row['unsupportedReason'] = 'unsupported_property_type'
        return row
    try:
        owner, value = obj.getPropertyByName(name, 2)
        guard()
        if owner is not obj:
            row['unsupportedReason'] = 'forwarded_property'
            return row
        row['value'] = _kfw_cad_native_value(kind, value, guard)
    except _KfwCadInspectionError as error:
        if error.code == 'stale_target':
            raise
        row['unsupportedReason'] = 'unsupported_property_value'
        return row
    except BaseException:
        row['unsupportedReason'] = 'unsupported_property_value'
        return row
    if expression_error is not None:
        row['unsupportedReason'] = expression_error
        return row
    bindings = [expression for path, expression in expressions
                if path.lstrip('.') == name and expression is not None]
    complex_binding = any(expression is not None and
                          (path.lstrip('.').startswith(name + '.')
                           or path.lstrip('.').startswith(name + '['))
                          for path, expression in expressions)
    if len(bindings) > 1 or complex_binding:
        row['unsupportedReason'] = 'unsupported_expression_binding'
        return row
    if bindings:
        row['expression'] = bindings[0]
    if kind == 'enumeration':
        row['unsupportedReason'] = 'enumeration_requires_choices'
    else:
        row['editable'] = not row['readOnly'] and not row['immutable'] and not bindings
    return row


def _kfw_cad_object_metadata(obj, guard):
    name = obj.Name
    guard()
    label = obj.Label
    guard()
    type_id = obj.TypeId
    guard()
    return {'name': name, 'label': label, 'typeId': type_id}


def _kfw_cad_inspect_object(obj, guard):
    names = list(obj.PropertiesList)
    guard()
    expressions, expression_error = [], None
    try:
        expressions = _kfw_cad_object_expressions(obj, names, guard)
    except _KfwCadInspectionError as error:
        if error.code == 'stale_target':
            raise
        expression_error = error.code
    properties = []
    for name in names:
        guard()
        properties.append(_kfw_cad_inspect_property(obj, name, expressions, expression_error, guard))
        guard()
    return dict(_kfw_cad_object_metadata(obj, guard), properties=properties)


def _kfw_cad_inspect_document(bridge, request):
    doc, unused_metadata, unused_observation = _kfw_cad_inspection_target(bridge, request)
    guard = lambda: _kfw_cad_inspection_guard(bridge, doc, request)
    objects = list(doc.Objects)
    guard()
    by_name = {}
    for obj in objects:
        guard()
        name = obj.Name
        guard()
        by_name[name] = obj
    if len(by_name) != len(objects):
        raise _KfwCadInspectionError('stale_target')
    selected = request.get('objectNames')
    if selected is not None and any(name not in by_name for name in selected):
        raise _KfwCadInspectionError('object_missing')
    rows = []
    chosen = objects if selected is None else [by_name[name] for name in selected]
    for obj in chosen:
        guard()
        name = obj.Name
        guard()
        current = doc.getObject(name)
        guard()
        if current is not obj:
            raise _KfwCadInspectionError('stale_target')
        rows.append(_kfw_cad_object_metadata(obj, guard)
                    if selected is None else _kfw_cad_inspect_object(obj, guard))
    final_doc, final_metadata, final_observation = _kfw_cad_inspection_target(bridge, request)
    if final_doc is not doc:
        raise _KfwCadInspectionError('stale_target')
    return {'bridgeEpoch': final_observation['bridgeEpoch'],
            'applicationRevision': final_observation['applicationRevision'],
            'document': final_metadata, 'objects': rows}
`;
