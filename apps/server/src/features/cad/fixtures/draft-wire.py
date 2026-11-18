"""FreeCAD 1.1.4 Draft Wire 的真实参数、几何及保存重开验收。

一手接口：随包 draftmake/make_wire.py、draftobjects/wire.py、
draftviewproviders/view_wire.py。使用正式 make_wire 工厂及真实官方
代理／ViewProvider；工厂的选择副作用仅发生在自有离屏 Task 进程，
不连接用户 GUI，不设置 Shape，不使用 Sketcher 或替代代理。
宿主提供 App、Part、doc、output_directory；FCStd 与交换文件由 KFW 交付。
"""

import math

import Draft
from draftobjects.wire import Wire
from draftviewproviders.view_wire import ViewProviderWire


_WIRE_NAME = "Wire"
_WIRE_TOLERANCE = 1e-6
_WIRE_OPTION_NAMES = {"width", "height", "resizedWidth", "resizedHeight"}


def _wire_require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _wire_dimension(value):
    _wire_require(isinstance(value, (int, float)) and not isinstance(value, bool)
                  and math.isfinite(value) and value > 0, "Draft 矩形尺寸必须是有限正数")
    return float(value)


def _wire_close(actual, expected, reason):
    _wire_require(math.isfinite(actual) and math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-7), reason)


def _wire_vector(point):
    values = [float(point.x), float(point.y), float(point.z)]
    _wire_require(all(math.isfinite(value) for value in values), "Draft 几何含非有限坐标")
    return values


def _wire_points(width, height):
    return [App.Vector(0, 0, 0), App.Vector(width, 0, 0),
            App.Vector(width, height, 0), App.Vector(0, height, 0)]


def _wire_placement():
    return App.Placement(App.Vector(125, -75, 0), App.Rotation(App.Vector(0, 0, 1), 30))


def _wire_pose(placement):
    return {"position": _wire_vector(placement.Base),
            "quaternion": [float(value) for value in placement.Rotation.Q]}


def _wire_type(proxy):
    return type(proxy).__module__ + "." + type(proxy).__name__


def _wire_bounds(shape):
    bounds = shape.BoundBox
    return [bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax]


def _wire_create_or_load(options):
    obj = doc.getObject(_WIRE_NAME)
    if obj is not None:
        return obj, True
    placement = _wire_placement()
    local_points = _wire_points(options.get("width", 1000.0), options.get("height", 500.0))
    # 官方工厂在给定 placement 时将传入世界点逆变换为局部 Points。
    obj = Draft.make_wire([placement.multVec(point) for point in local_points],
                          closed=True, placement=placement, face=True)
    _wire_require(obj is not None and obj.Name == _WIRE_NAME, "官方 Draft 工厂没有返回预期对象")
    obj.FilletRadius, obj.ChamferSize, obj.Subdivisions = 0.0, 0.0, 0
    obj.MapMode = "Deactivated"
    obj.Label = "参数矩形"
    doc.recompute()
    return obj, False


def _wire_validate_object(obj):
    _wire_require(obj.TypeId == "Part::FeaturePython" and isinstance(obj.Proxy, Wire)
                  and obj.Proxy.Type == "Wire", "对象不是原生参数 Draft Wire")
    _wire_require(obj.ViewObject is not None and isinstance(obj.ViewObject.Proxy, ViewProviderWire),
                  "Draft Wire 的真实 ViewProvider 没有恢复")
    _wire_require(obj.Closed and obj.MakeFace and obj.Base is None and obj.Tool is None,
                  "Draft Wire 未保留独立闭合面参数")
    _wire_require(obj.MapMode == "Deactivated" and not obj.AttachmentSupport,
                  "Draft Wire 不应附着到外部支撑")
    _wire_require(obj.FilletRadius.Value == 0 and obj.ChamferSize.Value == 0 and obj.Subdivisions == 0,
                  "Draft Wire 不应带圆角、倒角或分段")
    _wire_require(obj.Placement.isSame(_wire_placement(), _WIRE_TOLERANCE),
                  "Draft Wire 没有保留显式 Placement")
    _wire_require(obj.getStatusString() == "Valid", "Draft Wire 重算失败: " + obj.getStatusString())
    points = list(obj.Points)
    _wire_require(len(points) == 4, "Draft Wire 必须保留四个参数点")
    width, height = _wire_dimension(points[1].x), _wire_dimension(points[2].y)
    expected = _wire_points(width, height)
    _wire_require(all((point - target).Length < _WIRE_TOLERANCE for point, target in zip(points, expected)),
                  "Draft Wire 参数点没有组成预期局部矩形")
    return width, height, points


def _wire_edges(shape, expected_points):
    edges = []
    matched = set()
    for index, edge in enumerate(shape.Edges, 1):
        vertices = edge.Vertexes
        _wire_require(len(vertices) == 2 and edge.Curve.TypeId == "Part::GeomLine",
                      "Draft 矩形含非直线边或异常端点")
        start, end = vertices[0].Point, vertices[1].Point
        candidates = []
        for number, target_start in enumerate(expected_points):
            target_end = expected_points[(number + 1) % 4]
            forward = (start - target_start).Length < _WIRE_TOLERANCE and (end - target_end).Length < _WIRE_TOLERANCE
            reverse = (end - target_start).Length < _WIRE_TOLERANCE and (start - target_end).Length < _WIRE_TOLERANCE
            if forward or reverse:
                candidates.append(number)
                _wire_close(edge.Length, (target_end - target_start).Length, "Draft 边长不符")
        _wire_require(len(candidates) == 1 and candidates[0] not in matched, "Draft 实际边没有唯一对应矩形参数边")
        matched.add(candidates[0])
        edges.append({"name": "Edge" + str(index), "start": _wire_vector(start),
                      "end": _wire_vector(end), "length": float(edge.Length), "curveType": edge.Curve.TypeId})
    _wire_require(len(edges) == 4 and len(matched) == 4, "Draft 实际矩形未保留完整四边")
    return edges


def _wire_measure(obj, stage):
    width, height, points = _wire_validate_object(obj)
    shape = obj.Shape
    _wire_require(not shape.isNull() and shape.isValid() and len(shape.Faces) == 1
                  and len(shape.Wires) == 1 and len(shape.Vertexes) == 4 and len(shape.Solids) == 0,
                  "Draft Wire 没有生成有效二维面")
    _wire_require(shape.Wires[0].isClosed(), "Draft Wire 的实际轮廓未闭合")
    face = shape.Faces[0]
    _wire_require(face.Surface.TypeId == "Part::GeomPlane", "Draft 矩形面不是平面")
    normal = face.normalAt(0, 0)
    _wire_require((normal - App.Vector(0, 0, 1)).Length < _WIRE_TOLERANCE,
                  "Draft 矩形面没有保持 Z0 平面方向")
    _wire_close(shape.Area, width * height, "Draft 实际面积不符")
    _wire_close(shape.Length, 2 * (width + height), "Draft 实际周长不符")
    _wire_close(obj.Area.Value, shape.Area, "Draft Area 参数没有跟随实际几何")
    _wire_close(obj.Length.Value, shape.Length, "Draft Length 参数没有跟随实际几何")
    local = shape.copy()
    local.Placement = App.Placement()
    global_points = [obj.getGlobalPlacement().multVec(point) for point in points]
    for vertices, expected in ((local.Vertexes, points), (shape.Vertexes, global_points)):
        for point in expected:
            _wire_require(sum((vertex.Point - point).Length < _WIRE_TOLERANCE for vertex in vertices) == 1,
                          "Draft 实际顶点与局部／全局参数位置不一致")
    _wire_require(all(abs(vertex.Point.z) < _WIRE_TOLERANCE for vertex in shape.Vertexes),
                  "Draft 实际几何不在 Z0 平面")
    return {"stage": stage, "objectName": obj.Name, "nativeTypeId": obj.TypeId,
            "proxyType": _wire_type(obj.Proxy), "viewProviderType": _wire_type(obj.ViewObject.Proxy),
            "parameters": {"width": width, "height": height, "closed": bool(obj.Closed), "makeFace": bool(obj.MakeFace)},
            "placement": _wire_pose(obj.Placement),
            "points": {"local": [_wire_vector(point) for point in points],
                       "global": [_wire_vector(point) for point in global_points]},
            "geometry": {"valid": bool(shape.isValid()), "closed": bool(shape.Wires[0].isClosed()),
                         "edgeCount": len(shape.Edges), "vertexCount": len(shape.Vertexes),
                         "faceCount": len(shape.Faces), "wireCount": len(shape.Wires), "solidCount": len(shape.Solids),
                         "planar": True, "normal": _wire_vector(normal), "area": float(shape.Area),
                         "perimeter": float(shape.Length), "localBounds": _wire_bounds(local), "globalBounds": _wire_bounds(shape),
                         "localVertices": [_wire_vector(vertex.Point) for vertex in local.Vertexes],
                         "globalVertices": [_wire_vector(vertex.Point) for vertex in shape.Vertexes],
                         "localEdges": _wire_edges(local, points), "globalEdges": _wire_edges(shape, global_points)}}


def _wire_stage(obj, stage, width, height):
    obj.Points = _wire_points(width, height)
    doc.recompute()
    observed = _wire_measure(obj, stage)
    _wire_close(observed["parameters"]["width"], width, "Draft 宽度参数没有生效")
    _wire_close(observed["parameters"]["height"], height, "Draft 高度参数没有生效")
    _wire_require(doc.getObject(_WIRE_NAME) is obj, "改点后 Draft 对象身份改变")
    return observed


def run_wire_case(options=None):
    _wire_require(App.GuiUp and App.ActiveDocument is doc, "Draft 验收需要真实离屏 GUI 与当前 Task 文档")
    options = {} if options is None else options
    _wire_require(isinstance(options, dict) and set(options).issubset(_WIRE_OPTION_NAMES), "Draft 验收包含未知选项")
    options = {key: _wire_dimension(value) for key, value in options.items()}
    obj, reused = _wire_create_or_load(options)
    # 重开后先核验原始参数、代理和实际几何，再允许本轮改点。
    incoming = _wire_measure(obj, "incoming")
    width = options.get("width", incoming["parameters"]["width"])
    height = options.get("height", incoming["parameters"]["height"])
    resized_width, resized_height = options.get("resizedWidth", width + 250), options.get("resizedHeight", height + 100)
    _wire_require((width, height) != (resized_width, resized_height), "Draft 第二轮必须改变宽度或高度")
    stages = [_wire_stage(obj, "reopened" if reused else "initial", width, height),
              _wire_stage(obj, "resized", resized_width, resized_height)]
    final = stages[-1]
    return {"capability": "draft_wire", "reused": reused, "objectName": obj.Name,
            "nativeTypeId": obj.TypeId, "proxyType": final["proxyType"], "viewProviderType": final["viewProviderType"],
            "incoming": incoming, "stages": stages, "parameters": final["parameters"],
            "placement": final["placement"], "points": final["points"], "geometry": final["geometry"]}
