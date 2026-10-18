"""Draft 二维交换文件的独立原生回读夹具，不保存或修改原导出文件。

宿主预置 App、Part、doc、output_directory，且 doc 必须是本次新空文档。
read_draft_exchange(path, kind) 保留官方导入对象，返回普通 JSON，由宿主保存 doc。
依据 FreeCAD 1.1.4 随包 importSVG.py、draftfunctions/draftify.py，以及固定
4fd3bf3 的 src/Mod/Import/App/AppImportPy.cpp 与 dxf/ImpExpDxf.cpp。
只测读取几何；不把派生测量 Face 加入文档，也不补回 Draft 参数或原建模关系。
"""

import hashlib
import json
import math
import os
import uuid
import xml.etree.ElementTree as ET


def _exchange_require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _exchange_number(value, reason):
    value = float(value)
    _exchange_require(math.isfinite(value), "交换几何数值非有限: " + reason)
    return value


def _exchange_point(point):
    return [_exchange_number(value, "坐标") for value in (point.x, point.y, point.z)]


def _exchange_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def _exchange_svg_header(path):
    root = ET.parse(path).getroot()
    _exchange_require(root.tag.rsplit("}", 1)[-1] == "svg", "交换文件不是 SVG 根元素")
    dimensions = []
    for name in ("width", "height"):
        value = root.get(name, "").strip()
        _exchange_require(value.endswith("mm"), "本夹具要求 SVG 显式毫米尺寸，避免 DPI 询问: " + name)
        number = _exchange_number(value[:-2], name)
        _exchange_require(number > 0, "SVG 毫米尺寸必须为正: " + name)
        dimensions.append(number)
    values = root.get("viewBox", "").replace(",", " ").split()
    _exchange_require(len(values) == 4, "SVG 必须包含四个 viewBox 数值")
    viewbox = [_exchange_number(value, "viewBox") for value in values]
    _exchange_require(viewbox[2] > 0 and viewbox[3] > 0, "SVG viewBox 范围无效")
    return {"widthMm": dimensions[0], "heightMm": dimensions[1], "viewBox": viewbox,
            "headerAxisScale": [dimensions[0] / viewbox[2], dimensions[1] / viewbox[3]],
            "preserveAspectRatio": root.get("preserveAspectRatio", "xMidYMid meet")}


def _exchange_import_svg(path):
    header = _exchange_svg_header(path)
    import importSVG

    disable_scaling = bool(importSVG.params.get_param("svgDisableUnitScaling"))
    header["disableUnitScaling"] = disable_scaling
    header["svgStyle"] = int(importSVG.params.get_param("svgstyle"))
    sx, sy = header["headerAxisScale"]
    preserve = header["preserveAspectRatio"].strip().lower()
    if disable_scaling:
        effective = [1.0, 1.0]
    elif preserve.startswith("none"):
        effective = [sx, sy]
    else:
        scale = max(sx, sy) if preserve.endswith("slice") else min(sx, sy)
        effective = [scale, scale]
    header["effectiveRootScale"] = effective
    returned = importSVG.insert(path, doc.Name)
    _exchange_require(returned is None, "安装版 SVG insert 返回语义发生变化，需复核")
    return {"name": "importSVG.insert", "module": os.path.realpath(importSVG.__file__),
            "returnValue": None}, None, {"coordinateUnit": "mm", "svg": header}


def _exchange_import_dxf(path):
    import Import

    # 新建本次 Task 的专用参数组，不修改 Preferences/Mod/Draft 用户全局组。
    group_path = "User parameter:BaseApp/KfwCad/TaskExchange/" + uuid.uuid4().hex
    group = App.ParamGet(group_path)
    group.SetFloat("dxfScaling", 1.0)
    group.SetInt("DxfImportMode", 2)  # 官方 IndividualShapes，避免引入编辑器转换。
    scale = float(group.GetFloat("dxfScaling", 1.0))
    mode = int(group.GetInt("DxfImportMode", 2))
    _exchange_require(scale == 1.0 and mode == 2, "本次 DXF 专用配置不符")
    stats = Import.readDXF(path, doc.Name, False, group_path)
    settings = {"coordinateUnit": "mm", "optionSource": group_path, "dxfScaling": scale,
                "DxfImportMode": mode, "ignoreErrors": False,
                "unitResolution": "DXF header plus importer scaling; verify actual geometry"}
    return {"name": "Import.readDXF", "module": os.path.realpath(Import.__file__)}, stats, settings


def _exchange_shape_objects():
    objects = [obj for obj in doc.Objects if "Shape" in obj.PropertiesList
               and obj.getTypeIdOfProperty("Shape") == "Part::PropertyPartShape"
               and not obj.Shape.isNull()]
    _exchange_require(objects, "导入文档没有非空 Part 几何")
    names = {obj.Name for obj in objects}
    selected, excluded = [], []
    for obj in objects:
        compound_parents = [parent for parent in obj.InList if parent.Name in names
                            and parent.isDerivedFrom("Part::Compound")
                            and "Links" in parent.PropertiesList and obj in parent.Links]
        if compound_parents:
            excluded.append({"object": obj.Name, "includedBy": [parent.Name for parent in compound_parents]})
        else:
            selected.append(obj)
    _exchange_require(selected, "导入几何的父子关系无法确定唯一读取对象")
    return selected, excluded


def _exchange_global_shape(obj):
    shape = obj.Shape.copy()
    # Shape 已包含自身 Placement；这里只补 App::Part 等父容器的变换。
    parent_placement = obj.getGlobalPlacement().multiply(obj.Placement.inverse())
    shape.Placement = parent_placement.multiply(shape.Placement)
    _exchange_require(not shape.isNull() and shape.isValid(), "导入几何无效: " + obj.Name)
    placement = {"object": obj.Name, "parentPosition": _exchange_point(parent_placement.Base),
                 "parentQuaternion": [_exchange_number(value, "父容器旋转")
                                      for value in parent_placement.Rotation.Q]}
    return shape, placement


def _exchange_measure(selected):
    shapes, placements = [], []
    for obj in selected:
        shape, placement = _exchange_global_shape(obj)
        shapes.append(shape)
        placements.append(placement)
    edges = [edge for shape in shapes for edge in shape.Edges]
    _exchange_require(len(edges) == 4, "交换轮廓必须真实读取到四条边，实际为 " + str(len(edges)))
    groups = Part.sortEdges(edges)
    _exchange_require(len(groups) == 1 and len(groups[0]) == 4, "导入四边没有形成唯一连通轮廓")
    wire = Part.Wire(groups[0])
    closed, valid = bool(wire.isClosed()), bool(wire.isValid())
    _exchange_require(closed and valid, "导入轮廓不是有效闭合 Wire")
    face = Part.Face(wire)
    planar = isinstance(face.Surface, Part.Plane)
    _exchange_require(planar and face.isValid(), "导入轮廓不能形成有效平面围面积")
    edge_data = []
    for edge in wire.Edges:
        _exchange_require(len(edge.Vertexes) == 2, "四边轮廓含无明确端点的边")
        length = _exchange_number(edge.Length, "边长")
        _exchange_require(length > 0, "导入轮廓包含退化边")
        curve = edge.Curve
        edge_data.append({"start": _exchange_point(edge.Vertexes[0].Point),
                          "end": _exchange_point(edge.Vertexes[-1].Point), "length": length,
                          "curveType": str(getattr(curve, "TypeId", type(curve).__name__))})
    bounds = wire.BoundBox
    geometry = {"edgeCount": len(wire.Edges), "wireCount": len(groups), "closed": closed,
                "valid": valid, "planar": planar,
                "bounds": [_exchange_number(value, "包围盒") for value in
                           (bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax)],
                "vertices": sorted(_exchange_point(vertex.Point) for vertex in wire.Vertexes),
                "edges": edge_data, "perimeter": _exchange_number(wire.Length, "周长"),
                "enclosedArea": _exchange_number(face.Area, "围面积"),
                "importedFaceCount": sum(len(shape.Faces) for shape in shapes),
                "importedWireCount": sum(len(shape.Wires) for shape in shapes)}
    _exchange_require(geometry["perimeter"] > 0 and geometry["enclosedArea"] > 0,
                     "导入轮廓周长或围面积无效")
    return geometry, placements


def read_draft_exchange(path, kind):
    _exchange_require(kind in ("svg", "dxf"), "交换格式只接受 svg 或 dxf")
    _exchange_require(isinstance(path, str) and os.path.isabs(path), "交换文件必须使用绝对路径")
    path = os.path.realpath(path)
    _exchange_require(os.path.isfile(path), "交换文件不存在: " + path)
    _exchange_require(not doc.Objects, "read_draft_exchange 要求宿主提供本次新空文档")
    before_hash = _exchange_hash(path)
    importer, stats, units = _exchange_import_svg(path) if kind == "svg" else _exchange_import_dxf(path)
    doc.recompute()
    selected, excluded = _exchange_shape_objects()
    geometry, placements = _exchange_measure(selected)
    _exchange_require(_exchange_hash(path) == before_hash, "回读期间原交换文件字节发生改变")
    result = {"kind": kind, "path": path, "sourceSha256": before_hash, "document": doc.Name,
              "objects": [{"name": obj.Name, "type": obj.TypeId} for obj in doc.Objects],
              "selectedGeometryNames": [obj.Name for obj in selected], "excludedGeometry": excluded,
              "importer": importer, "stats": stats, "units": units,
              "geometry": geometry, "parentPlacements": placements,
              "enclosedAreaSource": "temporary Part.Face from imported closed Wire; not added to document"}
    return json.loads(json.dumps(result, ensure_ascii=False, allow_nan=False))
