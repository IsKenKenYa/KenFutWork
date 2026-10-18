import { FREECAD_OPERATIONS_SOURCE } from "./operations-source.js";
import { FREECAD_TOPOLOGY_SOURCE } from "./topology-source.js";

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
            bounds = None if empty else shape.optimalBoundingBox(False, False)
            item["shape"] = {
                "null": empty,
                "valid": not empty and shape.isValid(),
                "solids": 0 if empty else shape.countElement("Solid"),
                "volume": 0 if empty else shape.Volume,
                "area": 0 if empty else shape.Area,
                "faces": 0 if empty else shape.countElement("Face"),
                "edges": 0 if empty else shape.countElement("Edge"),
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


${FREECAD_OPERATIONS_SOURCE}


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


def global_shape(obj, source_shape=None):
    shape = (obj.Shape if source_shape is None else source_shape).copy()
    if hasattr(obj, "getGlobalPlacement"):
        # Shape 已包含对象自身 Placement；这里只追加父容器变换。
        shape.Placement = obj.getGlobalPlacement() * obj.Placement.inverse() * shape.Placement
    return shape


${FREECAD_TOPOLOGY_SOURCE}


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
    if action == "describe" and "edges" in args:
        response["edgePage"] = edge_page(doc, args["edges"])
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
