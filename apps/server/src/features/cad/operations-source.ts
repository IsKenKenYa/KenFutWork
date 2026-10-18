/** 可信结构化建模操作；由 FreeCAD runner 在同一 Task 进程中装配。 */
export const FREECAD_OPERATIONS_SOURCE = `def create_named_object(doc, type_id, operation, body=None):
    name = operation["name"]
    if doc.getObject(name) is not None:
        raise ValueError("对象名称已存在: " + name)
    obj = body.newObject(type_id, name) if body is not None else doc.addObject(type_id, name)
    if obj.Name != name:
        raise ValueError("FreeCAD 自动修改了对象名称: " + name + " -> " + obj.Name)
    if "label" in operation:
        obj.Label = operation["label"]
    return obj


def position_constraints(geometry_index, point_index, coordinates):
    import Sketcher
    # 草图外部轴 -1 为 X 轴、-2 为 Y 轴；零距离使用轴上约束避免退化。
    return [
        Sketcher.Constraint("PointOnObject", geometry_index, point_index, axis)
        if value == 0 else Sketcher.Constraint(dimension, geometry_index, point_index, value)
        for value, axis, dimension in zip(coordinates, (-2, -1), ("DistanceX", "DistanceY"))
    ]


def add_named_dimension(sketch, name, constraint):
    if any(existing.Name == name for existing in sketch.Constraints):
        raise ValueError("草图尺寸名称重复: " + name)
    index = sketch.addConstraint(constraint)
    sketch.renameConstraint(index, name)
    if sketch.Constraints[index].Name != name:
        raise ValueError("FreeCAD 自动修改了尺寸名称: " + name)


def add_rectangle_profile(sketch, profile):
    import Sketcher
    x, y = profile.get("origin", [0, 0])
    width, height = profile["width"], profile["height"]
    points = [App.Vector(x, y, 0), App.Vector(x + width, y, 0), App.Vector(x + width, y + height, 0), App.Vector(x, y + height, 0)]
    first = sketch.GeometryCount
    sketch.addGeometry([Part.LineSegment(points[index], points[(index + 1) % 4]) for index in range(4)], False)
    constraints = [Sketcher.Constraint("Coincident", first + index, 2, first + (index + 1) % 4, 1) for index in range(4)]
    constraints.extend(Sketcher.Constraint("Horizontal", first + index) for index in (0, 2))
    constraints.extend(Sketcher.Constraint("Vertical", first + index) for index in (1, 3))
    sketch.addConstraint(constraints + position_constraints(first, 1, [x, y]))
    add_named_dimension(sketch, profile["name"] + "_Width", Sketcher.Constraint("DistanceX", first, 1, first, 2, width))
    add_named_dimension(sketch, profile["name"] + "_Height", Sketcher.Constraint("DistanceY", first + 1, 1, first + 1, 2, height))


def add_circle_profile(sketch, profile):
    import Sketcher
    x, y = profile.get("center", [0, 0])
    index = sketch.addGeometry(Part.Circle(App.Vector(x, y, 0), App.Vector(0, 0, 1), profile["radius"]), False)
    sketch.addConstraint(position_constraints(index, 3, [x, y]))
    add_named_dimension(sketch, profile["name"] + "_Radius", Sketcher.Constraint("Radius", index, profile["radius"]))


def validate_sketch(doc, sketch):
    doc.recompute()
    status = sketch.solve()
    if status != 0:
        raise ValueError("草图求解失败: " + sketch.Name + "，状态 " + str(status))
    doc.recompute()
    if not sketch.FullyConstrained:
        raise ValueError("草图未完全约束: " + sketch.Name)
    if sketch.Shape.isNull() or not sketch.Shape.isValid():
        raise ValueError("草图几何为空或无效: " + sketch.Name)


def sketch_receipt(sketch):
    dimensions = {}
    for index, constraint in enumerate(sketch.Constraints):
        if constraint.Name and constraint.Type in ("DistanceX", "DistanceY", "Radius") and sketch.getDriving(index) and sketch.getActive(index):
            if constraint.Name in dimensions:
                raise ValueError("草图尺寸名称重复: " + constraint.Name)
            dimensions[constraint.Name] = sketch.getDatum(index).Value
    return {"geometryCount": sketch.GeometryCount, "fullyConstrained": bool(sketch.FullyConstrained), "dimensions": dimensions}


def create_sketch(doc, operation):
    body = require_body(doc, operation["body"]) if "body" in operation else None
    support_pad = None
    if "supportPad" in operation:
        if body is None:
            raise ValueError("支持 Pad 的草图必须指定 Body")
        support_pad = require_fixed_pad(doc.getObject(operation["supportPad"]), body)
        if body.Tip != support_pad:
            raise ValueError("支持 Pad 不是 Body 当前 Tip")
    sketch = create_named_object(doc, "Sketcher::SketchObject", operation, body)
    sketch.MapMode = "Deactivated"
    if support_pad is not None:
        sketch.setExpression("Placement.Base.z", support_pad.Name + ".Length")
    names = set()
    for profile in operation["profiles"]:
        if profile["name"] in names:
            raise ValueError("同一草图的轮廓名称重复: " + profile["name"])
        names.add(profile["name"])
        if profile["kind"] == "rectangle":
            add_rectangle_profile(sketch, profile)
        elif profile["kind"] == "circle":
            add_circle_profile(sketch, profile)
        else:
            raise ValueError("不支持的草图轮廓: " + profile["kind"])
    validate_sketch(doc, sketch)
    sketch.ViewObject.Visibility = True
    return sketch


def set_sketch_dimension(doc, operation):
    sketch = doc.getObject(operation["object"])
    if sketch is None or not sketch.isDerivedFrom("Sketcher::SketchObject"):
        raise ValueError("尺寸对象不存在或不是草图: " + operation["object"])
    suffix, expected_type = {"width": ("_Width", "DistanceX"), "height": ("_Height", "DistanceY"), "radius": ("_Radius", "Radius")}[operation["dimension"]]
    name = operation["profile"] + suffix
    matches = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
    if len(matches) != 1:
        raise ValueError("命名尺寸不存在或不唯一: " + name)
    index = matches[0]
    if sketch.Constraints[index].Type != expected_type:
        raise ValueError("命名尺寸类型不匹配: " + name)
    if not sketch.getDriving(index):
        raise ValueError("命名尺寸是参考约束，不能修改: " + name)
    if not sketch.getActive(index):
        raise ValueError("命名尺寸已停用，不能修改: " + name)
    # 官方 ExpressionEngine 同时保留索引路径与带前导点的命名路径，不解除既有绑定。
    paths = {"Constraints[" + str(index) + "]", "Constraints." + name, "Constraints.<<" + name + ">>"}
    if any(path.lstrip(".") in paths and expression is not None for path, expression in sketch.ExpressionEngine):
        raise ValueError("命名尺寸已有表达式，不能直接修改: " + name)
    sketch.setDatum(index, operation["value"])
    validate_sketch(doc, sketch)
    if not math.isclose(sketch.getDatum(index).Value, operation["value"], rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError("尺寸修改未生效: " + name)
    body = sketch.getParentGeoFeatureGroup()
    if body is not None and body.isDerivedFrom("PartDesign::Body") and body.Tip is not None:
        validate_body_result(body)
    return sketch


def apply_operations(doc, operations):
    receipts = []
    for index, operation in enumerate(operations, 1):
        kind = operation["kind"]
        try:
            if kind == "create_body":
                obj = create_named_object(doc, "PartDesign::Body", operation)
                doc.recompute()
            elif kind == "create_sketch":
                obj = create_sketch(doc, operation)
            elif kind == "create_pad":
                obj = create_pad(doc, operation)
            elif kind == "create_revolution":
                obj = create_revolution(doc, operation)
            elif kind == "create_boolean":
                obj = create_boolean(doc, operation)
            elif kind == "create_pocket":
                obj = create_pocket(doc, operation)
            elif kind == "set_dimension" and operation["dimension"] == "angle":
                obj = set_revolution_angle(doc, operation)
            elif kind == "set_dimension":
                obj = set_feature_dimension(doc, operation) if operation["dimension"] in ("length", "depth") else set_sketch_dimension(doc, operation)
            else:
                raise ValueError("不支持的 CAD 操作: " + kind)
            receipt = {"index": index, "kind": kind, "objectName": obj.Name, "type": obj.TypeId}
            if obj.isDerivedFrom("PartDesign::Body"):
                receipt["tip"] = obj.Tip.Name if obj.Tip else None
            if obj.isDerivedFrom("Sketcher::SketchObject"):
                receipt.update(sketch_receipt(obj))
                receipt["placementZ"] = obj.Placement.Base.z
                if "supportPad" in operation:
                    receipt["supportPad"] = doc.getObject(operation["supportPad"]).Name
            if obj.TypeId in ("PartDesign::Pad", "PartDesign::Pocket", "PartDesign::Revolution"):
                receipt.update(feature_receipt(obj))
            elif obj.TypeId == "PartDesign::Boolean":
                receipt.update(boolean_receipt(obj))
            receipts.append(receipt)
        except Exception as error:
            raise ValueError("第 " + str(index) + " 项操作 " + kind + " 失败: " + str(error)) from error
    return {"operations": receipts}


def require_body(doc, name):
    body = doc.getObject(name)
    if body is None or not body.isDerivedFrom("PartDesign::Body"):
        raise ValueError("Body 不存在或类型不符: " + name)
    return body


def require_body_sketch(doc, body, name):
    sketch = doc.getObject(name)
    if sketch is None or not sketch.isDerivedFrom("Sketcher::SketchObject") or sketch not in body.Group:
        raise ValueError("轮廓不是本 Body 的草图: " + name)
    validate_sketch(doc, sketch)
    return sketch


def require_free_xy_sketch(sketch, z=0.0, support_pad=None):
    placement = sketch.Placement
    if sketch.MapMode != "Deactivated" or not math.isclose(placement.Rotation.Angle, 0, abs_tol=1e-9):
        raise ValueError("结构化特征需要自由放置的 XY 草图: " + sketch.Name)
    if any(not math.isclose(actual, expected, abs_tol=1e-9) for actual, expected in zip((placement.Base.x, placement.Base.y, placement.Base.z), (0.0, 0.0, z))):
        raise ValueError("草图局部位置不符合特征平面: " + sketch.Name)
    expressions = [(path.lstrip("."), expression) for path, expression in sketch.ExpressionEngine if path.lstrip(".").startswith("Placement")]
    expected = [("Placement.Base.z", support_pad.Name + ".Length")] if support_pad is not None else []
    if expressions != expected:
        raise ValueError("草图位置表达式与支持 Pad 不符: " + sketch.Name)


def require_fixed_pad(pad, body):
    if pad is None or pad.TypeId != "PartDesign::Pad" or pad not in body.Group:
        raise ValueError("支持对象不是本 Body 的 Pad")
    types = pad.getEnumerationsOfProperty("Type")
    if pad.Type != types[0] or pad.SideType != "One side" or pad.Reversed or pad.UseCustomVector or not pad.AlongSketchNormal:
        raise ValueError("结构化工具仅支持正向单侧定长 Pad: " + pad.Name)
    sketch = require_body_sketch(pad.Document, body, pad.Profile[0].Name)
    require_free_xy_sketch(sketch)
    return pad


def require_fixed_revolution(feature, body):
    if feature is None or feature.TypeId != "PartDesign::Revolution" or feature not in body.Group:
        raise ValueError("对象不是本 Body 的 Revolution")
    if feature.Type != "Angle" or feature.Midplane or feature.Reversed or feature.BaseFeature is not None:
        raise ValueError("结构化工具仅支持首个正向单侧固定角 Revolution: " + feature.Name)
    if not math.isfinite(feature.Angle.Value) or not 0 < feature.Angle.Value <= 360:
        raise ValueError("Revolution 角度不在 (0,360] 范围: " + feature.Name)
    profile = feature.Profile
    if not profile or profile[0] is None:
        raise ValueError("Revolution 缺少草图 Profile: " + feature.Name)
    sketch = require_body_sketch(feature.Document, body, profile[0].Name)
    require_free_xy_sketch(sketch)
    axis = feature.ReferenceAxis
    if not axis or axis[0] != sketch or list(axis[1]) not in (["H_Axis"], ["V_Axis"]):
        raise ValueError("Revolution 必须绕本草图局部 X/Y 轴: " + feature.Name)
    return feature


def validate_single_solid(obj):
    if any("error" in state.lower() or "invalid" in state.lower() for state in obj.State):
        raise ValueError("特征重算失败: " + obj.Name + " " + str(obj.State))
    shape = obj.Shape
    if shape.isNull() or not shape.isValid() or len(shape.Solids) != 1 or not math.isfinite(shape.Volume) or shape.Volume <= 0:
        raise ValueError("特征没有有效单实体: " + obj.Name)


def validate_body_result(body):
    if body is None or body.Tip is None:
        raise ValueError("Body 缺少实体 Tip")
    validate_single_solid(body.Tip)
    validate_single_solid(body)
    if body.Tip.TypeId == "PartDesign::Pocket":
        pocket = body.Tip
        base = pocket.BaseFeature
        if base is None or not pocket.Shape.Volume < base.Shape.Volume - 1e-9:
            raise ValueError("Pocket 没有实际切除材料: " + pocket.Name)


def finish_feature(doc, body, feature, profile, previous):
    doc.recompute()
    validate_single_solid(feature)
    body.Tip = feature
    doc.recompute()
    validate_body_result(body)
    if profile is not None:
        profile.ViewObject.Visibility = False
    if previous is not None:
        previous.ViewObject.Visibility = False
    feature.ViewObject.Visibility = True


def require_first_solid_feature(body, feature_name):
    if any(has_shape_property(member) and not member.isDerivedFrom("Sketcher::SketchObject") for member in body.Group):
        raise ValueError("结构化 " + feature_name + " 必须是 Body 的首个实体特征")


def create_pad(doc, operation):
    body = require_body(doc, operation["body"])
    require_first_solid_feature(body, "Pad")
    sketch = require_body_sketch(doc, body, operation["profile"])
    require_free_xy_sketch(sketch)
    feature = create_named_object(doc, "PartDesign::Pad", operation, body)
    feature.Profile = sketch
    feature.Type = 0
    feature.SideType = "One side"
    feature.Reversed = False
    feature.UseCustomVector = False
    feature.AlongSketchNormal = True
    feature.Length = operation["length"]
    finish_feature(doc, body, feature, sketch, None)
    return feature


def create_revolution(doc, operation):
    body = require_body(doc, operation["body"])
    require_first_solid_feature(body, "Revolution")
    sketch = require_body_sketch(doc, body, operation["profile"])
    require_free_xy_sketch(sketch)
    feature = create_named_object(doc, "PartDesign::Revolution", operation, body)
    feature.Profile = sketch
    feature.ReferenceAxis = (sketch, [{"x": "H_Axis", "y": "V_Axis"}[operation["axis"]]])
    feature.Type = "Angle"
    feature.Midplane = False
    feature.Reversed = False
    feature.Angle = operation["angle"]
    finish_feature(doc, body, feature, sketch, None)
    require_fixed_revolution(feature, body)
    if not math.isclose(feature.Angle.Value, operation["angle"], rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError("旋转角度创建未生效: " + feature.Name)
    return feature


def create_pocket(doc, operation):
    body = require_body(doc, operation["body"])
    pad = require_fixed_pad(body.Tip, body)
    sketch = require_body_sketch(doc, body, operation["profile"])
    if sketch == pad.Profile[0]:
        raise ValueError("Pocket 不能复用 Pad 的基础草图")
    if any("Profile" in consumer.PropertiesList and consumer.Profile and consumer.Profile[0] == sketch for consumer in sketch.InList):
        raise ValueError("草图已被其它特征使用: " + sketch.Name)
    require_free_xy_sketch(sketch, pad.Length.Value, pad)
    feature = create_named_object(doc, "PartDesign::Pocket", operation, body)
    feature.Profile = sketch
    feature.Type = 1 if operation["mode"] == "through_all" else 0
    feature.SideType = "One side"
    feature.Reversed = False
    feature.UseCustomVector = False
    feature.AlongSketchNormal = True
    if operation["mode"] == "depth":
        feature.Length = operation["depth"]
    finish_feature(doc, body, feature, sketch, pad)
    return feature


def require_boolean_body(doc, name):
    body = require_body(doc, name)
    tip = body.Tip
    if tip is None or tip not in body.Group or not tip.isDerivedFrom("PartDesign::Feature"):
        raise ValueError("布尔 Body 缺少所属实体 Tip: " + name)
    validate_body_result(body)
    return body


def create_boolean(doc, operation):
    names = operation["toolBodies"]
    if not names or len(set(names)) != len(names) or operation["body"] in names:
        raise ValueError("布尔工具 Body 不能为空、重复或包含目标 Body")
    doc.recompute()
    body = require_boolean_body(doc, operation["body"])
    tools = [require_boolean_body(doc, name) for name in names]
    for tool in tools:
        if body in tool.OutListRecursive:
            raise ValueError("工具 Body 依赖目标 Body，不能创建循环布尔特征: " + tool.Name)
        owner = tool.getParentGeoFeatureGroup()
        if owner is not None and owner.isDerivedFrom("PartDesign::Boolean"):
            raise ValueError("工具 Body 已被布尔特征使用: " + tool.Name)
    previous = body.Tip
    feature = create_named_object(doc, "PartDesign::Boolean", operation, body)
    feature.setObjects(tools)
    mode = {"fuse": 0, "cut": 1, "common": 2}[operation["operation"]]
    feature.Type = mode
    finish_feature(doc, body, feature, None, previous)
    if (feature.BaseFeature != previous or list(feature.Group) != tools
            or feature.Type != feature.getEnumerationsOfProperty("Type")[mode]):
        raise ValueError("布尔特征的基体、工具或模式没有按请求保留: " + feature.Name)
    for tool in tools:
        tool.ViewObject.Visibility = False
    body.ViewObject.Visibility = True
    return feature


def boolean_receipt(feature):
    body = feature.getParentGeoFeatureGroup()
    mode = list(feature.getEnumerationsOfProperty("Type")).index(str(feature.Type))
    return {"bodyName": body.Name, "baseFeatureName": feature.BaseFeature.Name,
            "toolBodyNames": [tool.Name for tool in feature.Group],
            "operation": ("fuse", "cut", "common")[mode], "tip": body.Tip.Name,
            "volume": feature.Shape.Volume, "solids": len(feature.Shape.Solids)}


def set_feature_dimension(doc, operation):
    feature = doc.getObject(operation["object"])
    expected_type = "PartDesign::Pad" if operation["dimension"] == "length" else "PartDesign::Pocket"
    if feature is None or feature.TypeId != expected_type:
        raise ValueError("尺寸对象类型不匹配: " + operation["object"])
    body = feature.getParentGeoFeatureGroup()
    if body is None or not body.isDerivedFrom("PartDesign::Body"):
        raise ValueError("尺寸对象没有所属 Body")
    if expected_type == "PartDesign::Pad":
        require_fixed_pad(feature, body)
    elif feature.Type != feature.getEnumerationsOfProperty("Type")[0] or feature.SideType != "One side" or feature.Reversed or feature.UseCustomVector or not feature.AlongSketchNormal:
        raise ValueError("仅有限深度单侧 Pocket 可以修改 depth")
    else:
        pad = require_fixed_pad(feature.BaseFeature, body)
        sketch = require_body_sketch(doc, body, feature.Profile[0].Name)
        require_free_xy_sketch(sketch, pad.Length.Value, pad)
    if any(path.lstrip(".") == "Length" and expression is not None for path, expression in feature.ExpressionEngine):
        raise ValueError("特征长度已有表达式，不能直接修改: " + feature.Name)
    feature.Length = operation["value"]
    doc.recompute()
    if not math.isclose(feature.Length.Value, operation["value"], rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError("特征尺寸修改未生效: " + feature.Name)
    validate_single_solid(feature)
    validate_body_result(body)
    return feature


def set_revolution_angle(doc, operation):
    feature = doc.getObject(operation["object"])
    if feature is None or feature.TypeId != "PartDesign::Revolution":
        raise ValueError("尺寸对象不是 Revolution: " + operation["object"])
    body = feature.getParentGeoFeatureGroup()
    if body is None or not body.isDerivedFrom("PartDesign::Body"):
        raise ValueError("旋转对象没有所属 Body")
    require_fixed_revolution(feature, body)
    if any(path.lstrip(".") == "Angle" and expression is not None for path, expression in feature.ExpressionEngine):
        raise ValueError("旋转角度已有表达式，不能直接修改: " + feature.Name)
    tip = body.Tip
    feature.Angle = operation["value"]
    doc.recompute()
    if not math.isclose(feature.Angle.Value, operation["value"], rel_tol=1e-9, abs_tol=1e-9):
        raise ValueError("旋转角度修改未生效: " + feature.Name)
    if body.Tip != tip:
        raise ValueError("旋转角度修改意外改变 Body.Tip: " + body.Name)
    validate_single_solid(feature)
    validate_body_result(body)
    return feature


def feature_receipt(feature):
    body = feature.getParentGeoFeatureGroup()
    receipt = {"bodyName": body.Name, "profileName": feature.Profile[0].Name,
               "baseFeatureName": feature.BaseFeature.Name if feature.BaseFeature else None,
               "tip": body.Tip.Name if body.Tip else None,
               "volume": feature.Shape.Volume, "solids": len(feature.Shape.Solids)}
    if feature.TypeId == "PartDesign::Pad":
        receipt["length"] = feature.Length.Value
    elif feature.TypeId == "PartDesign::Pocket":
        mode = "depth" if feature.Type == feature.getEnumerationsOfProperty("Type")[0] else "through_all"
        receipt["mode"] = mode
        if mode == "depth":
            receipt["depth"] = feature.Length.Value
    else:
        receipt["axis"] = {"H_Axis": "x", "V_Axis": "y"}[feature.ReferenceAxis[1][0]]
        receipt["angle"] = feature.Angle.Value
    return receipt
`;
