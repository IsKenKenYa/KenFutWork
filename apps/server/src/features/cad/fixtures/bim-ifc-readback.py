"""在独立进程的空文档中，以 IfcOpenShell 0.8 SERIALIZED BRep 回读 IFC。

不调用 FreeCAD IFC 导入器，不依赖原 FCStd 或 Arch/Draft 代理。
IfcOpenShell 在世界坐标输出米，明确缩放1000至FreeCAD内部毫米。
解析长方体的双向差集、体积和表面积验证完整几何，bounds只作额外证据。
"""

import hashlib
import math

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.unit
from ifcopenshell import ifcopenshell_wrapper


def _ifc_require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _ifc_hash(path):
    with open(path, "rb") as stream:
        return hashlib.sha256(stream.read()).hexdigest()


def _ifc_spatial_structure(model, guids):
    storeys = model.by_type("IfcBuildingStorey")
    _ifc_require(len(storeys) == 1 and storeys[0].GlobalId == guids["storey"]
                 and storeys[0].CompositionType == "ELEMENT", "IFC 缺少唯一且匹配的真实楼层")
    storey = storeys[0]
    children = []
    for relation in model.by_type("IfcRelContainedInSpatialStructure"):
        if relation.RelatingStructure == storey:
            children.extend(relation.RelatedElements)
    expected = {guids["wall"], guids["column"]}
    _ifc_require(len(children) == 2 and {obj.GlobalId for obj in children} == expected,
                 "IFC 墙柱没有唯一包含在预期楼层")
    for element in children:
        _ifc_require(len(element.ContainedInStructure) == 1
                     and element.ContainedInStructure[0].RelatingStructure == storey,
                     "IFC 元素含重复或错误空间归属")
    # 显式默认 Site/Building 让楼层连接到 IfcProject，而非悬空容器。
    chain, current = [storey.is_a()], storey
    for expected_type in ("IfcBuilding", "IfcSite", "IfcProject"):
        relations = current.Decomposes
        _ifc_require(len(relations) == 1 and relations[0].is_a("IfcRelAggregates"), "IFC 空间层级缺少唯一聚合父级")
        current = relations[0].RelatingObject
        _ifc_require(current.is_a() == expected_type, "IFC 空间层级错误: " + current.is_a())
        chain.append(current.is_a())
    return {"storeyGuid": storey.GlobalId, "containedGuids": sorted(expected), "ancestry": chain}


def _ifc_read_solid(settings, product, dimensions, origin, name):
    # 保留 create_shape 返回值，避免其内部 BRep 子对象先被垃圾回收。
    created = ifcopenshell.geom.create_shape(settings, product, geometry_library="opencascade")
    brep = created.geometry.brep_data
    _ifc_require(isinstance(brep, str) and bool(brep.strip()), "IfcOpenShell 没有返回 SERIALIZED BRep")
    shape = Part.Shape()
    shape.importBrepFromString(brep, False)
    shape.scale(1000.0)
    _ifc_require(not shape.isNull() and shape.isValid() and shape.isClosed() and len(shape.Solids) == 1,
                 "IFC 回读不是完整有效实体: " + name)
    analytic = Part.makeBox(dimensions[0], dimensions[1], dimensions[2], App.Vector(*origin))
    volume = float(shape.Volume)
    expected_volume = math.prod(dimensions)
    expected_area = 2 * (dimensions[0] * dimensions[1] + dimensions[0] * dimensions[2] + dimensions[1] * dimensions[2])
    _ifc_require(math.isfinite(volume) and math.isclose(volume, expected_volume, rel_tol=1e-10, abs_tol=1e-3),
                 "IFC 回读实体体积或单位不符: " + name)
    _ifc_require(math.isfinite(shape.Area) and math.isclose(shape.Area, expected_area, rel_tol=1e-10, abs_tol=1e-3),
                 "IFC 回读实体表面积不符: " + name)
    excess, missing = abs(shape.cut(analytic).Volume), abs(analytic.cut(shape).Volume)
    limit = max(1e-3, expected_volume * 1e-10)
    _ifc_require(math.isfinite(excess) and math.isfinite(missing) and excess <= limit and missing <= limit,
                 "IFC 回读完整几何与解析长方体不一致: " + name)
    # 这里是交换文件的真实几何回读，不伪造原参数墙柱。
    imported = doc.addObject("Part::Feature", name)
    imported.Shape = shape
    bounds = shape.BoundBox
    return {"type": product.is_a(), "guid": product.GlobalId, "objectName": imported.Name,
            "valid": True, "closed": True, "solids": len(shape.Solids), "volume": volume,
            "area": float(shape.Area), "faces": len(shape.Faces), "edges": len(shape.Edges),
            "vertices": len(shape.Vertexes),
            "bounds": [bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax],
            "excessVolume": float(excess), "missingVolume": float(missing), "differenceTolerance": float(limit)}


def _ifc_read_file(spec, index):
    path, guids, parameters = spec["path"], spec["guids"], spec["parameters"]
    before = _ifc_hash(path)
    _ifc_require(before == spec["sha256"], "IFC 输入文件哈希不符")
    model = ifcopenshell.open(path)
    _ifc_require(model.schema == "IFC4", "IFC schema 不是约定的 IFC4")
    projects = model.by_type("IfcProject")
    _ifc_require(len(projects) == 1 and projects[0].UnitsInContext is not None, "IFC 缺少唯一项目及单位")
    length_units = [unit for unit in projects[0].UnitsInContext.Units if unit.UnitType == "LENGTHUNIT"]
    _ifc_require(len(length_units) == 1 and length_units[0].is_a("IfcSIUnit")
                 and length_units[0].Name == "METRE" and length_units[0].Prefix is None
                 and ifcopenshell.util.unit.calculate_unit_scale(model) == 1.0, "IFC 长度单位不是无前缀米")
    walls, columns = model.by_type("IfcWall"), model.by_type("IfcColumn")
    _ifc_require(len(walls) == 1 and len(columns) == 1, "IFC 缺少唯一墙或柱实体语义")
    _ifc_require(walls[0].GlobalId == guids["wall"] and columns[0].GlobalId == guids["column"], "IFC 墙柱 GUID 与源对象不符")
    spatial = _ifc_spatial_structure(model, guids)
    settings = ifcopenshell.geom.settings()
    settings.set("iterator-output", ifcopenshell_wrapper.SERIALIZED)
    settings.set("use-world-coords", True)
    settings.set("convert-back-units", False)
    geometry = {
        "wall": _ifc_read_solid(settings, walls[0], (parameters["wallLength"], 200, parameters["wallHeight"]),
                                (0, -100, 0), "IfcWall" + str(index)),
        "column": _ifc_read_solid(settings, columns[0], (300, 300, parameters["columnHeight"]),
                                  (4350, 350, 0), "IfcColumn" + str(index)),
    }
    after = _ifc_hash(path)
    _ifc_require(after == before, "IFC 回读改变了输入文件")
    return {"path": path, "sha256": after, "schema": model.schema, "lengthUnit": "METRE",
            "geometryUnit": "mm", "worldCoordinates": True, "serialized": True,
            "parameters": parameters, "guids": guids, "geometry": geometry, "spatial": spatial}


def run_bim_ifc_readback(specs):
    _ifc_require(App.ActiveDocument is doc and not doc.Objects, "IFC 独立回读必须从全新空文档开始")
    _ifc_require(str(ifcopenshell.version).lstrip("v").startswith("0.8."), "本矩阵要求 IfcOpenShell 0.8 SERIALIZED 接口")
    _ifc_require(isinstance(specs, list) and bool(specs), "IFC 回读清单为空")
    files = [_ifc_read_file(spec, index) for index, spec in enumerate(specs)]
    doc.recompute()
    return {"capability": "bim_ifc_readback", "emptyDocumentAtStart": True,
            "ifcOpenShellVersion": str(ifcopenshell.version), "files": files}
