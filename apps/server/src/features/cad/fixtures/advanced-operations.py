"""FreeCAD 进阶能力原生回归夹具。

宿主预置 App、Part、doc、output_directory；最终 doc 保持存活，由宿主发布。
官方来源：本机 FreeCAD 1.1.4 随附源码；本夹具独立编写，不导入官方测试 helper。
  Mod/PartDesign/PartDesignTests/TestBoolean.py:34-116：setObjects、Type=0/1/2。
  同目录 TestFillet.py:33-58：Base/Radius/UseAllEdges；TestChamfer.py:31-60：Base/Size。
  TestLinearPattern.py:32-48,147-166：Originals/Direction/Length/Occurrences、H_Axis。
  TestPolarPattern.py:92-111：Originals/N_Axis/Angle/Occurrences。
  Mod/TechDraw/TDTest/TechDrawTestUtilities.py:5-17：DrawPage/SVGTemplate。
  DrawViewPartTest.py:30-50：Source、Qt等待、投影边；DrawViewDimensionTest.py:52-74：尺寸。
  TechDraw.so公开API：makeExtentDim(view,[],0/1)、getRawValue、project/projectToSVG。
  TechDrawGui.so公开API：exportPageAsSvg；使用官方 Default_Template_A4_Landscape.svg。
需要既有离屏 QApplication 和官方 GUI 文档宿主，不启动可见窗口或外部进程。
"""

import json
import math
import os
import shutil
import time
import xml.etree.ElementTree as ET


TOLERANCE = 0.000001
metadata_path = os.path.join(output_directory, "advanced-official-private.json")
metadata = {"status": "running", "checks": [], "artifacts": [], "guiDependencies": [
    "既有离屏 QApplication 与官方 FreeCAD GUI 文档序列化器",
    "TechDrawGui.exportPageAsSvg；不需要屏幕截图或另开可见应用",
]}
with open(metadata_path, "x", encoding="utf-8") as stream:
    json.dump(metadata, stream, ensure_ascii=False, allow_nan=False)


def persist():
    with open(metadata_path, "w", encoding="utf-8") as stream:
        json.dump(metadata, stream, ensure_ascii=False, allow_nan=False, indent=2)


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def begin_step(name):
    metadata["activeStep"] = name
    persist()


def close_value(actual, expected, reason):
    require(math.isfinite(actual) and math.isclose(actual, expected, rel_tol=0, abs_tol=TOLERANCE),
            reason + ": actual=" + str(actual) + ", expected=" + str(expected))


def named_object(type_id, name, body=None):
    require(doc.getObject(name) is None, "对象名称已存在: " + name)
    obj = doc.addObject(type_id, name) if body is None else body.newObject(type_id, name)
    require(obj.Name == name, "FreeCAD 自动修改了对象名: " + name + " -> " + obj.Name)
    return obj


def require_new_path(name):
    path = os.path.join(output_directory, name)
    require(not os.path.lexists(path), "验收产物已存在，拒绝覆盖: " + name)
    return path


def solid(obj, volume, bounds=None):
    require(obj is not None, "几何对象缺失")
    require(not obj.Shape.isNull() and obj.Shape.isValid(), "对象几何为空或无效: " + obj.Name)
    require(len(obj.Shape.Solids) == 1, "对象不是单实体: " + obj.Name)
    require(not any("error" in state.lower() or "invalid" in state.lower() for state in obj.State),
            "对象重算错误: " + obj.Name + " " + str(obj.State))
    close_value(obj.Shape.Volume, volume, obj.Name + " 体积")
    box = obj.Shape.optimalBoundingBox(False, False)
    measured = [box.XMin, box.YMin, box.ZMin, box.XMax, box.YMax, box.ZMax]
    if bounds is not None:
        for name, actual, expected in zip(("XMin", "YMin", "ZMin", "XMax", "YMax", "ZMax"), measured, bounds):
            close_value(actual, expected, obj.Name + " " + name)
    return {"object": obj.Name, "type": obj.TypeId, "volume": obj.Shape.Volume,
            "expectedVolume": volume, "bounds": measured, "solids": len(obj.Shape.Solids)}


def receipt(stage, capability, details):
    metadata["checks"].append({"stage": stage, "capability": capability, **details})
    persist()


def body_box(prefix, length=10.0, width=10.0, height=10.0):
    body = named_object("PartDesign::Body", prefix + "Body")
    box = named_object("PartDesign::AdditiveBox", prefix + "Box", body)
    box.Length, box.Width, box.Height = length, width, height
    body.Tip = box
    doc.recompute()
    return body, box


def create_booleans():
    for label, mode in (("Fuse", 0), ("Cut", 1), ("Common", 2)):
        target_body, target = body_box("Boolean" + label + "Target")
        tool_body, tool = body_box("Boolean" + label + "Tool")
        tool.Placement.Base = App.Vector(5, 0, 0)
        doc.recompute()
        feature = named_object("PartDesign::Boolean", "Boolean" + label, target_body)
        feature.setObjects([tool_body])
        feature.Type = mode
        target_body.Tip = feature
        target.ViewObject.Visibility = False
        tool_body.ViewObject.Visibility = False
        target_body.ViewObject.Visibility = True
        feature.ViewObject.Visibility = True
        doc.recompute()


def vertical_origin_edge(box):
    matches = []
    for index, edge in enumerate(box.Shape.Edges, 1):
        vertices = edge.Vertexes
        if len(vertices) != 2:
            continue
        points = [vertex.Point for vertex in vertices]
        if all(abs(point.x) < TOLERANCE and abs(point.y) < TOLERANCE for point in points):
            if abs(edge.Length - box.Height.Value) < TOLERANCE:
                matches.append("Edge" + str(index))
    require(len(matches) == 1, "无法从实际几何唯一识别原点竖边")
    return matches[0]


def create_dressups():
    for prefix, type_id, parameter in (("Fillet", "PartDesign::Fillet", "Radius"),
                                        ("Chamfer", "PartDesign::Chamfer", "Size")):
        body, box = body_box(prefix)
        edge_name = vertical_origin_edge(box)
        feature = named_object(type_id, prefix + "Feature", body)
        feature.Base = (box, [edge_name])
        feature.UseAllEdges = False
        setattr(feature, parameter, 1.0)
        body.Tip = feature
        box.ViewObject.Visibility = False
        body.ViewObject.Visibility = True
        feature.ViewObject.Visibility = True
        metadata.setdefault("selectedEdges", {})[prefix] = edge_name
        doc.recompute()


def rectangle_pad(prefix):
    body = named_object("PartDesign::Body", prefix + "Body")
    profile = named_object("Sketcher::SketchObject", prefix + "Profile", body)
    profile.MapMode = "Deactivated"
    points = [App.Vector(0, 0, 0), App.Vector(10, 0, 0), App.Vector(10, 10, 0), App.Vector(0, 10, 0)]
    profile.addGeometry([Part.LineSegment(points[i], points[(i + 1) % 4]) for i in range(4)], False)
    constraints = [Sketcher.Constraint("Coincident", i, 2, (i + 1) % 4, 1) for i in range(4)]
    constraints.extend(Sketcher.Constraint("Horizontal", i) for i in (0, 2))
    constraints.extend(Sketcher.Constraint("Vertical", i) for i in (1, 3))
    constraints.extend([Sketcher.Constraint("PointOnObject", 0, 1, -2),
                        Sketcher.Constraint("PointOnObject", 0, 1, -1)])
    profile.addConstraint(constraints)
    for name, constraint in (("Width", Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 10.0)),
                             ("Height", Sketcher.Constraint("DistanceY", 1, 1, 1, 2, 10.0))):
        index = profile.addConstraint(constraint)
        profile.renameConstraint(index, prefix + "_" + name)
        require(profile.Constraints[index].Name == prefix + "_" + name, "阵列草图尺寸名被修改")
    doc.recompute()
    require(profile.solve() == 0 and profile.FullyConstrained, "阵列草图未完全约束")
    pad = named_object("PartDesign::Pad", prefix + "Pad", body)
    pad.Profile = profile
    pad.Type = 0
    pad.SideType = "One side"
    pad.Reversed = False
    pad.Length = 10.0
    body.Tip = pad
    doc.recompute()
    return body, profile, pad


def create_patterns():
    for prefix in ("Linear", "Polar"):
        body, profile, pad = rectangle_pad(prefix)
        feature = named_object("PartDesign::" + prefix + "Pattern", prefix + "Pattern", body)
        feature.Originals = [pad]
        feature.Occurrences = 4
        feature.Refine = True
        if prefix == "Linear":
            feature.Direction = (profile, ["H_Axis"])
            feature.Length = 30.0
        else:
            feature.Axis = (profile, ["N_Axis"])
            feature.Angle = 360.0
        body.Tip = feature
        profile.ViewObject.Visibility = False
        pad.ViewObject.Visibility = False
        body.ViewObject.Visibility = True
        feature.ViewObject.Visibility = True
        doc.recompute()


def pump_until(predicate, reason):
    deadline = time.monotonic() + 15.0
    last_error = None
    while time.monotonic() < deadline:
        application.processEvents()
        try:
            value = predicate()
            if value:
                return value
        except Exception as error:
            last_error = str(error)
        QtCore.QThread.msleep(20)
    raise ValueError(reason + (": " + last_error if last_error else ""))


def extent_dimension(page, view, direction, label):
    before = {obj.Name for obj in doc.Objects}
    # 原生API明确：空边列表表示整视图范围；0水平，1垂直，不猜投影Edge编号。
    returned = TechDraw.makeExtentDim(view, [], direction)
    created = [obj for obj in doc.Objects
               if obj.Name not in before and obj.isDerivedFrom("TechDraw::DrawViewDimension")]
    require(len(created) == 1, "makeExtentDim 未产生唯一真实尺寸对象")
    dimension = created[0]
    dimension.Label = label
    if dimension not in page.Views:
        page.addView(dimension)
    dimension.Arbitrary = False
    dimension.X, dimension.Y = (0.0, -25.0) if direction == 0 else (-40.0, 0.0)
    dimension.ViewObject.Fontsize = 3.5
    metadata.setdefault("extentCreation", []).append({
        "object": dimension.Name, "type": dimension.TypeId,
        "returnType": type(returned).__name__, "direction": direction,
    })
    return dimension.Name


def create_techdraw():
    box = named_object("Part::Box", "DrawingSourceBox")
    box.Length, box.Width, box.Height = 40.0, 20.0, 10.0
    page = named_object("TechDraw::DrawPage", "AdvancedPage")
    template = named_object("TechDraw::DrawSVGTemplate", "AdvancedTemplate")
    source_template = os.path.join(App.getResourceDir(), "Mod", "TechDraw", "Templates", "Default_Template_A4_Landscape.svg")
    copied_template = require_new_path("advanced-official-template.svg")
    with open(source_template, "rb") as incoming, open(copied_template, "xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing)
    template.Template = copied_template
    page.Template = template
    page.Scale = 1.0
    view = named_object("TechDraw::DrawViewPart", "AdvancedTopView")
    page.addView(view)
    view.Source = [box]
    view.Direction = App.Vector(0, 0, 1)
    require("XDirection" in view.PropertiesList, "TechDraw 视图缺少预期 XDirection")
    view.XDirection = App.Vector(1, 0, 0)
    view.X, view.Y = 80.0, 150.0
    doc.recompute()
    pump_until(lambda: len(view.getVisibleEdges(True)) == 4, "TechDraw 俯视投影未就绪")
    metadata["dimensions"] = {
        "width": extent_dimension(page, view, 0, "Overall width"),
        "height": extent_dimension(page, view, 1, "Overall height"),
    }
    doc.recompute()


def check_booleans(stage, edited):
    expected = {"Fuse": 1600.0 if edited else 1500.0,
                "Cut": 400.0 if edited else 500.0,
                "Common": 600.0 if edited else 500.0}
    shift, tool_length = (4.0, 12.0) if edited else (5.0, 10.0)
    for label, mode in (("Fuse", 0), ("Cut", 1), ("Common", 2)):
        feature = doc.getObject("Boolean" + label)
        body = doc.getObject("Boolean" + label + "TargetBody")
        tool = doc.getObject("Boolean" + label + "ToolBox")
        close_value(tool.Length.Value, tool_length, "布尔工具 Length")
        close_value(tool.Placement.Base.x, shift, "布尔工具位置")
        require(str(feature.Type) == feature.getEnumerationsOfProperty("Type")[mode], "布尔模式丢失")
        require(body.Tip is not None and body.Tip.Name == feature.Name, "布尔 Body.Tip 丢失")
        details = solid(feature, expected[label])
        solid(body, expected[label])
        require(feature.Shape.isInside(App.Vector(2, 5, 5), 0.0000001, True) == (label != "Common"),
                "布尔基体独有区域不符")
        require(feature.Shape.isInside(App.Vector(7, 5, 5), 0.0000001, True) == (label != "Cut"),
                "布尔交集区域不符")
        require(feature.Shape.isInside(App.Vector(14, 5, 5), 0.0000001, True) == (label == "Fuse"),
                "布尔工具独有区域不符")
        details["mode"] = str(feature.Type)
        receipt(stage, "boolean_" + label.lower(), details)


def check_dressups(stage, edited):
    size, distance = (12.0, 2.0) if edited else (10.0, 1.0)
    for prefix, parameter in (("Fillet", "Radius"), ("Chamfer", "Size")):
        body = doc.getObject(prefix + "Body")
        box = doc.getObject(prefix + "Box")
        feature = doc.getObject(prefix + "Feature")
        close_value(getattr(feature, parameter).Value, distance, prefix + " 参数")
        close_value(box.Length.Value, size, prefix + " 基体尺寸")
        removed = (1 - math.pi / 4) * distance ** 2 * size if prefix == "Fillet" else 0.5 * distance ** 2 * size
        expected = size ** 3 - removed
        details = solid(feature, expected, [0, 0, 0, size, size, size])
        solid(body, expected)
        require(body.Tip is not None and body.Tip.Name == feature.Name, "修饰特征 Tip 丢失")
        require(feature.Base[0].Name == box.Name and not feature.UseAllEdges, "修饰特征基体引用不符")
        require(not feature.Shape.isInside(App.Vector(distance / 10, distance / 10, size / 2), 0.0000001, True),
                "被选择的原点竖边未切除材料")
        require(feature.Shape.isInside(App.Vector(size - 0.5, size - 0.5, size / 2), 0.0000001, True),
                "无关角部材料意外丢失")
        details.update({"parameter": parameter, "value": getattr(feature, parameter).Value,
                        "base": feature.Base[0].Name, "subnames": list(feature.Base[1]),
                        "expectedFormula": "a^3-(1-pi/4)*r^2*a" if prefix == "Fillet" else "a^3-d^2*a/2"})
        receipt(stage, prefix.lower(), details)


def check_patterns(stage, edited):
    width, thickness = (12.0, 12.0) if edited else (10.0, 10.0)
    for prefix in ("Linear", "Polar"):
        body = doc.getObject(prefix + "Body")
        profile = doc.getObject(prefix + "Profile")
        pad = doc.getObject(prefix + "Pad")
        feature = doc.getObject(prefix + "Pattern")
        require(profile.solve() == 0 and profile.FullyConstrained, "阵列草图约束丢失")
        close_value(profile.getDatum(prefix + "_Width").Value, width, "阵列源草图 Width")
        close_value(pad.Length.Value, thickness, "阵列源 Pad 厚度")
        require(body.Tip is not None and body.Tip.Name == feature.Name, "阵列 Tip 没有保留")
        require([obj.Name for obj in feature.Originals] == [pad.Name], "阵列 Originals 引用不符")
        if prefix == "Linear":
            count, length = (5, 40.0) if edited else (4, 30.0)
            require(feature.Occurrences == count, "线性阵列数量不符")
            close_value(feature.Length.Value, length, "线性阵列总距离")
            require(feature.Direction[0].Name == profile.Name and list(feature.Direction[1]) == ["H_Axis"],
                    "线性阵列方向引用不符")
            expected, bounds = (width + length) * 10 * thickness, [0, 0, 0, width + length, 10, thickness]
            points = [App.Vector(i * length / (count - 1) + width / 2, 5, thickness / 2) for i in range(count)]
        else:
            require(feature.Occurrences == 4, "环形阵列数量不符")
            close_value(feature.Angle.Value, 360.0, "环形阵列角度")
            require(feature.Axis[0].Name == profile.Name and list(feature.Axis[1]) == ["N_Axis"],
                    "环形阵列轴引用不符")
            expected, bounds = 4 * width * 10 * thickness, [-width, -width, 0, width, width, thickness]
            points = [App.Vector(width / 2 * math.cos(i * math.pi / 2) - 5 * math.sin(i * math.pi / 2),
                                 width / 2 * math.sin(i * math.pi / 2) + 5 * math.cos(i * math.pi / 2), thickness / 2)
                      for i in range(4)]
        details = solid(feature, expected, bounds)
        solid(body, expected)
        require(all(feature.Shape.isInside(point, 0.0000001, True) for point in points), "阵列副本采样点缺失")
        require(not profile.ViewObject.Visibility and not pad.ViewObject.Visibility
                and body.ViewObject.Visibility and feature.ViewObject.Visibility, "阵列显示状态不符")
        receipt(stage, prefix.lower() + "_pattern", details)


def verify_svg(path):
    require(os.path.isfile(path) and os.path.getsize(path) > 0, "SVG 输出不存在或为空")
    tree = ET.parse(path)
    require(tree.getroot().tag.split("}")[-1] == "svg", "输出不是 SVG 文档")
    require(any(node.tag.split("}")[-1] in ("path", "line", "polyline", "polygon", "circle")
                for node in tree.iter()), "SVG 没有实际绘图几何")
    metadata["artifacts"].append({"path": path, "bytes": os.path.getsize(path)})


def check_techdraw(stage, edited):
    length, width, height = (50.0, 25.0, 12.0) if edited else (40.0, 20.0, 10.0)
    box = doc.getObject("DrawingSourceBox")
    page, view = doc.getObject("AdvancedPage"), doc.getObject("AdvancedTopView")
    horizontal = doc.getObject(metadata["dimensions"]["width"])
    vertical = doc.getObject(metadata["dimensions"]["height"])
    solid(box, length * width * height)
    pump_until(lambda: len(view.getVisibleEdges(True)) == 4, "重算后的 TechDraw 投影未就绪")
    pump_until(lambda: abs(float(horizontal.getRawValue()) - length) < TOLERANCE
               and abs(float(vertical.getRawValue()) - width) < TOLERANCE, "TechDraw 实际尺寸没有随基体更新")
    require(not horizontal.Arbitrary and not vertical.Arbitrary, "工程图尺寸被手工覆写")
    require([obj.Name for obj in view.Source] == [box.Name], "工程图视图源引用丢失")
    groups = TechDraw.project(box.Shape, App.Vector(0, 0, 1))
    projected = [group for group in groups[:2] if not group.isNull() and group.Edges]
    require(bool(projected), "TechDraw 原生投影没有可见边")
    bounds = App.BoundBox()
    for group in projected:
        bounds.add(group.BoundBox)
    close_value(bounds.XLength, length, "TechDraw 原生投影宽度")
    close_value(bounds.YLength, width, "TechDraw 原生投影高度")
    fragment = TechDraw.projectToSVG(box.Shape, App.Vector(0, 0, 1))
    margin = max(length, width) * 0.05
    viewbox = [bounds.XMin - margin, -bounds.YMax - margin,
               bounds.XLength + margin * 2, bounds.YLength + margin * 2]
    projection_path = require_new_path("advanced-" + stage + "-projection.svg")
    with open(projection_path, "x", encoding="utf-8") as stream:
        stream.write('<svg xmlns="http://www.w3.org/2000/svg" width="' + str(viewbox[2])
                     + 'mm" height="' + str(viewbox[3]) + 'mm" viewBox="'
                     + " ".join(str(value) for value in viewbox) + '">' + fragment + '</svg>')
    verify_svg(projection_path)
    page_path = require_new_path("advanced-" + stage + "-dimensioned-page.svg")
    TechDrawGui.exportPageAsSvg(page, page_path)
    verify_svg(page_path)
    receipt(stage, "techdraw_projection_dimensions_svg", {
        "view": view.Name, "page": page.Name,
        "widthDimension": {"name": horizontal.Name, "value": float(horizontal.getRawValue()), "text": str(horizontal.getText())},
        "heightDimension": {"name": vertical.Name, "value": float(vertical.getRawValue()), "text": str(vertical.getText())},
        "projection": projection_path, "dimensionedPage": page_path,
    })


def check_all(stage, edited):
    doc.recompute()
    for capability, checker in (("booleans", check_booleans), ("fillet_chamfer", check_dressups),
                                ("patterns", check_patterns), ("techdraw", check_techdraw)):
        begin_step(stage + ":" + capability)
        checker(stage, edited)


def edit_parameters():
    for label in ("Fuse", "Cut", "Common"):
        tool = doc.getObject("Boolean" + label + "ToolBox")
        tool.Length = 12.0
        tool.Placement.Base = App.Vector(4, 0, 0)
    for prefix, parameter in (("Fillet", "Radius"), ("Chamfer", "Size")):
        box = doc.getObject(prefix + "Box")
        box.Length, box.Width, box.Height = 12.0, 12.0, 12.0
        setattr(doc.getObject(prefix + "Feature"), parameter, 2.0)
    for prefix in ("Linear", "Polar"):
        profile = doc.getObject(prefix + "Profile")
        profile.setDatum(prefix + "_Width", 12.0)
        doc.getObject(prefix + "Pad").Length = 12.0
    linear = doc.getObject("LinearPattern")
    linear.Occurrences = 5
    linear.Length = 40.0
    box = doc.getObject("DrawingSourceBox")
    box.Length, box.Width, box.Height = 50.0, 25.0, 12.0
    doc.recompute()


try:
    import Sketcher
    import TechDraw
    import TechDrawGui
    from PySide import QtCore, QtWidgets

    application = QtWidgets.QApplication.instance()
    require(application is not None, "含尺寸整页 SVG 需要既有离屏 QApplication；本片不另开 GUI")
    begin_step("create_booleans")
    create_booleans()
    begin_step("create_fillet_chamfer")
    create_dressups()
    begin_step("create_patterns")
    create_patterns()
    begin_step("create_techdraw")
    create_techdraw()
    check_all("initial", False)

    initial_path = require_new_path("advanced-official-initial.FCStd")
    doc.saveAs(initial_path)
    document_name = doc.Name
    App.closeDocument(document_name)
    doc = App.openDocument(initial_path)
    check_all("initial_reopened", False)

    begin_step("edit_parameters")
    edit_parameters()
    check_all("edited", True)
    edited_path = require_new_path("advanced-official-edited.FCStd")
    doc.saveAs(edited_path)
    document_name = doc.Name
    App.closeDocument(document_name)
    doc = App.openDocument(edited_path)
    check_all("edited_reopened", True)

    metadata["status"] = "completed"
    metadata["checkpoints"] = [initial_path, edited_path]
    persist()
    result = {"suite": "advanced_official_operations",
              "metadataPath": metadata_path, "checkpoints": metadata["checkpoints"],
              "checks": metadata["checks"], "artifacts": metadata["artifacts"],
              "guiDependencies": metadata["guiDependencies"]}
except BaseException as error:
    metadata["status"] = "failed"
    metadata["error"] = str(error) or type(error).__name__
    persist()
    raise
