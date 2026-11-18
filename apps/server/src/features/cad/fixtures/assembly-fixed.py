"""FreeCAD 1.1.4 内置 Fixed 装配的真实参数与求解验收。

宿主提供 App、Part、doc、output_directory 和真实离屏 GUI；保存交由 KFW。
一手接口：随包 AssemblyTests/TestCore.py、JointObject.py、UtilsAssembly.py。
连接器采用从实际零件几何唯一识别的顶点。官方 findPlacement 明确将顶点
连接器的局部 Rotation 设为 identity；不猜 FaceN，不 mock 求解器或 GUI。
"""

import math

import AssemblyApp
import JointObject
import UtilsAssembly


_FIXED_TOLERANCE = 1e-6
_FIXED_NAMES = {
    "assembly": "KfwFixedAssembly",
    "joints": "KfwFixedJoints",
    "fixed": "KfwFixedPart",
    "moving": "KfwMovingPart",
    "ground": "KfwGrounded",
    "joint": "KfwFixedJoint",
}
_FIXED_OPTION_NAMES = {
    "fixedDimensions", "movingDimensions",
    "resizedFixedDimensions", "resizedMovingDimensions",
}
_FIXED_BASIS = (("x", (1, 0, 0)), ("y", (0, 1, 0)), ("z", (0, 0, 1)))


def _fixed_require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _fixed_dimensions(values):
    _fixed_require(isinstance(values, (list, tuple)) and len(values) == 3,
                   "装配零件尺寸必须是 Length、Width、Height 三元数组")
    _fixed_require(all(isinstance(value, (int, float)) and not isinstance(value, bool)
                       and math.isfinite(value) and value > 0 for value in values),
                   "装配零件尺寸必须是有限正数")
    return [float(value) for value in values]


def _fixed_read_dimensions(obj):
    return [float(getattr(obj, parameter).Value) for parameter in ("Length", "Width", "Height")]


def _fixed_set_dimensions(obj, dimensions):
    for parameter, value in zip(("Length", "Width", "Height"), dimensions):
        setattr(obj, parameter, value)


def _fixed_pose(placement):
    return {"position": [placement.Base.x, placement.Base.y, placement.Base.z],
            "quaternion": [float(value) for value in placement.Rotation.Q]}


def _fixed_residual(first, second):
    axes = {name: (first.Rotation.multVec(App.Vector(*vector))
                   - second.Rotation.multVec(App.Vector(*vector))).Length
            for name, vector in _FIXED_BASIS}
    return {"position": (first.Base - second.Base).Length,
            "axes": axes, "axisMax": max(axes.values())}


def _fixed_require_aligned(residual, label):
    _fixed_require(all(math.isfinite(value) and value < _FIXED_TOLERANCE
                       for value in (residual["position"], residual["axisMax"])),
                   "Fixed 装配的几何残差超出容差: " + label)


def _fixed_create_or_load(options):
    objects = {role: doc.getObject(name) for role, name in _FIXED_NAMES.items()}
    present = [obj is not None for obj in objects.values()]
    if any(present):
        _fixed_require(all(present), "既有 Fixed 装配对象不完整，拒绝补建或覆盖")
        return objects, True
    assembly = doc.addObject("Assembly::AssemblyObject", _FIXED_NAMES["assembly"])
    joints = assembly.newObject("Assembly::JointGroup", _FIXED_NAMES["joints"])
    fixed = assembly.newObject("Part::Box", _FIXED_NAMES["fixed"])
    moving = assembly.newObject("Part::Box", _FIXED_NAMES["moving"])
    _fixed_set_dimensions(fixed, options.get("fixedDimensions", [20, 12, 8]))
    _fixed_set_dimensions(moving, options.get("movingDimensions", [7, 5, 4]))
    fixed.Placement = App.Placement(App.Vector(12, -4, 3), App.Rotation(App.Vector(0, 0, 1), 15))
    # 先形成真实形状，再创建关节，避免原生 solve 删除尚未接线的关节。
    doc.recompute()
    ground = joints.newObject("App::FeaturePython", _FIXED_NAMES["ground"])
    JointObject.GroundedJoint(ground, fixed)
    JointObject.ViewProviderGroundedJoint(ground.ViewObject)
    joint = joints.newObject("App::FeaturePython", _FIXED_NAMES["joint"])
    JointObject.Joint(joint, JointObject.JointTypes.index("Fixed"))
    JointObject.ViewProviderJoint(joint.ViewObject)
    objects = dict(zip(("assembly", "joints", "fixed", "moving", "ground", "joint"),
                       (assembly, joints, fixed, moving, ground, joint)))
    _fixed_require(all(obj.Name == _FIXED_NAMES[role] for role, obj in objects.items()),
                   "FreeCAD 自动修改了装配对象名称")
    return objects, False


def _fixed_validate_structure(objects):
    assembly, joints = objects["assembly"], objects["joints"]
    fixed, moving, ground, joint = (objects[role] for role in ("fixed", "moving", "ground", "joint"))
    _fixed_require(assembly.TypeId == "Assembly::AssemblyObject" and joints.TypeId == "Assembly::JointGroup",
                   "既有对象不是原生 Assembly 与 JointGroup")
    _fixed_require(fixed.TypeId == "Part::Box" and moving.TypeId == "Part::Box",
                   "Fixed 验收零件必须保留真实参数 Box")
    _fixed_require(joints in assembly.Group and fixed in assembly.Group and moving in assembly.Group
                   and ground in joints.Group and joint in joints.Group,
                   "Fixed 装配对象的原生归属不符")
    _fixed_require(ground.ObjectToGround is fixed and joint.JointType == "Fixed" and not joint.Suppressed,
                   "Fixed 关节或 Grounded 引用不符")
    _fixed_require(isinstance(joint.Proxy, JointObject.Joint)
                   and isinstance(ground.Proxy, JointObject.GroundedJoint),
                   "原生装配 Python 代理没有恢复")
    _fixed_require(joint.ViewObject is not None and ground.ViewObject is not None
                   and isinstance(joint.ViewObject.Proxy, JointObject.ViewProviderJoint)
                   and isinstance(ground.ViewObject.Proxy, JointObject.ViewProviderGroundedJoint),
                   "原生装配 ViewProvider 没有恢复")
    _fixed_require(joint.Reference1 is not None and joint.Reference2 is not None
                   and joint.Reference1[0] is fixed and joint.Reference2[0] is moving,
                   "Fixed 装配没有保留两个零件的连接器引用")
    _fixed_require(not joint.Detach1 and not joint.Detach2
                   and joint.Offset1.isSame(App.Placement(), _FIXED_TOLERANCE)
                   and joint.Offset2.isSame(App.Placement(), _FIXED_TOLERANCE),
                   "Fixed 验收连接器不允许脱离或附加偏移")


def _fixed_vertex(obj, target):
    shape = obj.Shape.copy()
    shape.Placement = App.Placement()
    matches = ["Vertex" + str(index) for index, vertex in enumerate(shape.Vertexes, 1)
               if (vertex.Point - target).Length < _FIXED_TOLERANCE]
    _fixed_require(len(matches) == 1, "无法从实际几何唯一识别装配顶点: " + obj.Name)
    return matches[0]


def _fixed_rebuild_connectors(objects):
    fixed, moving, joint = (objects[role] for role in ("fixed", "moving", "joint"))
    targets = (App.Vector(fixed.Length.Value, 0, fixed.Height.Value),
               App.Vector(0, 0, moving.Height.Value))
    refs = []
    for obj, target in zip((fixed, moving), targets):
        name = _fixed_vertex(obj, target)
        refs.append((obj, [name, name]))
    # 直接使用官方 Reference 属性；setJointConnectors 会额外 preSolve，不能作为显式求解证据。
    joint.Reference1, joint.Reference2 = refs
    joint.Proxy.updateJCSPlacements(joint)
    for reference, placement, target, obj in zip(
        (joint.Reference1, joint.Reference2), (joint.Placement1, joint.Placement2), targets, (fixed, moving)
    ):
        _fixed_require(reference[0] is obj and UtilsAssembly.getObject(reference) is obj,
                       "原生连接器没有保留零件引用")
        _fixed_require_aligned(_fixed_residual(placement, App.Placement(target, App.Rotation())),
                               obj.Name + " 局部连接器")


def _fixed_measure(objects):
    joint = objects["joint"]
    connectors = []
    global_placements = []
    for reference, local in ((joint.Reference1, joint.Placement1), (joint.Reference2, joint.Placement2)):
        global_placement = UtilsAssembly.getJcsGlobalPlc(local, reference)
        connectors.append({"objectName": reference[0].Name, "subnames": list(reference[1]),
                           "local": _fixed_pose(local), "global": _fixed_pose(global_placement)})
        global_placements.append(global_placement)
    return {"connectors": connectors,
            "residuals": _fixed_residual(*global_placements),
            "placements": {role: _fixed_pose(objects[role].Placement) for role in ("fixed", "moving")}}


def _fixed_check_solids(objects):
    for role in ("fixed", "moving"):
        obj = objects[role]
        shape = obj.Shape
        _fixed_require(not shape.isNull() and shape.isValid() and len(shape.Solids) == 1,
                       "装配零件没有有效真实实体: " + obj.Name)
        expected_volume = math.prod(_fixed_read_dimensions(obj))
        _fixed_require(math.isfinite(shape.Volume)
                       and math.isclose(shape.Volume, expected_volume, rel_tol=1e-9, abs_tol=0),
                       "装配零件几何没有随参数重建: " + obj.Name)


def _fixed_solve_stage(stage, objects, grounded_placement):
    fixed, moving, joint, assembly = (objects[role] for role in ("fixed", "moving", "joint", "assembly"))
    _fixed_rebuild_connectors(objects)
    doc.recompute()
    _fixed_check_solids(objects)
    wrong = App.Placement(App.Vector(-30, 45, 16), App.Rotation(App.Vector(1, 1, 0), 37))
    moving.Placement = wrong
    _fixed_rebuild_connectors(objects)
    _fixed_require(moving.Placement.isSame(wrong, _FIXED_TOLERANCE),
                   "连接器更新提前移动了零件，不能作为显式求解验收")
    before = _fixed_measure(objects)
    _fixed_require(before["residuals"]["position"] > 1
                   and before["residuals"]["axisMax"] > _FIXED_TOLERANCE,
                   "显式求解前移动件没有真实错位")
    code = assembly.solve()
    _fixed_require(type(code) is int and code == 0, "原生 Fixed 求解失败，返回码: " + str(code))
    # 先测量显式 solve 的真实结果，再允许 doc.recompute 触发原生 SolveOnRecompute。
    after = _fixed_measure(objects)
    _fixed_require_aligned(after["residuals"], stage)
    _fixed_require_aligned(_fixed_residual(fixed.Placement, grounded_placement), "固定件 Placement")
    _fixed_require(not moving.Placement.isSame(wrong, _FIXED_TOLERANCE), "原生求解没有移动错位零件")
    grounding = {"fixedGrounded": bool(assembly.isPartGrounded(fixed)),
                 "fixedConnected": bool(assembly.isPartConnected(fixed)),
                 "movingConnected": bool(assembly.isPartConnected(moving))}
    _fixed_require(all(grounding.values()), "装配零件没有连接到显式固定基准")
    _fixed_validate_structure(objects)
    doc.recompute()
    _fixed_require_aligned(_fixed_measure(objects)["residuals"], stage + " 重算")
    _fixed_require_aligned(_fixed_residual(fixed.Placement, grounded_placement), "重算后的固定件 Placement")
    _fixed_check_solids(objects)
    return {"stage": stage, "solverCode": code,
            "parameters": {role: _fixed_read_dimensions(objects[role]) for role in ("fixed", "moving")},
            "before": before, "after": after, "grounding": grounding,
            "groundedPlacementUnchanged": True}


def run_fixed_case(options=None):
    _fixed_require(App.GuiUp, "Fixed 装配验收需要真实 FreeCAD GUI 文档宿主")
    options = {} if options is None else options
    _fixed_require(isinstance(options, dict) and set(options).issubset(_FIXED_OPTION_NAMES),
                   "Fixed 验收参数包含未知选项")
    options = {key: _fixed_dimensions(value) for key, value in options.items()}
    objects, reused = _fixed_create_or_load(options)
    if not reused:
        _fixed_rebuild_connectors(objects)
    _fixed_validate_structure(objects)
    grounded_placement = App.Placement(objects["fixed"].Placement)
    for role, option in (("fixed", "fixedDimensions"), ("moving", "movingDimensions")):
        if option in options:
            _fixed_set_dimensions(objects[role], options[option])
    # 连接器已接线；尺寸更新先重建实际几何，再由每轮求解重查顶点。
    doc.recompute()
    stages = [_fixed_solve_stage("initial" if not reused else "reopened", objects, grounded_placement)]
    defaults = {"fixed": [6, 0, 3], "moving": [2, 1, 2]}
    for role, option in (("fixed", "resizedFixedDimensions"), ("moving", "resizedMovingDimensions")):
        current = _fixed_read_dimensions(objects[role])
        dimensions = options.get(option, [value + delta for value, delta in zip(current, defaults[role])])
        _fixed_set_dimensions(objects[role], dimensions)
    doc.recompute()
    stages.append(_fixed_solve_stage("resized", objects, grounded_placement))
    final = stages[-1]
    return {"capability": "assembly_fixed", "reused": reused, "jointType": objects["joint"].JointType,
            "objects": {role: obj.Name for role, obj in objects.items()},
            "solverCodes": [stage["solverCode"] for stage in stages], "stages": stages,
            "parameters": final["parameters"], "connectors": final["after"]["connectors"],
            "placements": final["after"]["placements"], "residuals": final["after"]["residuals"],
            "grounding": final["grounding"],
            "groundedPlacementUnchanged": True}
