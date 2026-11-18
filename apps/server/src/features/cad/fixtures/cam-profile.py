"""FreeCAD 1.1.4 真实 CAM Job/Stock/ToolBit/Profile/linuxcnc 交付验收。

接口依据为随包 Path.Main.Job、Path.Main.Stock、Path.Op.Profile、
Path.Tool.Controller、Path.Tool.toolbit 及 CAMTests。沿用官方 Job 创建的
Controller/ToolBit，设置真实 6mm 刀径；不构造 Path、不手写机加工指令。
宿主提供 App、Part、doc、output_directory；FCStd 保存由 KFW 承担。
"""

import hashlib
import math
import os
import uuid

import Path
import Path.Main.Gui.Job as CamJobGui
import Path.Main.Job as CamJob
import Path.Main.Stock as CamStock
import Path.Op.Gui.Profile as CamProfileGui
import Path.Op.Profile as CamProfile
import Path.Tool.Controller as CamController
from Path.Post.Processor import PostProcessorFactory, WrapperPost
from Path.Tool.Gui.Controller import ViewProvider as CamControllerViewProvider
from Path.Tool.toolbit import ToolBitEndmill


_CAM_NAMES = {"source": "KfwCamPlate", "job": "KfwCamJob", "operation": "KfwCamProfile"}
_CAM_POST_ARGS = '--no-show-editor --precision 6 --preamble "G17 G54 G40 G49 G80 G90 G94 G91.1"'
_CAM_HEIGHTS = {"StartDepth": 5.0, "FinalDepth": 0.0, "StepDown": 1.0,
                "SafeHeight": 8.0, "ClearanceHeight": 10.0}
_CAM_FEEDS = {"HorizFeed": "300 mm/min", "VertFeed": "120 mm/min",
              "HorizRapid": "1500 mm/min", "VertRapid": "600 mm/min"}


def _cam_require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _cam_length(value):
    _cam_require(isinstance(value, (int, float)) and not isinstance(value, bool)
                 and math.isfinite(value) and value > 0, "CAM 板件长度必须是有限正数")
    return float(value)


def _cam_close(actual, expected, reason):
    _cam_require(math.isfinite(actual) and math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-8), reason)


def _cam_box(shape):
    bounds = shape.BoundBox
    return [bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax]


def _cam_commands(path):
    commands = []
    for command in path.Commands:
        parameters = {str(key): float(value) for key, value in command.Parameters.items()}
        _cam_require(all(math.isfinite(value) for value in parameters.values()), "原生刀路含非有限参数")
        commands.append({"name": str(command.Name), "parameters": parameters})
    return commands


def _cam_configure_controller(controller):
    controller.Label = "6mm Endmill Controller"
    controller.Tool.Diameter = 6.0
    controller.Tool.Label = "6mm Endmill"
    controller.Tool.SpindleDirection = "Forward"
    controller.ToolNumber = 1
    controller.SpindleDir = "Forward"
    controller.SpindleSpeed = 12000
    for property_name, value in _CAM_FEEDS.items():
        # 仅设定本次新建 Job 的参数，解除其工厂默认的 SetupSheet 进给表达式。
        controller.setExpression(property_name, None)
        setattr(controller, property_name, value)


def _cam_create_or_load(options):
    objects = {role: doc.getObject(name) for role, name in _CAM_NAMES.items()}
    present = [obj is not None for obj in objects.values()]
    if any(present):
        _cam_require(all(present), "CAM 验收对象不完整，拒绝补建或覆盖")
        return objects, True
    source = doc.addObject("Part::Box", _CAM_NAMES["source"])
    source.Length, source.Width, source.Height = options.get("length", 40.0), 20.0, 5.0
    doc.recompute()
    job = CamJob.Create(_CAM_NAMES["job"], [source], None)
    job.ViewObject.Proxy = CamJobGui.ViewProvider(job.ViewObject)
    _cam_require(len(job.Tools.Group) == 1, "原生 Job 没有创建唯一默认刀具控制器")
    controller = job.Tools.Group[0]
    _cam_require(isinstance(controller.Tool.Proxy, ToolBitEndmill), "原生 Job 默认刀具不是端铣刀")
    _cam_configure_controller(controller)
    # 显式建立跟随实际 Job.Model 的 stock，不依赖全局默认 stock 模板或余量。
    initial_stock = job.Stock
    job.Stock = CamStock.CreateFromBase(job, App.Vector(3, 3, 0), App.Vector(3, 3, 0), App.Placement())
    if initial_stock is not None:
        doc.removeObject(initial_stock.Name)
    job.Stock.Label = "CAM Plate Stock"
    job.Stock.ViewObject.Visibility = False
    doc.recompute()
    operation = CamProfile.Create(_CAM_NAMES["operation"], parentJob=job)
    operation.ViewObject.Proxy = CamProfileGui.PathOpGui.ViewProvider(
        operation.ViewObject, CamProfileGui.Command.res
    )
    operation.ToolController = controller
    # 官方 Profile 的空 Base 是整个 Job.Model 外轮廓，无需猜测 FaceN。
    operation.Base = []
    operation.Side, operation.Direction, operation.JoinType = "Outside", "CW", "Round"
    operation.UseComp = True
    operation.UseStartPoint, operation.SplitArcs = False, False
    operation.OffsetExtra = 0.0
    operation.processPerimeter, operation.processHoles, operation.processCircles = True, False, False
    operation.NumPasses, operation.Stepover = 1, 0.0
    for property_name, value in _CAM_HEIGHTS.items():
        operation.setExpression(property_name, None)
        setattr(operation, property_name, value)
    job.Fixtures, job.OrderOutputBy, job.SplitOutput = ["G54"], "Fixture", False
    job.PostProcessor, job.PostProcessorArgs = "linuxcnc", _CAM_POST_ARGS
    doc.recompute()
    return {"source": source, "job": job, "operation": operation}, False


def _cam_validate_structure(objects):
    source, job, operation = (objects[role] for role in ("source", "job", "operation"))
    _cam_require(source.TypeId == "Part::Box" and isinstance(job.Proxy, CamJob.ObjectJob)
                 and isinstance(operation.Proxy, CamProfile.ObjectProfile), "CAM 原生对象或代理没有恢复")
    _cam_require(isinstance(job.ViewObject.Proxy, CamJobGui.ViewProvider)
                 and isinstance(operation.ViewObject.Proxy, CamProfileGui.PathOpGui.ViewProvider),
                 "CAM Job 或 Profile 的真实 ViewProvider 没有恢复")
    _cam_require(job.Proxy.baseObjects(job) == [source] and len(job.Model.Group) == 1,
                 "CAM Job 没有保留唯一模型及原板件关系")
    _cam_require(list(job.Operations.Group) == [operation] and operation.Active and not operation.Base,
                 "CAM Job 外轮廓操作关系或启用状态不符")
    _cam_require(isinstance(job.Stock.Proxy, CamStock.StockFromBase) and job.Stock.Base is job.Model,
                 "CAM stock 没有跟随 Job.Model")
    _cam_require(len(job.Tools.Group) == 1 and operation.ToolController is job.Tools.Group[0],
                 "CAM Profile 的刀具控制器关系不符")
    controller = operation.ToolController
    _cam_require(isinstance(controller.Proxy, CamController.ToolController)
                 and isinstance(controller.ViewObject.Proxy, CamControllerViewProvider)
                 and isinstance(controller.Tool.Proxy, ToolBitEndmill), "CAM 刀具或控制器代理没有恢复")
    _cam_require(operation.Side == "Outside" and operation.Direction == "CW" and operation.UseComp
                 and operation.processPerimeter and not operation.processHoles and not operation.processCircles,
                 "CAM 操作不是请求的外侧轮廓")
    _cam_require(job.PostProcessor == "linuxcnc" and job.PostProcessorArgs == _CAM_POST_ARGS
                 and not job.SplitOutput and job.OrderOutputBy == "Fixture" and list(job.Fixtures) == ["G54"],
                 "CAM 后处理配置不符")
    _cam_close(source.Width.Value, 20.0, "CAM 板件宽度不符")
    _cam_close(source.Height.Value, 5.0, "CAM 板件厚度不符")
    _cam_close(controller.Tool.Diameter.Value, 6.0, "CAM 刀径不是 6mm")
    _cam_require(controller.ToolNumber == 1 and controller.SpindleSpeed == 12000
                 and controller.SpindleDir == "Forward" and controller.Tool.SpindleDirection == "Forward",
                 "CAM 主轴或刀号设置不符")
    for property_name, expected in _CAM_HEIGHTS.items():
        _cam_close(getattr(operation, property_name).Value, expected, "CAM 高度或深度不符: " + property_name)
    for property_name, requested in _CAM_FEEDS.items():
        expected = App.Units.Quantity(requested).Value
        _cam_close(getattr(controller, property_name).Value, expected, "CAM 进给不符: " + property_name)
    return controller


def _cam_parameters(objects, controller):
    source, operation = objects["source"], objects["operation"]
    return {"length": source.Length.Value, "width": source.Width.Value, "height": source.Height.Value,
            "sectionToleranceMm": App.Base.Precision.confusion() * 10,
            "toolDiameter": controller.Tool.Diameter.Value, "toolNumber": controller.ToolNumber,
            "spindleSpeedRpm": controller.SpindleSpeed,
            "nativeFeedMmPerSecond": {"horizontal": controller.HorizFeed.Value, "vertical": controller.VertFeed.Value},
            "requestedFeedMmPerMinute": {"horizontal": 300.0, "vertical": 120.0},
            "ncFeedMmPerMinute": {"horizontal": controller.HorizFeed.Value * 60, "vertical": controller.VertFeed.Value * 60},
            "depths": {key: getattr(operation, key).Value for key in _CAM_HEIGHTS}}


def _cam_stock_allowances(stock):
    return {"negative": [getattr(stock, key).Value for key in ("ExtXneg", "ExtYneg", "ExtZneg")],
            "positive": [getattr(stock, key).Value for key in ("ExtXpos", "ExtYpos", "ExtZpos")]}


def _cam_postprocess(job, stage):
    source_path = os.path.realpath(os.path.join(
        App.getHomePath(), "Mod", "CAM", "Path", "Post", "scripts", "linuxcnc_post.py"
    ))
    _cam_require(os.path.isfile(source_path), "随包 linuxcnc 后处理不存在")
    nc_path = os.path.join(output_directory, "profile-" + stage + "-" + uuid.uuid4().hex + ".ngc")
    _cam_require(not os.path.lexists(nc_path), "本次 NC 输出路径已存在")
    job.PostProcessorOutputFile = nc_path
    # 每轮创建新的官方实例，避免 legacy 后处理模块的可变全局参数跨轮残留。
    post = PostProcessorFactory.get_post_processor(job, "linuxcnc")
    _cam_require(isinstance(post, WrapperPost), "linuxcnc 没有加载为官方脚本后处理")
    actual_paths = (post.script_path, post.script_module.__file__, post.script_module.export.__code__.co_filename)
    _cam_require(all(os.path.realpath(path) == source_path for path in actual_paths),
                 "linuxcnc 被其它同名脚本遮蔽，拒绝使用非随包后处理")
    with open(source_path, "rb") as stream:
        source_hash = hashlib.sha256(stream.read()).hexdigest()
    sections = post.export()
    _cam_require(isinstance(sections, list) and len(sections) == 1
                 and len(sections[0]) == 2 and sections[0][0] == "allitems"
                 and isinstance(sections[0][1], str) and bool(sections[0][1].strip()),
                 "官方后处理未返回完整非空 NC 文本")
    nc_bytes = sections[0][1].encode("utf-8")
    with open(nc_path, "xb") as stream:
        stream.write(nc_bytes)
    with open(nc_path, "rb") as stream:
        written = stream.read()
    _cam_require(written == nc_bytes, "本次 NC 文件与官方导出文本不一致")
    return {"ncPath": nc_path, "ncBytes": len(written), "ncSha256": hashlib.sha256(written).hexdigest(),
            "postprocessResult": sections,
            "postprocessor": {"name": "linuxcnc", "source_path": source_path,
                              "module_path": os.path.realpath(post.script_module.__file__),
                              "export_source_path": os.path.realpath(post.script_module.export.__code__.co_filename),
                              "sha256": source_hash, "args": job.PostProcessorArgs}}


def _cam_profile_stage(stage, objects, length):
    source, job, operation = (objects[role] for role in ("source", "job", "operation"))
    source.Length = length
    doc.recompute()
    # 仅要求真实 Profile 重新生成；不替换 Path，也不拿旧字符串当本轮产物。
    operation.touch()
    doc.recompute()
    controller = _cam_validate_structure(objects)
    for obj in (source, job.Model.Group[0], job.Stock, operation, controller):
        _cam_require(obj.getStatusString() == "Valid", "CAM 对象重算失败: " + obj.Name + " " + obj.getStatusString())
    _cam_close(source.Shape.Volume, length * 20 * 5, "CAM 源零件没有按长度重建")
    _cam_close(job.Model.Group[0].Shape.Volume, source.Shape.Volume, "CAM Job 模型没有跟随源零件")
    _cam_require(job.Stock.Shape.isValid() and not job.Stock.Shape.isNull(), "CAM stock 没有实际有效几何")
    commands = _cam_commands(operation.Path)
    _cam_require(any(command["name"] in ("G1", "G2", "G3") for command in commands), "原生 Profile 没有生成切削刀路")
    controller_commands = _cam_commands(controller.Path)
    _cam_require(any(command["name"] == "M3" and command["parameters"].get("S", 0) > 0
                     for command in controller_commands), "原生刀具控制器没有生成正向主轴命令")
    return {"stage": stage, "parameters": _cam_parameters(objects, controller), "commands": commands,
            "controllerCommands": controller_commands, "stockBounds": _cam_box(job.Stock.Shape),
            "stockAllowances": _cam_stock_allowances(job.Stock),
            **_cam_postprocess(job, stage)}


def run_profile_case(options=None):
    _cam_require(App.GuiUp and App.ActiveDocument is doc, "CAM 验收需要真实离屏 GUI 与当前 Task 文档")
    options = {} if options is None else options
    _cam_require(isinstance(options, dict) and set(options).issubset({"length", "resizedLength"}), "CAM 验收包含未知选项")
    options = {key: _cam_length(value) for key, value in options.items()}
    objects, reused = _cam_create_or_load(options)
    controller = _cam_validate_structure(objects)
    length = options.get("length", objects["source"].Length.Value)
    resized = options.get("resizedLength", length + 10.0)
    _cam_require(resized != length, "CAM 第二轮必须改变板件长度")
    stages = [_cam_profile_stage("reopened" if reused else "initial", objects, length),
              _cam_profile_stage("resized", objects, resized)]
    _cam_require(stages[0]["commands"] != stages[1]["commands"], "改变尺寸后原生刀路没有变化")
    job = objects["job"]
    final = stages[-1]
    return {"capability": "cam_profile", "reused": reused, "stages": stages,
            "objects": {**{role: obj.Name for role, obj in objects.items()},
                        "modelGroup": job.Model.Name, "models": [obj.Name for obj in job.Model.Group],
                        "stock": job.Stock.Name, "tools": job.Tools.Name,
                        "controller": controller.Name, "tool": controller.Tool.Name},
            "relations": {"modelSources": [obj.Name for obj in job.Proxy.baseObjects(job)],
                          "stockBase": job.Stock.Base.Name, "operations": [obj.Name for obj in job.Operations.Group],
                          "controllers": [obj.Name for obj in job.Tools.Group],
                          "operationController": objects["operation"].ToolController.Name,
                          "controllerTool": controller.Tool.Name},
            "parameters": final["parameters"], "commands": final["commands"],
            "controllerCommands": final["controllerCommands"], "stockBounds": final["stockBounds"],
            "stockAllowances": final["stockAllowances"],
            "postprocessor": final["postprocessor"], "postprocessResult": final["postprocessResult"],
            "ncPath": final["ncPath"], "ncSha256": final["ncSha256"], "ncBytes": final["ncBytes"]}
