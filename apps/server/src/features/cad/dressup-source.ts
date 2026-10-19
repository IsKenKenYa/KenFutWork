/** 显式边圆角与等距倒角；选边前检仅操作独立后台 Task 副本中的自有 probe。 */
export const FREECAD_DRESSUP_SOURCE = `
_KFW_DRESSUP_TYPES = {
    "PartDesign::Fillet": ("radius", "Radius", "Fillet radius must be greater than zero"),
    "PartDesign::Chamfer": ("size", "Size", "Size must be greater than zero"),
}


def require_dressup_parameter(feature, parameter):
    if feature.getTypeIdOfProperty(parameter) != "App::PropertyQuantityConstraint":
        raise ValueError("修饰尺寸属性类型不符: " + feature.Name + "." + parameter)
    editor, status = feature.getEditorMode(parameter), feature.getPropertyStatus(parameter)
    if "ReadOnly" in editor or "ReadOnly" in status:
        raise ValueError("修饰尺寸为只读属性: " + feature.Name + "." + parameter)
    if "Immutable" in status:
        raise ValueError("修饰尺寸不可修改: " + feature.Name + "." + parameter)
    for path, expression in feature.ExpressionEngine:
        path = path.lstrip(".")
        if expression is not None and (path == parameter or path.startswith(parameter + ".") or path.startswith(parameter + "[")):
            raise ValueError("修饰尺寸已有表达式，不能直接修改: " + feature.Name + "." + parameter)


def require_dressup_solid(obj):
    status = obj.getStatusString()
    if status != "Valid":
        raise ValueError("修饰对象求解未完成: " + obj.Name + " " + status)
    validate_single_solid(obj)


def resolve_dressup_edges(base, names):
    if not names or len(set(names)) != len(names):
        raise ValueError("修饰特征必须选择非空且不重复的边")
    edges = []
    for name in names:
        try:
            edge = base.Shape.getElement(name)
        except Exception as error:
            raise ValueError("基体边不存在: " + base.Name + "." + name) from error
        if edge.ShapeType != "Edge" or edge.Degenerated:
            raise ValueError("修饰选择不是有效非退化边: " + base.Name + "." + name)
        if any(edge.isSame(previous) for previous in edges):
            raise ValueError("修饰选择重复指向同一条边: " + name)
        edges.append(edge)
    return edges


def require_same_dressup_edges(base, previous, current):
    if len(previous) != len(current):
        raise ValueError("拓扑命名重算改变了选边数量: " + base.Name)
    for old, new in zip(previous, current):
        common = old.common(new).Length
        tolerance = min(1e-7, min(old.Length, new.Length) * 1e-7)
        if common <= 0 or not all(math.isclose(common, length, rel_tol=1e-9, abs_tol=tolerance) for length in (old.Length, new.Length)):
            raise ValueError("拓扑命名重算改变了所选边，请重新查询: " + base.Name)


def prepare_dressup_naming(doc, base, names):
    selected = resolve_dressup_edges(base, names)
    if doc.UseHasher:
        # FreeCAD 1.1.4 的缓存哈希名在重开后首次重算可丢失 StringIDRef 索引。
        # 官方属性只停用名字压缩，保留完整 TNP；仅处理本次后台工程副本。
        doc.UseHasher = False
        if doc.UseHasher:
            raise ValueError("工程未能切换为完整拓扑名称")
        doc.recompute()
        require_dressup_solid(base)
        require_same_dressup_edges(base, selected, resolve_dressup_edges(base, names))
    return selected


def require_dressup_selection(doc, body, base, names, type_id):
    resolve_dressup_edges(base, names)
    unused_dimension, parameter, accepted = _KFW_DRESSUP_TYPES[type_id]
    tip, members = body.Tip, list(body.Group)
    for name in names:
        probe = doc.addObject(type_id, "KfwSelectionProbe")
        probe_name = probe.Name
        try:
            probe.BaseFeature = base
            probe.Base = (base, [name])
            probe.UseAllEdges = False
            if type_id == "PartDesign::Chamfer":
                probe.ChamferType = "Equal distance"
            require_dressup_parameter(probe, parameter)
            setattr(probe, parameter, 0)
            if getattr(probe, parameter).Value != 0:
                raise ValueError("原生选边检查没有保留零参数")
            doc.recompute()
            status = probe.getStatusString()
            if status != accepted or not probe.Shape.isNull() or probe.getParentGeoFeatureGroup() is not None:
                raise ValueError("原生未接纳所选边: " + base.Name + "." + name + " " + status)
        finally:
            if doc.getObject(probe_name) is probe:
                doc.removeObject(probe_name)
            doc.recompute()
        if body.Tip is not tip or list(body.Group) != members:
            raise ValueError("原生选边检查改变了 Body 参数链: " + body.Name)
    require_dressup_solid(base)
    require_dressup_solid(body)


def require_dressup_links(feature, body):
    link = feature.Base
    if not link or link[0] is None or feature.BaseFeature is not link[0]:
        raise ValueError("修饰特征的 Base 与 BaseFeature 不一致: " + feature.Name)
    base = link[0]
    if base not in body.Group or not base.isDerivedFrom("PartDesign::Feature"):
        raise ValueError("修饰基体不是本 Body 的实体特征: " + feature.Name)
    if feature.UseAllEdges:
        raise ValueError("结构化尺寸编辑仅支持显式选边: " + feature.Name)
    if feature.TypeId == "PartDesign::Chamfer" and feature.ChamferType != "Equal distance":
        raise ValueError("结构化 size 仅支持等距倒角: " + feature.Name)
    require_dressup_solid(base)
    names = list(link[1])
    resolve_dressup_edges(base, names)
    return base, names


def validate_dressup_result(feature, body, parameter, value):
    require_dressup_parameter(feature, parameter)
    if not math.isclose(getattr(feature, parameter).Value, value, rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError("修饰尺寸修改未生效: " + feature.Name + "." + parameter)
    require_dressup_solid(feature)
    require_dressup_solid(body)
    if body.Tip is None:
        raise ValueError("修饰 Body 缺少 Tip: " + body.Name)
    require_dressup_solid(body.Tip)
    validate_body_result(body)


def create_dressup(doc, operation):
    type_id = {"create_fillet": "PartDesign::Fillet", "create_chamfer": "PartDesign::Chamfer"}[operation["kind"]]
    dimension, parameter, unused_accepted = _KFW_DRESSUP_TYPES[type_id]
    doc.recompute()
    body = require_body(doc, operation["body"])
    base = doc.getObject(operation["base"])
    if base is None or base is not body.Tip or base not in body.Group or not base.isDerivedFrom("PartDesign::Feature"):
        raise ValueError("修饰基体必须是本 Body 的当前实体 Tip: " + operation["base"])
    require_dressup_solid(base)
    prepare_dressup_naming(doc, base, operation["edges"])
    require_dressup_selection(doc, body, base, operation["edges"], type_id)
    feature = create_named_object(doc, type_id, operation, body)
    feature.Base = (base, operation["edges"])
    feature.UseAllEdges = False
    if type_id == "PartDesign::Chamfer":
        feature.ChamferType = "Equal distance"
    require_dressup_parameter(feature, parameter)
    setattr(feature, parameter, operation[dimension])
    finish_feature(doc, body, feature, None, base)
    validate_dressup_result(feature, body, parameter, operation[dimension])
    actual_base, actual_names = require_dressup_links(feature, body)
    requested_edges = resolve_dressup_edges(base, operation["edges"])
    actual_edges = resolve_dressup_edges(actual_base, actual_names)
    if actual_base is not base or len(actual_edges) != len(requested_edges) or any(not a.isSame(b) for a, b in zip(actual_edges, requested_edges)):
        raise ValueError("原生未保留完整的请求选边: " + feature.Name)
    return feature


def set_dressup_dimension(doc, operation):
    feature = doc.getObject(operation["object"])
    expected = {"radius": "PartDesign::Fillet", "size": "PartDesign::Chamfer"}[operation["dimension"]]
    if feature is None or feature.TypeId != expected:
        raise ValueError("无 profile 的 " + operation["dimension"] + " 尺寸对象类型不匹配: " + operation["object"])
    body = feature.getParentGeoFeatureGroup()
    if body is None or not body.isDerivedFrom("PartDesign::Body") or feature not in body.Group:
        raise ValueError("修饰尺寸对象没有所属 Body: " + feature.Name)
    parameter = _KFW_DRESSUP_TYPES[expected][1]
    doc.recompute()
    require_dressup_parameter(feature, parameter)
    require_dressup_solid(feature)
    base, names = require_dressup_links(feature, body)
    tip = body.Tip
    views = [(obj, bool(obj.ViewObject.Visibility)) for obj in [body] + list(body.Group)]
    selected = prepare_dressup_naming(doc, base, names)
    actual_base, names = require_dressup_links(feature, body)
    if actual_base is not base:
        raise ValueError("拓扑命名重算改变了原基体: " + feature.Name)
    require_same_dressup_edges(base, selected, resolve_dressup_edges(base, names))
    require_dressup_selection(doc, body, base, names, expected)
    # 普通尺寸编辑只改 scalar；Base 的原生 shadow/TNP 链接由 FreeCAD 保持和更新。
    setattr(feature, parameter, operation["value"])
    doc.recompute()
    validate_dressup_result(feature, body, parameter, operation["value"])
    actual_base, actual_names = require_dressup_links(feature, body)
    if actual_base is not base or body.Tip is not tip:
        raise ValueError("修饰尺寸修改改变了原基体或末端 Tip: " + feature.Name)
    if any(bool(obj.ViewObject.Visibility) != visible for obj, visible in views):
        raise ValueError("修饰尺寸修改改变了原显示状态: " + feature.Name)
    require_dressup_selection(doc, body, actual_base, actual_names, expected)
    return feature


def dressup_receipt(feature):
    body = feature.getParentGeoFeatureGroup()
    dimension, parameter, unused_accepted = _KFW_DRESSUP_TYPES[feature.TypeId]
    return {"bodyName": body.Name, "baseFeatureName": feature.BaseFeature.Name,
            "edges": list(feature.Base[1]), "tip": body.Tip.Name if body.Tip else None,
            dimension: getattr(feature, parameter).Value,
            "volume": feature.Shape.Volume, "solids": feature.Shape.countElement("Solid")}
`;
