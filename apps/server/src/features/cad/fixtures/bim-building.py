"""FreeCAD 1.1.4 官方 Draft/Arch 工厂的有限 BIM 参数工程验收。

宿主提供 App、Part、doc、output_directory。只创建独立 Task 工程，
不设置墙柱的最终 Shape，不写全局偏好；FCStd 发布由 KFW 完成。
IFC 导出使用完整局部 preferences，STORE_UID 仅修改本次工作副本。
接口依据：随包 Arch.py、ArchWall.py、ArchStructure.py、
ArchBuildingPart.py 与 importers/exportIFC.py。
"""

import hashlib
import math
import os

import Arch
import ArchBuildingPart
import ArchStructure
import ArchWall
import Draft
import ifcopenshell
from draftobjects.wire import Wire
from draftviewproviders.view_wire import ViewProviderWire
from importers import exportIFC


_BIM_NAMES = {"baseline": "Line", "wall": "Wall", "column": "Structure", "storey": "BuildingPart"}
_BIM_INITIAL = {"wallLength": 4000.0, "wallHeight": 3000.0, "columnHeight": 3000.0}
_BIM_TOLERANCE = 1e-6


def _bim_require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _bim_dimensions(values):
    _bim_require(isinstance(values, dict) and set(values) == set(_BIM_INITIAL), "BIM 尺寸参数不完整或包含未知项")
    _bim_require(all(isinstance(value, (int, float)) and not isinstance(value, bool)
                     and math.isfinite(value) and value > 0 for value in values.values()),
                 "BIM 尺寸必须是有限正数")
    _bim_require(values["columnHeight"] > 300, "本例结构柱高度必须大于300mm截面尺寸")
    return {key: float(value) for key, value in values.items()}


def _bim_close(actual, expected, reason):
    _bim_require(math.isfinite(actual) and math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-6), reason)


def _bim_point(point):
    return [float(point.x), float(point.y), float(point.z)]


def _bim_proxy(proxy):
    return type(proxy).__module__ + "." + type(proxy).__name__


def _bim_create_or_load():
    objects = {role: doc.getObject(name) for role, name in _BIM_NAMES.items()}
    if any(obj is not None for obj in objects.values()):
        _bim_require(all(obj is not None for obj in objects.values()), "既有 BIM 工程缺少参数对象，拒绝补建")
        return objects, True
    _bim_require(not doc.Objects, "BIM 样件只能在空文档创建")
    baseline = Draft.make_line(App.Vector(0, 0, 0), App.Vector(4000, 0, 0))
    baseline.Closed, baseline.MakeFace = False, False
    baseline.FilletRadius, baseline.ChamferSize, baseline.Subdivisions = 0, 0, 0
    baseline.MapMode = "Deactivated"
    baseline.Placement = App.Placement()
    baseline.Label = "墙基线"
    doc.recompute()
    wall = Arch.makeWall(baseline, height=3000, width=200, align="Center", offset=0, name="直墙")
    # 官方工厂 offset=0 会读取默认偏好，显式归零以保持这个样件的确定性。
    wall.Offset = 0
    column = Arch.makeStructure(length=300, width=300, height=3000, name="结构柱")
    column.Normal = App.Vector(0, 0, 1)
    column.Placement = App.Placement(App.Vector(4500, 500, 0), App.Rotation())
    storey = Arch.makeFloor([wall, column], name="首层")
    storey.Placement = App.Placement()
    storey.Height, storey.HeightPropagate = 3000, False
    doc.recompute()
    objects = dict(zip(("baseline", "wall", "column", "storey"), (baseline, wall, column, storey)))
    _bim_require(all(obj is not None and obj.Name == _BIM_NAMES[role] for role, obj in objects.items()),
                 "官方 BIM 工厂没有创建预期对象")
    return objects, False


def _bim_validate_structure(objects):
    baseline, wall, column, storey = (objects[role] for role in ("baseline", "wall", "column", "storey"))
    _bim_require({obj.Name for obj in doc.Objects} == set(_BIM_NAMES.values()), "BIM 样件含意外对象或重复对象")
    definitions = ((baseline, "Part::FeaturePython", Wire, ViewProviderWire),
                   (wall, "Part::FeaturePython", ArchWall._Wall, ArchWall._ViewProviderWall),
                   (column, "Part::FeaturePython", ArchStructure._Structure, ArchStructure._ViewProviderStructure),
                   (storey, "App::GeometryPython", ArchBuildingPart.BuildingPart, ArchBuildingPart.ViewProviderBuildingPart))
    for obj, type_id, proxy, view_provider in definitions:
        _bim_require(obj.TypeId == type_id and isinstance(obj.Proxy, proxy), "BIM 原生 App 代理没有恢复: " + obj.Name)
        _bim_require(obj.ViewObject is not None and isinstance(obj.ViewObject.Proxy, view_provider),
                     "BIM 原生 ViewProvider 没有恢复: " + obj.Name)
        _bim_require(obj.getStatusString() == "Valid", "BIM 对象状态异常: " + obj.Name + ": " + obj.getStatusString())
    _bim_require(wall.Base is baseline and wall in baseline.InList, "直墙没有保留 Draft 基线引用")
    _bim_require(set(storey.Group) == {wall, column} and storey in wall.InList and storey in column.InList,
                 "墙柱没有保留真实楼层归属")
    _bim_require(wall.IfcType == "Wall" and column.IfcType == "Column" and storey.IfcType == "Building Storey"
                 and storey.CompositionType == "ELEMENT", "BIM 对象 IFC 类型或楼层语义不符")
    _bim_require(not wall.Additions and not wall.Subtractions and not column.Additions and not column.Subtractions
                 and column.Base is None,
                 "本例不允许隐含 BIM 加减料或结构基体: "
                 + repr({"wallAdditions": wall.Additions, "wallSubtractions": wall.Subtractions,
                         "columnAdditions": column.Additions, "columnSubtractions": column.Subtractions,
                         "columnBase": column.Base}))
    # 1.1.4 的 Structure.Tool 是 PropertyLinkSubList（可选挤出路径），空值为 []，不是 PropertyLink 的 None。
    _bim_require(column.getTypeIdOfProperty("Tool") == "App::PropertyLinkSubList" and column.Tool == [],
                 "本例不允许结构柱挤出路径: "
                 + repr({"propertyType": column.getTypeIdOfProperty("Tool"), "value": column.Tool}))
    _bim_require(wall.Align == "Center" and wall.Offset.Value == 0 and wall.Width.Value == 200,
                 "墙体厚度、中心对齐或偏移改变")
    _bim_require(column.Length.Value == 300 and column.Width.Value == 300
                 and (column.Normal - App.Vector(0, 0, 1)).Length < _BIM_TOLERANCE,
                 "结构柱截面或挤出方向改变")
    _bim_require(column.Placement.isSame(App.Placement(App.Vector(4500, 500, 0), App.Rotation()), _BIM_TOLERANCE)
                 and storey.Placement.isSame(App.Placement(), _BIM_TOLERANCE)
                 and not storey.HeightPropagate, "柱或楼层 Placement、尺寸传播设置改变")
    _bim_require(not baseline.Closed and not baseline.MakeFace and baseline.MapMode == "Deactivated"
                 and not baseline.AttachmentSupport and baseline.Base is None and baseline.Tool is None
                 and baseline.FilletRadius.Value == 0 and baseline.ChamferSize.Value == 0 and baseline.Subdivisions == 0
                 and baseline.Placement.isSame(App.Placement(), _BIM_TOLERANCE), "Draft 基线不是独立直线参数链")


def _bim_box_geometry(obj, dimensions, origin):
    shape = obj.Shape.copy()
    shape.Placement = obj.getGlobalPlacement().multiply(obj.Placement.inverse()).multiply(shape.Placement)
    expected = Part.makeBox(*dimensions, App.Vector(*origin))
    _bim_require(not shape.isNull() and shape.isValid() and len(shape.Solids) == 1
                 and shape.isClosed(), "BIM 对象没有完整有效实体: " + obj.Name)
    _bim_require(len(shape.Faces) == 6 and len(shape.Edges) == 12 and len(shape.Vertexes) == 8
                 and all(face.Surface.TypeId == "Part::GeomPlane" for face in shape.Faces),
                 "BIM 长方体拓扑不完整: " + obj.Name)
    for point in (App.Vector(origin[0] + dx, origin[1] + dy, origin[2] + dz)
                  for dx in (0, dimensions[0]) for dy in (0, dimensions[1]) for dz in (0, dimensions[2])):
        _bim_require(sum((vertex.Point - point).Length < _BIM_TOLERANCE for vertex in shape.Vertexes) == 1,
                     "BIM 长方体顶点位置不符: " + obj.Name)
    _bim_close(shape.Volume, math.prod(dimensions), "BIM 实际体积不符: " + obj.Name)
    _bim_close(shape.Area, expected.Area, "BIM 实际表面积不符: " + obj.Name)
    excess, missing = abs(shape.cut(expected).Volume), abs(expected.cut(shape).Volume)
    limit = max(1e-3, expected.Volume * 1e-10)
    _bim_require(math.isfinite(excess) and math.isfinite(missing) and excess <= limit and missing <= limit,
                 "BIM 完整几何与解析长方体不一致: " + obj.Name)
    bounds = shape.BoundBox
    return {"valid": True, "closed": True, "solids": len(shape.Solids), "faces": len(shape.Faces),
            "edges": len(shape.Edges), "vertices": len(shape.Vertexes), "volume": float(shape.Volume),
            "area": float(shape.Area), "bounds": [bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax],
            "excessVolume": float(excess), "missingVolume": float(missing), "differenceTolerance": float(limit)}


def _bim_measure(objects, stage):
    _bim_validate_structure(objects)
    baseline, wall, column, storey = (objects[role] for role in ("baseline", "wall", "column", "storey"))
    points = list(baseline.Points)
    _bim_require(len(points) == 2 and points[0].Length < _BIM_TOLERANCE
                 and abs(points[1].y) < _BIM_TOLERANCE and abs(points[1].z) < _BIM_TOLERANCE,
                 "Draft 基线参数不是 X 轴两点直线")
    dimensions = _bim_dimensions({"wallLength": points[1].x, "wallHeight": wall.Height.Value,
                                 "columnHeight": column.Height.Value})
    _bim_require(len(baseline.Shape.Edges) == 1 and not baseline.Shape.Faces and not baseline.Shape.Solids
                 and baseline.Shape.Edges[0].Curve.TypeId == "Part::GeomLine", "墙基线没有生成真实直线边")
    _bim_close(baseline.Shape.Length, dimensions["wallLength"], "Draft 基线形状没有跟随参数")
    _bim_close(wall.Length.Value, dimensions["wallLength"], "墙体长度没有跟随 Draft 基线")
    _bim_close(storey.Height.Value, dimensions["wallHeight"], "楼层高度没有保持显式参数")
    geometry = {"wall": _bim_box_geometry(wall, (dimensions["wallLength"], 200, dimensions["wallHeight"]), (0, -100, 0)),
                "column": _bim_box_geometry(column, (300, 300, dimensions["columnHeight"]), (4350, 350, 0))}
    _bim_require(not storey.Shape.isNull() and storey.Shape.isValid() and len(storey.Shape.Solids) == 2,
                 "真实楼层没有收集墙柱两个实体")
    _bim_close(storey.Shape.Volume, sum(value["volume"] for value in geometry.values()), "楼层聚合体积不符")
    return {"stage": stage, "parameters": dimensions, "geometry": geometry,
            "objects": {role: {"name": obj.Name, "typeId": obj.TypeId, "proxyType": _bim_proxy(obj.Proxy),
                                "viewProviderType": _bim_proxy(obj.ViewObject.Proxy),
                                "ifcType": str(obj.IfcType) if hasattr(obj, "IfcType") else None}
                        for role, obj in objects.items()},
            "references": {"wallBase": wall.Base.Name, "storeyMembers": sorted(obj.Name for obj in storey.Group),
                           "columnToolCount": len(column.Tool)},
            "baselinePoints": [_bim_point(point) for point in points]}


def _bim_export(objects, snapshot):
    preferences = {"DEBUG": False, "CREATE_CLONES": False, "FORCE_BREP": False, "STORE_UID": True,
                   "SERIALIZE": False, "EXPORT_2D": False, "FULL_PARAMETRIC": False,
                   "ADD_DEFAULT_SITE": True, "ADD_DEFAULT_BUILDING": True, "ADD_DEFAULT_STOREY": False,
                   "IFC_UNIT": "metre", "SCALE_FACTOR": 0.001, "GET_STANDARD": False,
                   "EXPORT_MODEL": "arch", "GROUPS_AS_ASSEMBLIES": False, "IGNORE_STD_GROUPS": True,
                   "SCHEMA": "IFC4"}
    destination = os.path.join(output_directory, "bim-" + snapshot["stage"] + ".ifc")
    _bim_require(not os.path.lexists(destination), "IFC 阶段文件已存在，拒绝覆盖")
    previous_uids = {role: str(objects[role].IfcData.get("IfcUID", "")) for role in ("wall", "column", "storey")}
    exportIFC.export([objects["storey"]], destination, preferences=preferences)
    _bim_require(os.path.isfile(destination) and os.path.getsize(destination) > 0, "官方 IFC 导出没有生成文件")
    guids = {role: str(objects[role].IfcData.get("IfcUID", "")) for role in ("wall", "column", "storey")}
    _bim_require(len(set(guids.values())) == 3 and all(len(uid) == 22 for uid in guids.values()), "IFC 导出没有写回唯一 GUID")
    _bim_require(all(not uid or guids[role] == uid for role, uid in previous_uids.items()), "IFC 导出改变了既有对象 GUID")
    # STORE_UID 会重算；导出结束后再核验整个参数链和真实几何。
    after = _bim_measure(objects, snapshot["stage"])
    _bim_require(after["parameters"] == snapshot["parameters"] and after["geometry"] == snapshot["geometry"],
                 "IFC 导出改变了参数或几何")
    with open(destination, "rb") as stream:
        sha256 = hashlib.sha256(stream.read()).hexdigest()
    snapshot["ifc"] = {"path": destination, "sha256": sha256, "schema": "IFC4", "lengthUnit": "METRE",
                       "scaleFactor": 0.001, "storeUid": True, "guids": guids,
                       "ifcOpenShellVersion": str(ifcopenshell.version), "preferences": preferences}
    return snapshot


def run_bim_case(options=None):
    _bim_require(App.GuiUp and App.ActiveDocument is doc, "BIM 验收需要真实离屏 GUI 与当前 Task 文档")
    options = {} if options is None else options
    _bim_require(isinstance(options, dict) and set(options).issubset({"expectedParameters", "parameters"}), "BIM 验收包含未知选项")
    expected = _bim_dimensions(options.get("expectedParameters", _BIM_INITIAL))
    target = _bim_dimensions(options.get("parameters", {"wallLength": 5000, "wallHeight": 3500, "columnHeight": 3200}))
    _bim_require(all(target[key] != expected[key] for key in expected), "每轮必须改变基线长度、墙高和柱高")
    objects, reused = _bim_create_or_load()
    # 保存重开后，先读原参数、真实代理、引用和几何，不能通过重设参数掩盖恢复失败。
    incoming = _bim_measure(objects, "incoming")
    _bim_require(incoming["parameters"] == expected, "重开的 BIM 参数不等于上一轮交付结果")
    stages = [_bim_export(objects, incoming)]
    objects["baseline"].Points = [App.Vector(0, 0, 0), App.Vector(target["wallLength"], 0, 0)]
    objects["wall"].Height = target["wallHeight"]
    objects["column"].Height = target["columnHeight"]
    objects["storey"].Height = target["wallHeight"]
    doc.recompute()
    final = _bim_measure(objects, "resized")
    _bim_require(final["parameters"] == target, "BIM 参数更新没有生效")
    stages.append(_bim_export(objects, final))
    return {"capability": "bim_wall_column_storey", "reused": reused, "parameters": final["parameters"],
            "objects": {role: obj.Name for role, obj in objects.items()}, "stages": stages}
