/** 单次隔离 FreeCADCmd 的 Python 程序；以文本随服务端与桌面打包。 */
export const FREECAD_RUNNER_SOURCE = String.raw`"""KFW FreeCAD worker. Input and output files are private to one invocation."""

import json
import math
import os
import shutil
import traceback

def has_shape_property(obj):
    # App::Part/Origin 基准也会动态响应 .Shape；只有真实属性才是建模几何。
    return "Shape" in obj.PropertiesList


def is_sketch_only_body(obj):
    if not obj.isDerivedFrom("PartDesign::Body") or obj.Tip is not None:
        return False
    features = [member for member in obj.Group if has_shape_property(member)]
    return bool(features) and all(member.isDerivedFrom("Sketcher::SketchObject") for member in features)


def describe(doc):
    objects = []
    for obj in doc.Objects:
        item = {
            "name": obj.Name,
            "label": obj.Label,
            "type": obj.TypeId,
            "state": list(obj.State),
            "properties": list(obj.PropertiesList),
        }
        if hasattr(obj, "Tip"):
            item["tip"] = obj.Tip.Name if obj.Tip else None
        if has_shape_property(obj):
            shape = obj.Shape
            empty = shape.isNull()
            bounds = None if empty else shape.BoundBox
            item["shape"] = {
                "null": empty,
                "valid": not empty and shape.isValid(),
                "solids": 0 if empty else len(shape.Solids),
                "volume": 0 if empty else shape.Volume,
                "area": 0 if empty else shape.Area,
                "faces": 0 if empty else len(shape.Faces),
                "edges": 0 if empty else len(shape.Edges),
                "bounds": None if empty else [bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax],
            }
        objects.append(item)
    return {"name": doc.Name, "label": doc.Label, "objects": objects}


def validate(doc, require_solids=False, expected_volume=None):
    doc.recompute()
    solids = 0
    for obj in doc.Objects:
        if any("error" in state.lower() or "invalid" in state.lower() for state in obj.State):
            raise ValueError("对象重算失败: " + obj.Name + " " + str(obj.State))
        if not has_shape_property(obj):
            continue
        shape = obj.Shape
        if shape.isNull() and is_sketch_only_body(obj):
            # 纯二维草图不产生 Body 实体聚合；Sketch 自身仍在本循环逐项校验。
            continue
        if shape.isNull() or not shape.isValid():
            raise ValueError("对象几何为空或无效: " + obj.Name)
        solids += len(shape.Solids)
    if require_solids and solids == 0:
        raise ValueError("工程没有有效实体")
    if expected_volume:
        obj = doc.getObject(expected_volume["objectName"])
        if not obj or not hasattr(obj, "Shape"):
            raise ValueError("体积检查对象不存在")
        value = obj.Shape.Volume
        if not math.isfinite(value) or not math.isclose(value, expected_volume["value"], rel_tol=0, abs_tol=expected_volume.get("tolerance", 0.000001)):
            raise ValueError("体积不符合预期: " + str(value))


def primitive(doc, args):
    types = {"box": "Part::Box", "cylinder": "Part::Cylinder", "sphere": "Part::Sphere", "cone": "Part::Cone"}
    obj = doc.addObject(types[args["kind"]], "Primitive")
    if "label" in args:
        obj.Label = args["label"]
    for key, prop in [("length", "Length"), ("width", "Width"), ("height", "Height"), ("radius", "Radius"), ("radius2", "Radius2")]:
        if key in args:
            setattr(obj, "Radius1" if args["kind"] == "cone" and key == "radius" else prop, args[key])


def create_named_object(doc, type_id, operation, body=None):
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
    body = None
    if "body" in operation:
        body = doc.getObject(operation["body"])
        if body is None or not body.isDerivedFrom("PartDesign::Body"):
            raise ValueError("草图所属 Body 不存在或类型不符: " + operation["body"])
    sketch = create_named_object(doc, "Sketcher::SketchObject", operation, body)
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
            elif kind == "set_dimension":
                obj = set_sketch_dimension(doc, operation)
            else:
                raise ValueError("不支持的 CAD 操作: " + kind)
            receipt = {"index": index, "kind": kind, "objectName": obj.Name, "type": obj.TypeId}
            if obj.isDerivedFrom("PartDesign::Body"):
                receipt["tip"] = obj.Tip.Name if obj.Tip else None
            if obj.isDerivedFrom("Sketcher::SketchObject"):
                receipt.update(sketch_receipt(obj))
            receipts.append(receipt)
        except Exception as error:
            raise ValueError("第 " + str(index) + " 项操作 " + kind + " 失败: " + str(error)) from error
    return {"operations": receipts}


def publish(source, destination, execution_id):
    # 同目录临时文件 + 独占链接发布；即使目标已存在或跨卷也不覆盖用户文件。
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    partial = destination + ".kfw-" + execution_id + ".partial"
    try:
        with open(source, "rb") as incoming, open(partial, "xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        os.link(partial, destination)
    finally:
        if os.path.isfile(partial):
            os.unlink(partial)


def export_objects(doc, args):
    names = args.get("objectNames")
    if names:
        objects = [doc.getObject(name) for name in names]
        if any(obj is None or not has_shape_property(obj) or obj.Shape.isNull() for obj in objects):
            raise ValueError("导出对象不存在或没有有效几何")
    else:
        # 只有几何消费者替代输入形状；容器、分组和工程图的引用不隐藏零件。
        candidates = [obj for obj in doc.Objects if has_shape_property(obj) and not obj.Shape.isNull()]
        shaped_names = {obj.Name for obj in candidates}
        objects = [obj for obj in candidates if not any(consumer.Name in shaped_names and consumer != obj for consumer in obj.InList)]
    if not objects:
        raise ValueError("没有可导出的几何，请显式选择 objectNames")
    return objects


def global_shape(obj):
    shape = obj.Shape.copy()
    if hasattr(obj, "getGlobalPlacement"):
        # Shape 已包含对象自身 Placement；这里只追加父容器变换。
        shape.Placement = obj.getGlobalPlacement() * obj.Placement.inverse() * shape.Placement
    return shape


def require_task_directory(path, working_directory):
    if not path or os.path.commonpath([os.path.realpath(path), working_directory]) != working_directory:
        raise ValueError("FreeCAD 没有使用本次 Task 的隔离数据或临时目录")
    if not os.path.isdir(path):
        raise ValueError("FreeCAD 的 Task 临时目录不存在")


def initialize_qt(action):
    from PySide import QtCore
    if action not in ("primitive", "python", "operations"):
        return QtCore.QCoreApplication.instance() or QtCore.QCoreApplication([])
    if os.environ.get("QT_QPA_PLATFORM") != "offscreen":
        raise ValueError("CAD 工程创建必须使用隔离的 Qt 离屏平台")
    from PySide import QtWidgets
    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    if not isinstance(application, QtWidgets.QApplication):
        raise ValueError("CAD 工程创建不能从 QCoreApplication 升级为 GUI 应用")
    import FreeCADGui as Gui
    # 完整 GUI 文档注册官方序列化器，但不连接用户可见的 FreeCAD 进程。
    Gui.showMainWindow()
    Gui.getMainWindow().hide()
    return application


def projection(objects, view):
    import TechDraw
    direction = App.Vector(*{"isometric": (1, -1, 1), "top": (0, 0, 1), "front": (0, -1, 0), "right": (1, 0, 0)}[view])
    shape = Part.makeCompound([global_shape(obj) for obj in objects])
    groups = TechDraw.project(shape, direction)
    visible = [group for group in groups[:2] if not group.isNull() and group.Edges]
    if not visible:
        raise ValueError("所选几何在此视图没有可见投影线")
    bounds = App.BoundBox()
    for group in visible:
        bounds.add(group.BoundBox)
    span = max(bounds.XLength, bounds.YLength)
    if not math.isfinite(span) or span <= 0:
        raise ValueError("投影范围无效")
    margin = span * 0.05
    style = {"stroke": "#243447", "stroke-width": str(span / 700), "fill": "none"}
    fragment = TechDraw.projectToSVG(shape, direction, vStyle=style, v0Style=style, v1Style=style)
    # TechDraw 片段自带 scale(1,-1)；viewBox 使用真实投影形状的翻转后坐标。
    viewbox = [bounds.XMin - margin, -bounds.YMax - margin, bounds.XLength + margin * 2, bounds.YLength + margin * 2]
    # 与 FreeCAD Draft 的交换约定一致：一个 SVG 坐标单位对应一毫米。
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + str(viewbox[2]) + 'mm" height="' + str(viewbox[3]) + 'mm" viewBox="' + " ".join(str(value) for value in viewbox) + '" preserveAspectRatio="xMidYMid meet">' + fragment + '</svg>'
    metadata = {"kind": "wireframe", "view": view, "objectNames": [obj.Name for obj in objects], "projectedBounds": [bounds.XMin, bounds.YMin, bounds.XMax, bounds.YMax]}
    return svg, metadata, shape, direction


def describe_error(error):
    reason = str(error) or type(error).__name__
    script_frames = [frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename == "<cad_run_python>"]
    line = script_frames[-1].lineno if script_frames else None
    if isinstance(error, SyntaxError) and error.filename == "<cad_run_python>":
        line = error.lineno
    if line is not None:
        return reason + "（脚本第 " + str(line) + " 行）"
    return reason


def require_live_document(namespace):
    doc = namespace.get("doc")
    try:
        live = doc is not None and App.getDocument(doc.Name) is not None
    except Exception:
        live = False
    if not live:
        raise ValueError("Python 的 doc 已关闭或无效；请将仍存活的文档赋回 doc，再交给工具保存") from None
    return doc


def perform(request):
    args = request["input"]
    if args.get("documentPath"):
        doc = App.openDocument(args["documentPath"])
        # 脚本常用的 doc.save() 也落在工作副本，原工程只作输入。
        if request["action"] not in ("describe", "preview"):
            doc.saveAs(os.path.join(request["workingDirectory"], "input-copy.FCStd"))
    else:
        doc = App.newDocument("KfwModel")
    require_task_directory(doc.TransientDir, os.path.realpath(request["workingDirectory"]))
    action = request["action"]
    if action == "primitive":
        primitive(doc, args)
    elif action == "python":
        namespace = {"App": App, "FreeCAD": App, "Part": Part, "doc": doc, "output_directory": request["workingDirectory"]}
        exec(compile(args["source"], "<cad_run_python>", "exec"), namespace)
        doc = require_live_document(namespace)
    elif action == "operations":
        operation_data = apply_operations(doc, args["operations"])
    validate(doc, action == "primitive" or args.get("requireSolids", False), args.get("expectedVolume"))
    response = {"version": [str(value) for value in App.Version()], "document": describe(doc)}
    if action == "operations":
        response["data"] = operation_data
    if action == "python" and "result" in namespace:
        try:
            # source 的独立 namespace.result 仅成为 data，不能覆盖宿主执行回执。
            response["data"] = json.loads(json.dumps(namespace["result"], allow_nan=False))
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError("Python result 必须是普通 JSON 值；大结果请写入 Task 文件并返回路径") from error
    if action == "describe":
        return response
    destination = request["outputPath"]
    if os.path.lexists(destination):
        raise FileExistsError("输出文件已存在，请使用新文件名: " + destination)
    extension = args["format"] if action == "export" else "svg" if action == "preview" else "FCStd"
    temporary = os.path.join(request["workingDirectory"], "artifact." + extension)
    if action in ("export", "preview"):
        objects = export_objects(doc, args)
        if extension == "step":
            Part.export(objects, temporary)
        elif extension == "stl":
            import Mesh
            Mesh.export(objects, temporary)
        elif extension == "obj":
            import Mesh
            Mesh.export(objects, temporary)
        elif extension == "brep":
            Part.makeCompound([global_shape(obj) for obj in objects]).exportBrep(temporary)
        elif extension in ("svg", "dxf"):
            svg, metadata, shape, direction = projection(objects, args.get("view", "isometric" if action == "preview" else "top"))
            response["preview"] = metadata
            if extension == "svg":
                with open(temporary, "x", encoding="utf-8") as stream:
                    stream.write(svg)
            else:
                import TechDraw
                entities = TechDraw.projectToDXF(shape, direction)
                with open(temporary, "x", encoding="utf-8") as stream:
                    stream.write("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n" + entities + "0\nENDSEC\n0\nEOF\n")
    else:
        App.ParamGet("User parameter:BaseApp/Preferences/Document").SetInt("CountBackupFiles", 0)
        doc.saveAs(temporary)
    if not os.path.isfile(temporary) or os.path.getsize(temporary) == 0:
        raise ValueError("FreeCAD 没有生成有效输出文件")
    publish(temporary, destination, request["executionId"])
    response["outputPath"] = destination
    return response


result_path = os.environ["KFW_CAD_RESULT"]
with open(os.environ["KFW_CAD_REQUEST"], encoding="utf-8") as stream:
    request = json.load(stream)
envelope = {"protocol": "kfw-cad/1", "executionId": request["executionId"], "success": False}
try:
    import FreeCAD as App
    import Part
    # 保留引用：authoring 使用完整离屏 GUI serializer，其余操作只需 Qt 核心事件宿主。
    qt_application = initialize_qt(request["action"])
    for directory in (App.getUserAppDataDir(), App.getUserCachePath(), App.getTempPath()):
        require_task_directory(directory, os.path.realpath(request["workingDirectory"]))
    envelope.update(perform(request))
    envelope["success"] = True
except BaseException as error:
    envelope["error"] = describe_error(error)
    traceback.print_exc()
finally:
    with open(result_path + ".tmp", "x", encoding="utf-8") as stream:
        json.dump(envelope, stream, ensure_ascii=False, allow_nan=False)
    os.replace(result_path + ".tmp", result_path)
    # FreeCADCmd 部分发行包在执行文件后进入交互控制台；结果持久化后显式结束本次进程。
    os._exit(0 if envelope["success"] else 1)
`;
