# CAD 官方接口与插件接入调研

> **角色：调研**。资料核验日期：2026-10-18。面向在 KFW 中使用 Agent 进行建模、改尺寸、检查及交付文件的用户，研究本轮 FreeCAD 接入及后续 AutoCAD、Blender 的可行性与工作流风险。本文区分官方接口事实、工程推断、用户确认和本机验收；不代替实施规格或发布验收。插件扩展点及服务契约仍以《[改造计划](../方案设计/改造计划.md)》§4.2、§4.10 为准。

## 1. 研究结论

FreeCAD 的 Python、宏与命令行接口适合由 Agent 驱动现有应用，首期无需把 CAD 编辑器嵌入 KFW。真正需要验证的是“建模、修改、重算、保存、重开、导出”这一完整参数化工作流，模块可以导入或原语可以生成都不足以证明它。用户已确认后台独立工程优先，常用操作提供结构化入口，同时保留 FreeCAD Python 以达到更广的官方接口。当前可见文档涉及未保存修改、选择与撤销，应作为后续独立能力验收。AutoCAD 在 Windows 与 macOS 的接口差异很大，不能把 Windows COM 工具直接称为跨平台 CAD 控制。Blender 已有官方 Lab MCP，可作为后续场景与渲染接入的上游依据，但本轮没有安装或实测 Blender、AutoCAD，也不以它们作为 FreeCAD 基础能力的必需依赖。

以上接口依据见 [FreeCAD Power users hub](https://wiki.freecad.org/Power_users_hub)、[AutoCAD 2027 接口表](https://help.autodesk.com/cloudhelp/2027/ENU/AutoCAD-Customization/files/GUID-E6429154-36DF-4D84-8ABC-9FCA15B66158.htm)、[Blender 官方 Lab MCP](https://www.blender.org/lab/mcp-server/)。

## 2. 本轮确认的产品范围

下表是当前用户确认，不是从附件“已拍板”字样推定的历史决策。

| 项目 | 本轮边界 |
| --- | --- |
| 产品形态 | KFW 官方 Agent 插件，控制用户安装的外部 CAD；不新增 CAD 工作方式，不内嵌完整 CAD 编辑器 |
| 消费方 | Code、Design 共享；未来 Work 可以消费同类能力，本轮不实现 Work 模式 |
| 首要对象 | 后台独立工程，随后支持用户当前打开的 FreeCAD 文档 |
| 操作方式 | 常用操作结构化，同时提供 FreeCAD Python；不能把 Python 暗藏在未声明的工具参数中 |
| 首期深度 | 基础 2D／3D 的完整参数化链路优先；其他官方工作台保留广泛可达性，分别记录依赖与验收状态 |
| 权限与生命周期 | 消费已有真实 Task、目录授权、审批、Run 能力冻结、代际和取消；选择画布不增加目录权限 |
| 其他应用 | AutoCAD、Blender 做文档可行性研究；本轮不安装、不宣称本机验证通过 |

结构化操作与 Python 都是执行入口。后者能到达文件、进程和应用模块，不能因为命名为 CAD 工具就被视为天然受限；应服从实际执行环境和用户所选权限方式。MCP 是 Agent 到工具的协议，FreeCAD Python／AutoLISP／Blender Python 是应用执行接口，两者不是互相替代的层。

## 3. FreeCAD 官方能力与验收矩阵

### 3.1 接口路线

官方 Power users hub 将 Python、宏、工作台开发和应用嵌入列为扩展入口。Embedding 文档还指出，外部解释器直接加载编译模块存在 Python／编译环境兼容条件；使用应用提供的命令行进程可以避免把 FreeCAD ABI 耦合进 KFW 的 Node 运行时。**工程推断**：后台工程首期使用用户所装 FreeCAD 的执行体，KFW 负责请求、结果和进程生命周期，应用负责几何及工程文件。[官方文档源：Power users hub](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Power_users_hub.md)、[Embedding FreeCAD](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Embedding_FreeCAD.md)

Headless 文档明确区分应用文档与 GUI 文档：导入 `FreeCADGui` 不会自动得到 GUI document 或 view provider。它还记录了无 GUI 生成 scenegraph 的路径。这支持后台几何操作，但不能证明每个工作台或每种截图方式都能无界面使用。[Headless FreeCAD](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Headless_FreeCAD.md)

| 工作流 | 官方接口依据 | 应交付的行为证据 | 本文状态 |
| --- | --- | --- | --- |
| 文档创建、保存、重开 | App Document／Python 接口 | 原生工程可重开；对象、约束和参数保留 | 接口可行；插件链路待验 |
| 2D 几何与草图 | Sketcher `addGeometry`、几何／尺寸约束 | 闭合轮廓、约束状态、尺寸回读与矛盾约束错误 | 首期重点，不能止于创建线段 |
| 3D 原语、布尔、位置 | Part 形状及文档对象 | 有效性、实体数、体积、包围盒与预期对应 | 首期重点 |
| 参数化实体 | PartDesign Body、草图和特征 | 拉伸／凹槽／旋转等有真实依赖；改源尺寸后下游随动 | 首期完整链重点 |
| 进阶建模 | 圆角、倒角、阵列及其他官方特征 | 合理参数成功；失效参数能识别；重开后依赖保留 | 按操作验收，不能统称“全部支持” |
| 表达式与单位 | Quantity、属性、表达式接口 | 显式单位输入、正确回读、关联参数更新 | 需要独立覆盖 |
| 工程文件及交换格式 | `Std Export` 与对应格式模块 | 导出正确对象；再导入核对几何和单位 | 格式逐项验，不以文件非空代替 |
| 工程图 | TechDraw 文档对象、官方 TDTest | 投影完成后导出；模板、比例、尺寸与异步计算正确 | 官方路径存在；GUI／Qt 依赖单列 |
| PNG 预览 | GUI view 的图像导出、scenegraph 路线 | 真实图像、视角和对象可见性正确；缺图形环境可解释 | 不预设必须 Blender；按运行环境实测 |
| Draft／BIM／Assembly 等 | 对应工作台 Python／命令接口 | 安装模块、依赖和代表性任务分别通过 | 广泛可达不等于已验收 |
| FEM／CAM 等 | 官方工作台与外部工具链 | 网格／求解器／后处理器可用；输出语义正确 | 外部依赖、领域验收另列 |
| 当前 GUI 文档 | 应用内 Python／GUI API | 明确文档身份、保留未保存工作、正确撤销和选择 | 后续能力，本轮后台链不冒充覆盖 |

矩阵来源：[Sketcher scripting](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Sketcher_scripting.md)、[PartDesign Workbench](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/PartDesign_Workbench.md)、[Quantity](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Quantity.md)、[Std Export](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Std_Export.md)、[TechDraw 官方测试](https://github.com/FreeCAD/FreeCAD/tree/main/src/Mod/TechDraw/TDTest)、[TechDrawGui API](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/TechDrawGui_API.md)、[Std ViewScreenShot](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Std_ViewScreenShot.md)。

### 3.2 开发者工作流中的关键语义

- **标识与索引**：草图脚本几何索引从 0 起，界面显示从 1 起；不能把界面编号直接用作 Python 参数。对象名、显示标签和边／面的拓扑引用也应分清。[Sketcher scripting](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Sketcher_scripting.md)
- **先重算再判定**：`Document.recompute()` 的 Python 包装返回重算数量，不是“所有特征正确”的布尔值。需要检查对象状态、重算后的形状以及请求要求。源码还存在空形状检查直接返回的路径，因此 `Shape.check()` 没抛异常不能证明形状非空有效。[DocumentPyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/main/src/App/DocumentPyImp.cpp)、[DocumentObjectPyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/main/src/App/DocumentObjectPyImp.cpp)、[TopoShapePyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/Part/App/TopoShapePyImp.cpp)
- **保持可编辑链路**：若需求是改尺寸和派生零件，仅保存最终 `Part::Feature` 形状不足以证明保存了 Body、草图、约束与特征依赖。应保存原生工程、重开修改源尺寸、重新检查下游，而不是只看一次截图。[Feature editing](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Feature_editing.md)
- **单位与容差分别处理**：内部长度／角度与用户显示单位不同；几何判断容差、界面小数位、STL 网格误差也不是一个数。应明确单位并按测量量级定义断言，不能用统一比例掩盖细小特征或网格问题。[Quantity](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Quantity.md)、[Std Export](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Std_Export.md)
- **拓扑引用需要再次确认**：官方说明 1.0 起缓解了拓扑命名问题，仍不能保证所有模型及后续操作不会重映射。改尺寸后继续把旧 `Edge7` 当作同一条边可能操作错误对象；应重新读取对象与几何特征再选择。[Topological naming problem](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Topological_naming_problem.md)
- **导出终态对象**：PartDesign 应导出目标 Body／Tip 等预期对象，避免把全部中间特征一起交付形成重复实体。文件存在且非空只是写入证据，交换格式还需再导入检查。[Std Export](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Std_Export.md)

上述 `main` 源码用于解释语义，不替代安装版核验；实际 FreeCAD 1.1.4 的结果见本轮实测记录。

## 4. AutoCAD：平台差异与可行性

### 4.1 跨平台接口矩阵

以下针对 AutoCAD 完整版；LT、Web 需按各自产品列另验，不能从完整版推定。

| 能力 | Windows | macOS | KFW 影响 |
| --- | --- | --- | --- |
| AutoLISP | 支持 | 支持 | 跨平台基础自动化候选 |
| SCR 命令脚本 | 支持 | 支持 | 适合命令序列；仍须处理提示、区域设置和文件对话框 |
| ObjectARX | 支持 | 支持 | 进阶原生插件路线；分平台构建和测试 |
| Managed .NET | 支持 | 不支持 | 不能照搬 Windows C# 适配器 |
| COM／ActiveX、VBA | 支持 | 不支持 | `pywin32` 一类方案不能代表 Mac 可控性 |
| Core Console | 官方资料提供 Windows `accoreconsole.exe` 路线 | 本次未确认同等官方后台可执行器 | Mac 不能直接承诺复用该执行路径 |
| APS Automation | 云端服务 | 可从 Mac 调用同一云服务 | 是远程执行提供方，不是本机应用控制 |

依据：[AutoCAD 2027 接口表](https://help.autodesk.com/cloudhelp/2027/ENU/AutoCAD-Customization/files/GUID-E6429154-36DF-4D84-8ABC-9FCA15B66158.htm)、[Mac 官方接口表](https://help.autodesk.com/cloudhelp/2027/ENU/AutoCAD-MAC-Customization/files/GUID-E6429154-36DF-4D84-8ABC-9FCA15B66158.htm)、[脚本启动工作流](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-DidYouKnow/files/GUID-BE44AE86-7638-48C9-BE5B-C1DF8E4C8808.htm)、[APS 官方 Core／GUI API 区分](https://github.com/autodesk-platform-services/skills/blob/main/skills/acad-dotnet/references/autocad-api.md)。

Core Console 与桌面插件也不等价：官方 APS 资料明确区分 Core／Database DLL 和仅桌面 GUI 使用的 `AcMgd.dll`。APS Automation 则在云端运行 AutoCAD 脚本、AutoLISP 和插件，适合 DWG 批处理，但涉及独立授权、上传和作业生命周期。[官方 Core Console 资料](https://github.com/autodesk-platform-services/skills/blob/main/skills/acad-dotnet/references/autocad-api.md)、[Automation API](https://aps.autodesk.com/automation-apis)

### 4.2 MCP 与许可事实

AutoCAD 2027 官方产品页说明 Autodesk Assistant 已使用 MCP，本机 MCP 组件也有独立更新机制；这些材料没有证明 KFW 可以直接连接公开的图纸控制端点。另一个 **Autodesk Product Help MCP** 明确是公开、免认证、只读文档服务，不能修改图纸。[AutoCAD 2027](https://www.autodesk.com/products/autocad/product-details)、[本机 MCP 更新机制](https://www.autodesk.com/support/technical/article/caas/tsarticles/ts/4f8xUJxv9zsm3Nhq5Chao3.html)、[Product Help MCP](https://help.autodesk.com/cloudhelp/ENU/ADSKMCP-ProductHelpMcp/files/ADSKMCP_ProductHelpMcp_ide_integration_html.html)

许可不能概括为“无人值守一律不允许”。当前 Offerings 页更新于 **2026-10-14**：Single User 将 batch processing、renders 等后台活动排除于交互并发设备数计算，同时保留合理速率及技术限制。General Terms §8.3 区分默认内部业务 API 使用与其他用途的开发许可，§8.1 限制向第三方提供产品功能的服务方式。**待核验**：未来公开分发／商业提供 AutoCAD 适配器及远程服务的具体许可，需要结合实际方式与对应 developer terms，桌面订阅本身不能证明覆盖全部场景。[Offerings](https://www.autodesk.com/company/terms-of-use/en/offering-types-and-benefits)、[General Terms](https://www.autodesk.com/company/terms-of-use/en/general-terms)

实现上还应保留 AutoCAD 的受信路径机制，不以全局关闭 `SECURELOAD` 作为正常安装步骤；脚本命令需考虑国际化前缀。[SECURELOAD](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-541566C6-2738-49DD-87C3-C1490E924A02.htm)、[AutoLISP 国际化](https://help.autodesk.com/cloudhelp/2026/PTB/AutoCAD-LT-AutoLISP/files/GUID-D156B6ED-B1B4-42CB-BE1D-CA251BFC08C3.htm)

## 5. Blender：后台操作与官方 MCP

### 5.1 官方可行性

Blender CLI 支持后台执行 Python，并提供脚本异常退出码；可制作、修改、保存场景以及渲染导出。参数按顺序执行，文件加载和输出设置相对于渲染命令的位置会影响结果。macOS 官方文档说明应执行应用包内二进制，不能假设 `blender` 已进入 PATH。[CLI 参数](https://docs.blender.org/manual/nl/5.0/advanced/command_line/arguments.html)、[渲染参数顺序](https://docs.blender.org/manual/en/5.1/advanced/command_line/render.html)、[macOS 启动](https://docs.blender.org/manual/en/latest/advanced/command_line/launch/macos.html)

Python 数据 API 与 `bpy.ops` 操作器的依赖不同；后者常要求特定窗口、选择、模式或编辑器上下文。**工程推断**：后台适配器优先数据 API，需要操作器的工作流逐项验证，不能把 GUI 中可执行推为后台可执行。[Operators Gotchas](https://docs.blender.org/api/5.0/info_gotchas_operators.html)

GLB 可打包展示用网格、贴图等数据，但不能当作 FreeCAD 原生参数化工程的替代品；曲线等非网格数据、复杂材质也可能不能原样保留。[官方 glTF 导出说明](https://github.com/KhronosGroup/glTF-Blender-IO/blob/main/docs/blender_docs/scene_gltf2.rst)

### 5.2 官方 Lab MCP 与执行边界

Blender 官方 Lab 已发布 MCP 项目，要求 Blender 5.1+、Add-on、LLM Client 和 MCP Server。因此“Blender 只有社区 MCP”已经不准确。官方同时明确，生成 Python 可以删除或外发数据，项目没有这类保护；它可作为真实上游研究，不能直接当成 KFW Task 权限已经落实的证明。[官方 Lab MCP](https://www.blender.org/lab/mcp-server/)、[官方源仓库](https://projects.blender.org/lab/blender_mcp)

Blender 当前官方源码明确说明 Python 线程整合不具备线程安全，长期线程可能导致难以定位的崩溃；2025 年官方还删除了旧版“timer 配合另一线程事件队列”的示例。后续 GUI 桥接应审查其事件循环、状态与取消机制，不能从旧教程复制长期 socket 线程直接操作 `bpy`。[线程限制源码](https://github.com/blender/blender/blob/main/doc/python_api/rst/info_gotchas_threading.rst)、[删除旧示例的官方提交](https://projects.blender.org/blender/blender/commit/a010c1c8b801c07fbfb976eaf1bf391b3f3a42eb)

Extension manifest 提供平台、版本、许可和 files／network 等权限声明；这些是 Blender 扩展元数据，不是 MCP 传输协议，也不等于进程沙箱强制执行。未来分发使用 Blender Python API 的脚本／扩展时，按官方许可要求核对归属；本轮不引入第三方 Blender 代码。[官方 manifest 模板](https://github.com/blender/blender/blob/main/scripts/templates_toml/blender_manifest.toml)、[Blender 许可](https://www.blender.org/about/license/)

## 6. 按工作流风险排序的问题

这是面向 Agent 开发者体验的证据聚类，不是投诉数量排行榜。严重度表示对本产品工作流的影响；“频率信号”只说明来源是否把它列为持续问题、是否有同类报告，**不是用户发生率**。文档明确的机制可以高置信，是否仍影响本机版本仍须实测。

| 优先级／类型 | 用户目标与断点 | 一手证据／频率信号 | 置信度 | 产品动作 |
| --- | --- | --- | --- | --- |
| 高／可靠性 | 改尺寸后继续加工正确边面；旧拓扑编号可能指向别处 | 官方长期专题，且存在多个同类上游 issue；不是当前版本发生率统计 | 问题机制高，本机触发未验 | 重新描述几何再引用；源尺寸变化后覆盖下游链及失效例 |
| 高／开发接口 | 一轮操作后确认成功；仅凭重算数量或没有异常误判空形状／坏特征 | 官方 Python 包装源码明确语义；频率无统计 | 高 | 检查对象状态、非空形状及业务读数；结果区分写入、重算、几何和交付 |
| 高／工作流 | 获取可继续编辑的零件；只存最终形状丢失特征语义 | 官方 Body／Feature 编辑模型；接口必然性而非投诉频率 | 高 | 保存原生工程并重开改尺寸；交换格式与源工程分别交付 |
| 高／执行权限 | 扩展进阶能力；脚本能到达 CAD 之外 | 用户确认 Python 入口；Blender Lab 明示任意代码的数据风险 | 高 | 复用真实 Task 和执行权限；不把命名、模型审批或 manifest 当成操作系统隔离 |
| 高／可靠性 | 不中断用户已有建模；应用内异步线程与 GUI 状态可能互相干扰 | Blender 官方线程专题、删除旧例；无发生率 | Blender 机制高，FreeCAD GUI 具体实现待验 | 后台工程先独立交付；当前文档单独授权、标识并验撤销／取消 |
| 中／配置与文档 | 安装后直接调用；外部 Python ABI 或 headless GUI 假设不成立 | FreeCAD 官方 Embedding／Headless 专门列出条件 | 高 | 以应用提供的执行体探测版本；按工作流报告缺少的模块／图形依赖 |
| 中／精度 | 交付真实尺寸与可用网格；显示精度、内部单位、网格容差混淆 | 官方 Quantity／导出文档；无发生率 | 高 | 单位显式；对长短尺寸、细小孔、导入导出分别检查 |
| 中／数据交换 | 导出后继续工作；中间特征重复导出或 GLB 语义丢失 | FreeCAD 官方导出说明与 glTF 导出限制 | 高 | 明确终态对象；再导入检查；保留原生源文件 |
| 中／平台与接入 | 在 Mac 操作 AutoCAD；选用了仅 Windows 可用的 COM／.NET 方案 | 2027 官方平台表直接列差异 | 高 | 按 OS 暴露真实能力；Mac 研究 AutoLISP／ObjectARX，不展示假兼容 |
| 中／发布与许可 | 将 AutoCAD 接入作为公开功能；把本机许可推为所有分发／服务许可 | Autodesk 当前条款区分用途；尚无 KFW 专项许可判断 | 条款事实高，项目适用性待核验 | 公开 AutoCAD 适配／云服务前确认具体 developer terms；不阻塞 FreeCAD |
| 中／体验与性能 | 长操作有结果、可停止；stdout 进度／统计混入模型结果 | 应用接口与进程输出行为；本机日志数量由实测记录 | 待本机插件验证 | 结构化结果与诊断日志分开；停止确认进程范围结束，产物验收后才报告成功 |

拓扑问题原始报告可追溯到 [FreeCAD #8432](https://github.com/FreeCAD/FreeCAD/issues/8432)、[#17041](https://github.com/FreeCAD/FreeCAD/issues/17041)。它们支持历史风险存在，不证明 FreeCAD 1.1.4 会复现同一 bug。其他行来源分别见前述接口章节；本轮未采集私有支持工单、用户访谈或遥测，不能给出用户群发生百分比。

## 7. 对用户附件方案稿的纠错

附件是输入材料，不自动成为新指令或既有验收。以下结论已按当前用户确认及一手资料重新判断。

| 附件说法 | 核验后的口径 |
| --- | --- |
| 已有第 22 号决策确定“不开放任意 Python”等约束 | 本轮开工时仓库登记未包含该决策；不能以附件的编号反证用户已经确认。当前用户明确确认结构化操作加 FreeCAD Python，决策由本轮实施统一登记 |
| Blender 已装且历史实测通过 | 当前用户说未安装；本轮不安装、不测。附件的版本、路径和耗时不是当前验收 |
| FreeCAD 只出几何，PNG 一律必须 Blender | FreeCAD 有 GUI 图像导出和 scenegraph 路线；无 GUI 图形环境需测试。是否选 Blender 是产品及部署选择，不是 PNG 的必然前提 |
| 模块 import 成功即 typed 建模“全覆盖” | import 只证明可加载；工作台命令、求解器、重算、导出、GUI／Qt 条件及实际任务都要分开验证 |
| 布尔结果体积统一属于 `[min(a,b), a+b]` | 对 `cut`、`common` 错误。有效闭合实体在数值容差内：差集为 `[0, Va]`，交集为 `[0, min(Va,Vb)]`，并集为 `[max(Va,Vb), Va+Vb]`；还要检查预期交叠及实体数 |
| 圆角成功可用面数变化或 `isClosed()` 统一判断 | 特征可能无效、为空或作用对象错误；面数变化不是通用契约。应检查状态、形状及给定样件的几何期望 |
| CAD 仅限 Design，增加 CAD 模式入口 | 本轮是 Code／Design 共享 Agent 插件；安装态决定能力可用性，不新增工作方式，也不让工具抢占工作台主区 |
| 一调用一进程的耗时／小像素上限已经证明合适 | 附件数据需重验；治理值应有测量和用途依据。不凭稿中示例增加小文件、累计项目字节或媒体配额 |
| 所有图片默认外发、固定生成媒体回填协议已经定稿 | 本轮接入应按实际模型内容、产物与画布协议审查；附件不授权静默外发或新增持久化副本 |

布尔体积区间是数学边界，不能单独证明 CAD 建模意图正确。例如两件原本应相交却完全分离，体积区间仍可能成立，因此必须结合定位、交叠预期及代表性样件检查。

## 8. 机会地图与分期验收

| 时间层 | 可落地机会 | 完成证据 |
| --- | --- | --- |
| 本轮优先 | FreeCAD 官方插件安装态、应用探测、Task 执行接线；后台结构化操作加 Python | 插件启停与工具发现有效；Task 目录和执行权限生效；缺应用、失败、撤权、取消均有真实结果 |
| 本轮优先 | 基础 2D／3D 参数化闭环 | 草图约束→实体特征→源尺寸变化→重算→保存重开→再修改→导出再导入；不能只做单次法兰截图 |
| 本轮优先 | 操作结果可判断与可恢复 | 正常及错误样件均覆盖；无效几何不标成功；失败／停止不覆盖有效源工程，不误报交付 |
| 后续一阶段 | 更多官方工作台与更好诊断 | 每个域有版本／依赖、代表性任务、失败与交付证据；不以大量工具名代替能力 |
| 后续一阶段 | 当前可见 FreeCAD 文档控制 | 明确连接的应用／文档，保护未保存修改；选择、撤销、保存、取消和应用退出分别验证 |
| 后续一阶段 | Blender 可选场景／渲染适配 | 用户安装后验证后台保存、渲染、导出；若复用官方 MCP，再核对运行协议、取消和脚本权限 |
| 深入研究 | AutoCAD 本机适配与许可 | 取得对应平台安装及授权后，Windows／Mac 分别验证；公开控制 MCP 与只读 Help MCP 分清 |
| 深入研究 | CAM／FEM 等专业交付与跨应用交换 | 外部求解器／后处理器、几何精度、单位和交付要求按领域验证；生成文件不等于物理制造验收 |

## 9. 本机证据与未验收项

2026-10-18 本机为 FreeCAD **1.1.4**，Git `4fd3bf320d9566a27e60069fc8387448aaa3a094`，捆绑 CPython **3.11.14**。CLI 为 `/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd`；每次传独立 `--user-cfg`／`--system-cfg`，只使用合成工程与临时目录。

| 验证层 | 实际结果 | 边界 |
| --- | --- | --- |
| 安装与 CLI | GUI 可打开；`GuiUp=0` 的后台脚本创建 10×20×30 Box，体积 6000、有效 Shape、保存 FCStd 成功；`recompute()` 实测返回 int 1 | 不代表 GUI API 可在 CLI 直接调用 |
| 应用自带测试 | PartDesignTests 的 Primitive／Sketch／Pad／Pocket／Revolve／Hole／Fillet／Chamfer／LinearPattern／PolarPattern／Mirrored／MultiTransform／Loft／Pipe／Helix／Thickness／Boolean／Datum／ShapeBinder，**19 模块、81 项全过** | 没有运行全 FreeCAD 测试集；不代表 KFW 已接入或覆盖全部工作台 |
| 自定义几何探针 | **8 项全过**：布尔各自的体积不变量、全约束圆环及 Pad、原生 Pocket＋六孔环形阵列、尺寸修改与保存重开、STEP 回读、STL 回读、约束冲突、后台 TechDraw 投影 | 法兰外径 80→90、厚 10、中心孔 30、孔圆直径 60 上六个直径 8 孔；最终体积约 53532.7388 mm³；STL 另允许网格近似误差 |
| 后台 TechDraw | 创建 QCoreApplication 实例后，用 Qt 事件循环等待投影，四条可见边与 Up-to-date 状态通过 | 直接照部分官方 console 测试片段会因没有 QApplication 永久等待，不能无限等，也不能只调用 recompute |
| 精确 Task 沙箱 | 实际 srt-seatbelt／filesystem enforced，指定应用只读，Box 建模／FCStd／JSON、exit0、rangeEmpty 均通过 | `hw.optional.neon` 具体读取补丁另有正反测试；未扩大 Task 写域 |
| 停止权限探针 | 独立合成 CLI 进程启动后 SIGTERM，进程组确认清空 | 该项是外层进程探针；KFW 工具取消另有专门回归 |
| 原生投影接口 | `TechDraw.project()` 返回平面 Shape 分组与真实 BoundBox；`projectToSVG()` 片段自带 Y 翻转；`projectToDXF()` 返回实体片段 | DXF 片段不等于完整可交换文件，包完整文件后仍须重导入验证 |
| GUI 图片／图纸 | API 能写 PNG、SVG、PDF；第一轮 PNG 为白图，SVG／PDF 仅确认文件存在 | **不判通过**；文件字节数不是视觉验收。后台线框预览采用真实几何投影单列验收 |

自定义探针已保存为 [`FreeCAD能力探针.py`](../../scripts/诊断/FreeCAD能力探针.py)，每次另建临时产物目录。可复制执行：

```sh
cad_probe_config_dir="$(mktemp -d)"
/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd --user-cfg "$cad_probe_config_dir/user.cfg" --system-cfg "$cad_probe_config_dir/system.cfg" scripts/诊断/FreeCAD能力探针.py
```

探针初轮也抓到了自身两项错误并修正：原生新建特征不会自动保证 Body.Tip 指向它，漏设时 STEP 导出的是少五孔的旧状态；Pad.Profile 在当前版本返回 LinkSub 元组，不能当直接对象。两者均通过保存重开和 STEP 回读才发现，不能把初轮错误当 FreeCAD 后端故障。

### 9.1 KFW 后台插件验收

官方 bundle、共享按需工具及可信服务现已接线：`cad_status`、`cad_describe_document`、`cad_create_primitive`、`cad_run_python`、`cad_export`、`cad_preview`。源码层工具与预览共 **28 项**；CAD 审批复用严格入参和完整脚本证据，超预算／敏感／不完整证据保留人工审批。Python 可选 `result` 返回普通 JSON；日志不当作结果。

显式运行 `KENFUTWORK_CAD_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/cad/freecad.integration.test.ts` 的完整场景已通过：真实 Task 沙箱内草图／约束／Pad，尺寸修改后原文件不变，STEP、PNG、SVG、DXF、BREP；嵌套容器与工程图引用不妨碍默认选对象，投影与 BREP 保留全局坐标，SVG／DXF 重新导入保持 10×20 mm。Python 自定义结果也由真实进程回读。普通测试仍默认跳过真实应用场景。

实施中确实发现并修复的边界：

- stdout／stderr 必须在退出等待前订阅并 ACK；原接线缺失导致 helper 回报失败，不能用已生成文件掩盖。
- FreeCAD 文档临时目录依赖专用缓存目录，单设 TMPDIR 不够。使用官方 `FREECAD_USER_HOME/DATA/TEMP`，验证数据／缓存／临时／文档 transient 目录均在本次 Task 执行树；不允许退化写 `/`。依据为 [ApplicationDirectories.cpp](https://github.com/FreeCAD/FreeCAD/blob/main/src/App/ApplicationDirectories.cpp) 与 [Document.cpp](https://github.com/FreeCAD/FreeCAD/blob/main/src/App/Document.cpp)。
- `hasattr(obj,"Shape")` 会包含容器与无限基准几何。默认选择只取真实 Shape 属性，不用全体 InList 判断几何替代；父容器 Placement 依官方组合式应用到副本。
- SVG 交换文件保留毫米尺寸；PNG 在内存副本中设置与真实 viewBox 等比的像素视口，避免拉伸、非零坐标裁空及按自然 DPI 解码大位图。文件存在、解码成功仍不足以证明画面非空。

串行全包测试 **19 任务成功**（server 3294／shared 170／Web 1065 通过，默认跳过另计）、全类型 **26 任务**、workspace **38 项**及 lint 零错误通过。真实模型整轮用户任务另行验收，不把本节服务层证据扩大成 Agent 或 GUI 全面验收。AutoCAD、Blender 均无本机验收。

### 9.2 二维聚合边界与真实模型任务

安装版对应的官方 `1.1.4` 源码将 Body 的 Tip 初值设为空；仅有 Sketch／Datum 不产生实体特征，无 Tip 的 Body 将 Shape 设为空后正常返回。因此不能用三维实体聚合规则拒绝合法纯草图工程。[BodyBase.cpp](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Mod/Part/App/BodyBase.cpp#L37)、[Body.h](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Mod/PartDesign/App/Body.h#L97)、[Body.cpp](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Mod/PartDesign/App/Body.cpp#L397)

真实 Task 沙箱回归新增两项：10×20 mm 纯草图 Body 保存／重开、默认选择 Sketch 的 SVG／DXF 及 PNG 通过；要求实体、普通空 Feature、空 Body、坏 Pad、缺 Tip 的实体 Body、额外空草图均拒绝。合法空聚合返回 `bounds:null`。删除通用 HOME 重定向，继续使用 FreeCAD 官方专用配置／缓存／临时目录变量；本轮 CAD 三文件 31 项（含三项原生场景）通过。

已有 GLM 5.3 Flash 在 Code build 权限下，一条输入、一个 Run 完成原生参数化圆柱、STEP 和等轴线框 PNG。过程先误把不存在的输出当输入，继而误读 Python 元组；Agent 根据失败回执自行修正、重新描述并验证，没有由验收脚本补写交付文件或代答审批。独立回读确认 Tip=Pad，原生与 STEP 体积均为 1570.7963267948965 mm³，STEP 为 20×20×5 mm；改直径至 30 mm 后体积 3534.291735288518 mm³，源文件未改。该证据是后台圆柱交付闭环，不能扩大为全部工作台或当前 GUI 文档控制验收。

原生应用控制已能读取、截图、操作菜单并执行官方 Python。GUI 重开上述交付后，Body／Pad 的 Visibility 为 false；只改变内存中的显示状态即可看到正确圆柱，未保存覆盖原工程。不能由这个加载结果倒推存盘属性为 false；原片的 App.Visibility 实际为 true，缺少的是 GUI 保存成员。后续修复及其边界见下节。

### 9.3 官方视图保存、进阶工具链与取消

官方 `1.1.4` 中，`setupWithoutGUI()` 创建 `Application(false)`，不建立监听文档生命周期的 GUI 文档；GUI 状态保存由 `Gui::Document` 的文档保存观察者完成。独立 CLI 对照也确认：`setupWithoutGUI()` 能保存有效几何，但没有 ViewObject 或 `GuiDocument.xml`；离屏 `QApplication`＋`FreeCADGui.showMainWindow()` 建立官方 GUI 保存器后，两者均存在。[FreeCADGuiPy.cpp](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Main/FreeCADGuiPy.cpp)、[Gui Application.cpp](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Gui/Application.cpp)、[Gui Document.cpp](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Gui/Document.cpp)

KFW 仅对创建／修改操作选择 `QT_QPA_PLATFORM=offscreen` 并隐藏该独立进程的主窗，使用官方序列化器；不拼接 XML、不统一覆盖脚本的可见性。真实 Task 回归通过保存重开后的 Body／Pad 可见、草图隐藏，纯二维 Body／Sketch 可见及原语默认可见，同时保留 Tip 和体积。可见 FreeCAD 另行打开离屏样本，未手动切换 Visibility 就能显示正确圆柱。离屏平台报告没有 OpenGL 上下文，因此未把其缩略图或 framebuffer 当作有效预览；线框 PNG 路径保持独立。

进阶回归通过真实 `createCadTools(service)` 消费：约束草图→Pad→Pocket→六孔原生环形阵列→外径 80→90 mm→保存重开→STEP 导出回读。逐步核对解析体积，最终 Tip、Profile、90×90×10 mm 包围盒、实体数及源工程字节均正确。此项属于 KFW 工具层实测；圆角、倒角、旋转等仍分别以此前官方测试证据登记，不虚构真实 Agent 全覆盖。

真实 CAD 取消回归在源脚本写出就绪标记后中止 Task 信号，确认不发布最终 FCStd，并以同一 Task 的新信号继续建模成功。三项单元回归另锁定安装门控等待、派发前最后路径解析、退出后回执读取期间换代际均不得派发或报告旧成功。最终 CAD 三文件 **38 项**通过（含六项原生场景）；普通测试仍默认跳过原生场景。

原 Code Flash Run 的持久事件已对账：六组成对 requested／resolved→allow，分别为三次 Python、检查、交换及预览；期间有独立模型调用用量，本机验收脚本未代答。Design 同 Task 的首次真实尝试尚未调用 CAD 插件，改走辅助 Write／直接 Bash；观察者拒绝无关 echo、允许已审阅的辅助脚本后停止测试 Run，未执行其直接启动 FreeCAD 的 Bash。该次明确不计 Design 插件验收通过，保留现场继续核查按需工具曝光。

完整服务器 profile 的临时真实 PG／HTTP 模型集成测试 **4 项通过**：实际安装本地官方 CAD bundle，共享同一 Project／Task，Design 首个真实模型请求包含 ToolSearch，搜索后 CAD Python 被送入独立审批；等待期间停用插件，即使模型返回 allow 也不派发。重新启用后同 Task 的 Code Run 重新审批并抵达可信进程入口。另一场景撤权取消原审批与 HTTP 审查，迟到 allow 不派发、没有伪造 FCStd。应用发现及进程边界在这组测试用替身，不将其当作几何实测；真实 CAD 几何由前述六项原生场景证明。撤权终态是带明确原因的 run_failed，区别于用户主动 Stop。

### 9.4 真实模型脚本失败与诊断

第二次 Design 输入明确要求 ToolSearch 后，真实 Flash 已成功搜索并调用 CAD 工具，否定了“Design 没有工具入口”的推断；同一 Task 的 code／design Run 工作方式也由持久输入与冻结绑定对账。脚本仍先后出现裸 AssertionError、关闭文档后保留失效 doc。后者可由官方同路径打开复用逻辑解释：saveAs(MID) 后 openDocument(MID) 返回已有文档，关闭该别名也会关闭原 doc。[Application.cpp](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/App/Application.cpp#L937)

观察窗口结束后重新读取，产品 Run 仍在等待人工审批，不能当作已经停止；待审批脚本仍有“实际 13 条约束却断言 12”及未把 doc3 赋回 doc 的静态错误，观察者随后显式停止这条测试 Run，确认 completedInterrupted、零活动和零待审批。未强行批准或修改模型脚本，不计作完整二维交付通过。

运行器现在给真正属于 `<cad_run_python>` 的内层 traceback 帧补源行号；SyntaxError 用自身 filename／lineno 定位。脚本结束后的失效 doc 不伪造源行，明确要求将存活文档赋回 doc，不自动选择 ActiveDocument。新增真实回归覆盖裸断言、有说明异常、嵌套异常、语法错误、失效绑定与显式重新绑定后成功。只补定位，不追加源码、完整栈或宿主路径；原异常消息保持，不能据此承诺对用户自带消息自动去敏。

### 9.5 常用约束草图与命名尺寸

新增共享按需工具 `cad_apply_operations`，首批覆盖 Body、同一 Sketch 内矩形／圆及命名驱动尺寸修改；复杂建模仍由受 Task 权限控制的 Python 补充。矩形宽高、圆半径与坐标使用真实 Sketcher 约束；零坐标按对应轴使用 PointOnObject，不用退化的零距离。坐标是固定绝对位置，不将初始居中误称为改尺寸后仍相对居中。接口事实交叉核对安装版随附 `SketcherTests/TestSketcherSolver.py`、`TestSketchExpression.py` 及 [Sketcher 官方 Python 包装](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Mod/Sketcher/App/SketchObjectPyImp.cpp)。

原生回归确认同一草图五段几何、两个闭合轮廓、完全约束，宽高和半径修改后保存重开仍保持真实数值；零坐标、轴上点与负坐标均独立回读。原 FCStd 字节不变，SVG／DXF／PNG 来自修改后的工程。对象名称碰撞或自动改名、错误 Body、缺尺寸、参考／停用尺寸、失配类型均失败，指定最终文件不发布。

测试另发现真实表达式保护缺陷：安装版保存的命名绑定为 `.Constraints.Plate_Width`，不能只匹配 `Constraints[index]`；原实现会保留 45 mm 表达式，却把要求改成 50 mm 的操作报告成功。修复后同时识别索引和命名路径，修改后回读生效值；命名／索引入口的表达式均由真实文件回归验证拒绝，不解除绑定。审查追加的原生 RED 还复现了停用尺寸仍保留 driving 标志，修改其值会误报成功而几何不动；现检查 `getActive`，回执只列启用的驱动尺寸，并验证同一草图其它启用尺寸仍可正常修改。[官方约束启停接口](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Mod/Sketcher/App/SketchObject.pyi#L498)

CAD 三文件 **43 项通过，含九个原生场景**。这组工具层证据仍不等于新的真实 Flash 整轮任务或全部结构化三维操作已通过。

### 9.6 真实 Design 交付与预览后的请求边界

新的独立 Design Task 在同一既有验收 Project／主目录使用官方 GLM 5.3 Flash，一条输入中经 `cad_apply_operations` 创建同一 Sketch 的 30×20 mm 矩形与圆心 `[15,10]`、半径 2.5 mm 的圆，导出 FCStd／SVG／DXF／俯视 PNG。四组 CAD 审批均持久化为 allow，观察者没有代答。独立 FreeCAD 回读确认完全约束、五段几何、两个闭合轮廓、无实体与无 Body.Tip、原生显示状态及交换尺寸；四个原片哈希均未变，PNG 已实际查看。

该 Run 在预览成功后收到主模型 400／1210，仍明确记作整轮失败。不能把文件已生成扩大为 Run 完成，也不能由“预览后失败”推断 Flash 不支持图片。[官方 Flash 图片能力](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)与[对话补全接口](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)均确认图像输入。

同一配置、同一 PNG 的最小真实对照中，文字工具结果、工具结果中的图片、独立用户图片在流式与非流式下都得到 200，因此图片角色本身不是本次充分原因。通过可信 Task 线程绑定固定原生 checkpoint，只读恢复完整消息，用假 Key 的本机 HTTP recorder 录出实际 SDK 请求形态；该 24 条历史在官方端点重放为相同 400，仅去掉图片则 200。进一步最小化到先文字工具、再图片工具：早先 `Glob` 的空结果为 `[{"type":"text","text":""}]`，该空块与后续图片组合触发 400；只把此工具内容改成空字符串即 200。非空文字数组的同类对照仍为 200，不能把所有文字数组都称为不受支持。

修复仅在 Completions 请求边界将纯文字 ToolMessage 数组按原序以换行连接为字符串；空数组／空文本得到空字符串，不改持久历史、调用身份、元数据、图片或其它协议。真实旧 checkpoint 经修复后的实际工厂投影后，在同一官方端点得到 200，24 条消息的工具调用 ID 和图片字节保持一致。回归通过实际 Code Harness 的三次模型 HTTP 请求锁住“先空文字工具，后图片”的组合，并保留预算内大 PNG 的尺寸与哈希断言；流式／非流式另验证文本、空结果、图片与输入对象不变。

本批不把官方文档未承诺的工具图片角色推广为所有 Chat 供应商的兼容结论；ZCode 的完整媒体后置投影已作方向研究，本次只修复已由真实请求证实的空文字边界。新 Task 的整轮终态仍须另行复验，原失败状态与原片保留。

## 10. 来源地图与证据限制

| 来源组 | 用途 | 强项与限制 |
| --- | --- | --- |
| FreeCAD Power users hub、Embedding、Headless | 自动化入口和后台／GUI 边界 | 官方 Wiki 有访问防护，本轮交叉使用官方 GitHub 文档源；旧镜像已归档，不能默认等于安装版实现 |
| FreeCAD Sketcher、PartDesign、Quantity、Export、TechDraw 文档 | 参数化操作、索引、单位与交换格式 | 接口文档和范例支持可行性，不替代各工作流测试 |
| FreeCAD Document／DocumentObject／TopoShape Python 包装源码 | 重算数量、状态、空形状语义 | `main` 与安装版可能不同；本机探针决定当前结论 |
| FreeCAD Topological naming 专题、上游 issues | 历史持续风险及边界样例 | 多报告是频率信号，不是当前版本或用户群发生率 |
| AutoCAD 2027 官方平台表、脚本文档、APS 官方仓库 | 平台 API 与 Core／GUI 装配差异 | 文档层核验；没有本机安装验证，Mac 后台路线未确认 |
| APS Automation 官方产品文档 | 云端作业与本机控制的区别 | 可行性不等于已获服务权限、已配置或已验收 |
| Autodesk Offerings、General Terms | 后台活动、API 用途和服务提供边界 | 已记录页面日期；具体项目许可适用性仍需按用途核对 |
| Autodesk Assistant 产品页、本机 MCP 更新、Product Help MCP 文档 | 区分控制组件、产品内能力与只读帮助 | 未得到可供 KFW 接入的公开 AutoCAD 控制协议证据 |
| Blender CLI、Python API、源码和 manifest | 后台运行、上下文、线程及扩展路线 | 部分 docs 页面全文抓取受限，使用官方索引摘录与官方源码交叉核对；运行时仍未验 |
| Blender 官方 Lab MCP 页面及源仓库 | 真实官方 MCP、依赖和风险边界 | 官方入口可追溯；源站部分请求拒绝，未审计全部实现或复用其代码 |
| 用户附件及当前确认 | 目标、建议样件和历史说法 | 附件是待核材料；当前确认决定本轮范围，不能由附件推导未授权结论 |

本轮没有用 Reddit、博客或第三方 MCP 的星数证明接口能力，也没有以营销介绍代替应用 API。未访问私有支持数据或遥测；没有实际安装的应用、官方页面未说明的协议、专业工作台未跑过的操作均保留待验。
