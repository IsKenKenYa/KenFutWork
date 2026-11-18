"""独立后台工程的原生选边实验，不是用户GUI或结构化工具实现。"""

body = doc.addObject("PartDesign::Body", "Body")
box = body.newObject("PartDesign::AdditiveBox", "Box")
box.Length, box.Width, box.Height = 10, 10, 10
doc.recompute()


def vertical_edge(feature, x, y):
    matches = []
    for index, edge in enumerate(feature.Shape.Edges, 1):
        points = [vertex.Point for vertex in edge.Vertexes]
        if len(points) == 2 and all(abs(point.x - x) < 1e-7 and abs(point.y - y) < 1e-7 for point in points):
            if abs(edge.Length - 10) < 1e-7:
                matches.append("Edge" + str(index))
    assert len(matches) == 1, str((feature.Name, x, y, matches))
    return matches[0]


initial = body.newObject("PartDesign::Fillet", "InitialFillet")
initial.Base = (box, [vertical_edge(box, 0, 0)])
initial.UseAllEdges = False
initial.Radius = 1
body.Tip = initial
doc.recompute()
assert initial.Shape.isValid() and len(initial.Shape.Solids) == 1
sharp = vertical_edge(initial, 10, 10)
smooth = vertical_edge(initial, 1, 0)
original_group = list(body.Group)
original_volume = body.Shape.Volume


def inspect_selection(kind, parameter, selected, edge_class):
    probe = doc.addObject("PartDesign::" + kind, "KfwSelectionProbe")
    name = probe.Name
    try:
        probe.BaseFeature = initial
        probe.Base = (initial, [selected])
        probe.UseAllEdges = False
        if kind == "Chamfer":
            probe.ChamferType = "Equal distance"
        setattr(probe, parameter, 0)
        assert getattr(probe, parameter).Value == 0
        doc.recompute()
        row = {"kind": kind, "edgeClass": edge_class, "status": probe.getStatusString(),
               "parameter": getattr(probe, parameter).Value, "shapeNull": probe.Shape.isNull(),
               "outsideBody": probe.getParentGeoFeatureGroup() is None}
        assert body.Tip is initial and list(body.Group) == original_group
        assert abs(body.Shape.Volume - original_volume) < 1e-7
        return row
    finally:
        if doc.getObject(name) is probe:
            doc.removeObject(name)
        doc.recompute()


outcomes = []
for kind, parameter in [("Fillet", "Radius"), ("Chamfer", "Size")]:
    outcomes.append(inspect_selection(kind, parameter, sharp, "sharp"))
    outcomes.append(inspect_selection(kind, parameter, smooth, "smooth"))
assert list(body.Group) == original_group and body.Tip is initial
assert not any(obj.Name.startswith("KfwSelectionProbe") for obj in doc.Objects)

# SDK原生混选会成功而忽略smooth边：为后续结构化入口保留可复现证据。
mixed = body.newObject("PartDesign::Fillet", "MixedFillet")
mixed.Base = (initial, [sharp, smooth])
mixed.UseAllEdges = False
mixed.Radius = 0.5
body.Tip = mixed
doc.recompute()
assert mixed.Shape.isValid() and len(mixed.Shape.Solids) == 1
result = {"outcomes": outcomes, "sharp": sharp, "smooth": smooth,
          "mixedVolume": mixed.Shape.Volume, "mixedRequestedEdges": list(mixed.Base[1]),
          "tip": body.Tip.Name}
