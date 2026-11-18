"""独立 SVG 交换几何回读；不导入、调用或复刻 KFW SVG 序列化器。

宿主提供 App、Part、doc。create_svg_case(name) 创建真实 Part::Feature；
read_svg_case(path, name) 在本次空文档使用正式 importSVG.insert 回读。
期望 Shape 每次从下列数学定义重建，只存在于内存，不加入读回文档。
样点距离是代表性双向检验，不是穷尽 Hausdorff 距离证明。

API 依据：安装版 Part/TestPartApp.py 的 BSpline 构造与几何属性，
Draft/draftobjects/ellipse.py 的 Ellipse/ArcOfEllipse，bezcurve.py 的
Bezier.increase/setPoles，importDXF.py 的带 weights BSpline 构造，
drafttests/test_draftgeomutils.py 的 Wire.OrderedVertexes。
"""

import json
import math
import os


SVG_CASE_NAMES = (
    "rotated_rectangle", "far_origin_line", "circle", "circle_arc",
    "ellipse_rotated", "ellipse_arc_rotated", "bezier_quadratic", "bezier_cubic",
    "bspline_cubic", "bspline_rational", "bspline_degree5", "sphere", "cylinder", "torus",
)
_SVG_SOLID_CASES = {"sphere", "cylinder", "torus"}
_SVG_SAMPLE_LIMIT = 129


def _svg_require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _svg_number(value, label):
    value = float(value)
    _svg_require(math.isfinite(value), "SVG 验收数据不是有限数: " + label)
    return value


def _svg_point(value):
    return [_svg_number(component, "点坐标") for component in (value.x, value.y, value.z)]


def _svg_vectors(points):
    return [App.Vector(x, y, 0) for x, y in points]


def _svg_bezier(points):
    curve = Part.BezierCurve()
    degree = len(points) - 1
    curve.increase(degree)
    curve.setPoles(_svg_vectors(points))
    _svg_require(curve.Degree == degree and not curve.isRational(),
                 "原生 Bezier 构造没有保留次数或非有理参数")
    return curve.toShape(), {"degree": degree, "rational": False, "poles": points}


def _svg_bspline(points, degree, knots, mults, weights=None):
    curve = Part.BSplineCurve()
    arguments = {"poles": _svg_vectors(points), "degree": degree, "knots": knots,
                 "mults": mults, "periodic": False}
    if weights is not None:
        arguments["weights"] = weights
    curve.buildFromPolesMultsKnots(**arguments)
    _svg_require(curve.Degree == degree and not curve.isPeriodic(),
                 "原生 BSpline 构造没有保留次数或非周期参数")
    _svg_require(bool(curve.isRational()) == (weights is not None),
                 "原生 BSpline 构造没有保留有理参数")
    _svg_require(list(curve.getMultiplicities()) == mults
                 and list(curve.getKnots()) == knots,
                 "原生 BSpline 构造没有保留节点或重数")
    return curve.toShape(), {"degree": degree, "rational": bool(curve.isRational()),
                             "poles": points, "knots": knots, "multiplicities": mults,
                             "weights": weights}


def _svg_case_shape(name):
    """只按 case 的独立数学定义构造；不读取待验 SVG 或导入后的 Curve 类型。"""
    _svg_require(name in SVG_CASE_NAMES, "未知 SVG 几何验收 case: " + str(name))
    if name == "rotated_rectangle":
        length, width = 1250.0, 600.0
        origin, degrees = (25.123456789, -13.987654321), 17.0
        angle = math.radians(degrees)
        cosine, sine = math.cos(angle), math.sin(angle)
        corners = [(origin[0] + x * cosine - y * sine,
                    origin[1] + x * sine + y * cosine)
                   for x, y in ((0, 0), (length, 0), (length, width), (0, width))]
        vertices = _svg_vectors(corners)
        shape = Part.makePolygon(vertices + [vertices[0]])
        definition = {"length": length, "width": width, "origin": list(origin),
                      "rotationDegrees": degrees, "corners": corners}
    elif name == "far_origin_line":
        points = [(1234567.890123456, -987654.321098765),
                  (1234568.013580245, -987654.286530875)]
        shape = Part.makeLine(*_svg_vectors(points))
        definition = {"points": points}
    elif name in ("circle", "circle_arc"):
        center, radius = App.Vector(21.123456789, -8.987654321, 0), 7.89123456789
        curve = Part.Circle(center, App.Vector(0, 0, 1), radius)
        _svg_require(math.isclose(curve.Radius, radius, rel_tol=1e-14, abs_tol=0),
                     "原生 Circle 半径不符")
        definition = {"center": _svg_point(center), "radius": radius}
        if name == "circle":
            shape = curve.toShape()
        else:
            start, end = 0.35, 4.65
            shape = Part.ArcOfCircle(curve, start, end).toShape()
            shape.reverse()
            definition.update({"startRadians": start, "endRadians": end,
                               "edgeOrientation": "Reversed"})
    elif name in ("ellipse_rotated", "ellipse_arc_rotated"):
        center = App.Vector(-12.345678901, 31.987654321, 0)
        major, minor, degrees = 15.234567891, 6.789012345, 31.0
        curve = Part.Ellipse(center, major, minor)
        _svg_require(math.isclose(curve.MajorRadius, major, rel_tol=1e-14, abs_tol=0)
                     and math.isclose(curve.MinorRadius, minor, rel_tol=1e-14, abs_tol=0),
                     "原生 Ellipse 长短半轴不符")
        definition = {"center": _svg_point(center), "majorRadius": major,
                      "minorRadius": minor, "rotationDegrees": degrees}
        if name == "ellipse_rotated":
            shape = curve.toShape()
        else:
            start, end = 0.4, 4.7
            shape = Part.ArcOfEllipse(curve, start, end).toShape()
            shape.reverse()
            definition.update({"startRadians": start, "endRadians": end,
                               "edgeOrientation": "Reversed"})
        shape.rotate(center, App.Vector(0, 0, 1), degrees)
    elif name == "bezier_quadratic":
        shape, definition = _svg_bezier([(1.123456789, 2.345678901),
                                          (9.876543219, 17.234567891),
                                          (23.456789012, -3.456789012)])
    elif name == "bezier_cubic":
        shape, definition = _svg_bezier([(-7.123456789, 3.456789012),
                                          (4.567890123, 19.876543219),
                                          (18.901234567, -12.345678901),
                                          (32.123456789, 6.789012345)])
    elif name in ("bspline_cubic", "bspline_rational"):
        points = [(-4.123456789, 1.234567891), (3.456789012, 16.789012345),
                  (14.567890123, -7.890123456), (25.678901234, 13.456789012),
                  (37.890123456, 2.345678901)]
        weights = [1.0, 0.7, 1.8, 0.9, 1.2] if name == "bspline_rational" else None
        shape, definition = _svg_bspline(points, 3, [0.0, 0.45, 1.0], [4, 1, 4], weights)
    elif name == "bspline_degree5":
        points = [(-2.123456789, 0.345678901), (3.456789012, 12.345678901),
                  (9.876543219, -5.678901234), (17.234567891, 18.901234567),
                  (24.567890123, -9.012345678), (31.890123456, 11.234567891),
                  (40.123456789, 1.456789012)]
        shape, definition = _svg_bspline(points, 5, [0.0, 0.6, 1.0], [6, 1, 6])
    elif name == "sphere":
        center, radius = App.Vector(5.123456789, -3.456789012, 7.890123456), 12.345678901
        shape = Part.makeSphere(radius, center)
        definition = {"center": _svg_point(center), "radius": radius}
    elif name == "cylinder":
        base = App.Vector(13.456789012, -7.890123456, -2.345678901)
        radius, height = 8.123456789, 17.234567891
        shape = Part.makeCylinder(radius, height, base, App.Vector(0, 0, 1))
        definition = {"base": _svg_point(base), "radius": radius, "height": height}
    else:
        center = App.Vector(-7.890123456, 5.678901234, 3.456789012)
        major, minor = 18.345678901, 4.123456789
        shape = Part.makeTorus(major, minor, center, App.Vector(0, 0, 1))
        definition = {"center": _svg_point(center), "majorRadius": major, "minorRadius": minor}
    _svg_require(not shape.isNull() and shape.isValid() and len(shape.Edges) > 0,
                 "数学定义没有产生有效原生几何: " + name)
    return shape, definition


def _svg_view(name):
    return ("isometric", [1, -1, 1]) if name in _SVG_SOLID_CASES else ("top", [0, 0, 1])


def _svg_expected_shape(shape, name):
    if name not in _SVG_SOLID_CASES:
        return shape, {"source": "independent original mathematical curve", "excludedDegenerateEdges": 0}
    import TechDraw
    # projectEx 顺序为 V,V1,VN,VO,VI,H,H1,HN,HO,HI；官方 Plain SVG 采用 VO、V。
    groups = TechDraw.projectEx(shape, App.Vector(1, -1, 1))
    edges, excluded = [], 0
    for index in (3, 0):
        group = groups[index]
        if group.isNull():
            continue
        for edge in group.Edges:
            length = _svg_number(edge.Length, "HLR 边长")
            if edge.Degenerated or length == 0:
                excluded += 1
            else:
                _svg_require(length > 0, "HLR 边长为负")
                edges.append(edge)
    _svg_require(edges, "官方三维 HLR 没有可见非退化投影边")
    return Part.makeCompound(edges), {"source": "TechDraw.projectEx(shape, Vector(1,-1,1)): groups[3] (VO), groups[0] (V)",
                                      "excludedDegenerateEdges": excluded}


def _svg_bounds(shape):
    bounds = shape.optimalBoundingBox(False, False)
    return [_svg_number(value, "包围盒") for value in (
        bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax)]


def _svg_measure(shape):
    _svg_require(not shape.isNull() and shape.isValid() and shape.Edges,
                 "SVG 验收没有有效非空边")
    shape_edges = list(shape.Edges)
    groups = Part.sortEdges(shape_edges)
    wires = []
    for edges in groups:
        wire = Part.Wire(edges)
        _svg_require(not wire.isNull() and wire.isValid(), "SVG 导入边不能形成有效 Wire")
        closed = bool(wire.isClosed())
        vertices = list(wire.OrderedVertexes)
        _svg_require(vertices, "SVG Wire 没有实际顶点")
        endpoints = [] if closed else [_svg_point(vertices[0].Point), _svg_point(vertices[-1].Point)]
        wires.append({"closed": closed, "edgeCount": len(edges), "endpoints": endpoints,
                      "length": math.fsum(_svg_number(edge.Length, "Wire 逐边长度") for edge in wire.Edges)})
    return {"valid": True, "edgeCount": len(shape_edges), "wireCount": len(wires),
            "closed": bool(wires) and all(wire["closed"] for wire in wires),
            "wires": wires, "length": math.fsum(_svg_number(edge.Length, "逐边长度") for edge in shape_edges),
            "lengthOracle": "math.fsum(Edge.Length)",
            "bounds": _svg_bounds(shape)}


def _svg_samples(shape):
    """全 Shape 总共最多 129 点；对各实际边的有限参数区间作均匀复合采样。"""
    edges = list(shape.Edges)
    _svg_require(edges, "无法采样空几何")
    intervals = []
    for edge in edges:
        start = _svg_number(edge.FirstParameter, "边起参数")
        end = _svg_number(edge.LastParameter, "边终参数")
        _svg_require(end > start, "边参数区间为空或反向")
        intervals.append((start, end))
    samples = []
    used_edges = set()
    for index in range(_SVG_SAMPLE_LIMIT):
        coordinate = len(edges) * index / (_SVG_SAMPLE_LIMIT - 1)
        edge_index = min(int(coordinate), len(edges) - 1)
        fraction = coordinate - edge_index if index < _SVG_SAMPLE_LIMIT - 1 else 1.0
        start, end = intervals[edge_index]
        point = edges[edge_index].valueAt(start + (end - start) * fraction)
        _svg_point(point)
        samples.append(point)
        used_edges.add(edge_index)
    return samples, len(used_edges)


def _svg_distances(source, target):
    samples, edge_count = _svg_samples(source)
    edges = list(target.Edges)
    boxes = [edge.BoundBox for edge in edges] if len(edges) > 128 else []
    maximum, worst = -1.0, None
    for point in samples:
        vertex = Part.Vertex(point)
        if boxes:
            # 包围盒下界只剔除不可能更近的边，距离仍由独立原生 extrema 求解。
            candidates = sorted((math.sqrt(sum(max(low - value, 0, value - high) ** 2
                                                    for value, low, high in (
                                                        (point.x, box.XMin, box.XMax),
                                                        (point.y, box.YMin, box.YMax),
                                                        (point.z, box.ZMin, box.ZMax)))), index)
                                for index, box in enumerate(boxes))
            distance = math.inf
            for lower_bound, index in candidates:
                if lower_bound > distance + App.Base.Precision.confusion():
                    break
                distance = min(distance, vertex.distToShape(edges[index])[0])
        else:
            distance = vertex.distToShape(target)[0]
        distance = _svg_number(distance, "点到 Shape 距离")
        _svg_require(distance >= 0, "原生几何距离为负")
        if distance > maximum:
            maximum, worst = distance, _svg_point(point)
    return {"sampleCount": len(samples), "sampledEdgeCount": edge_count,
            "maxDistance": maximum, "worstPoint": worst}


def _svg_global_shape(obj):
    shape = obj.Shape.copy()
    parent = obj.getGlobalPlacement().multiply(obj.Placement.inverse())
    shape.Placement = parent.multiply(shape.Placement)
    _svg_require(not shape.isNull() and shape.isValid(), "导入对象的全局几何无效: " + obj.Name)
    return shape


def _svg_imported_shapes():
    for obj in doc.Objects:
        _svg_require(not any("error" in state.lower() or "invalid" in state.lower() for state in obj.State),
                     "SVG 导入对象存在真实错误: " + obj.Name)
    objects = [obj for obj in doc.Objects if "Shape" in obj.PropertiesList
               and obj.getTypeIdOfProperty("Shape") == "Part::PropertyPartShape"
               and not obj.Shape.isNull()]
    _svg_require(objects, "正式 SVG 导入没有产生非空 Part Shape")
    names = {obj.Name for obj in objects}
    selected, excluded = [], []
    for obj in objects:
        parents = [parent for parent in obj.InList if parent.Name in names
                   and parent.isDerivedFrom("Part::Compound")
                   and "Links" in parent.PropertiesList and obj in parent.Links]
        if parents:
            excluded.append({"object": obj.Name, "includedBy": [parent.Name for parent in parents]})
        else:
            selected.append(obj)
    _svg_require(selected, "SVG 导入对象不能唯一确定几何消费者")
    shapes = [_svg_global_shape(obj) for obj in selected]
    return Part.makeCompound(shapes), selected, excluded


def _svg_json(data):
    # 这里仅校验普通 JSON 与全 finite，不内置或放宽几何误差阈值。
    json.dumps(data, allow_nan=False)
    return data


def create_svg_case(name):
    shape, definition = _svg_case_shape(name)
    object_name = "Svg_" + name
    _svg_require(doc.getObject(object_name) is None, "SVG 源对象名称已存在: " + object_name)
    obj = doc.addObject("Part::Feature", object_name)
    _svg_require(obj.Name == object_name, "原生自动修改了 SVG 源对象名")
    obj.Shape = shape
    doc.recompute()
    _svg_require(obj.getStatusString() == "Valid", "SVG 源对象重算失败")
    global_shape = _svg_global_shape(obj)
    if name in _SVG_SOLID_CASES:
        _svg_require(len(global_shape.Solids) == 1, "三维 SVG 源不是有效单实体")
        source = {"valid": True, "solids": 1, "bounds": _svg_bounds(global_shape),
                  "edgeCount": len(global_shape.Edges), "volume": _svg_number(global_shape.Volume, "实体体积")}
    else:
        source = _svg_measure(global_shape)
    view, direction = _svg_view(name)
    return _svg_json({"fixture": "svg-roundtrip", "case": name, "stage": "created",
                      "objectName": obj.Name, "definition": definition,
                      "view": view, "direction": direction, "source": source,
                      "sampleLimitPerDirection": _SVG_SAMPLE_LIMIT})


def read_svg_case(path, name):
    _svg_require(not doc.Objects, "SVG 独立回读必须从本次空文档开始")
    original, definition = _svg_case_shape(name)
    expected, reference = _svg_expected_shape(original, name)
    view, direction = _svg_view(name)
    path = os.path.realpath(path)
    _svg_require(os.path.isfile(path) and os.path.getsize(path) > 0, "SVG 交换文件不存在或为空")
    import importSVG
    settings = {"svgDisableUnitScaling": bool(importSVG.params.get_param("svgDisableUnitScaling")),
                "svgstyle": int(importSVG.params.get_param("svgstyle")),
                "svgPrecision": int(importSVG.params.get_param("svgPrecision"))}
    returned = importSVG.insert(path, doc.Name)
    _svg_require(returned is None, "安装版 importSVG.insert 返回语义改变，需重新核对")
    doc.recompute()
    actual, objects, excluded = _svg_imported_shapes()
    expected_to_actual = _svg_distances(expected, actual)
    actual_to_expected = _svg_distances(actual, expected)
    expected_measure = _svg_measure(expected)
    actual_measure = _svg_measure(actual)
    return _svg_json({"fixture": "svg-roundtrip", "case": name, "stage": "readback",
                      "path": path, "definition": definition, "view": view,
                      "direction": direction, "reference": reference,
                      "importer": {"name": "importSVG.insert", "module": os.path.realpath(importSVG.__file__),
                                   "settings": settings, "returnValue": None},
                      "objects": [{"name": obj.Name, "type": obj.TypeId} for obj in objects],
                      "excludedDuplicateConsumers": excluded,
                      "expected": expected_measure, "actual": actual_measure,
                      "sampling": {"limitPerDirection": _SVG_SAMPLE_LIMIT,
                                   "method": "uniform finite parameters across actual edges",
                                   "scope": "representative bidirectional samples; not exhaustive Hausdorff proof"},
                      "expectedToActual": expected_to_actual, "actualToExpected": actual_to_expected,
                      "maxDistance": max(expected_to_actual["maxDistance"], actual_to_expected["maxDistance"])})
