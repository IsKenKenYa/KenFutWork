/** 按需查询真实拓扑；保留原 Shape 的 EdgeN，只包装当前页并应用父容器变换。 */
export const FREECAD_TOPOLOGY_SOURCE = `def edge_description(edge, name):
    degenerated = bool(edge.Degenerated)
    vertices = []
    for vertex in edge.Vertexes:
        point = vertex.Point
        vertices.append([point.x, point.y, point.z])
    bounds = None if degenerated else edge.optimalBoundingBox(False, False)
    return {
        "name": name,
        "curveType": None if degenerated else type(edge.Curve).__name__,
        "length": edge.Mass,
        "vertices": vertices,
        "bounds": [bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax] if bounds is not None and bounds.isValid() else None,
        "closed": bool(edge.Closed),
    }


def edge_page(doc, request):
    name = request["objectName"]
    obj = doc.getObject(name)
    if obj is None:
        raise ValueError("边查询对象不存在: " + name)
    if not has_shape_property(obj) or obj.Shape.isNull():
        raise ValueError("边查询对象没有有效 Shape: " + name)
    shape = obj.Shape
    total = shape.countElement("Edge")
    offset, limit = request.get("offset", 0), request.get("limit", 50)
    end = min(total, offset + limit)
    items = []
    for index in range(offset, end):
        edge_name = "Edge" + str(index + 1)
        edge = global_shape(obj, shape.getElement(edge_name))
        items.append(edge_description(edge, edge_name))
    return {"objectName": name, "coordinateFrame": "global", "unit": "mm", "offset": offset,
            "total": total, "nextOffset": end if end < total else None, "items": items}
`;
