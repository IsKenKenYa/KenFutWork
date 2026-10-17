# CAD

安装并启用后，Code 与 Design 的 Agent 可在当前 Task 权限内操作已安装的 FreeCAD。插件操作独立工程，不接管当前 GUI 文档，不安装 FreeCAD 或其它软件。

提供运行时状态、工程检查、参数化基本体、FreeCAD Python、真实几何线框预览和 STEP / STL / OBJ / BREP / SVG / DXF 导出。Python 可使用已安装工作台公开的 API；常用参数单位为 mm。具体模块及模型是否可用，以实际执行回执为准。

常用草图使用 `cad_apply_operations`：顺序创建 Body、同一草图内的矩形和圆，或修改命名驱动尺寸。矩形 `origin` 为左下角、圆 `center` 为圆心，默认均为 `[0,0]`，使用固定绝对坐标；改变矩形宽高不会自动移动圆心。轮廓名在草图内唯一，尺寸命名为 `轮廓名_Width`／`_Height`／`_Radius`。操作后的草图须求解成功并完全约束；参考或停用尺寸、类型不符或已有表达式的尺寸拒绝修改。回执 `data.operations` 返回实际尺寸与求解状态。空 Body 应在同批添加有效草图，不能作为有效工程单独交付。复杂建模继续使用 Python。

运行沿用 Task 的目录授权、执行审批、超时与停止机制。输出默认保存在 Task 目录的 `.kfw-cad/`；指定输出时必须使用新文件名。源工程不会被工具保存覆盖。工程会重算并检查几何及对象错误状态，可额外要求实体或预期体积。PartDesign 脚本应明确设置 `Body.Tip` 并检查最终对象。

Python 脚本可选设置 `result = {"radius": 10}` 等普通 JSON 值，由回执 `data` 返回；未设置时不增加该字段。脚本命名空间与宿主回执分离，`result` 不能覆盖执行状态。自定义 JSON 原样返回，不自动去敏，完整回执受当前进程输出设置约束；大结果和媒体写入 Task 文件再返回路径，stdout 保留为私有日志。

`cad_preview` 用官方 TechDraw 真实几何投影生成线框 SVG，再栅格化 PNG，提供等轴、俯视、正视与右视，不依赖 Blender 或 GUI。图片只在当次模型观察中传递，持久工具回执保存文件路径与几何元数据。SVG / DXF 是投影交换文件。线框预览不是着色渲染，可编辑工程使用 FCStd，在 FreeCAD 中显式打开检查；AutoCAD、Blender 和当前 GUI 文档控制尚未接入。
