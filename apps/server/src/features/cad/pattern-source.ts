/** 原生特征阵列；独立完整布尔结果验证所有实例，保留 Body 的多实体设置。 */
export const FREECAD_PATTERN_SOURCE = `
_KFW_PATTERN_TYPES = {
    "PartDesign::LinearPattern": ("length", "Length", "Direction", "direction"),
    "PartDesign::PolarPattern": ("angle", "Angle", "Axis", "axis"),
}
_KFW_PATTERN_ORIGINALS = {"PartDesign::Pad": "add", "PartDesign::Revolution": "add", "PartDesign::Pocket": "cut"}
_KFW_PATTERN_PROPERTY_TYPES = {
    "Length": "App::PropertyLength", "Angle": "App::PropertyAngle",
    "Occurrences": "App::PropertyIntegerConstraint", "Reversed": "App::PropertyBool",
}
_KFW_PATTERN_AXES = {"H_Axis": (1, 0, 0), "V_Axis": (0, 1, 0), "N_Axis": (0, 0, 1)}


def require_pattern_shape(shape, body, label):
    if shape.isNull() or not shape.isValid() or not math.isfinite(shape.Volume) or shape.Volume <= 0:
        raise ValueError("阵列几何为空或无效: " + label)
    solids = shape.countElement("Solid")
    if solids < 1 or (not body.AllowCompound and solids != 1):
        raise ValueError("阵列完整结果有多个实体，当前 Body 未允许多实体: " + label)


def require_pattern_object(obj, body):
    if obj.getStatusString() != "Valid":
        raise ValueError("阵列对象重算未完成: " + obj.Name + " " + obj.getStatusString())
    require_pattern_shape(obj.Shape, body, obj.Name)


def require_pattern_parameter(feature, parameter):
    if feature.getTypeIdOfProperty(parameter) != _KFW_PATTERN_PROPERTY_TYPES[parameter]:
        raise ValueError("阵列参数类型不符: " + feature.Name + "." + parameter)
    status, editor = feature.getPropertyStatus(parameter), feature.getEditorMode(parameter)
    if "ReadOnly" in status or "ReadOnly" in editor or "Immutable" in status:
        raise ValueError("阵列参数不可修改: " + feature.Name + "." + parameter)
    for path, expression in feature.ExpressionEngine:
        path = path.lstrip(".")
        if expression is not None and (path == parameter or path.startswith(parameter + ".") or path.startswith(parameter + "[")):
            raise ValueError("阵列参数已有表达式，不能直接修改: " + feature.Name + "." + parameter)


def pattern_history(body, base):
    history, seen = [], set()
    current = base
    while current is not None:
        if current.Name in seen or current not in body.Group or not current.isDerivedFrom("PartDesign::Feature"):
            raise ValueError("阵列基体历史存在循环或跨 Body 引用: " + body.Name)
        seen.add(current.Name)
        history.append(current)
        current = current.BaseFeature
    return history


def require_pattern_original(body, base, original):
    if original is None or original.TypeId not in _KFW_PATTERN_ORIGINALS or original not in pattern_history(body, base):
        raise ValueError("阵列原件必须是基体历史中的同 Body Pad、Pocket 或 Revolution")
    if original.Suppressed:
        raise ValueError("阵列原件已被抑制: " + original.Name)
    require_pattern_object(original, body)
    if original.getTypeIdOfProperty("AddSubShape") != "Part::PropertyPartShape":
        raise ValueError("阵列原件缺少原生增减材几何: " + original.Name)
    tool = original.AddSubShape
    if tool.isNull() or not tool.isValid() or tool.countElement("Solid") < 1 or not math.isfinite(tool.Volume) or tool.Volume <= 0:
        raise ValueError("阵列原件的增减材几何无效: " + original.Name)


def require_pattern_axis(body, sketch, axis, feature=None):
    if sketch is None or not sketch.isDerivedFrom("Sketcher::SketchObject") or sketch not in body.Group or axis not in _KFW_PATTERN_AXES:
        raise ValueError("阵列方向必须引用同 Body 草图的 H_Axis、V_Axis 或 N_Axis")
    if sketch.getStatusString() != "Valid":
        raise ValueError("阵列方向草图尚未求解: " + sketch.Name)
    if feature is not None:
        members = list(body.Group)
        if members.index(sketch) >= members.index(feature) or feature in sketch.OutListRecursive:
            raise ValueError("阵列方向不能引用自身或后继草图: " + sketch.Name)


def require_pattern_links(feature, body):
    if feature.Suppressed or feature.TransformMode != "Features" or feature.Mode != "Extent":
        raise ValueError("结构化阵列仅支持未抑制的特征总范围模式: " + feature.Name)
    if feature.TypeId == "PartDesign::LinearPattern" and feature.Occurrences2 != 1:
        raise ValueError("结构化阵列仅支持单方向线性阵列: " + feature.Name)
    extent = getattr(feature, _KFW_PATTERN_TYPES[feature.TypeId][1]).Value
    if not math.isfinite(extent) or extent <= 0 or not 1 <= feature.Occurrences <= 2147483647:
        raise ValueError("阵列范围或次数超出原生取值范围: " + feature.Name)
    base, originals = feature.BaseFeature, list(feature.Originals)
    if base is None or base is feature or len(originals) != 1:
        raise ValueError("阵列必须保留基体及唯一原件: " + feature.Name)
    require_pattern_object(base, body)
    require_pattern_original(body, base, originals[0])
    axis_property = _KFW_PATTERN_TYPES[feature.TypeId][2]
    reference = getattr(feature, axis_property)
    if not reference or reference[0] is None or len(reference[1]) != 1:
        raise ValueError("阵列缺少唯一草图轴引用: " + feature.Name)
    sketch, names = reference[0], tuple(reference[1])
    require_pattern_axis(body, sketch, names[0], feature)
    return base, tuple(originals), sketch, names


def pattern_parameters(feature):
    dimension, parameter, unused_axis, unused_field = _KFW_PATTERN_TYPES[feature.TypeId]
    return {dimension: getattr(feature, parameter).Value,
            "occurrences": feature.Occurrences, "reversed": bool(feature.Reversed)}


def assign_pattern_parameters(feature, changes):
    dimension, parameter, unused_axis, unused_field = _KFW_PATTERN_TYPES[feature.TypeId]
    if ("angle" if dimension == "length" else "length") in changes:
        raise ValueError("阵列类型不支持所请求的范围参数: " + feature.Name)
    properties = {dimension: parameter, "occurrences": "Occurrences", "reversed": "Reversed"}
    for field, native in properties.items():
        if field in changes:
            require_pattern_parameter(feature, native)
    # 批改参数统一赋值后，由调用方只重算一次，避免中间组合暂时失效。
    for field, native in properties.items():
        if field in changes:
            setattr(feature, native, changes[field])


def require_pattern_parameter_values(feature, expected, changed):
    actual = pattern_parameters(feature)
    for field, value in expected.items():
        equal = math.isclose(actual[field], value, rel_tol=1e-12, abs_tol=0) if field in ("length", "angle") else actual[field] == value
        if not equal:
            raise ValueError("阵列参数没有保留请求值: " + feature.Name + "." + field)
    dimension, parameter, unused_axis, unused_field = _KFW_PATTERN_TYPES[feature.TypeId]
    for field, native in ((dimension, parameter), ("occurrences", "Occurrences"), ("reversed", "Reversed")):
        if field in changed:
            require_pattern_parameter(feature, native)


def pattern_copy_tools(feature, base, original, sketch, axis):
    count = feature.Occurrences
    if count == 1:
        return []
    tool = original.AddSubShape.copy()
    # 固定 1.1.4 FeatureTransformed.cpp 的原生乘法顺序；保留 AddSubShape 自身 Location。
    transform = original.Placement * base.Shape.Placement.inverse()
    tool.transformShape(transform.toMatrix())
    relative = feature.Placement.inverse() * sketch.Placement
    direction = relative.Rotation.multVec(App.Vector(*_KFW_PATTERN_AXES[axis]))
    if feature.Reversed:
        direction = -direction
    if feature.TypeId == "PartDesign::LinearPattern":
        step = feature.Length.Value / (count - 1)
    else:
        angle = feature.Angle.Value
        # 官方 PolarPattern 使用 OCCT Precision::Confusion() = 1e-7 判定整周。
        step = angle / (count if abs(angle - 360.0) < 1e-7 else count - 1)
    copies = []
    for index in range(1, count):
        copy = tool.copy()
        if feature.TypeId == "PartDesign::LinearPattern":
            copy.translate(direction * (step * index))
        else:
            copy.rotate(relative.Base, direction, step * index)
        copies.append(copy)
    return copies


def pattern_expected_shape(feature, body, links):
    base, originals, sketch, names = links
    expected = base.Shape.copy()
    expected.Placement = App.Placement()
    copies = pattern_copy_tools(feature, base, originals[0], sketch, names[0])
    if copies:
        if _KFW_PATTERN_ORIGINALS[originals[0].TypeId] == "add":
            expected = expected.fuse(tuple(copies))
        else:
            expected = expected.cut(tuple(copies))
    require_pattern_shape(expected, body, feature.Name + " 的完整布尔结果")
    return expected


def require_pattern_equivalent(expected, actual, label):
    if expected.countElement("Solid") != actual.countElement("Solid"):
        raise ValueError("阵列没有保留完整实体数量: " + label)
    for residual in (expected.cut(actual), actual.cut(expected)):
        if not residual.isNull() and (not residual.isValid() or residual.countElement("Solid") != 0):
            raise ValueError("阵列实际结果与全部实例的完整布尔结果不符: " + label)


def validate_pattern_result(feature, body, links):
    require_pattern_object(feature, body)
    expected = pattern_expected_shape(feature, body, links)
    actual = feature.Shape.copy()
    actual.Placement = App.Placement()
    require_pattern_equivalent(expected, actual, feature.Name)
    if body.Tip is None:
        raise ValueError("阵列 Body 缺少末端 Tip: " + body.Name)
    require_pattern_object(body.Tip, body)
    require_pattern_object(body, body)
    # Body 包含 Tip 全部几何；比较统一世界坐标，不漏掉容器或特征 Placement。
    require_pattern_equivalent(global_shape(body.Tip), global_shape(body), body.Name)


def pattern_edit_snapshot(feature, body, links):
    members = list(body.Group)
    return {"tip": body.Tip, "members": members, "links": links,
            "bases": [(obj, obj.BaseFeature) for obj in members if obj.isDerivedFrom("PartDesign::Feature")],
            "views": [(obj, bool(obj.ViewObject.Visibility)) for obj in [body] + members],
            "expressions": tuple(feature.ExpressionEngine),
            "refine": bool(feature.Refine), "allowCompound": bool(body.AllowCompound)}


def require_pattern_snapshot(feature, body, snapshot):
    if body.Tip is not snapshot["tip"] or list(body.Group) != snapshot["members"] or require_pattern_links(feature, body) != snapshot["links"]:
        raise ValueError("阵列参数修改改变了对象、原件、轴引用或末端 Tip: " + feature.Name)
    if any(obj.BaseFeature is not base for obj, base in snapshot["bases"]):
        raise ValueError("阵列参数修改改变了 Body 的基体历史: " + body.Name)
    if any(bool(obj.ViewObject.Visibility) != visible for obj, visible in snapshot["views"]):
        raise ValueError("阵列参数修改改变了原显示状态: " + feature.Name)
    if bool(feature.Refine) != snapshot["refine"] or bool(body.AllowCompound) != snapshot["allowCompound"]:
        raise ValueError("阵列参数修改改变了原精化或多实体设置: " + feature.Name)
    if tuple(feature.ExpressionEngine) != snapshot["expressions"]:
        raise ValueError("阵列参数修改改变了原表达式绑定: " + feature.Name)


def create_pattern(doc, operation):
    type_id = {"create_linear_pattern": "PartDesign::LinearPattern", "create_polar_pattern": "PartDesign::PolarPattern"}[operation["kind"]]
    dimension, parameter, axis_property, axis_field = _KFW_PATTERN_TYPES[type_id]
    doc.recompute()
    body = require_body(doc, operation["body"])
    base = body.Tip
    if base is None or base not in body.Group:
        raise ValueError("阵列 Body 缺少所属实体 Tip: " + body.Name)
    require_pattern_object(base, body)
    original = doc.getObject(operation["original"])
    require_pattern_original(body, base, original)
    reference = operation[axis_field]
    sketch = doc.getObject(reference["sketch"])
    require_pattern_axis(body, sketch, reference["axis"])
    feature = create_named_object(doc, type_id, operation, body)
    feature.BaseFeature = base
    feature.Originals = [original]
    feature.TransformMode = "Features"
    feature.Mode = "Extent"
    if type_id == "PartDesign::LinearPattern":
        feature.Occurrences2 = 1
    setattr(feature, axis_property, (sketch, [reference["axis"]]))
    feature.Refine = True
    values = {dimension: operation[dimension], "occurrences": operation["occurrences"], "reversed": operation.get("reversed", False)}
    assign_pattern_parameters(feature, values)
    body.Tip = feature
    doc.recompute()
    links = require_pattern_links(feature, body)
    if links != (base, (original,), sketch, (reference["axis"],)):
        raise ValueError("原生未保留请求的阵列引用: " + feature.Name)
    require_pattern_parameter_values(feature, values, values)
    validate_pattern_result(feature, body, links)
    base.ViewObject.Visibility = False
    feature.ViewObject.Visibility = True
    return feature


def set_pattern_parameters(doc, operation):
    feature = doc.getObject(operation["object"])
    if feature is None or feature.TypeId not in _KFW_PATTERN_TYPES:
        raise ValueError("参数对象不是线性或环形阵列: " + operation["object"])
    body = feature.getParentGeoFeatureGroup()
    if body is None or not body.isDerivedFrom("PartDesign::Body") or feature not in body.Group:
        raise ValueError("阵列参数对象没有所属 Body: " + feature.Name)
    doc.recompute()
    links = require_pattern_links(feature, body)
    validate_pattern_result(feature, body, links)
    snapshot = pattern_edit_snapshot(feature, body, links)
    expected = {field: value for field, value in operation.items() if field not in ("kind", "object")}
    assign_pattern_parameters(feature, operation)
    doc.recompute()
    require_pattern_parameter_values(feature, expected, operation)
    require_pattern_snapshot(feature, body, snapshot)
    validate_pattern_result(feature, body, links)
    return feature


def pattern_receipt(feature):
    body = feature.getParentGeoFeatureGroup()
    dimension, parameter, axis_property, axis_field = _KFW_PATTERN_TYPES[feature.TypeId]
    reference = getattr(feature, axis_property)
    return {"bodyName": body.Name, "baseFeatureName": feature.BaseFeature.Name,
            "originals": [obj.Name for obj in feature.Originals], "tip": body.Tip.Name if body.Tip else None,
            axis_field: {"sketch": reference[0].Name, "axis": reference[1][0], "subnames": list(reference[1])},
            "mode": feature.Mode, "transformMode": feature.TransformMode,
            dimension: getattr(feature, parameter).Value, "occurrences": feature.Occurrences,
            "reversed": bool(feature.Reversed), "refine": bool(feature.Refine),
            "allowCompound": bool(body.AllowCompound), "volume": feature.Shape.Volume,
            "solids": feature.Shape.countElement("Solid")}
`;
