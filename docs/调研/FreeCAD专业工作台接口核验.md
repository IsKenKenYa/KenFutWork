# FreeCAD 专业工作台接口核验

> **角色：调研。** 核验日期：2026-10-18。范围：内置 Assembly、CAM／Path、FEM、BIM／Arch／Draft 的官方接口、依赖、运行形态和后续验收要求。优先读取本机 FreeCAD 1.1.4 随包 Python，再以官方固定提交 `4fd3bf320d9566a27e60069fc8387448aaa3a094` 的源码及官方文档交叉核对。本轮没有导入或执行这些工作台、求解器、后处理器，没有运行测试、操作 GUI 或安装依赖。
>
> 实施方向仍归[CAD 控制插件规划](../插件/CAD控制插件规划.md)。已完成的布尔、圆角／倒角、阵列及 TechDraw 代表工作流见[主调研 §9.14](CAD官方接口与插件接入调研.md)，本文不重复研究，也不把这些证据扩大为专业工作台已验收。AutoCAD／Blender 沿用主调研，不在本批重新研究。

## 1. 结论与证据层级

这些专业能力有官方 Python 入口，适合先通过独立 FreeCAD 进程和现有后台 Python 工具验证；并不需要把工作台 UI 嵌入 KFW。它们不是同一种执行任务：Assembly 在进程内求解装配；CAM 生成并后处理刀路；FEM 通常还需网格器和外部求解器；BIM 同时涉及几何、对象语义和 IFC 数据。GUI 命令、数据 API 和外部程序的成功条件应分别记录。[A1][C1][F1][B1]

| 证据层 | 本轮确认 | 不能据此声称 |
| --- | --- | --- |
| 官方接口／源码 | 下文列出的函数、对象类型、返回值、依赖查找和 GUI 条件分支存在 | 本机导入成功、完整任务可执行或结果正确 |
| 安装文件 | 本机存在对应模块、动态库、可执行文件及包版本记录 | 动态装载、ABI、PATH、外部进程或本机求解已通过 |
| 代表流程 | 下文给出待执行的输入、闭环和成功判据 | 已生成对应工程、刀路、有限元结果或 IFC |
| KFW 产品整链 | 本轮没有新增专业工作台工具或真实 Task 执行证据 | 当前插件已完整支持这些领域，或 GUI 固定标量工具能编辑其全部对象 |

官方 Headless 文档提供 `FreeCADCmd` 的无界面 Python 入口；领域脚本仍须由应用自己的解释器和模块环境执行，不能用系统 Python 的可导入性代替。Assembly／Draft／BIM 的数据 API、CAM 的 Job／Operation 与 FEM 的建模对象可以作为候选调用面，但 Qt、Coin、文档激活和外部进程仍需按下文逐项验证。没有查到可以替代这些流程的统一“专业工作台 CLI RPC”。[G1]

## 2. 本机只读盘点

根路径为 `/Applications/FreeCAD.app/Contents/Resources/`。Info.plist 的 `CFBundleVersion` 及 conda 元数据均记录 FreeCAD 1.1.4；随包 Python 为 3.11.14。以下只读取文件和元数据，未执行二进制：

| 项目 | 已找到的条目 | 版本事实／限制 |
| --- | --- | --- |
| Assembly | `Mod/Assembly/`、`lib/AssemblyApp.so`、`lib/AssemblyGui.so`、`lib/libOndselSolver.1.0.1.dylib` | `share/pkgconfig/OndselSolver.pc` 记录 1.0.1；未验证装载及求解 |
| CAM | `Mod/CAM/Path/`、`lib/area.so`、`lib/python3.11/site-packages/opencamlib/ocl.so` | conda 记录 OpenCamLib 2023.01.11；未验证具体算法或后处理器 |
| FEM | `Mod/Fem/`、`bin/gmsh`、`bin/ccx` | conda 记录 Gmsh 4.15.0、CalculiX 2.23、VTK 9.3.1；未启动网格器或求解器 |
| BIM／Draft | `Mod/BIM/`、`Mod/Draft/`、IfcOpenShell 扩展模块 | conda 记录 IfcOpenShell 0.8.4；未验证 IFC 导入／导出及回读 |

安装包内有依赖不代表 KFW 子进程能找到它们：例如 FEM 会从用户配置或 PATH 查找 ccx／gmsh。后续须在本次 Task 的隔离配置和进程环境中核验实际命中的路径，不改用户全局设置；所有中间输入、网格、求解日志和输出须落入 Task 授权目录，外部子进程须进入已有停止／撤权机制。这些是接线验收要求，不是本轮已完成事实。[F2][F3]

## 3. 内置 Assembly

### 3.1 接口、依赖和运行形态

官方内置 Assembly 使用 Ondsel solver，不能与 Assembly3、A2plus 或其它外部装配工作台混称。`AssemblyApp` 是注册原生对象类型的 Python 扩展；固定源码入口会加载 Part。本机随包的 `AssemblyTests/TestCore.py` 使用以下对象及 Python Proxy 路径，但本文没有运行该测试：[A1][A3][A5][A6]

| 接口 | 精确形态／用途 |
| --- | --- |
| 装配容器 | `doc.addObject("Assembly::AssemblyObject", "Assembly")` |
| 关节组 | `assembly.newObject("Assembly::JointGroup", "Joints")` |
| 普通关节 | 组内创建 `App::FeaturePython`，再 `JointObject.Joint(joint, type_index)`；索引对应模块的 `JointTypes`，0 为 Fixed |
| 固定基准件 | `JointObject.GroundedJoint(joint, component)` |
| 连接器 | `joint.Proxy.setJointConnectors(joint, refs)`；随包示例传两组“组件＋子元素名称列表” |
| 显式求解 | `assembly.solve()` 或 `assembly.solve(False)`，返回整数状态 |
| 基准检查 | `assembly.isPartGrounded(component)` |

求解 **0 为成功**；绑定文档列出 -6 无固定件、-4 过约束、-3 冲突、-5 约束格式错误、-1 求解器错误、-2 冗余约束。不能用 truthy 判断，也不能仅凭零件 Shape 有效判断装配约束已满足。`solve` 可改变零件 Placement；其可选 bool 参数涉及保存求解前位置，不是事务 CAS 或通用恢复承诺。[A2][A5]

GUI 的 SolveAssembly 命令依赖当前活动装配，并用事务包裹重算；后台不应照搬 `Gui.runCommand`、选择集或 `UtilsAssembly.activeAssembly()`。直接 API 可显式持有装配和引用，但 `JointObject.py` 仍导入 PySide、pivy／Coin 等，并可在设置连接器时自动求解。故“App 对象路径存在”并不证明纯无 GUI 启动条件已满足。[A3][A4][A7]

### 3.2 最小代表流程与判据

**待执行建议**：同一个新工程中创建两个有明确基准面的参数化零件，建立 Assembly／JointGroup，固定第一个零件，再建立 Fixed joint 将第二个定位；显式求解，保存 FCStd，关闭重开，改变零件尺寸后重新定位连接器并求解。先使用同文档组件，避免把外部文件链接恢复问题混入第一条装配闭环。

成功至少需要：求解码为0；固定件身份和 Placement 保持；连接器的全局位置／轴向残差在事先规定的容差内；组件数量及引用仍正确；保存重开后关节、固定关系和结果 Placement 可复算。子元素不能把示例里的固定 Face／Vertex 编号当成跨尺寸变化的永久标识。第二条流程再验证 Revolute 的预期自由度和受控角度，不能由 Fixed 样例推定所有关节、运动仿真和 BOM 已通过。[A1][A3]

失败边界包括未固定、冲突／冗余、失效子元素、错误组件层级、外部零件缺失和求解后的部分 Placement 变化。失败应保留明确状态及自有工作副本，不把旧摆放当新结果。当前 GUI 标量写工具拒绝含 Proxy 的对象，不能据其已有验证宣称能直接编辑 Joint Proxy；专业装配首先需要独立后台流程验收。

## 4. CAM／Path

### 4.1 接口、依赖和运行形态

工作台目录已是 CAM，但 Python 核心和包仍名为 `Path`。官方文档区分内部通用运动命令与控制器方言，后处理不能省略；内部 `Path.Path`／`Path.Command` 的存在不代表可直接交付特定机床程序。[C1]

已核对本机与固定版本的入口：[C2][C3][C4][C6]

| 接口 | 精确形态／用途 |
| --- | --- |
| Job | `Path.Main.Job.Create(name, base, templateFile=None)`；base 为模型列表，使用当前 ActiveDocument 创建 Job 和资源 |
| Profile | `Path.Op.Profile.Create(name, obj=None, parentJob=None)`；Base 显式指向模型与子元素 |
| 刀具控制器 | `Path.Tool.Controller.Create(name=..., tool=None, toolNumber=1, assignViewProvider=True, assignTool=True)` |
| 刀路读取 | `operation.Path.Commands`；内部 Path 可 `toGCode()` |
| 后处理 | `PostProcessorFactory.get_post_processor(job, postname).export()`；新版返回分段结果或 None，不等于目标文件已写入 |

Job 会创建模型资源／stock／刀具控制器等关联对象；不能只创建一个空 Job 就判完成。部分路径用 `FreeCAD.GuiUp` 区分 ViewProvider；但 Job 也使用 QtCore，GUI Job 页面与数据 API 不是同一入口。Profile 官方随包测试会比较实际运动命令；这是可参考的断言形式，本轮没有运行。[C2][C3]

依赖按操作区分：Adaptive 使用 `area`；Surface 明确尝试 `ocl`／`opencamlib`，缺失会抛 ImportError，不能把 Profile 可用推为所有3D策略可用。后处理器工厂从配置搜索路径和 `sys.path` 动态加载 Python 模块；它是可执行代码和机床语义的一部分，不是无副作用的格式名称。首次验收应固定已选后处理器及参数、Task 输出路径，并核验实际加载来源。[C4][C5][C7]

### 4.2 最小代表流程与判据

**待执行建议**：一个40×20×5 mm板件建立 Job、显式 stock、6 mm刀具与正进给／主轴设置，生成外轮廓 Profile，明确高度、下刀深度、切削侧及方向；检查命令后，使用指定后处理器生成新 NC 文件。保存重开 Job，改变板长，重新生成刀路并核对路径包络变化。

成功至少需要：Job 模型和刀具关系正确；非空切削命令而不是只有 rapid；所有运动参数有限、进给有效；安全高度与最终深度吻合；考虑刀具半径后的路径包络／切削侧正确；后处理结果包含所选控制器需要的单位、坐标模式、刀具／主轴与结束段，回读运动语义和预期一致。文件非空、内部 `toGCode()` 成功或一个截图都不足以证明这些条件。[C1][C3][C4]

应覆盖空／错 Base、不可加工方向、刀具缺失、无有效切削区域、无效步距／深度、算法依赖缺失、后处理器缺失／返回 None。刀路可视化与仿真、机床专用验证分别验收；本轮不连接或执行真实机床，也不声称 NC 文件已获得制造验收。

## 5. FEM

### 5.1 建模、网格与求解 API

官方 Python 教程给出悬臂体从 Analysis 到结果的流程，但旧教程中的函数拼法不能覆盖安装版：本机正确入口是 **`makeSolverCalculiXCcxTools`**，不是旧文中的 `makeSolverCalculixCcxTools`。以下以1.1.4随包实现为准：[F1][F2][F5]

| 阶段 | 已核对的入口 |
| --- | --- |
| Analysis | `ObjectsFem.makeAnalysis(doc, name="Analysis")` |
| 材料 | `ObjectsFem.makeMaterialSolid(doc, name="MaterialSolid")`，Material 字典包含带单位的模量、密度等；须加入 Analysis |
| 约束／载荷 | `makeConstraintFixed(doc, name=...)`、`makeConstraintForce(doc, name=...)`；References 显式绑定几何 |
| 网格对象 | `ObjectsFem.makeMeshGmsh(doc, name="MeshGmsh")`，设置 Shape、单元阶次及尺寸 |
| 网格执行 | `femmesh.gmshtools.GmshTools(mesh_obj)`；有 prepare／compute／update_properties 路径，旧 `create_mesh()` 是兼容入口 |
| CalculiX 对象 | `ObjectsFem.makeSolverCalculiXCcxTools(doc, name="SolverCcxTools")` |
| 求解工具 | `femtools.ccxtools.FemToolsCcx(analysis=None, solver=None, test_mode=False)`；显式提供同文档、同 Analysis 的 solver |
| 求解步骤 | `check_prerequisites()` 返回诊断字符串；`write_inp_file()`、`setup_ccx()`、`ccx_run()`、`load_results()`／`run()` |

GmshTools 使用配置的 gmshBinaryPath 或 PATH，随后启动外部进程；ccxtools 同样从 ccxBinaryPath／PATH 定位并探测 CalculiX。网格计算、进程结束、读取网格和结果装载是不同阶段。QtCore／过程管理仍参与，GUI 分支还可能显示错误对话框；须验证独立后台宿主的事件循环、工作目录和停止范围，不能从函数定义推定纯 headless 整链已通过。[F2][F3]

有两个会造成假验收的明确源码边界：

- `FemToolsCcx.run()` 在结果装载后仍有“装载失败需要报错”的 TODO；返回 True 后还须检查 `results_present`、真实结果对象和数据，不能只看退出码或 True。[F2]
- 官方 `boxanalysis_base` 示例在网格生成失败或 test_mode 下可以回退预制粗网格。因此示例 setup 完成不证明本机 Gmsh 真正运行；后续必须记录实际 mesher、退出及新网格来源，不能把回退夹具算作网格器验收。[F4]

### 5.2 最小代表流程与判据

**待执行建议**：线弹性三维直杆，明确长度／截面、材料模量与泊松比，一端固定、另一端施加轴向力，使用新生成的四面体网格，完成 INP→CalculiX→FRD／DAT→结果对象，保存重开。可用100×10×10 mm、E=210000 MPa、F=1000 N作为建议输入；这些数值没有在本轮执行。

成功至少需要：Analysis 完整、材料覆盖全部单元、约束方向及单位正确；节点和体单元非零且不存在非正 Jacobian；求解实际结束并有可信结果；位移／应力数组长度与网格对应、数值有限。远离端部的名义轴向应力应与 F/A、位移与 FL/(EA) 的解析基线及网格收敛趋势相符；夹持端局部效应不应被统一误差比例掩盖。求解日志、网格参数、载荷／材料和结果文件一并保留，不能只交付彩色云图。[F1][F2]

失败覆盖至少包含无材料、未充分约束、载荷／References 错误、网格失败／坏单元、二进制不存在、求解非零退出、结果缺失与无法装载。Elmer、Mystran、Z88、非线性、热／流／电磁问题分别是后续独立领域验收，不能从线弹性 CalculiX 结果推出。

## 6. Draft、Arch／BIM 与 IFC

### 6.1 Draft：明确的二维数据对象

当前 `Draft.make_wire(pointslist, closed=False, placement=None, face=None, support=None, bs2wire=False)` 可接 App.Vector 列表；`Draft.makeWire` 在安装版是兼容别名。无活动文档、点类型不符或错误输入可返回 None，而不是总会抛异常。应显式持有独立文档、placement、closed／face，不依赖交互工具的工作平面或吸附状态。官方旧 Draft API 页自己注明内容可能陈旧，所以精确拼法与参数以安装版源为准。[D1][D2]

**待执行建议**：创建1000×500 mm闭合矩形 wire／face，保存重开，修改 points 后再核对；交付 FCStd 与二维交换文件。检查闭合性、四条有效边、平面、位置、面积500000 mm²及周长3000 mm，回读确认尺度和轮廓。空点列、自交、非共面或错误 placement 是独立失败输入。Draft polyline 是参数对象，不等于 Sketcher 的尺寸约束／完全约束草图；两者不可混称。其二维几何／交换可先沿后台 API 验证，交互绘制、文字和视图格式另验。

### 6.2 Arch 数据 API 与集成 BIM 工作台

官方说明自1.0起 BIM、Native-IFC 与 Arch 集成为 BIM 工作台；本机代码在 `Mod/BIM/`，但 `Arch` Python facade 仍保留。它借 Draft 的二维对象构建墙、结构件和楼层，也可使用 Part／PartDesign 几何，不要求先操作 BIM 欢迎页或交互向导。[B1]

已核对的直接 API：[B2][B3]

- `Arch.makeWall(baseobj=None, height=None, length=None, width=None, align=None, offset=None, face=None, name=None)`；有 base 时 length 不代替基线，base 为面时 width 也不是同一种含义。新对象需要重算才得到真实墙体 Shape。
- `ArchStructure.makeStructure(baseobj=None, length=None, width=None, height=None, name=None)`，Arch facade 导出该功能；未给尺寸会读取 Arch 偏好，后台应显式提供。
- `Arch.makeBuildingPart(objectslist=None, baseobj=None, name=None)` 组织建筑／楼层部件。几何、建筑类型、层级及材料应分别读取，不能仅凭 Part::FeaturePython 类型判断 BIM 语义。

**待执行建议**：4 m直基线生成200 mm厚、3 m高直墙，另建300×300×3000 mm结构柱，归入明确楼层；保存重开，改基线长度及墙高，检查依赖和数量。直墙基线场景的理论体积为2.4 m³，但需同时核对对齐侧、端点及实际包围盒。源码的 makeWall 单位说明仍有 TODO，首次样例必须通过真实几何量确认尺度，不能把函数接受 float 当作单位证明。多段墙接角、多层材料、洞口／门窗、楼梯、屋顶及钢筋属于随后单独样例，不由该直墙推出。[B2][B3]

无 base／错误 base、退化轮廓、墙宽或高度无效、复杂接角失败、分组层级与 IFC 类型错误均需明确诊断。大量 BIM 对象使用 Python Proxy，GUI 标量工具现有限制并未因为其属于官方工作台而解除；本轮只确认后台 API 候选路线。

### 6.3 IFC：互操作与 Native-IFC 分开

本机 `BIM/Init.py` 默认把 IFC 导入注册到 `nativeifc.ifc_import`，IFC／IFCJSON 导出仍注册到 `importers.exportIFC`。不能拿旧 `importIFC` 命名或“IFC 已注册”代替实际路线确认。[B4]

传统 Arch 导出入口是 `importers.exportIFC.export(exportList, filename, colors=None, preferences=None)`；缺少 IfcOpenShell 时可打印错误并返回，不一定抛异常。非 GUI 模式可显式提供 colors。Native-IFC 有 `open(filename)` 和 `insert(filename, docname, strategy=None, shapemode=None, switchwb=None, silent=False, singledoc=False)`；open 会新建／激活文档，并通过 Qt timer 安排后续修改标志处理，insert 也会读取策略设置，不能把它当成不需要事件循环、没有状态变化的纯文件解析。[B5][B6]

**待执行建议**：将上面的墙／柱／楼层导出 IFC，再在另一独立文档／进程回读。核对 IFC schema、长度单位、类别、GUID、空间包含关系、数量和实际几何尺度；保存 FCStd 后仍保留原可编辑参数链。Native-IFC 的 IFC 主数据编辑、传统 Arch 几何参数工程和单向导出是不同流程，不能互相代替。缺依赖、无输出、丢对象／类别、单位缩放错误或语义关系丢失均失败；文件扩展名、非空文件或一次 import 成功不足以证明互操作。

## 7. 后续接线与验收顺序

| 建议顺序 | 最小独立交付 | 必须补的本机／Task证据 |
| --- | --- | --- |
| 1 | Draft 二维对象→Arch 直墙／结构件→FCStd | 数据 API 与偏好隔离、参数变化、保存重开、几何／语义；再单独验证 IFC 回读 |
| 2 | 内置 Assembly 的 grounded＋Fixed 闭环 | AssemblyApp 装载、明确求解码、连接器残差、Placement、保存重开及失败状态 |
| 3 | CAM Profile＋一个指定 post | 模型／stock／刀具、有效运动、包络／深度、真实后处理及 NC 回读 |
| 4 | FEM 线弹性三维分析 | 实际新网格、ccx 执行、真实结果装载、解析／收敛基线及停止范围 |

每项先在新的独立工程中验证，再通过真实 Task 的既有 CAD Python／文件交付链验证，最后才决定是否增加专业结构化工具。当前通用几何校验器对专业 Job、Analysis、mesh、结果和 Proxy 文档的兼容性也尚未实证，不能从 Python 接口存在推定这些文档能直接通过产品交付。GUI 当前文档接入另遵守已有打开句柄、观察前提和审批；不能把后台 Python 的权限证明移植为任意 GUI Python 权限。

本轮交付仅为 E 批次官方研究记录。Assembly 全部关节／运动、CAM 全部策略／控制器、FEM 全部求解器／物理场、BIM 全部构件／IFC往返及用户现存 GUI 的操作均未验收；也没有新安装或要求安装任何应用、库或求解器。专业流程的可执行性、性能和领域正确性保留待验，不能用包存在、import 或官方测试文件存在替代。

## 8. 来源

下列源码固定到安装版对应提交；官方文档用于语义和流程概览，遇旧函数拼法或目录变化，以1.1.4源码与随包实现为准。随包测试只作为 API／预期行为示例，本轮未运行。

[G1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Headless_FreeCAD.md
[A1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Assembly_Workbench.md
[A2]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/App/AssemblyObjectPyImp.cpp
[A3]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/AssemblyTests/TestCore.py
[A4]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/JointObject.py
[A5]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/App/AssemblyObject.pyi
[A6]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/App/AppAssembly.cpp
[A7]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/CommandSolveAssembly.py
[C1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/CAM_scripting.md
[C2]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Main/Job.py
[C3]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/CAMTests/TestPathProfile.py
[C4]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Post/Processor.py
[C5]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Op/Surface.py
[C6]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Tool/Controller.py
[C7]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Op/Adaptive.py
[F1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/FEM_Tutorial_Python.md
[F2]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Fem/femtools/ccxtools.py
[F3]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Fem/femmesh/gmshtools.py
[F4]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Fem/femexamples/boxanalysis_base.py
[F5]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Fem/ObjectsFem.py
[D1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Draft_API.md
[D2]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Draft/draftmake/make_wire.py
[B1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/BIM_Workbench.md
[B2]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/BIM/Arch.py
[B3]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/BIM/ArchStructure.py
[B4]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/BIM/Init.py
[B5]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/BIM/importers/exportIFC.py
[B6]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/BIM/nativeifc/ifc_import.py
