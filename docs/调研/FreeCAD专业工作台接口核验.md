# FreeCAD 专业工作台接口核验

> **角色：调研 + Assembly／CAM／FEM／Draft 代表流程实测记录。** 官方研究日期：2026-10-18；Assembly／CAM／FEM／Draft 实测追加：2026-10-19。范围：内置 Assembly、CAM／Path、FEM、BIM／Arch／Draft 的官方接口、依赖、运行形态和后续验收要求。原研究批次优先读取本机 FreeCAD 1.1.4 随包 Python，再以官方固定提交 `4fd3bf320d9566a27e60069fc8387448aaa3a094` 的源码及官方文档交叉核对，当时未执行这些工作台或外部程序。随后已通过既有 CAD Python 工具验收内置 Grounded＋Fixed 装配（§3.3）、CAM Profile＋LinuxCNC后处理（§4.3）及真实 Task 的 FEM 轴向压力（§5.3）代表闭环；Draft实测见§6.1；BIM仍未实测。本页未新增安装应用、库或求解器，后台独立工程证据不覆盖用户现存 GUI 文档。
>
> 实施方向仍归[CAD 控制插件规划](../插件/CAD控制插件规划.md)。已完成的布尔、圆角／倒角、阵列及 TechDraw 代表工作流见[主调研 §9.14](CAD官方接口与插件接入调研.md)，本文不重复研究，也不把这些证据扩大为专业工作台已验收。AutoCAD／Blender 沿用主调研，不在本批重新研究。

## 1. 结论与证据层级

这些专业能力有官方 Python 入口，适合先通过独立 FreeCAD 进程和现有后台 Python 工具验证；并不需要把工作台 UI 嵌入 KFW。它们不是同一种执行任务：Assembly 在进程内求解装配；CAM 生成并后处理刀路；FEM 通常还需网格器和外部求解器；BIM 同时涉及几何、对象语义和 IFC 数据。GUI 命令、数据 API 和外部程序的成功条件应分别记录。[A1][C1][F1][B1]

| 证据层 | 当前确认 | 不能据此声称 |
| --- | --- | --- |
| 官方接口／源码 | 下文列出的函数、对象类型、返回值、依赖查找和 GUI 条件分支存在 | 本机导入成功、完整任务可执行或结果正确 |
| 安装文件 | 本机存在对应模块、动态库、可执行文件及包版本记录 | 动态装载、ABI、PATH、外部进程或本机求解已通过 |
| 代表流程 | §3.3的 Grounded＋Fixed 显式求解与重开折返、§4.3的 Profile／真实LinuxCNC后处理／NC回读、§5.3的 FEM 新网格／新求解及重开已实测 | 全部装配关节／运动、CAM策略／机床制造、FEM所有物理场／求解器或 IFC 已通过 |
| KFW 产品整链 | 既有 `cad_run_python` 已交付 §3.3 的装配及 §4.3 的CAM独立工程与新NC；真实 Task 的 CAD Python／文件链已完成 §5.3 的FEM独立工程及所列失败／取消 | 当前插件完整支持全部专业领域，或 GUI 固定标量工具能编辑其全部对象 |

官方 Headless 文档提供 `FreeCADCmd` 的无界面 Python 入口；领域脚本仍须由应用自己的解释器和模块环境执行，不能用系统 Python 的可导入性代替。Assembly／Draft／BIM 的数据 API、CAM 的 Job／Operation 与 FEM 的建模对象可以作为候选调用面，但 Qt、Coin、文档激活和外部进程仍需按下文逐项验证。没有查到可以替代这些流程的统一“专业工作台 CLI RPC”。[G1]

## 2. 本机只读盘点

根路径为 `/Applications/FreeCAD.app/Contents/Resources/`。Info.plist 的 `CFBundleVersion` 及 conda 元数据均记录 FreeCAD 1.1.4；随包 Python 为 3.11.14。下表来自原研究批次的只读文件及元数据盘点；随后 Assembly、CAM、FEM 的实际执行证据分别单列于 §3.3、§4.3、§5.3，不能倒写成原盘点时已经运行：

| 项目 | 已找到的条目 | 版本事实／限制 |
| --- | --- | --- |
| Assembly | `Mod/Assembly/`、`lib/AssemblyApp.so`、`lib/AssemblyGui.so`、`lib/libOndselSolver.1.0.1.dylib` | `share/pkgconfig/OndselSolver.pc` 记录 1.0.1；随后原生装载、Fixed 求解及重开见 §3.3 |
| CAM | `Mod/CAM/Path/`、`lib/area.so`、`lib/python3.11/site-packages/opencamlib/ocl.so` | conda 记录 OpenCamLib 2023.01.11；随后Profile及随包LinuxCNC后处理已实测，见 §4.3；未据此验证OpenCamLib全部算法 |
| FEM | `Mod/Fem/`、`bin/gmsh`、`bin/ccx` | conda 记录 Gmsh 4.15.0、CalculiX 2.23、VTK 9.3.1；随后 Gmsh／CalculiX 实际执行见 §5.3 |
| BIM／Draft | `Mod/BIM/`、`Mod/Draft/`、IfcOpenShell 扩展模块 | conda 记录 IfcOpenShell 0.8.4；未验证 IFC 导入／导出及回读 |

安装包内有依赖不代表 KFW 子进程能找到它们：例如 FEM 便捷方法会从用户配置或 PATH 查找 ccx／gmsh。§5.3 已显式选择应用随包二进制，将本次中间输入、网格、求解日志和输出置于 Task 授权目录，且不改用户全局设置。真实Gmsh子进程取消与三种失败已单独验证，见§5.3；这不扩大为全部外部求解器或专业流程的停止／撤权证明。[F2][F3]

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

求解返回 **0 是本次装配验收的必要条件，不是充分条件**；绑定文档还列出 -6 无 grounded set、-4 过约束、-3 冲突、-5 约束格式错误、-1 求解器错误、-2 冗余约束。不能用 truthy 判断，也不能仅凭零件 Shape 有效或返回0判断目标零件已进入求解、装配约束已满足；还须核对预期零件的固定／连通关系及求解后连接器残差。`solve` 可改变零件 Placement；其可选 bool 参数涉及保存求解前位置，不是事务 CAS 或通用恢复承诺。[A2][A5]

固定源码进一步表明，`getGroundedParts` 会纳入原生 Origin，`removeUnconnectedJoints` 从 grounded 图遍历，只在本次求解的局部集合中过滤不连通零件／关节，不删除原文档对象。因此删掉用户创建的 Grounded joint 不必使 grounded set 为空；原生 solver 可能只解包含 Origin 的子图并返回0。-6 是内部空 grounded set 的保护，不能将它写成“删除 Grounded 必返回-6”的契约。§3.3 的真实探针已经否定该假设；产品任务是否完成仍由目标关系与残差决定。[A10]

GUI 的 SolveAssembly 命令依赖当前活动装配，并用事务包裹重算；后台不应照搬 `Gui.runCommand`、选择集或 `UtilsAssembly.activeAssembly()`。直接 API 可显式持有装配和引用，但 `JointObject.py` 仍导入 PySide、pivy／Coin 等，并可在设置连接器时自动求解。故“App 对象路径存在”并不证明纯无 GUI 启动条件已满足。[A3][A4][A7]

### 3.2 最小代表流程与判据

**原研究建议**：同一个新工程中创建两个有明确基准面的参数化零件，建立 Assembly／JointGroup，固定第一个零件，再建立 Fixed joint 将第二个定位；显式求解，保存 FCStd，关闭重开，改变零件尺寸后重新定位连接器并求解。§3.3 已用同文档双参数 Box 完成这条代表闭环；外部文件链接恢复仍单独待验。

成功至少需要：求解码为0；预期固定件已 grounded 且连通、移动件属于该连通求解图；固定件身份和 Placement 保持；连接器的全局位置／轴向残差在事先规定的容差内；组件数量及引用仍正确；保存重开后关节、固定关系和结果 Placement 可复算。子元素不能把示例里的固定 Face／Vertex 编号当成跨尺寸变化的永久标识。第二条流程再验证 Revolute 的预期自由度和受控角度，不能由 Fixed 样例推定所有关节、运动仿真和 BOM 已通过。[A1][A3][A10]

失败边界包括未固定、冲突／冗余、失效子元素、错误组件层级、外部零件缺失和求解后的部分 Placement 变化。失败应保留明确状态及自有工作副本，不把旧摆放当新结果。当前 GUI 标量写工具拒绝含 Proxy 的对象；§3.3 是既有 CAD Python 的独立后台工程证据，没有因此放宽用户 GUI 的 Joint Proxy 编辑权限。

### 3.3 原生 Grounded＋Fixed：错位求解、参数变化与重开折返

2026-10-19 主执行线程使用 [assembly-fixed.py](../../apps/server/src/features/cad/fixtures/assembly-fixed.py) 完成首条真实原生集成验收，用时5.04秒，随后又完成双零件 STEP 导出回读。能力经既有 `cad_run_python` 交付，没有新增固定结构的 Assembly 工具。工程包含原生 `Assembly::AssemblyObject`、`Assembly::JointGroup`、同文档两个参数 Box，以及真实 Grounded／Fixed Joint 的 App Proxy 和官方 ViewProvider；不使用 mock 或替代求解器。[A2][A4][A8]

| 检查点 | 实际设置与观测 |
| --- | --- |
| 固定基准 | 固定零件 Placement 为位置(12,-4,3)、绕Z轴15°；每轮求解后保持 |
| 故意错位 | 每阶段将移动零件先置于(-30,45,16)、绕(1,1,0)轴37°，避免沿用上轮已对齐的摆放 |
| 连接器选择 | 从当前真实几何唯一识别 Vertex，直接写原生 `Reference1`／`Reference2` 后 `updateJCSPlacements`；不猜固定 Face／Vertex 编号 |
| 局部坐标系 | 顶点连接器局部 Rotation 为 identity，依据官方 `findPlacement` 语义；局部位置由实际顶点确定，不把整个 Placement 假设为单位变换 |
| 显式求解证据 | 更新 Reference／JCS 后仍确认错位，再调用 `assembly.solve()`；原生返回0后，连接器全局位置及三个轴向残差均小于10⁻⁶，固定件 Placement 保持 |
| 持久化 | 独立重开后仍保留引用、原生 App／ViewProvider Proxy及几何体积，并继续改尺寸、错位及重新求解；每轮输入源文件字节保持 |

官方 `setJointConnectors` 会触发额外预求解；本次没有把其预求解的结果当成显式 solver 成功。直接 Reference＋JCS 更新后的错位前提与求解后的残差分别断言，通用几何校验只说明几何可用，不能替代装配约束已满足的证据。[A4][A9]

| 阶段 | 固定件尺寸／移动件尺寸（mm） | 本轮验证 |
| --- | --- | --- |
| 初次求解 | 20×12×8／7×5×4 | 真实错位→显式求解0→全局位置／轴向残差检查 |
| 同工程改尺寸 | 26×12×11／9×6×6 | 从变化后的几何重识别顶点；重新错位、求解，引用和体积检查 |
| 保存后独立重开再改 | 35×12×14／13×8×7 | 原生代理恢复；再次变化几何、重建JCS并显式求解 |
| 再次重开恢复原尺寸 | 20×12×8／7×5×4 | 恢复参数后重新求解，固定基准、引用、体积及源文件字节检查 |

最初仅创建 App Proxy 而漏建官方 ViewProvider 时，求解本身可成功，但独立重开后 `Joint.ViewObject.Proxy` 为整数，导致 redraw 错误。随后按随包 `CommandCreateJoint.py` 与 `JointObject.py` 的官方创建路径构建 `ViewProviderJoint`、`ViewProviderGroundedJoint`，再跑完整持久化链通过。该修复没有把 Proxy 设为 None、mock ViewProvider、静默修补旧工程或操作用户当前 GUI；也不能由“求解过一次”省略保存重开的代理恢复检查。[A4][A8]

双零件 STEP 已实际导出并独立回读；约束、引用和 App／ViewProvider Proxy 的持久化证据仍来自 FCStd，不能以几何交换文件替代。另一条原生探针发现，移除 Grounded 后 `solve()` 实际返回0，否定了“必须-6”的原验收假设；这与 §3.1 的 Origin 和求解子图语义一致，不能通过伪造返回码或改生产运行时让它迎合测试。[A10]

**当前证据边界**：上述同文档 Grounded＋Fixed 正常闭环、参数重开折返及双零件 STEP 回读已通过。失败用例也已通过：删除 Grounded、故意移错移动件，确认目标零件未固定／未连通，原生仍返回0但连接器残差未消除；脚本明确拒绝、不发布目标，源FCStd字节保持。其他关节、运动、BOM、外部链接、全部装配失败及用户当前 GUI 操作仍分别待验；该样件不构成全部 Assembly 已验收。

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

依赖按操作区分：Adaptive 使用 `area`；Surface 明确尝试 `ocl`／`opencamlib`，缺失会抛 ImportError，不能把 Profile 可用推为所有3D策略可用。后处理器工厂从配置搜索路径和 `sys.path` 动态加载 Python 模块；它是可执行代码和机床语义的一部分，不是无副作用的格式名称。§4.3 已固定LinuxCNC后处理器、参数及Task新输出路径，并核验实际随包模块来源；其他后处理器仍分别验证。[C4][C5][C7]

### 4.2 最小代表流程与判据

**原研究建议**：一个40×20×5 mm板件建立 Job、显式 stock、6 mm刀具与正进给／主轴设置，生成外轮廓 Profile，明确高度、下刀深度、切削侧及方向；检查命令后，使用指定后处理器生成新 NC 文件。保存重开 Job，改变板长，重新生成刀路并核对路径包络变化。该代表闭环已按 §4.3 实际执行；其他策略、后处理器、仿真和机床验证不由此推定。

成功至少需要：Job 模型和刀具关系正确；非空切削命令而不是只有 rapid；所有运动参数有限、进给有效；安全高度与最终深度吻合；考虑刀具半径后的路径包络／切削侧正确；后处理结果包含所选控制器需要的单位、坐标模式、刀具／主轴与结束段，回读运动语义和预期一致。文件非空、内部 `toGCode()` 成功或一个截图都不足以证明这些条件。[C1][C3][C4]

应覆盖空／错 Base、不可加工方向、刀具缺失、无有效切削区域、无效步距／深度、算法依赖缺失、后处理器缺失／返回 None。刀路可视化与仿真、机床专用验证分别验收；本轮不连接或执行真实机床，也不声称 NC 文件已获得制造验收。

### 4.3 真实 Task：Profile、随包LinuxCNC后处理与NC独立回读

2026-10-19 主执行线程以 [cam-profile.py](../../apps/server/src/features/cad/fixtures/cam-profile.py) 完成三轮正向原生验收，用时8.62秒；随后包含拒绝边界的最终2项原生矩阵用时15.49秒通过，临时原生日志为 `/tmp/kfw-cad-cam-final-native.log`。操作经既有后台 Python／Task 能力交付，不新增固定CAM工具，不操作用户当前GUI或连接机床。工程包含真实 Job、stock、6 mm ToolBit、ToolController、Profile及全部对应官方ViewProvider；保存重开后核对真实关系、几何和刀具恢复。[C2][C3][C6]

| 项目 | 实际设置／检查 |
| --- | --- |
| 原生几何及stock | 初始板件40×20×5 mm；stock在XY每侧外扩3 mm，Z范围0至5 mm，随板长变化核对 |
| 外轮廓 | Outside／CW／Round；UseComp按软件刀具半径补偿生成中心线，实际到矩形距离3 mm，圆弧半径3 mm |
| 切深 | StepDown=1 mm；五层实际Z为4、3、2、1、10⁻⁶ mm，最后一层的原生容差行为单列于下文 |
| 全层几何 | 每层闭合，顺时针转向、总转角绝对值2π；核对分段圆弧、实际包络和解析包络面积，不只比较外包围盒或命令数 |
| 高度／进给 | SafeHeight=8 mm、ClearanceHeight=10 mm；水平／竖直进给300／120 mm/min，对应内部5／2 mm/s |
| 刀具／主轴／结束 | 刀号1、实际M6、正转M3及S12000；随后M5／M2结束，按模态和顺序回读 |
| 新输出 | 每个stage新建后处理工厂实例及UUID文件名，共6份新NC；比较返回文本、实际文件字节及Node侧独立哈希 |

三轮中均包含原阶段与改尺寸后的重新生成：

| 轮次 | 板长变化（宽20、高5 mm） | 证据 |
| --- | --- | --- |
| 初次工程 | 40→50 mm | 新刀路、新工厂、新NC，真实几何／补偿／进给及后处理回读 |
| 保存后独立重开 | 50→70 mm | Job／stock／刀具／Profile及ViewProvider恢复，重新生成并回读 |
| 再次独立重开折返 | 70→40 mm | 恢复原板长再生成；每轮输入FCStd源字节保持，新产物单独交付 |

后处理使用 `Path.Post.Processor.PostProcessorFactory.get_post_processor(job, "linuxcnc")`，由完整Job构建工件坐标系、ToolController及operation顺序，再调用 `export()` 得到分段文本；本机官方linuxcnc通过 `WrapperPost` 执行脚本。每轮检查实际 `script_path`、模块 `__file__`、`export.__code__.co_filename` 三重规范路径及源码哈希，确认命中 `App.getHomePath()/Mod/CAM/Path/Post/scripts/linuxcnc_post.py`。不修改全局后处理搜索配置，不以另一个同名模块或内部 `toGCode()` 冒充官方后处理。[C4][C8]

实际参数为 `--no-show-editor --precision 6 --preamble "G17 G54 G40 G49 G80 G90 G94 G91.1"`，G21由后处理另行输出；显式固定XY平面、G54、绝对坐标、mm/min进给及增量I/J圆心模态。`export()` 返回文本后，由夹具在本次Task目录独占写入新的NC，未走编辑器或GUI文件对话框。另由 [TypeScript原生验收](../../apps/server/src/features/cad/cam-operations.integration.test.ts) 独立解析文件模态、实际直线／圆弧和F进给，与内部Path逐段比较，包含内部mm/s到NC mm/min的60倍转换。非空文本或导出函数返回不能单独作为切削成功。[C4][C8]

两处真实原生观察改变了最初的断言：

- 请求 `FinalDepth=0`，实际底层为10⁻⁶ mm。随包 `Path/Op/Area.py::_buildPathArea` 将 `SectionTolerance` 设为 `FreeCAD.Base.Precision.confusion()*10`，固定源码 `Area.cpp` 在边界将切片高度钳至 `zmin+SectionTolerance`。这是内核切片容差，不是后处理舍入或DepthParams算错；本次记录请求值与实际值并按该原生基线检查，不把它写成实际精确切到0，也不强改NC掩盖差异。[C9][C10]
- Profile起点可落在圆角中间，因而一层可能有5段G2而非4段。验收依据闭合整圈、顺时针转角、3 mm实际偏移／圆弧半径及解析几何，不强行要求“矩形四角必须正好4条圆弧命令”。

拒绝边界也已真实通过：缺失后处理器时工厂实际返回None，脚本明确报错；清空 `job.Operations.Group` 后，由真实linuxcnc生成非空的首尾及WCS文本，原生Path回读没有G1／G2／G3实际运动，脚本据此拒绝。这份无切削文本由官方后处理真实生成，没有手写或mock；两种失败均保持源FCStd字节，显式目标文件为ENOENT，未发布失败工程。

**当前证据边界**：已通过的仅是该矩形外轮廓、随包LinuxCNC后处理、参数重开折返及两种拒绝。SafeHeight／ClearanceHeight、单位、刀具半径、主轴和终止检查属于此次文件与路径语义证据；通用几何校验不证明刀路可制造。其他CAM策略、其他机床方言、碰撞／去料仿真、实际机床与制造、用户当前GUI、BIM仍待独立验收；Draft独立证据见§6.1。本节不把原生矩阵通过扩大为本批所有workspace门禁已完成。

NC 模态验收另补顺序回归：不能只检查G17／G21／G90／G94／G91.1在全文件出现，须在相关运动前生效；当前G54及G43H1也检查。把声明移至运动之后的反例先取得RED，再按当前模式检查修正并覆盖G55切换。最终3项（两项原生＋该单元反例）15.81秒通过，三轮后六份旧NC哈希仍保持。原生与先前定向证据有重叠，不相加。

## 5. FEM

### 5.1 建模、网格与求解 API

官方 Python 教程给出悬臂体从 Analysis 到结果的流程，但旧教程中的函数拼法不能覆盖安装版：本机正确入口是 **`makeSolverCalculiXCcxTools`**，不是旧文中的 `makeSolverCalculixCcxTools`。以下以1.1.4随包实现为准：[F1][F2][F5]

| 阶段 | 已核对的入口 |
| --- | --- |
| Analysis | `ObjectsFem.makeAnalysis(doc, name="Analysis")` |
| 材料 | `ObjectsFem.makeMaterialSolid(doc, name="MaterialSolid")`，Material 字典包含带单位的模量、密度等；须加入 Analysis |
| 约束／载荷 | `makeConstraintFixed(doc, name=...)`、`makeConstraintForce(doc, name=...)`、`makeConstraintPressure(doc, name=...)`；References 显式绑定几何 |
| 网格对象 | `ObjectsFem.makeMeshGmsh(doc, name="MeshGmsh")`，设置 Shape、单元阶次及尺寸 |
| 网格执行 | `femmesh.gmshtools.GmshTools(mesh_obj)`；有 prepare／compute／update_properties 路径，旧 `create_mesh()` 是兼容入口 |
| CalculiX 对象 | `ObjectsFem.makeSolverCalculiXCcxTools(doc, name="SolverCcxTools")` |
| 求解工具 | `femtools.ccxtools.FemToolsCcx(analysis=None, solver=None, test_mode=False)`；显式提供同文档、同 Analysis 的 solver |
| 求解步骤 | `check_prerequisites()` 返回诊断字符串；`write_inp_file()`、`setup_ccx()`、`ccx_run()`、`load_results()`／`run()` |

GmshTools 使用配置的 gmshBinaryPath 或 PATH，随后启动外部进程；ccxtools 同样从 ccxBinaryPath／PATH 定位并探测 CalculiX。网格计算、进程结束、读取网格和结果装载是不同阶段。QtCore／过程管理仍参与，GUI 分支还可能显示错误对话框；不能从函数定义推定纯 headless 整链已通过。§5.3 实测的是 KFW 独立后台宿主及显式子进程路线，不覆盖全部 GUI 分支或其他运行环境。[F2][F3]

有两个会造成假验收的明确源码边界：

- `FemToolsCcx.run()` 在结果装载后仍有“装载失败需要报错”的 TODO；返回 True 后还须检查 `results_present`、真实结果对象和数据，不能只看退出码或 True。[F2]
- 官方 `boxanalysis_base` 示例在网格生成失败或 test_mode 下可以回退预制粗网格。因此示例 setup 完成不证明本机 Gmsh 真正运行；后续必须记录实际 mesher、退出及新网格来源，不能把回退夹具算作网格器验收。[F4]

### 5.2 最小代表流程与判据

**原研究建议**：线弹性三维直杆，明确长度／截面、材料模量与泊松比，一端固定、另一端施加轴向力，使用新生成的四面体网格，完成 INP→CalculiX→FRD／DAT→结果对象，保存重开。当时建议的100×10×10 mm、E=210000 MPa、F=1000 N力载荷样件未执行；随后实际采用 §5.3 的1 MPa面压力、泊松比0样件，不能把两组输入混称为同一验收。

成功至少需要：Analysis 完整、材料覆盖全部单元、约束方向及单位正确；节点和体单元非零且不存在非正 Jacobian；求解实际结束并有可信结果；位移／应力数组长度与网格对应、数值有限。远离端部的名义轴向应力应与 F/A、位移与 FL/(EA) 的解析基线及网格收敛趋势相符；夹持端局部效应不应被统一误差比例掩盖。求解日志、网格参数、载荷／材料和结果文件一并保留，不能只交付彩色云图。[F1][F2]

失败覆盖至少包含无材料、未充分约束、载荷／References 错误、网格失败／坏单元、二进制不存在、求解非零退出、结果缺失与无法装载。Elmer、Mystran、Z88、非线性、热／流／电磁问题分别是后续独立领域验收，不能从线弹性 CalculiX 结果推出。

### 5.3 真实 Task：轴向压力、参数折返与原生工程重开

2026-10-19 主执行线程通过真实 Task 的既有 CAD Python 工具运行了独立验收夹具 [fem-axial-pressure.py](../../apps/server/src/features/cad/fixtures/fem-axial-pressure.py)。这是新创建／修改本次模型后实际执行 Gmsh 与 CalculiX 的数值证据，不是官方示例 setup、旧网格导入或旧 FRD 读取。夹具按本机1.1.4随包 `ObjectsFem.py`、`femmesh/gmshtools.py`、`femtools/ccxtools.py`、`feminout/importCcxFrdResults.py` 的接口组织；对应固定版本一手来源仍见 [F2][F3][F5]。

| 基线项 | 实际输入或结果 |
| --- | --- |
| 宿主／外部程序 | FreeCAD 1.1.4；应用随包 Gmsh 4.15.0、CalculiX 2.23 |
| 几何及材料 | Box 为100×10×10 mm；E=210000 MPa，ν=0，线弹性静力 |
| 边界及载荷 | x=0面三平动固定；x=L面1 MPa均匀压力，未反向，压力指向-x |
| 实际新网格 | 198节点、493个三维体单元；本次 Gmsh 新生成 UNV |
| 实际新结果 | 本次 CCX 新生成 FRD；完整节点位移、六个应力分量与 von Mises 数组长度匹配、数值有限，按结果自身 compact 网格映射节点 |
| 解析基线 | ux(x)=-p·x/E，uy=uz=0；σxx=-p，其余应力分量为0；von Mises=p |
| 数值门槛及观测 | 全场按1%相对误差阈值检查，失败不自动放宽；基线 ux 最大归一化误差约1.4×10⁻⁶，自由端平均 ux 约-0.00047619 mm，与-pL/E一致 |
| 原生文件交付 | 保存 FCStd 后由独立进程重开，结果数组保持；不是只保留图片或最终结果摘要 |

参数折返复用几何、Analysis、材料、约束、网格对象与求解器引用，每轮重新建网格、重新写 INP、重新求解并读取新的 FRD：

| 轮次 | L／压力／方向 | 理论自由端 ux | 真实链路结果 |
| --- | --- | --- | --- |
| 初始 | 100 mm／1 MPa／向内 | -100/210000 mm | 新网格、新求解及完整数组解析检查通过 |
| 改参数及反向 | 200 mm／2 MPa／`Reversed=True` | +400/210000 mm | 新网格、新 FRD 通过同一严格阈值；不是缩放旧数组 |
| 恢复原参数 | 100 mm／1 MPa／向内 | -100/210000 mm | 再次生成新网格、新 FRD并通过；输入源文件字节保持 |

实际执行还确认了两处接线边界：

- `App.getResourceDir()` 在本机指向 `Resources/share`，不能拼接成 `share/bin/gmsh`。夹具优先按 `App.getHomePath()/bin` 找到 `Resources/bin/gmsh` 与 `Resources/bin/ccx`，并记录两个 App 路径、候选及实际二进制，不扫描或安装其他程序。
- FEM `mesh.Shape` 是 `App::PropertyLink`，不是几何 `Part::PropertyPartShape`。通用交付校验已经按属性类型区分，不能对所有名为 Shape 的属性直接调用几何方法；该 Shape Link 原生回归已通过，不意味着所有专业 Proxy／属性类型都已兼容。

Gmsh 采用分阶段准备／写入 API，CalculiX 采用官方 INP 写入和 FRD 装载 API，实际外部执行由显式 `subprocess` 负责。本次 `.brep`、`.geo`、UNV、INP、FRD、stdout／stderr及报告位于本轮 Task 的新目录，运行标识和路径单独记录；每个外部进程超时9秒，线程数为1。Gmsh 线程数仅写入本次 `.geo`，不修改用户全局配置。夹具检查 INP 中真实的 `BOUNDARY`、`DLOAD`、`ELASTIC` 记录，并保留逐阶段报告；不使用 `boxanalysis_base` 的预制网格回退，也不以 `run()` 返回 True 或结果对象存在代替数值检查。

失败边界已实际通过：从有结果的源工程重开，每轮重新网格；Analysis 移除材料、清空压力 References 均拒绝；真实 CCX 成功后删除本次 FRD 也拒绝，已有结果不算本次成功，目标文件不存在、输入字节保持。取消另用真实 Gmsh 解析 `.geo` 后自行写就绪标记再进入等待，确认父 FreeCAD 与子 Gmsh 两个 PID 存活后取消 Task，回执为 cancelled，两个 PID 均不存在，目标工程未发布。这条取消证据是进程范围验收，不把等待脚本当作网格成功，也不扩大为所有外部求解器的进程行为。

**当前证据边界**：上述正常流程、参数折返、保存重开、三种失败及真实 Gmsh 子进程取消均已通过；通用 CAD 校验只保证对象状态与几何，有限元数值／载荷验证由本次脚本负责，不是新增固定 FEM 工具。该样件采用ν=0的均匀单轴场，未做独立网格收敛研究；它不覆盖其他材料、几何、接触、非线性、热／流／电磁、其他求解器、全部 FEM 工作台，也不构成制造或工程设计认证。Assembly、CAM的独立代表证据见 §3.3、§4.3；BIM／IFC及用户当前 GUI 文档仍待验。

## 6. Draft、Arch／BIM 与 IFC

### 6.1 Draft：明确的二维数据对象

当前 `Draft.make_wire(pointslist, closed=False, placement=None, face=None, support=None, bs2wire=False)` 可接 App.Vector 列表；`Draft.makeWire` 在安装版是兼容别名。无活动文档、点类型不符或错误输入可返回 None，而不是总会抛异常。应显式持有独立文档、placement、closed／face，不依赖交互工具的工作平面或吸附状态。官方旧 Draft API 页自己注明内容可能陈旧，所以精确拼法与参数以安装版源为准。[D1][D2]

**2026-10-19真实Task验收**：使用正式`Draft.make_wire`创建1000×500mm闭合面，显式平移(125,-75,0)mm并绕Z30°。工厂将传入世界点逆变换到局部Points，不能把局部点当成世界点重复变换。原生Wire与ViewProviderWire均真实创建并随FCStd重开；每次重开先核验旧参数与Shape，再改尺寸，1000×500→1250×600→1500×750→1000×500三轮往返保持对象身份、Closed/MakeFace、位置、完整四边／四点、平面、零实体及解析面积／周长；源文件字节保持。

每轮交付新FCStd及SVG／DXF，六份独立正式回读核对mm、四边轮廓、全局位置、面积与周长，最后复核各文件独立SHA-256不变。SVG使用importSVG.insert；DXF使用核心Import.readDXF的Task专用参数组（dxfScaling=1、IndividualShapes），不调用会询问或下载的旧wrapper。独立测量临时Face只用于计算围面积，不加入导入文档或冒充文件自带面。精度缺陷及修复单列主调研§9.28，本节不沿用旧约六位有效数导出。

要求实体的二维面及真实自交面两种失败均不发布目标，原FCStd字节保持。2项原生矩阵17.23s通过：`KENFUTWORK_CAD_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/cad/draft-operations.integration.test.ts --maxWorkers=1 --no-file-parallelism`。Draft polyline参数不等于Sketcher的尺寸约束／完全约束；空点列、非共面、其它Placement组合、交互绘制、文字及其它Draft对象未由这两个样例推出，BIM／IFC另验。

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

| 原建议顺序 | 最小独立交付 | 当前状态及仍需的本机／Task证据 |
| --- | --- | --- |
| 1 | Draft 二维对象→Arch 直墙／结构件→FCStd | 数据 API 与偏好隔离、参数变化、保存重开、几何／语义；再单独验证 IFC 回读 |
| 2 | 内置 Assembly 的 grounded＋Fixed 闭环 | §3.3的原生装载、显式求解0及残差检查、基准Placement、代理恢复、参数重开折返与STEP回读已通过；原生返回0但目标未连通／残差超限的拒绝与不发布也已通过，其余关节与失败另验 |
| 3 | CAM Profile＋一个指定 post | §4.3的真实Job／stock／刀具、全层运动／包络／实际切深、LinuxCNC后处理、NC独立回读与两种拒绝已通过；其他策略、方言、仿真及机床另验 |
| 4 | FEM 线弹性三维分析 | §5.3的新网格、ccx、真实结果、解析检查及重开已通过；三种失败拒绝与真实Gmsh取消另通过，网格收敛及其他领域另验 |

每项先在新的独立工程中验证，再通过真实 Task 的既有 CAD Python／文件交付链验证，最后才决定是否增加专业结构化工具。Assembly 已完成 §3.3 代表文档的原生代理恢复与显式约束求解，CAM已完成 §4.3 的Job恢复、实际后处理及新NC交付，FEM已完成 §5.3 代表文档及Shape Link的实际交付；其他专业Job、复杂Analysis、Proxy文档的兼容性仍须分别验证，不能从这些样例推定全部文档能通过产品交付。GUI 当前文档接入另遵守已有打开句柄、观察前提和审批；不能把后台 Python 的权限证明移植为任意 GUI Python 权限。

E 批次原交付是只读官方研究；随后新增的Assembly、CAM、FEM、Draft实测分别单列 §3.3、§4.3、§5.3、§6.1。Assembly仅完成上述Grounded＋Fixed代表闭环、双零件STEP及所列拒绝；CAM仅完成Profile／LinuxCNC代表闭环及两种拒绝；FEM仅完成该线弹性样件及所列失败／取消。Draft已完成§6.1参数面与二维交换闭环；BIM／IFC仍未实测，不能扩展为所有专业工作台、全部关节、CAM策略／机床制造、求解器或物理场已验收。用户现存GUI操作另验。没有新安装或要求安装任何应用、库或求解器。尚未覆盖的可执行性、性能和领域正确性保留待验，不能用包存在、import或官方测试文件存在替代。

## 8. 来源

下列源码固定到安装版对应提交；官方文档用于语义和流程概览，遇旧函数拼法或目录变化，以1.1.4源码与随包实现为准。原研究引用的随包测试仅作 API／预期行为依据；§3.3、§4.3、§5.3 是另外执行的 KFW 独立夹具，不能混称为这些官方测试全部通过。

[G1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Headless_FreeCAD.md
[A1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Assembly_Workbench.md
[A2]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/App/AssemblyObjectPyImp.cpp
[A3]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/AssemblyTests/TestCore.py
[A4]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/JointObject.py
[A5]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/App/AssemblyObject.pyi
[A6]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/App/AppAssembly.cpp
[A7]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/CommandSolveAssembly.py
[A8]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/CommandCreateJoint.py
[A9]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/UtilsAssembly.py
[A10]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/App/AssemblyObject.cpp#L707
[C1]: https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/CAM_scripting.md
[C2]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Main/Job.py
[C3]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/CAMTests/TestPathProfile.py
[C4]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Post/Processor.py
[C5]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Op/Surface.py
[C6]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Tool/Controller.py
[C7]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Op/Adaptive.py
[C8]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Post/scripts/linuxcnc_post.py
[C9]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/Path/Op/Area.py#L222
[C10]: https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/App/Area.cpp#L1748
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
