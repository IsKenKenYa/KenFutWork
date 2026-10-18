# CAD

安装并启用后，Code 与 Design 的 Agent 可在当前 Task 权限内操作已安装的 FreeCAD。后台工具操作独立工程；GUI 工具须显式指定运行实例和文档。插件不安装 FreeCAD 或其它软件。

提供运行时状态、工程检查、参数化基本体、FreeCAD Python、真实几何线框预览和 STEP / STL / OBJ / BREP / SVG / DXF 导出。Python 可使用已安装工作台公开的 API；常用参数单位为 mm。具体模块及模型是否可用，以实际执行回执为准。

`cad_describe_document` 可传 `edges: {objectName, offset, limit}`，分页读取指定对象的真实 `EdgeN`。默认一页50条，可沿 `edgePage.nextOffset` 继续，也可显式增大 `limit`；超尾是空页。结果包含全局毫米坐标、曲线类型、长度、原生顶点、边界与闭合状态，退化边的曲线／边界为空，闭合圆可能只有一个顶点。边号属于当前工程重算后的拓扑，改几何后重新查询；该工具只读源文件，不生成工程版本。

`cad_gui_status` 只读查询运行中的 FreeCAD 应用，目前支持 macOS，返回实际 PID、系统登记的启动时间、内核出生身份与安装路径。不启动应用、不读取或修改其文档。未运行应用返回空列表，不支持的平台明确报错。

`cad_gui_documents` 使用上述完整身份查询打开文档的名称、文件名、原生 UID、修改／事务和活动状态。它向外部 GUI 加载固定宏，按执行权限审批，会改变文件对话框工作目录；不读取几何、不保存、关闭或修改文档。GUI 不继承 Task OS 沙箱，Name／Uid 不是后续编辑的授权句柄。取消不终止 FreeCAD；送达未知时不自动重发。该查询不经过辅助功能树。查询会在 FreeCAD 内保留事件观察器，返回桥代际、每次打开的新文档句柄及全局／文档观察计数；关闭重开会换句柄。计数涵盖已收到事件和查询时元数据差异，不代表完整内容版本，无法发现所有查询间改变后恢复的过程；这些标识不授予编辑权限。

`cad_gui_inspect_document` 使用最新文档快照中的桥代际、打开句柄和两个观察修订，省略 `objectNames` 只列对象，指定对象才读取直接标量属性、单位维度、只读标志与表达式。过期目标先重新查询。属性 getter 在外部 GUI 执行，仍按执行权限审批；工具不会修改、重算或保存工程。复杂属性不读取，枚举暂只读；`editable` 不是编辑授权。属性值原样进入会话，不自动去敏。

`cad_gui_set_properties` 修改当前活动 GUI 文档的直接标量属性。先查询文档与属性，提供最新身份／修订及每项预期值；整批预检后才修改，拒绝只读、不可变、转发属性、表达式绑定目标、枚举和复杂属性。默认修改后重算，正常提交形成一条原生撤销记录；工具尚不保存源文件。复杂建模继续在后台独立工程中使用完整 Python。

`cad_gui_undo_operation` 显式撤销同一 Task 中自身已确认提交的属性操作。先用状态工具取得原 `sourceOperationId` 的 `committed` 回执、`undoProvenance` 和 `snapshot`，本次使用新的 `operationId`；应用身份沿用原操作，桥代际、文档句柄及两个预期修订严格沿用原提交快照，不能用新 inspect 刷新旧撤销前提。新 Run 按当前 Task 的 scope／branch 代际和执行权限审批；原操作可来自历史代际，其记录只证明历史归属，不授予当前权限。原记录与证明由宿主读取并冻结，模型不能提供事务名或证明正文。

撤销前核对准确栈顶、历史摘要及当前属性值，拒绝后来事务、待提交事务、编辑态和外部引用方；不会仅因目标有向外依赖就一概拒绝。通过后只调用一次原生 `doc.undo()`，核对原 before 值、事件和 Undo／Redo 迁移，不重算、redo、保存或关闭文档。正常 apply 期间的临时 pending 是原生 Redo 记录，不代表新用户事务；`partial` 保留现场，不自动补偿。原生接口和观察计数不提供任意回调下的原子回滚保证。

`cad_gui_copy_document` 将显式选择的 GUI 内存文档复制为新的 Task FCStd 文件，目标可以不是活动文档。先取得最新文档快照；GUI 仅向实例私有操作目录调用固定 `saveCopy`，宿主再按当前 Task 权限发布到 `outputPath`，默认使用 `.kfw-cad/gui-snapshots/操作编号.FCStd`，已有文件不覆盖。`copied` 只表示私有副本已生成并校验，`published` 才表示 Task 文件发布完成；不要用私有操作路径交付文件。复制不保存源文件、不切换活动文档、不重算或清除修改状态；允许保留源的 touched 或错误模型，几何有效性可在发布后用 `cad_describe_document` 检查。首期拒绝外部依赖、引用者及无法可靠解释的链接。FreeCAD 序列化可能调用文档 provider，仍按独立执行权限审批，不继承 Task OS 沙箱。

`operationId` 仅作同一请求的持久幂等编号。用 `cad_gui_operation_status` 查询同一 Task 的原结果及副本发布状态；查询不连接 FreeCAD，也不发布新文件。属性写入的正常结果为 `committed` 或 `no_op`，显式撤销成功为 `undone`，预检拒绝为 `rejected`；`partial` 可能保留原生调用的影响，`unknown` 表示尚无可信回执或发布结果未确认。停止、超时或未知结果后不要换编号盲重试，也不自动撤销或关闭工程。撤销同编号的终态沿用自身冻结请求与回执，不再依赖原修改记录或 GUI 存活；没有可信终态的 unknown 不重发。原生操作、磁盘回执与 Task 文件发布不是一个原子事务；认领后无回执会保留未知状态，重启或插件启停均不自动重发。取消标记只能在原生调用之间生效，不中断正在执行的 FreeCAD 原生函数。停用／卸载及宿主关闭会为旧无回执请求追加取消标记，这些停止操作在重建宿主后仍会对账旧记录；Run停止只取消其来源请求。取消落盘未确认时会报错并保留关闭屏障，不能靠重新启用消除。

GUI 副本已在独立实例经真实 Task 验证发布、后台检查／修改与 STEP 导出；正式撤销另验证多属性恢复、后来事务／刷新目标／pending 拒绝、同编号持久重放及重复宏不二次撤销。源 FCStd 字节保持，范围与证据见仓库《日志》，不扩大到用户现存 GUI、全部撤销操作或任意 provider／回调。原生副本会保留在实例操作目录，没有固定工作区字节预算。

常用草图使用 `cad_apply_operations`：顺序创建 Body、同一草图内的矩形和圆，或修改命名驱动尺寸。矩形 `origin` 为左下角、圆 `center` 为圆心，默认均为 `[0,0]`，使用固定绝对坐标；改变矩形宽高不会自动移动圆心。轮廓名在草图内唯一，尺寸命名为 `轮廓名_Width`／`_Height`／`_Radius`。操作后的草图须求解成功并完全约束；参考或停用尺寸、类型不符或已有表达式的尺寸拒绝修改。回执 `data.operations` 返回实际尺寸与求解状态。空 Body 应在同批添加有效草图，不能作为有效工程单独交付。复杂建模继续使用 Python。

`create_boolean` 在 `cad_apply_operations` 中创建参数化 Body 布尔，显式指定目标 `body`、工具列表 `toolBodies` 和 `operation: fuse/cut/common`。目标与工具须有有效单实体 Tip，工具不得包含目标、重复或已被另一 Boolean 使用的 Body。回执记录实际基体、工具、Tip、实体数和体积；保留真实参数引用，可继续修改上游尺寸后重算。工具 Body 会隐藏；无交集切除可保持原体，空结果或多实体结果不发布文件。多工具 `common` 使用 FreeCAD 原生语义，需要依次求交时使用多个单工具 `common` 操作。

`create_fillet`／`create_chamfer` 在 `cad_apply_operations` 中创建定半径圆角／等距倒角。指定 `body`、当前 Tip 的 `base`、真实且不重复的 `edges`，以及正数 `radius`／`size`（mm）。每条边均须由原生选边接纳；混入会被忽略的平滑边会整体拒绝。`set_dimension` 不带 `profile` 的 `radius` 修改 Fillet，`size` 修改显式选边等距 Chamfer；草图半径仍带 `profile`。已有表达式、只读或不可变参数拒绝修改；修改早期特征保留后继 Tip、引用和显示状态，下游重算失效不发布文件。

后台结构化修饰工程采用 FreeCAD 官方完整拓扑名称（`UseHasher=false`），保留 TNP 和自动链接更新。切换会原生重算工作副本，并核验原选边几何；不手工重绑失效的 Base。此适配针对已实测的 1.1.4 哈希映射重开后重算失配，不修改源文件或用户 GUI 文档。其它倒角模式、面选择和全边模式由 Python 承接。

`create_linear_pattern`／`create_polar_pattern` 创建特征阵列：指定 `body`、当前支撑历史中的单个 `original`（Pad／Pocket／Revolution），以及同 Body 上游草图的 H／V／N 主轴。线性用 `direction:{sketch,axis}` 与首末总距离 `length`；环形用 `axis:{sketch,axis}` 与正向总角度 `angle`（0～360°，不含0）。`occurrences` 包含原件，可为1；`reversed` 反向。当前 Tip 作支撑，可只重复较早的增材或减材特征；已有后加特征保留原位。原件抑制、跨 Body 或缺少历史关系会拒绝。

`set_pattern_parameters` 用 `object` 与 `length`／`angle`／`occurrences`／`reversed` 批改后统一重算，保留后继 Tip、原件／轴引用、显示、Refine 及多实体设置。已有表达式目标不能直接改；未指定的表达式字段可随数量联动，绑定保留。此固定入口采用 Features／Extent、单原件与单方向；其它原生模式由 Python 承接。直接赋角度超出360°会被原生夹值，因此结构化输入明确限制；表达式计算走另一条原生路径，仍按实际值与完整几何验证，不强制套直接赋值范围。

阵列保留工程的 `Body.AllowCompound`：允许多实体时交付全部实体和交换文件；要求单实体时拒绝截断。验证独立构建全部副本的增减材布尔结果，核对实体数量和双向差集，避免只凭有效 Shape 报告成功。原生已抑制的 PartDesign 特征可有空 Shape；真实错误、普通空特征及当前活动结果仍分别校验。

后台运行沿用 Task 的目录授权、执行审批、超时与停止机制。输出默认保存在 Task 目录的 `.kfw-cad/`；指定输出时必须使用新文件名。源工程不会被工具保存覆盖。后台建模与检查会重算并检查几何及对象错误状态，可额外要求实体或预期体积；GUI 副本不执行这些重算或几何修复。PartDesign 脚本应明确设置 `Body.Tip` 并检查最终对象。

内置 Assembly 可通过后台 Python 使用 `AssemblyApp`、`JointObject` 与官方关节 ViewProvider。当前实测覆盖同文档两零件的 Grounded＋Fixed、显式求解、改尺寸、保存重开及参数折返。建立连接器可能先预定位，须确认显式求解的实际结果，返回0仅是必要条件，还须检查零件的固定／连接状态、连接器全局位置／方向与固定件保持；仅有有效 Shape 不证明约束满足。当前没有固定的装配结构化工具，其他关节、运动、BOM 和外部零件链接仍分别待验。

FEM 可通过 `cad_run_python` 使用已安装的 ObjectsFem、Gmsh 与 CalculiX。当前实测为线弹性轴向压力代表流程：新网格、真实求解、完整节点场解析核验及保存重开；不是所有物理场或求解器验收。FreeCAD 几何校验不会自动验证有限元分析，Agent 脚本须检查材料、载荷、边界、新网格与新结果，以及完整、有限的位移和应力数据。中间输入、网格、求解日志和结果放在本次 `output_directory`；随包程序从 `App.getHomePath()/bin` 定位，不改用户全局偏好，不用旧结果替代本次求解。

Python 脚本可选设置 `result = {"radius": 10}` 等普通 JSON 值，由回执 `data` 返回；未设置时不增加该字段。脚本命名空间与宿主回执分离，`result` 不能覆盖执行状态。自定义 JSON 原样返回，不自动去敏，完整回执受当前进程输出设置约束；大结果和媒体写入 Task 文件再返回路径，stdout 保留为私有日志。

`cad_preview` 用官方 TechDraw 真实几何投影生成线框 SVG，再栅格化 PNG，提供等轴、俯视、正视与右视，不依赖 Blender 或 GUI。图片只在当次模型观察中传递，持久工具回执保存文件路径与几何元数据。SVG / DXF 是投影交换文件。线框预览不是着色渲染，可编辑工程使用 FCStd，在 FreeCAD 中显式打开检查；AutoCAD、Blender及覆盖保存 GUI 源文件尚未接入。
