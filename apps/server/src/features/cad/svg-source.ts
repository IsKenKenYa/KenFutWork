/** 序列化 TechDraw 已投影的原生曲线；数字精度与曲线近似分别明确记录。 */
export const FREECAD_SVG_SOURCE = `
import math
from html import escape as _precise_svg_escape


def _precise_svg_number(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("SVG 原生几何含非有限数值")
    return "0" if value == 0 else format(value, ".17g")


def _precise_svg_point(point):
    if not all(math.isfinite(value) for value in (point.x, point.y, point.z)):
        raise ValueError("SVG 原生几何含非有限坐标")
    if abs(point.z) > App.Base.Precision.confusion() * 10:
        raise ValueError("SVG 编码需要 TechDraw 的 XY 平面投影几何")
    return _precise_svg_number(point.x) + " " + _precise_svg_number(point.y)


def _precise_svg_range(edge):
    first, last = edge.ParameterRange
    if not math.isfinite(first) or not math.isfinite(last) or not first < last:
        raise ValueError("SVG 原生边的裁剪参数范围无效")
    return first, last


def _precise_svg_conic(edge, curve, first, last):
    axis, x_axis = curve.Axis, curve.XAxis
    angular = App.Base.Precision.angular()
    if not all(math.isfinite(value) for value in (axis.x, axis.y, axis.z, x_axis.x, x_axis.y, x_axis.z)):
        raise ValueError("SVG 圆锥曲线的轴向无效")
    if abs(axis.x) > angular or abs(axis.y) > angular or abs(abs(axis.z) - 1) > angular or abs(x_axis.z) > angular:
        raise ValueError("SVG 圆或椭圆必须来自 XY 平面原生投影")
    if curve.TypeId == "Part::GeomCircle":
        major, minor, rotation = curve.Radius, curve.Radius, 0.0
    else:
        major, minor = curve.MajorRadius, curve.MinorRadius
        rotation = math.degrees(math.atan2(x_axis.y, x_axis.x))
    if not math.isfinite(major) or not math.isfinite(minor) or major <= 0 or minor <= 0:
        raise ValueError("SVG 圆或椭圆半径无效")
    span = last - first
    if span > 2 * math.pi + angular:
        raise ValueError("SVG 原生圆或椭圆边超过单个参数周期")
    # SVG 的单个 A 命令不能表达首尾相同的整圆；用两个原生半弧。
    full = abs(span - 2 * math.pi) <= angular
    stops = (first + span / 2, last) if full else (last,)
    sweep = "1" if axis.z > 0 else "0"
    path = "M " + _precise_svg_point(edge.valueAt(first))
    previous = first
    for parameter in stops:
        large = "1" if parameter - previous > math.pi else "0"
        path += " A " + " ".join((_precise_svg_number(major), _precise_svg_number(minor),
                                  _precise_svg_number(rotation), large, sweep,
                                  _precise_svg_point(edge.valueAt(parameter))))
        previous = parameter
    return '<path d="' + path + '"/>'


def _precise_svg_bezier(curve):
    degree = curve.Degree
    poles = curve.getPoles()
    if curve.isRational() or degree not in (1, 2, 3) or len(poles) != degree + 1:
        raise ValueError("SVG 精确 Bezier 编码需要非有理一至三阶曲线")
    command = {1: "L", 2: "Q", 3: "C"}[degree]
    path = "M " + _precise_svg_point(poles[0]) + " " + command + " " + " ".join(
        _precise_svg_point(point) for point in poles[1:]
    )
    return '<path d="' + path + '"/>'


def _precise_svg_polyline(edge, tolerance):
    # 固定 SDK 的 Deflection 分支使用 GCPnts_UniformDeflection，默认启用误差检查。
    # 官方算法要求 C2；低连续度 BSpline 在调用方先精确分解成各个 Bezier 段。
    if edge.Continuity not in ("C2", "C3", "CN"):
        raise ValueError("原生 SVG 折线近似需要可确认的 C2 连续曲线")
    points = edge.discretize(Deflection=tolerance)
    if len(points) < 2:
        raise ValueError("原生 SVG 折线近似没有返回完整端点")
    first, last = _precise_svg_range(edge)
    if (points[0] - edge.valueAt(first)).Length > tolerance or (points[-1] - edge.valueAt(last)).Length > tolerance:
        raise ValueError("原生 SVG 折线近似没有保留裁剪端点")
    # 标准 polyline 保留同一组点，避开交换方通用 path 的逐命令处理。
    fragment = '<polyline points="' + " ".join(_precise_svg_point(point) for point in points) + '"/>'
    return fragment, len(points) - 1


def _precise_svg_spline(edge, curve, first, last, tolerance):
    # Curve 是 BRepAdaptor 的独立几何副本，已包含边 Location；只裁剪副本。
    trimmed = curve.copy()
    trimmed.segment(first, last)
    pieces = trimmed.toBezier() if curve.TypeId == "Part::GeomBSplineCurve" else [trimmed]
    if not pieces:
        raise ValueError("原生 BSpline 到 Bezier 分解没有返回曲线")
    paths, segments, approximated = [], 0, False
    for piece in pieces:
        if not piece.isRational() and piece.Degree in (1, 2, 3):
            paths.append(_precise_svg_bezier(piece))
        else:
            path, count = _precise_svg_polyline(piece.toShape(), tolerance)
            paths.append(path)
            segments += count
            approximated = True
    return " ".join(paths), segments if approximated else None


def _precise_svg_edge(edge, tolerance):
    if edge.Degenerated:
        raise ValueError("SVG 投影包含无法编码为普通曲线的退化边")
    first, last = _precise_svg_range(edge)
    try:
        curve = edge.Curve
    except TypeError as error:
        # 固定 SDK 仅在 GeomAbs_OtherCurve 分支没有 Python 几何 wrapper。
        # 原生 edge adaptor 仍可执行有误差控制的 C2 离散化，不伪造 Curve.TypeId。
        if str(error) != "undefined curve type":
            raise
        path, segments = _precise_svg_polyline(edge, tolerance)
        return path, "GeomAbs_OtherCurve", segments
    curve_type = curve.TypeId
    if curve_type == "Part::GeomLine":
        return '<path d="M ' + _precise_svg_point(edge.valueAt(first)) + " L " + _precise_svg_point(edge.valueAt(last)) + '"/>', curve_type, None
    if curve_type in ("Part::GeomCircle", "Part::GeomEllipse"):
        return _precise_svg_conic(edge, curve, first, last), curve_type, None
    if curve_type in ("Part::GeomBezierCurve", "Part::GeomBSplineCurve"):
        path, segments = _precise_svg_spline(edge, curve, first, last, tolerance)
        return path, curve_type, segments
    path, segments = _precise_svg_polyline(edge, tolerance)
    return path, curve_type, segments


def precise_svg_fragment(groups, style):
    tolerance = App.Base.Precision.confusion() * 10
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise ValueError("原生 SVG 近似容差无效")
    attributes = {"stroke": "rgb(0, 0, 0)", "stroke-width": "1.0",
                  "stroke-linecap": "butt", "stroke-linejoin": "miter", **style,
                  "fill": "none", "transform": "scale(1,-1)"}
    encoded_attributes = " ".join(
        _precise_svg_escape(str(key), quote=True) + '="' + _precise_svg_escape(
            _precise_svg_number(value) if isinstance(value, (int, float)) else str(value), quote=True
        ) + '"' for key, value in attributes.items()
    )
    paths, approximations = [], []
    edge_count = 0
    for group_index, group in enumerate(groups):
        if group.isNull():
            continue
        for edge_index in range(1, group.countElement("Edge") + 1):
            edge = group.getElement("Edge" + str(edge_index))
            try:
                path, curve_type, segments = _precise_svg_edge(edge, tolerance)
            except Exception as error:
                raise ValueError("第 " + str(group_index + 1) + " 组投影 Edge" + str(edge_index) + " 的 SVG 编码失败: " + str(error)) from error
            paths.append(path)
            edge_count += 1
            if segments is not None:
                approximations.append({"groupIndex": group_index, "edgeIndex": edge_index,
                                       "curveType": curve_type, "lineSegments": segments,
                                       "method": "GCPnts_UniformDeflection", "toleranceMm": tolerance})
    if edge_count == 0:
        raise ValueError("原生 SVG 编码没有可见投影边")
    fragment = "<g " + encoded_attributes + ">" + "".join(paths) + "</g>"
    return fragment, {"numericPrecision": 17, "edgeCount": edge_count,
                      "approximationToleranceMm": tolerance, "approximatedEdges": approximations}
`;
