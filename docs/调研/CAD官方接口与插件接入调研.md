# CAD 官方接口与插件接入调研

> **角色：调研**。资料核验日期：2026-10-18—19。面向在 KFW 中使用 Agent 进行建模、改尺寸、检查及交付文件的用户，研究本轮 FreeCAD 接入及后续 AutoCAD、Blender 的可行性与工作流风险。本文区分官方接口事实、工程推断、用户确认和本机验收；不代替实施规格或发布验收。插件扩展点及服务契约仍以《[改造计划](../方案设计/改造计划.md)》§4.2、§4.10 为准。

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
| 文档创建、保存、重开 | App Document／Python 接口 | 原生工程可重开；对象、约束和参数保留 | 后台保存／重开与源保护已验，见 §9.1～§9.8；GUI 内存副本→Task 发布已有工具实证，固定原位保存与持久写域也已有真实工具整链证据，见[桥接核验](FreeCAD当前文档桥接接口核验.md) §16.7 |
| 2D 几何与草图 | Sketcher `addGeometry`、几何／尺寸约束 | 闭合轮廓、约束状态、尺寸回读与矛盾约束错误 | 结构化约束／改尺寸及真实 Design 整轮已验，见 §9.5、§9.7 |
| 3D 原语、布尔、位置 | Part 形状及文档对象 | 有效性、实体数、体积、包围盒与预期对应 | 原语与位移／旋转有既有证据；Python 布尔及结构化 Body 布尔三模式、参数联动与来源保护已验，见 §9.14、§9.20 |
| 参数化实体 | PartDesign Body、草图和特征 | 拉伸／凹槽／旋转等有真实依赖；改源尺寸后下游随动 | 结构化 Pad／Pocket、厚度联动与首个固定角 Revolution 已有原生证据，见 §9.8、§9.13 |
| 进阶建模 | 圆角、倒角、阵列及其他官方特征 | 合理参数成功；失效参数能识别；重开后依赖保留 | Python 单边修饰／线性与环形阵列四阶段见 §9.14；结构化多边修饰见 §9.23；线性／环形阵列及完整结果证明见 §9.24 |
| 表达式与单位 | Quantity、属性、表达式接口 | 显式单位输入、正确回读、关联参数更新 | 后台厚度／角度联动见 §9.8、§9.13；GUI Quantity 基础数值／单位签名、直接属性表达式读取及保留绑定的标量写入已有实证，见[桥接核验](FreeCAD当前文档桥接接口核验.md) §10、§11；不代表任意显示单位转换或 GUI 表达式编辑已验收 |
| 工程文件及交换格式 | `Std Export` 与对应格式模块 | 导出正确对象；再导入核对几何和单位 | STEP／STL／BREP／SVG／DXF 已有分层回读证据，见 §9 |
| 工程图 | TechDraw 文档对象、官方 TDTest | 投影完成后导出；模板、比例、尺寸与异步计算正确 | 离屏 A4／俯视图／真实尺寸及整页 SVG 已验，见 §9.14；独立 GUI 原生夹具另验证单页 PDF 导出与栅格查看，见 §9.17，不代表正式 PDF 工具或完整比例／标注验收 |
| PNG 预览 | GUI view 的图像导出、scenegraph 路线 | 真实图像、视角和对象可见性正确；缺图形环境可解释 | 后台真实几何线框 PNG 已验，见 §9.1、§9.7；独立 GUI 原生夹具已导出并查看着色 PNG，见 §9.17，不代表正式 GUI 预览工具已交付 |
| Draft／BIM／Assembly 等 | 对应工作台 Python／命令接口 | 安装模块、依赖和代表性任务分别通过 | Assembly Grounded＋Fixed、完整Provider、重开折返与交换及未连通拒绝见§9.26；Draft参数面及SVG／DXF闭环见§9.29，Arch墙柱楼层与独立IFC4互操作见§9.30；其它关节／对象／复杂BIM待验，接口见[专业工作台核验](FreeCAD专业工作台接口核验.md) |
| FEM／CAM 等 | 官方工作台与外部工具链 | 网格／求解器／后处理器可用；输出语义正确 | FEM真实新网格／CalculiX轴向压力及失败／停止代表流程见§9.25；CAM外轮廓／官方linuxcnc与真实NC核验见§9.27；其它FEM领域及CAM策略／后处理器待验，接口依赖见[专业工作台核验](FreeCAD专业工作台接口核验.md) |
| 当前 GUI 文档 | 应用内 Python／GUI API | 明确文档身份、保留未保存工作、正确撤销和选择 | 固定查询／观察、直接标量读写、副本发布及自身已提交属性操作的显式撤销已有独立 GUI 的真实 Task 工具实证；固定原位保存与停止／恢复已有真实工具证据，见[桥接核验](FreeCAD当前文档桥接接口核验.md) §8～§16 |

本表区分后台工具、独立 GUI 的真实 Task 工具和专用原生夹具。GUI 工具的逐项行为与验收范围以[桥接核验](FreeCAD当前文档桥接接口核验.md)为准；现有证据未覆盖用户现存 GUI、任意 GUI Python、全部属性或全部工作台。该文第14节的归属／原生 undo／redo 仍是夹具证据，正式显式撤销的工具实证单列第15节；它只支持自身有证明的已提交属性操作。原位保存的独立工具证据见第16.7节，不能从副本发布或撤销结果推定。

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
| 本轮已验 | 当前可见 FreeCAD 文档固定控制 | 固定查询／观察、标量读写、副本→Task 与自身属性显式撤销已有工具实证；固定原位保存、Native-held取消及持久恢复写域已有独立产品工具整链验收，详见[桥接核验](FreeCAD当前文档桥接接口核验.md)；不等于用户任意现存文档全面验收 |
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

本批不把官方文档未承诺的工具图片角色推广为所有 Chat 供应商的兼容结论；ZCode 的完整媒体后置投影已作方向研究，本次只修复已由真实请求证实的空文字边界。修复后的新 Task 整轮复验见下一节，原失败状态与原片保留。

### 9.7 修复后真实 Design 整轮复验

在 `ce79d4e2` 的修复后，新建独立 Task `a46ea8d4-efe2-4e96-8759-d489089b2301`，同一既有验收 Project／主目录、已有官方 GLM 5.3 Flash、Design 工作方式。一条用户输入、一个 Run `3d56d527-c961-4352-a0d7-08885f13eb66` 完成创建、交换、预览、工程描述与 Python 回读，最终 `completedSuccess`，工具零错误、零活动和零待审批。六组 CAD 审批均为 requested／resolved→allow，观察者没有代答。

四个 `structured-final-2d` 文件独立原生回读通过：完全约束、五段几何、两个闭合轮廓、30×20 mm、圆心 `[15,10]`／半径 2.5 mm、无实体／Body.Tip、显示状态为 true；SVG／DXF 回读保持 30×20 mm。四原片在独立检查前后哈希一致，旧失败样本的四文件也未改变。此证据覆盖这条后台二维交付，不代表全部三维工具或可见 GUI 当前文档控制已经通过。

额外可见应用检查中，文件进入了 FreeCAD 最近列表，但未确认模型树／视口加载；随后查询 Dock 的原生自动化服务耗时约 5 小时 52 分后返回 `timeoutReached`。Goal 未被主动暂停；恢复后实时 HTTP 复核仍为上述成功终态、原片哈希一致。该 GUI 工具超时与后台 CAD 权限／产物有效性分别记录，当前不再以非必要界面检查阻塞 CLI 工作；可见 GUI 控制继续作为后续独立验收。


### 9.8 结构化 Pad／Pocket 与参数链

本机官方 1.1.4 附带的 `PartDesignTests/TestPad.py`、`TestPocket.py`、`TestPartDesignGui.py` 与 Sketcher 放置测试，分别给出 Profile／Body、有限／贯穿切除、`SideType` 及自由草图 Placement 的 API 依据。组合行为另用真实 Task 沙箱验证，未仅凭属性存在就宣称可用：圆底 Pad 厚度 10→12 mm，孔草图局部 Z 随 `Pad.Length` 表达式变化，有限深度 4→6 mm、贯穿、显式关闭重开及 STEP 再导入的单实体和解析体积一致。未采用已弃用的 Midplane，也未猜测 FaceN。

结构化入口复用同一个 `cad_apply_operations`；工具回归先在第三项 `create_pad` 得到明确“不支持”失败，随后同一用例通过。矩形板 40×30×10 mm、r4／深5孔，改到 50×35×12 mm、r5／深6后，原生回读体积为 `50*35*12 - pi*5^2*6`；再把厚度改为14验证孔平面联动。Body 整体平移旋转后的 STEP 回读保持物理体积与世界包围盒；独立贯穿分支随厚度增长仍切穿。输入 FCStd 字节保持不变。

本批结构化范围是同 Body 首个正向 XY 单侧定长 Pad、绑定孔草图、有限／贯穿 Pocket 及对应尺寸；任意其它建模仍由 Python 承接，不冒充所有 PartDesign 参数组合已经封装。可信建模脚本独立于执行／序列化脚本，由既有 runner 在同一次进程装配；没有新增 HTTP、数据库或特权运行通道。失败矩阵已原生验证跨 Body、错类型、未绑定／旋转草图、过时 Tip、无材料切除、多实体、表达式保护和通孔深度误参，逐项确认失败文件不存在且源字节不变。回退 Tip 后重用已消费草图的实测 RED 已修为明确拒绝，三个新原生用例通过；最终全仓门禁另记日志。


### 9.9 真实 Code 三维整轮验收

在 `412ef83f` 后，以既有官方 GLM 5.3 Flash、既有独立审批设置和同一验收 Project／目录，新建 Code Task `ac40e2a1-a033-4746-a892-84eba88a3346`。一条输入、一个 Run `09d42ac8-8a65-4dcd-9bdf-e43b95c09a4a` 完成结构化建模、厚度联动、工程描述、Python 检查、STEP 与 PNG，最终 `completedSuccess`；实时 HTTP 复核零活动、零待审批、无 lastError。17 次工具调用零错误；五组 CAD requested／resolved 均为 allow，观察者未代答。

Agent 用一次 `cad_apply_operations` 创建 40×30 mm 板、初始 Pad 10 mm、固定 `[20,15]`／r4 贯穿孔，再将 Pad 改为 12 mm。另起原生 FreeCAD 回读三份交付：两草图完全约束，孔 Z 为12且仍绑定真实 `BasePad.Length`，最终 Tip 为 `HolePocket`，有效单实体、孔中点无材料；FCStd 与 STEP 的体积均为 `13796.81421051076 mm³`，包围盒均为 `[0,0,0,40,30,12]`。Body／Pocket 显示，草图与旧 Pad 隐藏，原生 GuiDocument 存在；PNG 实际查看为非空的带孔等轴线框。

三份原片独立检查前后哈希相同，启动前目录内既有12份文件的哈希也全部保持。真实 Task／Project／目录、两类代际和 Code Run 绑定已从持久事件核对。此项覆盖后台 Code 三维工具整轮，与 §9.7 的独立 Design 二维任务分别记账，不冒充同 Task 真实跨模式或当前 GUI 文档控制已验；同 Task 共享与权限恢复仍由 §9.3 的完整宿主测试证明。此前单次 helper 失联的死因仍未确认，不能用这次模型成功替代该问题的独立调查。


### 9.10 helper 失联的生命周期取证

针对 §9.8 中单次 STEP 后 helper 不可达，先用真实合成 helper 建立成功的 initialize／spawn 句柄，再以独立控制通道制造“断连→退出23”。确定性 RED 表明，后续 Stop／Close 丢失首因；修复后标准 Error.cause 关联同一诊断 ID，父端在现有 captureRoot／Task 哈希私有目录记录事件顺序、helper PID、后到退出码／信号、有界 stderr 和最后进程快照。没有命令参数／环境变量，普通错误消息不含 stderr，文件权限600；写入失败不替代执行错误。诊断 consumer 修改 cause 不能反向篡改内部首因。五项回归通过，全类型26任务通过。

未知退出仍返回 stop_unconfirmed，Close 失败与禁止重开、代际及恢复屏障保持。没有从 helper 退出或文件成功反推命令 rangeEmpty。取证后的同模型连续80次 STEP 全部成功，私有记录确认80个进程退出、关闭 ACK、helper退出0；仍不把连续成功称为原间歇死因已经修复。

另以真实 Task stdio 建立明确首帧 ACK 屏障：子进程写 A、等待 stdin，再写 B 后退出；父端持有 A 的 listener Promise。该独立探针稳定复现同类 helper 失联，新的私有 stderr 记录 `PipeOutputRelay.publish` 对未 ACK 前帧抛 output_failed，helper退出1。该堆栈证明了一个实际退出竞态，下一批先将探针锁为回归再修复；原 NrqudE 没有 helper stderr，不能将这份新堆栈冒充原现场证据。


### 9.11 stdio 退出冲洗与 ACK 的回归修复

本机 Node v24.18.0 内嵌 `internal/child_process` 第304行在 child 退出时 nextTick 调 `flushStdio`，第331行对仍可读的 stdio 调 `resume()`。因此应用前一帧主动 pause，并不保证退出时不会再收到数据。旧 PipeOutputRelay 将这种尾部交付视为“前帧未 ACK”而直接在 data 监听器抛错，终止整个 Task helper；前述独立探针的私有堆栈与该路径一致。

正式回归先全部 RED：真实 macOS Task 中，stdout／stderr 各自持住 A 的 listener Promise，另一路报自身实际 PID，stdin 命令使 B 写入回调后正常退出；确实观察该测试 PID 退出后才释放 ACK。旧版两条流均无法获得完整 AB 与退出证明，另四项纯流回归覆盖强制 resume、跨块 UTF8／EOF、序号／字节游标及关闭后历史采集。

修复仅在原 relay 中接受退出冲洗带来的额外文本，立即再次 pause 并排队，收到前帧 ACK 后按序发送；单帧在途、完整协议与有界 capture 分离、重复／未来 ACK 及关闭语义保留。不吞数据、不用历史截断替代协议、不加重试或任意新字节预算。六项回归转绿；后续原生 CAD 与全仓门禁另记日志。这证明该退出竞态已修复，不代表所有 helper 失联原因都被覆盖。

原生全套复验又发现取证写入的收尾竞争：关闭 RPC ACK 后父端立即返回，exit／close 的私有记录与测试删目录相撞。新增明确存活屏障的 helper 回归先 RED，现由 helper 在关闭回执发送回调后自行断开 IPC，父端等待实际 close 和最后记录写完才返回。独立 Node 探针确认当前运行时父端抢先断开 IPC 可能只有 exit、缺 close，不能用该方式判断最终资源边界。关闭已 ACK 但 helper 仍存活时复用既有 killGraceMs 收尾自己的 helper，SIGTERM／SIGKILL 两条路径有回归；未收到关闭 ACK 时不使用此终止流程，继续保持 stop_unconfirmed 与不可重开屏障。没有给目录删除增加重试。

最终范围回归六文件53项、启用真实 FreeCAD 的 CAD 四文件49项均通过；workspace38项、串行全包19任务、全类型26任务及lint零错误通过，默认跳过和既有警告另计。独立只读复核未发现该输出与关闭组合的新缺陷。该结果覆盖本节确定性竞态及既有后台 CAD 场景，原始缺少 stderr 的间歇现场仍保留未完全归因边界。

### 9.12 曲面尺寸与显示网格

旋转原型以解析体积、轴向及内部点核验几何后，发现同一 Shape 的默认 `BoundBox` 会受已有三角网格影响。独立环体回归（主半径10 mm、副半径2 mm，另以0.5 mm偏差生成显示网格）先得到 RED：期望边界-12 mm，旧回执为-11.972025230286471 mm。不是放宽尺寸误差后判为成功。

回执改用 [`TopoShape.optimalBoundingBox(False, False)`](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Mod/Part/App/TopoShape.pyi)，关闭三角网格参与和形状容差扩张，读取几何边界；字段结构、局部坐标口径、单位与体积判定保持。回归分别核对创建后的六个边界、保存重开后的六个边界、有效单实体及源工程字节保护。此项只改变尺寸读取，不改变用户工程、网格精度或预览样式。

采用该测量接口的独立 Python 旋转原型已通过32个阶段：两个局部轴、矩形和圆轮廓、90／180／360度、改尺寸后恢复、角度表达式及保存重开。该探针证明后台 Python 路径可行，不等于 `create_revolution` 已封装或 STEP 变换／当前可见文档控制已验。

### 9.13 结构化旋转与上游改角

常用旋转沿同一个 `cad_apply_operations` 接线，新增本 Body 首个自由 XY 草图绕局部 X／Y 轴的正向单侧固定角 Revolution；`angle` 范围 `(0,360]`，角度单位为度。`set_dimension(angle)` 通过现有 schema 和审批投影，拒绝已有 Angle 表达式、反向／对称／其它模式及外部基准轴，不重设用户关系。首实体检查与原 Pad 复用同一函数，未新增运行路径、工具特权或 HTTP 契约。[本机对应官方旋转用例](https://github.com/FreeCAD/FreeCAD/blob/1.1.4/src/Mod/PartDesign/PartDesignTests/TestRevolve.py)

契约两项先 RED，原生三项也在旧工具参数层失败；接入后两轴的矩形环形柱与圆轮廓环体分别验证实际角度、体积、内部点、参数修改、保存重开、Body 变换后 STEP 独立再导入与源字节保护。额外原生场景验证后继增材实体存在时修改上游角度，真实 Tip、下游几何和显示状态保持；若改角使下游失效，拒绝发布。角度表达式、跨 Body、错误对象、已有实体、跨轴自交及同方向外部基准轴分别拒绝。

外部轴夹具最初试用另一草图的内部轴，FreeCAD 自身返回 Invalid，不能用此夹具宣称生产拒绝已覆盖。现改用官方可用的 Body Y 基准轴，先保存有效源工程，再核验结构化入口明确拒绝；两次无效夹具结果保留在本机记录。当前原生证据只覆盖上述固定角首特征，任意轴、反向／双角及后续增材旋转仍由 Python 承接，不扩大封装范围。

### 9.14 进阶 Python 工作流与真实工程图

同一个受 Task 约束的 `cad_run_python` 路径已执行八类能力，每类经过初始建模、保存关闭重开、修改参数、再次保存关闭重开四阶段。正式夹具 `features/cad/fixtures/advanced-operations.py` 独立编写，按本机 FreeCAD 1.1.4 随包 `TestBoolean`、`TestFillet`、`TestChamfer`、`TestLinearPattern`、`TestPolarPattern` 与 TechDraw 测试核验 API，不导入上游测试 helper，不新增生产运行通道。

- **布尔**：两个相交 Body 的 fuse／cut／common 分别核对体积、单实体、Tip 和各区域内部点；工具尺寸及位置修改后，体积分别为1600／400／600 mm³。
- **圆角／倒角**：依据真实端点唯一选择竖边；源长宽高和半径／倒角尺寸修改后，按解析公式及被切除／无关区域的内部点核对，Tip 与基体引用在重开后保持。
- **阵列**：线性阵列与环形阵列使用真实 Originals 和草图轴；修改草图宽度、源 Pad 厚度、线性数量和间距后，最终体积6240／5760 mm³，复制位置、完全约束与显示状态保持。
- **工程图**：官方随包 A4 横向模板、俯视 Source、真实 `makeExtentDim`／`getRawValue` 尺寸及整页 SVG。40×20 mm 源修改为50×25 mm 后，两条尺寸随动，未启用 Arbitrary 或手填数字；每阶段核对 SVG 的实际 text 元素和297×210 mm物理页面。

首次探针的测试模板路径不适合本机资源布局，随后改用官方 `Default_Template_A4_Landscape.svg`。另一版虽然数值全过，导出文字却位于页面外；[官方尺寸文档](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/TechDraw_LengthDimension.md) 明确 X／Y 相对 View，与[视图在页面上的坐标](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/TechDraw_View.md)不同。修正相对位置及字号后，实际渲染并查看 SVG，50／25两条尺寸、箭头和轮廓均完整显示。没有仅以 SVG 非空或路径数字代替文字验收。

32项阶段检查后再启动独立 FreeCAD 进程 describe 最终文件，八项最终几何均有效单实体，解析体积一致，FCStd 源字节保持；正式原生测试将同一流程和读回接线，默认关闭、显式开关启用。本项证明这些代表性后台 Python 工作流，不代表所有拓扑／参数组合、结构化封装、PDF、可见应用渲染或当前 GUI 文档桥接均已验收。

### 9.15 原生权限与 GUI 实例查询

当前 Codex 原生通道实测能够读取已安装 FreeCAD 1.1.4 的界面、截图，以及通过键盘新建并关闭独立空文档，没有待确认的系统权限弹窗。另一个使用独立配置、数据、缓存和 Qt 临时目录的测试进程，经本机 Unix socket 的实际 peer PID 核验后执行固定只读宏；延迟到 GUI 事件循环后回报 PID、空文档列表、配置路径和窗口状态。初版诊断误用不存在的 `getUserConfigPath`，改用官方 `ConfigGet("UserConfigPath")` 后所有隔离路径均通过；这不是产品运行器缺陷。

实际 NSWorkspace 结果中，`NSBundle.executableURL` 为 `Contents/MacOS/FreeCAD`，运行进程的 executableURL 为同安装中的 `Contents/Resources/bin/freecad`。二者不相等是当前官方包的实际启动结构，不能据此把正常 GUI 错判为其它程序。机器上 `/Applications` 与挂载盘存在相同 bundleId 的应用，直接按 bundleId 选择也存在歧义；查询只返回系统实际枚举的 GUI 实例，并分别验证真实路径和可执行性。

官方 CAD 插件的 `cad_gui_status` 通过现有 Task、安装门控、限时和取消调用这个固定探针；查询完成前再次核对授权。原生集成测试经真实工具入口查询当前应用，再按 PID、系统启动时间、真实可执行路径及 bundle 路径独立复核，拒绝把空枚举当作这项原生验收通过。该结果只证明当前通道权限和只读实例查询；不证明 KFW 已能读写当前文档，也不宣称用户应用已被 Task OS 沙箱收养。当前文档控制继续按独立批次推进。

### 9.16 用户报告的三次可见 FreeCAD 崩溃

2026-10-18 用户报告工作期间应用崩溃并自行重开后，读取系统现存三份 `.ips`，没有要求用户补交日志。三份报告的目标均为 `/Applications/FreeCAD.app/Contents/Resources/bin/freecad`、父进程 `launchd`、主线程 `EXC_BAD_ACCESS/SIGSEGV`；关键栈一致：`objc_release`、数组释放、`QMacAccessibilityElement dealloc +60`。它们加载 Qt 6.8.3，不是普通正常退出或后台 FreeCADCmd 的退出回执。

| 本机 captureTime（UTC+8） | GUI PID | 已核对的本线程动作 | 时间关系 |
| --- | --- | --- | --- |
| 14:32:49.5537 | 27471 | 14:32:48.174 发起 CUA 点击及 AX 树／截图读取 | 约 1.38 秒后崩溃 |
| 14:34:27.2558 | 25304 | 14:34:27.085 发起 CUA 激活及 AX 树读取 | 约 0.17 秒后崩溃 |
| 15:21:45.8036 | 26943 | 原生渲染诊断宏创建并关闭自己的临时对照文档，15:21:45.757353 写完最终回执 | 约 46 毫秒后崩溃 |

报告名依次为 `freecad-2026-10-18-143252.ips`、`143429.ips`、`152148.ips`；文件名时间比实际 captureTime 略晚。原始报告保持不变，哈希及脱敏摘要、22 次 GUI 调用时间线保存在本机诊断目录。第三次最终回执及原片哈希通过不能排除其后 GUI 崩溃，更不能用后台测试通过解释用户所见退出。

[FreeCAD #30720](https://github.com/FreeCAD/FreeCAD/issues/30720) 包含同一 Qt 6.8.3 析构指纹；[Qt 修复 b1ed5f6](https://github.com/qt/qtbase/commit/b1ed5f656f064e553b33752f8e87d2f5b9553e38)关联 QTBUG-134784，修复 macOS accessibility 缓存引用计数及合成行／列元素清理。对应 6.8.3 源码缺少该修复，6.9.1 源码已有；上游讨论也混有不同堆栈和后续问题，不能承诺任意升级消除所有崩溃。

**事实与推断分开**：前两次与本线程 CUA 操作高度贴合，第三次发生在本线程原生 GUI 探针完成后；“开发验收可能触发上游 Qt 辅助功能缺陷”是最强候选，不能说本线程操作无关。尚未在安全对照中独立重现并最小化具体失效对象，三份报告也没有提供 AX 请求来源的 voucher 信息，因此不称三次根因已完全确认或已修复。为保护用户现有工作，停止在用户实例进行 GUI／AX 验收，不修改其安装或全局辅助功能配置。

当前固定 CAD 后台链只创建新的 `freecadcmd` 进程；建模使用 offscreen 平台和独立配置／缓存／TMP，现有 `cad_gui_status` 只读 NSWorkspace／NSBundle，没有 AX、向应用发宏或终止应用 PID 的实现。这是源码审计结论，不是绝对排除间接影响：任意 Python 的实际内容、完全访问下的 OS 权限、macOS pipes 的 PGID 身份及共享 Cocoa 状态仍需分别审计。尤其不能用 PTY 的 SID／出生身份校验为 pipes 路径背书。本批增加真实后台 QPA／窗口状态断言，覆盖 provider 误进入 Cocoa 的回归边界；它不替代用户崩溃的因果复现。

### 9.17 当前文档原生探针的范围

在用户本次报告前，独立配置的 GUI 测试实例已完成 13 步、55 项断言和 898 条观察事件，验证当前文档参数化创建／改尺寸、GUI Modified 与 isTouched 区别、事务 ID、拒绝迟到撤销、自有栈顶 undo／redo、saveCopy 原件身份与字节保护、关闭重开后旧句柄拒绝。仅清理所存储引用对应的自有文档；无剩余文档。原生着色 PNG 已查看，PDF 由现有渲染器栅格化后查看，均有真实几何；该单页只证明 GUI PDF 导出，不扩大为完整比例／标注验收。

此探针不是生产 GUI 工具。官方 socket 没有业务 ACK；主线程宏回执需要包含请求及文档代际，仍须核验回执后存活。`closeActiveTransaction(False, id)` 才是正确签名，错 ID 可先清全局事务身份；`saveCopy` 不等于 `saveAs`，重开可以复用 Name／Uid，均已由原生行为记录确认。源宏与逐项回执留在本机明确的诊断目录，尚未作为稳定产品桥发布。

### 9.18 macOS 后台 pipes 的启动身份与停止边界

崩溃对账后继续审计后台停止路径，发现原 pipes 直接启动目标并按数值 PGID 收尾；PTY 的 SID／birth 证明并未覆盖它。真实最小回归先 RED：刻意延后范围签发时，目标已创建文件。此缺口与三次 Qt SIGSEGV 是分别成立的事实，不据此把进程清理定为崩溃根因。

现在 macOS pipes 先启动随包固定 native wrapper，由私有 fd3 报告 SID／出生时间；独立 inspector 只按这份 birth 复验活动 leader、PGID 与 SID，范围装入 owner 后重新检查 Task 准入和启动取消，再发送 R 及目标环境。wrapper 在完整校验前不执行目标、不应用其环境，也不 fork；wrapper 环境不继承用户的动态库注入变量。exec 保留原 argv、PID 与 OS sandbox launcher，fd3 设置 CLOEXEC，不混入标准输出、采集或 MCP 协议；exec errno 仍返回 spawn_failed。

无放行或身份失败时关闭私有通道并等待固定 wrapper 自行退出；已签发范围则按原 birth 停止并确认清空。该路径明确不退回数值 PID／PGID 猜杀；无法确认仍保留 stop_unconfirmed。握手有独立时限，不受长命令 timeoutMs:null 影响；背压写入与取消／EOF 竞争，避免 write callback 挂住使超时失效。启动结果与清理结果分开：ready／wait 保留启动错误，但 stop 在已保存 rangeEmpty:true 后返回清空事实，不把成功撤权误报为失败。

针对上述启动前执行、背压取消和清空误报分别取得 RED→GREEN；父端还覆盖坏身份／非 UTF8／超长协议、exec 失败、短命尾部及自有父子停止不影响独立会话。原生夹具验证缺失／截断／非法放行帧、原 birth、停止 leader 拒绝接纳、目标环境替换和 fd3 不继承。首轮广范围在 Codex 外层沙箱内触发 sandbox-exec 禁止嵌套／ps EPERM，另发现模型预览长度误截身份协议；私有身份读取已与预览长度分离，并在授权的真实 macOS 权限下复验，未关闭产品沙箱。

这一身份批次先接通 Task 撤权／关闭与已有 owner.stop 的启动取消；其后补齐的 Run signal 启动取消见 §9.19。不能把 RPC 发出时点当成 helper 已受理取消，更不承诺跨进程传递前任意时点均保证零执行。Linux 与 Windows 原有进程范围保持独立，不借本机 macOS 结果宣称跨平台实测。本轮未向现存用户或隔离 GUI 实例发送 AX／宏操作，也未修改 FreeCAD 安装和全局设置。

### 9.19 Run／Task 在启动等待阶段的取消

CAD 将既有 Run／Task 合并 signal 传入 `spawnStdio(request, { signal })`。该选项只控制启动等待，返回句柄后的取消继续由 CAD 的 drain／stop 消费；signal 不放入请求、IPC、指纹或持久事件。请求在接纳时复制，调用方随后修改原对象不改变派发与取消身份。

派发前可中止当前调用对目录、恢复准入或共享初始化的等待；共享准备继续供同 Task 其它调用使用，不因一个 Run 取消而停用整个 Task。派发后固定绑定原 helper 连接，按 Task／原代际／invocation／原参数指纹发送 `cancelspawn`。helper 在首次 await 前登记取消控制器及结果墓碑；不同参数、未知调用或代际不匹配均拒绝，不允许冲突请求的取消停止已有正确命令。同一 helper 生命周期内，同参数重放继承取消事实，换一个 signal 不会重启副作用；跨服务重启的 Run 恢复仍由原有持久 Task／Run 协议负责。

无 owner 时，空回执只在已永久禁止该调用后续派发后返回；已有 owner 则等待 stop 及最终 `rangeEmpty:true` 快照。父端收到匹配身份的停止回执后才结束为取消；未清空、错身份、失联或回执超时均保留 `stop_unconfirmed` 与恢复写域。超时只说明未知，不代表进程已退出；真实迟到退出仍由既有快照通道观察。停止回执的时限按既有 killGraceMs 覆盖冻结、TERM／CONT、再次冻结及 KILL 阶段，不新增文件或媒体存储限额。

取消快返使共享准备与 Task 关闭的交叠成为实际路径。安装版 SRT 0.0.78 的 `reset()` 不等待 `initializationPromise`，因此 helper 关闭先禁止新派发并停止已有 proof owner，再等待初始化与只读证明收束，最后 reset／清理临时目录。每个 probe 派发点和原生 R 前均检查关闭闸门，避免关闭后迟到重建状态。准备失败可以被关闭过程收束，真实停止未确认仍保留失败。

父端／消费者分别取得已取消请求仍被接纳、共享等待不能中断、取消身份随原对象漂移，以及 CAD 未转交 signal 的 RED；helper 取得精确取消身份、无 owner／已有 owner 收尾、关闭越过共享准备等 RED。新增真实 macOS 公共入口验证在 running 事件与 spawn 返回之间取消，原 PID 清空、重放不重启、新调用恢复；合成回执测试单独验证 ACK 丢失／错身份／未清空的父端屏障，不冒充 OS 证据。最终命令与结果见《日志》同批记录。本轮仍不对用户 FreeCAD GUI 进行 AX 或宏操作。

### 9.20 结构化 Body 布尔与原生 Common 语义

同一个 `cad_apply_operations` 新增 `create_boolean`，以 `body`、`toolBodies`、`operation:fuse/cut/common` 创建真实 `PartDesign::Boolean`，复核原生 `BaseFeature`／`Group`／模式及实际 Body.Tip，不用静态 Shape 替代参数链。契约和审批共用 schema，仍沿既有 Task／后台沙箱／新文件发布；首次契约三模式与原生工具整链均先取得未接线的 RED。原生入口来自固定版 [TestBoolean.py](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/PartDesignTests/TestBoolean.py)与 [FeatureBoolean.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureBoolean.cpp)。

工具 Body 已被另一个 Boolean 使用时，原生 `setObjects` 会将它从旧 GeoFeatureGroup 移走，旧 Boolean 的工具列表可被清空，而空工具执行分支不保证抛错或清掉旧 Shape。先用真实回归确认当前实现错误接受第二个 Boolean，再在 `setObjects` 前拒绝已归属 Boolean 的工具；不由此普遍禁止目标已有下游消费者。依据 [GeoFeatureGroupExtension.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/GeoFeatureGroupExtension.cpp)及上述 Boolean 实现，原生回归保留旧 Group／Tip／参数链及源字节。

四项原生测试覆盖：三模式保存重开及修改工具 Pad 后下游体积；已消费工具不能迁移；缺失／错误／空／多实体／曲面 Body、对象名碰撞、无效几何与空结果不发布；多工具 fuse／cut、无交集 cut、两层单工具 common；目标已有消费者可继续追加并联动，而下游反向成为工具的循环被拒绝。失败工程的源字节保持，原生重开核对每层 Group／BaseFeature／Tip／显示状态。该范围不代表复杂父容器坐标组合、全部拓扑异常或当前 GUI 布尔工具已验收。

重复验收另捕获循环请求被原生间歇接受：Shape valid／single，特征仅标 Touched，仍返回旧几何。因此不能依赖重算后的错误状态自行拒绝。调用原生布尔前读取工具 `OutListRecursive`，当它已依赖目标 Body 本身时明确拒绝；该接口递归构造真实链接与表达式依赖，见固定版 [DocumentObjectPyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentObjectPyImp.cpp)与 [DocumentObject.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentObject.cpp)。不因工具表达式只引用旧 TargetBox.Length 就禁止合法共同上游；原生正向已覆盖此表达式与既有消费者同时存在，反向请求重复三次并锁定明确循环拒绝原因。

多工具 Common 不能假设为顺序求交。固定版将首形状与工具组交给原生 Objects／Tools 布尔算法，见 [TopoShapeExpansion.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Part/App/TopoShapeExpansion.cpp)。本机自有三盒场景实际得到 `Compound`、Shape valid、两个实体、体积约800mm³，状态仍为 Up-to-date；这不满足本工具单实体交付规则。工具没有改写原生算法或放宽判据，明确拒绝该结果。用户若要依次相交，可用两个单工具 Common，实际体积800→600mm³，并保留两层参数引用。

夹具首轮误以为预置了标准库 os，另一轮误把原生多工具 Common 当逐次交集；分别补显式导入及一手取证后纠正夹具，未添加生产兼容别名或改变原生语义。临时几何输出由固定回归断言取代。运行命令、时间及最终全仓门禁由《日志》单独记账，不把诊断工程当 Common 产品成功。

### 9.21 结构化圆角／倒角接口核验与验收边界

本节核验官方 `1.1.4` 固定提交 `4fd3bf320d9566a27e60069fc8387448aaa3a094` 的接口，供下一步结构化封装使用；本节调研未启动 FreeCAD 或新增原生验收。已有 §9.14 的后台 Python 圆角／倒角四阶段证据继续有效，但不据此宣称新的结构化入口已经通过。

原生实体分别是 `PartDesign::Fillet` 与 `PartDesign::Chamfer`，均继承 `DressUp`；选中的基体和子元素存于 `Base`（`App::PropertyLinkSub`），Body 内的 `BaseFeature` 与 `Base` 对象由 `onChanged` 双向保持一致。圆角通过 `Radius` 控制；倒角模式及有效参数如下。属性有单位和编辑状态，不能把存在的属性一律当作当前模式的有效输入。[FeatureFillet.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureFillet.cpp)、[FeatureChamfer.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureChamfer.cpp)、[FeatureDressUp.h](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureDressUp.h)、[FeatureDressUp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureDressUp.cpp)

| 特征／原生模式 | 求解参数 | 原生执行检查 |
| --- | --- | --- |
| Fillet | `Radius`（Length） | `Radius > 0` |
| Chamfer `Equal distance`（0） | `Size`（Length） | `Size > 0`；`Size2`、`Angle` 只读 |
| Chamfer `Two distances`（1） | `Size`、`Size2`（Length），`FlipDirection` | 两个距离均大于 0；`Angle` 只读 |
| Chamfer `Distance and Angle`（2） | `Size`（Length）、`Angle`（角度），`FlipDirection` | `Size > 0`，`0 < Angle < 180`；`Size2` 只读 |

`UseAllEdges=true` 时，两种特征直接取基体全部边，忽略 `Base` 的子元素选择。安装版随附官方测试用立方体六个面创建特征，并分别验证全边模式可覆盖空子名乃至无效的 `Face50`，关掉全边模式后改选单面会改变结果。这只证明全边分支覆盖选择，不能解释为显式选择时允许无效边。首期结构化封装可先提供显式边的定半径圆角／等距倒角，其余原生模式、面选择和全边模式继续由 Python 承接；这是产品封装范围，不是 FreeCAD 能力限制。[TestFillet.py](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/PartDesignTests/TestFillet.py)、[TestChamfer.py](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/PartDesignTests/TestChamfer.py)

显式分支的实际 `getContinuousEdges(const TopoShape&)` 优先读取 `Base` shadow 的 `newName`，回落 `oldName`；边直接进入筛选，面／Wire 展开为边，形状去重。无法解析的链接抛 `Invalid edge link`；不是恰有两个相邻面或连续性不是 `C0` 的边会被跳过，最终空边集再由特征执行拒绝。因而不能仅校验 `EdgeN` 字符串格式或最终 Shape 非空，就声称每条请求边都已处理。结构化显式边应以当前基体拓扑核验选择，并明确处理被原生跳过的边；不要把静态 `EdgeN` 约定成跨任意几何修改的永久身份。[FeatureDressUp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureDressUp.cpp)

已有高级 Python 夹具按端点位置及长度，在当前 Box.Shape.Edges 中唯一定位原点竖边，再构造从 1 开始的 `EdgeN`；它不是预先猜测固定编号。创建后检查单实体、有效性、解析体积、被移除角与保留角，并在基体边长 10→12、Radius／Size 1→2 后重算、保存重开。新增结构化验收可复用这一几何判据，但必须通过真实 `cad_apply_operations` 消费方，不能把直接执行该夹具等同于结构化工具已经接通。夹具见 `apps/server/src/features/cad/fixtures/advanced-operations.py`，既有结果见 §9.14。

失败判断必须同时覆盖求解状态与几何：圆角／倒角源码均在参数、基体、选边、内核构造、空形状和实体规则检查通过后，才于尾部 `Shape.setValue`。此前失败可保留旧 Shape，所以旧形状仍 valid／single 不能证明本次请求成功。应沿用已有 runner 的整工程错误检查和发布屏障，并核对操作要求的参数、链接及新结果；超大半径／距离等内核拒绝不应发布最终 FCStd，也不能回退为静态 Shape 假装完成。[FeatureFillet.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureFillet.cpp)、[FeatureChamfer.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureChamfer.cpp)、[Feature.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/Feature.cpp)

创建与编辑须区分。`Body.addObject` 会把新实体特征设为 Tip；`insertObject`／`setBaseProperty` 还会重接相邻实体的 `BaseFeature`，而 Body 求解直接读取当前 Tip.Shape。修改已有早期圆角／倒角应原位改参数并重算，不重新 addObject、不无条件把 Tip 设回被编辑对象；应保留已有下游 Tip、依赖和显示状态，并检查下游重算。不能由这些重接行为推出“存在下游就一概禁止修改”；未支持的历史插入／换基体行为应与普通尺寸编辑明确区分。[Body.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/Body.cpp)、[FeatureDressUp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureDressUp.cpp)

公开 Python 未暴露 `getContinuousEdges`／实际接受边列表；仅靠最终 Shape 有效不能证明多选边都被处理。后续可先验证一个限于独立后台副本的候选：创建不加入 Body 的自有新鲜修饰 probe，同时设 BaseFeature 和 Base，利用零 Radius／Size 在原生选边之后、几何构造之前的参数检查区别被接纳与空边集。单设 Base 会因缺少容器失败；两种参数的属性下界是0且零值不被夹成正数。probe 仍会暂时改变文档 ActiveObject／Modified 和目标 InList，不能迁入用户 GUI 或宣称无状态变化；单边完整建模的成功／失败也不能代替多边组合可行性。

固定版可从公开 `probe.getStatusString()` 读取具体执行 Why，底层日志链没有翻译调用；`doc.getErrorDescription` 仅为C++内部接口。对应正参数错误源文是 `Fillet radius must be greater than zero`／`Size must be greater than zero`，重算后应立即读取，不能用 GUI 翻译文本比较。本节为实现前的候选记录；随后原生验证与运行时接线见 §9.23，出现其它状态不能当作接纳证明。依据 [DocumentObject.pyi](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentObject.pyi)、[状态包装](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentObjectPyImp.cpp)、[参数夹取](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyUnits.cpp)及上述 Feature 源码。

下一轮真实 Task 验收至少覆盖：两种结构化创建→保存重开→修改基体和特征尺寸→再次重开；显式多边、重复边、缺失／越界链接和会被跳过的边；零／负参数、过大参数、错误对象／Body 与名称碰撞；已有下游时原位改早期特征并保留末端 Tip；修改表达式绑定属性时沿用既有保护。每项核对参数链、当前选择、错误状态、单实体与可计算几何；失败保持源字节且不发布目标文件。此处是待执行矩阵，不能作为已通过测试的计数，也不扩大为全部倒角模式或复杂拓扑重命名验收。

### 9.22 当前边拓扑的按需读取

为结构化修饰操作提供真实选边前提，既有 `cad_describe_document` 新增可选 `edges:{objectName,offset,limit}`；沿同一 Task、执行审批、后台进程和只读来源文件接线，默认 describe 概要不变。显式查询才返回 typed `edgePage`，包含当前对象的 EdgeN、全局毫米坐标、曲线类型、线性度量、原生顶点、包围盒及闭合状态。输入与审批共用 schema，返回契约也同步扩展，避免服务端解析丢掉新字段。

`countElement("Edge")`／`getElement("EdgeN")` 可按原生编号仅包装当前页；原概要的实体／面／边数量也等价改用 countElement。默认50条、可显式放大正安全整数页数并沿 nextOffset 继续，超尾返回空页；不是固定总边数或工程容量额度。边详情只复用父容器变换，避免重复应用对象自身 Placement。EdgeN 对应当前文件重算后的对象，不是跨改模的永久身份。依据固定版 [TopoShapePyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Part/App/TopoShapePyImp.cpp)、[TopoShapeEdgePyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Part/App/TopoShapeEdgePyImp.cpp)及既有 global_shape 实证。

官方退化边属性 `Degenerated` 来自 BRep_Tool。其 Curve／Length getter 经曲线 adaptor，不能假定存在普通三维曲线；查询用原生 Mass 取线性度量，退化边的 curveType／bounds 返回 null。闭合圆的拓扑顶点集合可只有一个，保留真实唯一顶点，不能制造两个端点。首次真实 Sphere 查询已暴露 `optimalBoundingBox` 可在返回 BoundBox 之前抛 `Bnd_Box is void`；后置 isValid 不能兜住，改为退化分支根本不调用该方法，普通边保持严格原生路径，不吞未知几何异常。

契约正向1项先RED、非法输入1项GREEN；原生两项先在未接线参数层RED。接线后发现上述退化框错误，再最小修复。最终新原生两项7.26秒通过：嵌套App::Part旋转与对象自身旋转的全局顶点范围，4／6／8mm边长、闭合Circle、Sphere两条退化边、120边默认50及更大显式页、超尾空页、缺失／无Shape目标拒绝；源工程设为只读后字节保持，不返回新工程路径。既有参数化／容器／全局坐标／交换物理尺寸原生整链另12.59秒通过；层级证据不相加。

这不是 GUI 当前文档的边查询，也不提供两相邻面的C0判定：公开 edge.Continuity 只描述一维曲线，不能包装成“可圆角”的布尔值。其它工作台、全部曲线类型和复杂父容器组合仍按实际证据验收；圆角／倒角结构化创建和尺寸修改已在后续独立切片接入，见 §9.23。最终门禁见同批《日志》。

### 9.23 结构化修饰与原生命名适配

`cad_apply_operations` 已接入显式多边 `create_fillet`／`create_chamfer` 与无 profile 的 radius／size 修改；草图半径仍带 profile。实际类型分流，参数必须为 `App::PropertyQuantityConstraint` 且非 ReadOnly／Immutable／表达式绑定。创建只消费所属 Body 的当前 Tip，编辑只赋标量并保留当前末端 Tip、Base 对象及显隐；允许原生更新 TNP 子名，不重写 Base 或 BaseFeature。完整 Python 继续承接面／全边／其它倒角模式。

独立原生零参数 probe 已验证 §9.21 的候选：不加入 Body，同时设 BaseFeature 与 Base；每条锐边返回确切正参数错误，平滑边返回空选择错误。实际混选 `[锐边,平滑边]` 的原生 Fillet 会成功并忽略平滑边，证明有效 Shape 不是全选边完成证明。结构化入口逐条检查，多边组合仍须求解成功；finally 只删除本次持有的真实对象，不按名称前缀清理。probe 改变后台临时文档状态，不迁入 GUI，不宣称无副作用。

初始结构化回归在修改 Pad.Length 时稳定失败：`Invalid edge link`，旧 Shape 仍有效且保留旧体积。无 probe 的纯原生 Python 创建后，保存跨进程重开，仅改 Length 同样失败；单独 sketch.solve 正常，关闭工作副本 saveAs 也不能消除。公开 ElementMap 实测，Hasher／Tag／MapVersion 不变，原 `#f:2;…`／`#11:6;…` 重算后变 `#f;…`／`#11;…`；未改参数的基体 touch 重算也会改变此缓存映射。全新手写 Sketch＋Pad 同样复现，不能把失败归为新工具选边或草图求解。此证据定位到安装版哈希化命名与恢复后重算的不一致；未定位到 SDK 的唯一缺陷行，不扩大为其它版本通病。

官方 `Document.UseHasher=false` 只停止名称压缩，仍保留 ElementMap、完整 TNP 名称和自动 `updateElementReferences`。切换会对有 geometry 属性的对象 enforceRecompute；旧显式索引 hasher 仍可恢复，不能假称瞬间无损展开或修复旧坏链接。固定提交依据：[Document.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Document.cpp)、[GeoFeature.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/GeoFeature.cpp)、[TopoShapeExpansion.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Part/App/TopoShapeExpansion.cpp)、[StringHasher.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/StringHasher.cpp)。

后台结构化修饰操作采用这一官方完整名称形态，输出工程持久保留 `UseHasher=false`。转换前后所选同编号边必须具有等于双方完整长度的共同几何，且共同长度为正；容差随极小边收紧，不能把不相交小边当作一致。随后每条边原生预检、特征状态与单实体、参数／链接回读、整工程最终检查及原发布屏障全部保留。任何选边几何变化或依赖失效均拒绝发布；不手工修补坏链接，不触碰只读源文件或用户 GUI。

七项原生正向回归已通过：两种特征的两条相对竖边、Pad.Length10→12与Radius／Size1→2、解析体积、保存重开；同批创建草图／Pad／修饰再跨进程改长度；已有默认 True 原生工程改修饰尺寸再改上游长度；早期 Fillet／Chamfer 的反向后继修饰，保持末端 Tip、各层 Base 对象及显隐。另保留零参数选边与原生混选对照。失败边界及最终门禁按同批《日志》实际结果登记，不把本例推广为任意复杂拓扑、全部模式或 GUI 修饰验收。

### 9.24 结构化阵列、全部实例与参数联动

`cad_apply_operations` 已接入 `create_linear_pattern`／`create_polar_pattern`，以及非空参数子集 `set_pattern_parameters`。首批为 Features／Extent、单原件、线性单方向，原件可选当前支撑历史中的 exact Pad／Pocket／Revolution；当前 Tip 才是 BaseFeature，原件不必是 Tip。真实 `Originals`、草图轴引用、参数、实体数、体积与 AllowCompound 进入回执。固定版没有 `OriginalSubFeatures`；模式／字段不能照后续版本或营销示例猜测。依据 [FeatureTransformed.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureTransformed.cpp)、[FeatureLinearPattern.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureLinearPattern.cpp)、[FeaturePolarPattern.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeaturePolarPattern.cpp)。

线性 Length 是首末总距离，N>1 时步距 Length/(N-1)；Occurrences 包含原件，原生允许1，N=1 没有额外工具副本。环形接近360°时使用 Angle/N，其它角度使用 Angle/(N-1)，精确遵循原生 abs(Angle-360)<1e-7 判据，不能默认 math.isclose。H／V／N 方向及中心来自真实 Sketch Placement，经 pattern.Placement 逆变换进入支撑局部坐标；不额外乘 Body 世界变换。真实可回读直接角度输入为正向(0,360]，反向由 Reversed 表达。

公开 `AddSubShape` 为 Part::PropertyPartShape；增减材类型及 getTransformations／rejected 未暴露到固定版 Python。按官方构造函数确定 Pad／Revolution 为增材、Pocket 为减材，不从实际结果反推。支撑 Shape 只清顶层 Placement；工具按 original.Placement × inverse(base.Shape.Placement) 变换，再构建所有 j=1…N-1 实例。完整期望为支撑对全部工具的 fuse/cut，实际结果清顶层 Placement 后比较。双方均须有效且有实体，实体数量一致，双方差集均不得残留 Solid；布尔异常不吞掉，不按整体体积百分比放过小副本。Body.Shape 另与末端 Tip 在统一世界坐标比较。依据 [FeatureAddSub.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/FeatureAddSub.cpp)、上述变换源码及 [PartFeature.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Part/App/PartFeature.cpp)。

`Body.AllowCompound` 必须按实际工程读取。安装版默认 True 的原生对照保留四个断开实体、约2000mm³；显式 False 后，同样请求仍可返回 Valid／Up-to-date，却只保留第一个实体、约500mm³。该截断分支已真实复现，但不能称为默认行为。新工具不切换此设置：允许多实体时交付全部零件及 STEP；要求单实体时，完整期望为多实体即拒绝发布。减材副本位于支撑外可不改变材料，沿用完整布尔语义，不要求每个实例都改变体积。单实体分支依据 [Feature.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/PartDesign/App/Feature.cpp)。

首次只改次数的真实回归揭示：Length=Occurrences*5mm／Angle=Occurrences*90deg 合法联动，却被旧参数全量冻结误拒。修复仅核对请求字段，并保留原 ExpressionEngine 绑定文本与顺序；未指定字段按原生表达式联动，直接修改绑定目标仍拒绝。只批赋允许参数后统一重算，保留 BaseFeature 历史、Originals、轴引用、Group、后继 Tip、显隐、Refine 和 AllowCompound；已删除的实例导致后继 Fillet 失效时拒绝发布，不重绑边号。

另一真实边界是 PropertyAngle 的写入路径。[PropertyUnits.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyUnits.cpp) 的默认 AngleStandard 为[-360,360]，Python setPyObject 夹值，实测直接赋720得到360；因此结构化直接输入限制(0,360]。表达式 setPathValue 直接赋数值，实测只改 Occurrences 到8可使已有 Angle=Occurrences*90deg 得到720且绑定保留，完整几何验证通过。不能把直接赋值范围扩大成全局表达式范围；Offset 同为 PropertyAngle，亦不能声称直接赋720原样保留，多圈 Spacing 另可累计或使用间隔列表，仍由完整 Python 承接。

原生抑制也不能按普通空几何处理：合法 Suppressed Pad 被清空 Shape，原通用 runner 因此拒绝有效 Extra 工程。实测 RED 后，空形状豁免只识别原生 PartDesign::Feature 继承链、真正 App::PropertyBool 的 Suppressed=True；Error／Invalid 状态仍优先拒绝，非空坏几何、普通空特征、requireSolids 保留。Part::Feature 自添同名属性与未抑制空 PartDesign 特征均实测拒绝。合法抑制工程可保存／描述，阵列另拒绝抑制原件，避免原生 getOriginals 静默过滤。

本批原生矩阵35项已逐项完成：线性／环形的增材、Pocket 减材、Revolution 原件与上游改角；全部草图主轴、反向、Count1、首末范围／次数批改、表达式联动及多圈路径；默认多实体及全部 STEP 零件、False 单实体截断拒绝；较早原件与后加特征、非单位 Body／Sketch Placement 和 STEP 世界尺寸；后继 Fillet 的引用／Tip／显隐保留及减少数量删除引用拒绝；跨 Body／错类型／碰撞、ReadOnly／Immutable、表达式目标、Spacing／二维阵列模式拒绝，以及合法抑制和伪造空几何边界。源字节与失败目标不存在分别检查。测试复用同一真实服务／Task 作用域与工具消费方，未操作用户 GUI；不是全部工作台、全部阵列模式、任意复杂 TNP 或真实 LLM 自主建模验收。范围／原生／全包证据有重叠，最终门禁及拆分运行记录见同批《日志》。

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


### 9.25 FEM 真实网格、求解与完整节点场

既有 `cad_run_python`／真实 Task 链路完成 FreeCAD 1.1.4 的轴向线弹性静力代表流程。100×10×10 mm、E=210000 MPa、ν=0，x=0面固定，x=L面1 MPa均匀压力。实际 Gmsh 4.15.0 新建198节点／493体单元，实际 CalculiX 2.23 新建 FRD；INP 的固定节点／三平动、DLOAD 面压力及 ELASTIC 参数分别核对。读取完整位移、六应力分量和 von Mises 数组，节点按结果自身 compact 网格映射，检查长度、完整覆盖及有限值。全场对照 ux=-px/E、σxx=-p、vm=p 的严格1%阈值，基线 ux 最大归一化误差约1.4e-6，自由端均值约-0.00047619 mm；未为失败放宽门槛。

真实 FEM 网格的 `Shape` 是 `App::PropertyLink`，旧 runner 以同名属性调用 `isNull()` 报错，原生 RED 后改为只识别 `Part::PropertyPartShape`。describe、几何校验和显式／默认交换选择统一消费该判断；volume guard 另取得链接对象 `.Volume` 属性错误的原生 RED，改为同样明确拒绝非几何对象。结果工程保存、独立描述及独立 Python 重开保持几何链接与完整结果数组；默认STEP只导真实Box并回读体积，显式把Mesh链接当交换对象拒绝。没有吞异常或把链接对象当重复实体。

尺寸／压力／方向按100 mm／1 MPa向内→200 mm／2 MPa反向→原参数折返，复用模型对象引用、删除旧结果、每轮新网格新INP新FRD并重复全部解析检查；每轮独立runId／路径，源FCStd字节保持。失败从有结果的源工程重新执行，移除Analysis材料、清空压力References、真实CCX后删除本次FRD均拒绝，不发布目标。取消测试由真实Gmsh解析器写就绪标记后等待，先证实FreeCAD／Gmsh两个PID存活，再取消Task，确认cancelled、两个PID均ESRCH及目标不存在；等待不是网格成功证据。

脚本使用官方分阶段Gmsh输入／网格装载和CalculiX INP／FRD接口配显式subprocess，避开便捷方法重设工作目录；本次输入、日志、网格及结果均在Task私有新目录，每个外部程序超时9秒、线程1。实际二进制从App.getHomePath()/bin定位，App.getResourceDir()在本机为Resources/share；报告记录候选与命中，不改用户全局偏好、不安装依赖、不使用示例的预制网格回退。

这是后台Python代表验收及一处真实属性类型兼容修复，不是新增结构化FEM工具。通用几何检查不能证明物理分析正确，领域判据由Agent脚本核验。该ν=0单轴样件未做独立网格收敛研究，也不覆盖其它材料、物理场、非线性、接触或其它求解器。Assembly代表流程续见§9.26；CAM代表流程续见§9.27；BIM仍待验，未操作用户现存GUI或扩大Qt崩溃调查。最终命令与层级证据见同批《日志》，不相加。


### 9.26 内置 Assembly Fixed 的真实求解与完整 Provider

既有后台 Python／Task 工具完成同文档两件参数 Box 的原生 `Assembly::AssemblyObject`、`Assembly::JointGroup`、Grounded＋Fixed。每轮先故意错位移动件，再直接设置官方连接器 Reference、调用 `updateJCSPlacements`；确认更新后仍错位才显式 `solve()`，求解返回0且连接器全局位置／三基轴残差均小于1e-6，固定件原 Placement 保持。没有用 `setJointConnectors` 的自动 preSolve 冒充显式求解，也不依赖 GUI 选择集、活动装配或 mock solver。

固定件初始为(12,-4,3)mm＋绕Z15°；移动件求解前为(-30,45,16)mm＋绕(1,1,0)37°。两件初始20×12×8／7×5×4mm，改至26×12×11／9×6×6mm；独立保存重开再改35×12×14／13×8×7，下一独立重开折返20×12×8／7×5×4。连接器顶点按实际零件几何唯一识别，不猜固定FaceN；顶点局部identity Rotation按官方findPlacement核验。每轮检查参数体积、真实App／ViewProvider代理、归属和引用、固定基准与连接状态；源FCStd字节保持。

初版只创建App关节代理，首次求解正常，但保存重开后ViewObject.Proxy是整数，`redrawJointPlacements`报属性错误。按随包`CommandCreateJoint.py`和`JointObject.py`的真实创建路径建立`ViewProviderJoint`与`ViewProviderGroundedJoint`后，离屏宿主可正常序列化／恢复；没有设None、mock GUI、静默修复旧文件或给Harness加兼容开关。这是领域脚本必须完成的官方对象创建，不是通用宿主替每个工作台猜Provider。

另一个原生RED否定了“删Grounded必返回-6”的验收假设。[固定源码AssemblyObject.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Assembly/App/AssemblyObject.cpp#L707)的getGroundedParts包含原生Origin；removeUnconnectedJoints会把不与任何固定对象连接的关节从本次求解vector过滤，而不删除文档关节。两零件均未连接Origin时，原生可跳过其约束并返回0，不会自动固定首个Box。必须继续核对`isPartGrounded`／`isPartConnected`与实际连接器残差，不能把返回码0或旧有效Shape单独当成功。

这是一条Fixed代表流程，不是全部关节、运动、BOM、外部零件文件或当前GUI装配验收。通用CAD几何检查不能证明约束满足，脚本负责领域判据；其它工作台按独立流程推进，未操作用户现存GUI或扩大Qt崩溃调查。最终原生命令、失败不发布与STEP回读及门禁见同批《日志》。


### 9.27 CAM Job、真实后处理与 NC 运动语义

既有后台Python／Task链完成原生Job、跟随模型的stock、6mm端铣刀ToolBit／Controller与Outside／CW／Round软件刀径补偿Profile。40×20×5mm板件先改长50，独立保存重开50→70，再独立重开70→40；每阶段新factory／UUID文件，六份NC分别核对实际字节、返回文本和独立Node哈希，最后复核旧NC哈希不变。stock为XY每边3mm余量、Z0～5；唯一源模型、clone、stock、operation、controller和tool引用、原生App／ViewProvider以及真实几何均保留，输入FCStd字节逐轮保持。

实际使用随包linuxcnc Factory→WrapperPost的完整Job导出，不把Profile.toGCode()当后处理。export返回`[('allitems', text)]`，`'-'`不会自动写NC，脚本在本次Task目录独占写入。实际script_path／module.__file__／export.co_filename与应用随包文件规范路径一致，来源SHA-256独立核对；每阶段新实例，未改用户搜索路径或偏好。参数显式`--no-show-editor --precision 6 --preamble "G17 G54 G40 G49 G80 G90 G94 G91.1"`，后处理另发G21；不触发GUI编辑器或文件选择框。

NC独立读取后按本例绝对XYZ、XY增量I/J与mm/min解析，逐段核对内部Path的G0／G1／G2／G3端点、圆心和进给；内部F为mm/s，NC为mm/min，换算×60。每层闭合、到成品矩形的刀心距离3mm、圆弧半径3mm、CW总转角2π及圆角矩形解析面积分别检查，不能只比包围盒。校验5层、下刀步距、安全高度8／净空10、水平300／垂直120mm/min、刀1/M6/G43H1与12000rpm的M3→M5/M2时序。模态在相关运动前生效，不能把末尾补写单位／坐标声明当作有效；窄审反例已先取得RED再修正验收器，并覆盖坐标系切换。

两项原生行为纠正了初始断言：[固定Area.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/CAM/App/Area.cpp#L1748)会把触底显式截面改成zMin+SectionTolerance，Area.py设置该值为Precision.confusion()*10。本例请求FinalDepth0，实际末层1e-6mm，前四层4/3/2/1不变；记录并精确检查这个原生偏移，未笼统放宽所有深度，也未误归因于后处理舍入。Profile在圆角中点开始，会把同一角分成两段G2；按闭合几何／总转角验收，不要求固定4段。

真实失败边界：不存在的后处理工厂返回None，脚本明确拒绝；清空Job操作后，真实linuxcnc仍可返回非空首尾／WCS文本，原生Path回读没有实际切削运动，脚本拒绝。两者均源FCStd字节保持、显式目标不存在，未用mock或手写NC替代失败。通用CAD几何校验不证明刀路可制造，领域判据由脚本与本例独立oracle核验；这些证据不覆盖其它CAM策略、控制器、仿真、真实机床执行或用户现存GUI。最终命令、门禁与重叠统计见同批《日志》。


### 9.28 投影外轮廓与二维交换数值精度

旋转后的1250×600mm Draft矩形暴露生产缺陷：旧`TechDraw.projectToSVG`／`projectToDXF`使用默认约六位有效数，回读边长偏差约0.003mm、面积约750002.17689mm²；原FCStd参数和几何正确。不是修改尺寸参数或放宽验收解决。固定源码确认SVG内部局部stringstream未提供Python精度参数，`tolerance`控制曲线网格，不能当作数字有效位数。[SVG序列化源码](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/TechDraw/App/TechDrawExport.cpp#L156)

KFW保留官方投影，仅对已投影原生边做17位有效数的SVG编码：直线、圆／旋转椭圆及裁剪弧、非有理一至三阶Bezier保持解析表达；B-spline先原生裁剪并精确拆Bezier，高阶／有理片段及无Python包装的OtherCurve在可确认C2时使用原生`GCPnts_UniformDeflection`，当前请求容差`Precision.confusion()*10`，即1e-6mm。折线使用标准polyline，回执分别记录数字精度、近似容差、曲线类型和段数；不能把近似曲线说成解析曲线。退化边或无法确认连续度时明确失败，不改安装的FreeCAD、不补猜舍入后的坐标。原生FCStd保留原始可编辑曲线。

球体／圆环还暴露旧`project()[:2]`取范围的缺陷：`project()`只返回V/V1/H/H1，没有VO外轮廓。改用`projectEx()`的VO与V（索引3、0），与官方默认Plain SVG相同；bounds、SVG和DXF共用选择，不混入hidden/seam/iso。DXF改走官方`Import.writeDXFShape(...,14,False,Task专用参数组)`完整R14 writer，实体数字固定九位小数、毫米单位；显式隔离writer配置，不再手包低精度片段。[Python绑定](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/TechDraw/App/AppTechDrawPy.cpp#L1086)、[默认可见线组合](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/TechDraw/App/ProjectionAlgos.cpp#L147)、[DXF实体数字精度](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Mod/Import/App/dxf/dxf.cpp#L124)

独立回读矩阵从数学定义重建14种源几何，包括大坐标短线、旋转矩形、圆／圆弧、旋转椭圆／弧、二／三阶Bezier、普通／有理／五阶B-spline及球／柱／圆环。正式`importSVG.insert`导入后核对闭合性、包围盒、逐边长度和双向各129个样点的原生距离；三种实体另走正式PNG预览。样点不是穷尽Hausdorff证明，投影预览不是工程图标注或着色渲染。长度使用`math.fsum(Edge.Length)`，避免聚合Shape固定阶积分与Edge容差积分的差异导致假红；对数千折线边用保守包围盒下界剔除，再逐候选原生distToShape，未放宽原几何／弧长门槛。初版通用path的SVG导入超时，改为同点polyline后约0.22秒；另一次超时来自独立距离oracle，未因此提高生产时限。本批旋转矩形回读覆盖原尺寸精度问题。最终命令与门禁见同批《日志》，不把这些证据扩大为所有CAD曲线、视图、交换格式或用户现存GUI均已通过。


### 9.29 Draft 参数面与独立二维交换闭环

既有Task／后台Python链使用正式Draft.make_wire及原生Wire／ViewProviderWire完成闭合矩形面。显式(125,-75,0)mm＋Z30°位置，工厂世界点输入／局部Points、真实局部／全局四点四边分别核对；1000×500→1250×600→1500×750→1000×500三轮改宽高及独立FCStd重开保留同一对象身份、Closed/MakeFace、平面、零实体与解析面积／周长，不通过直接设置Shape伪造参数对象。

六份新SVG／DXF正式独立读回mm尺度、全局位置、四边闭合轮廓、长度及围面积；DXF核心Import.readDXF使用Task私有配置，SVG使用importSVG.insert，保留真实导入对象。测量Face不加入文档、不冒称文件自带面；原工程与全部旧交换文件字节／SHA-256保持。二维面要求实体、真实自交面均拒绝且目标不存在，源工程字节保持。原生2项17.23s通过，命令及门禁见同批《日志》；精度修复见§9.28。

这不是新增结构化Draft工具，也不是Sketcher全约束、全部Draft对象或交互绘制验收；Agent通过既有cad_run_python到达官方能力，2D指导与PartDesign的Body.Tip要求分清。BIM／IFC、GUI原位保存与有限进阶真实Agent收尾继续，未操作用户现存GUI或扩大Qt崩溃调查。


### 9.30 Arch/BIM 参数工程与 IFC4 独立互操作

正式Draft基线、Arch Wall／Structure／Floor建立直墙、矩形柱和真实楼层，App／ViewProvider、Base／Group与IfcType均核验。墙长／高／柱高4000/3000/3000→5000/3500/3200→3000/2500/2800→4000/3000/3000三轮独立FCStd保存重开，修改前先验证旧工程，再由原Points/Height参数重算；墙Center对齐与柱中心位置、完整实体双向差集、面积／体积／bounds匹配独立解析长方体，源字节保持。

六阶段各新IFC4，以显式本地preferences导出米制arch模型与默认Site／Building；STORE_UID=True仅更新Task工作副本，源工程不改，墙／柱／楼层GUID跨导出和重开保持。独立进程的空doc使用随包IfcOpenShell0.8.4 SERIALIZED世界BRep，米→毫米×1000，逐叶真实几何回读及双向差集、单位／schema／唯一类别／GUID／空间包含与Storey→Building→Site→Project链都通过；不依赖原FCStd重建或FreeCAD IFC导入器。FCStd及旧IFC的字节／哈希最终保持。零长度、该柱模板不接纳的300mm高度、缺墙IFC均拒绝且目标不存在。

原生2项44.02s通过，最终门禁见同批《日志》。初版把LinkSubList的空Tool误判为None、后来容差元数据精确比较误判浮点末位，两者均为夹具修正，不修改产品限制或放宽几何门槛。细节、接口与证据边界见专业核验§6.2／§6.3；不扩大成复杂BIM、其它IFC schema、Native-IFC编辑或当前GUI全面验收。GUI原位保存与有限真实Agent收尾继续，未扩大FreeCAD崩溃调查。


### 9.31 当前 GUI 原位保存、停止与文件恢复边界

新增共享按需cad_gui_save_document，复用唯一持久Controller／认领及Task权限、独立审批；已有FCStd路径与当前快照冻结到请求。App.save单次写入，不调用Gui.save/Std_Save、不另存／重算／撤销／清脏。实际备份候选目录也须在已授权父目录内，不猜不存在的backupDir偏好。Native返回／抛出后的writeFinished与业务saved/partial分别核验，实际ZIP／CRC／文件身份／SHA-256和准确ACK路径另验；异常、未知不自动重试或补偿。

原有操作store增加只读可信枚举，CAD以真实Provider接入文件恢复与撤销参与者，冻结写域跨回调／服务重启保留；扫描前先装恢复屏障，unknown不能被allSettled、取消marker或Run／插件关闭吞掉。没有新ctx key、另一个Task宿主或第二写域缓存。声明的写域只覆盖固定保存的标准文件／备份，外部GUI及第三方provider不继承Task OS沙箱。

自有GUI真实Task整链104.27s通过：41×82×7mm原位文件与独立后台体积23534、完整原生身份／历史／GUI脏标保持，冷同编号重放不再次保存；另一次Native持有时取消，Node回调结束后冷Provider仍拒跨Task相交恢复与本Task停止，可信partial/writeFinished到达后才放行。计数严格两次、新参数保留、实例正常清理，未操作用户现存文档或扩大崩溃调查。准确条件、原生命令及限制见桥接核验§16.6／§16.7，有限真实Agent收尾见§9.32。


### 9.32 首期交付对账与有限 GLM 进阶验收

本轮已确认的FreeCAD首期范围已交付：共用官方插件／Task与目录权限、后台结构化操作及完整Python、真实工程与交换文件／线框预览、当前文档固定查询／属性写入／副本／自身撤销／原位保存，以及取消、幂等与文件恢复边界。基础Code三维和Design二维的真实官方GLM整轮证据仍见§9.9／§9.7；进阶零件、Assembly／CAM／FEM／Draft／BIM仅按前文逐项实测范围记账，不扩大成全部工作台、任意provider或工程认证。AutoCAD／Blender仍只有官方接口研究，未安装和本机验收。

新增一次有限BIM自主交付场景，仅复用一个新隔离Code Project `98fbcb21-7fda-454e-b797-f7fff1492fa8` 和Task `00a1adfa-22cf-4fef-bbc5-ee967955f718`，现有官方GLM `glm-5.3-flash`／max；未改供应商、Key、默认模型、审批设置或提交IGM／VGM。首Run `8ef9494a-90cd-4c47-bfe4-a937c8b724f4` 模型流180秒无输出终止；preserve重跑原输入的中间Run `a48f71f8-30dd-4471-944a-2aa5a8166ed4` 在请求模型前因缺能力快照被拒，暴露并促成独立修复 `cfe90a7b`，真实PG／本地受控模型10项通过，细节见同批《日志》。准备脚本另曾把创建响应的camelCase误写为数据库字段，在创建Task／发送前停止；修正后核对项目及会话为空，复用原项目，未重复创建。

修复后同Task用原文再次接纳，Run `26e799d9-9514-4b65-8e0d-39e57dbf35ec` 仍因模型流180秒无输出终止，未进入任何CAD工具。最终零活动、零待审批，隔离目录为空，没有professional.FCStd／professional.ifc，独立产物oracle因无输入未执行；**本次进阶GLM验收未通过，不能算作BIM自主交付证据**。两次模型流尝试没有证明是供应商、网络还是协议原因；未用未认证健康连接冒充推理通过，也未延长超时、切换模型或无限重试。原生BIM与IFC4的独立几何证据见§9.30，不与本次失败混算。

本机私有证据保留在`/private/tmp/kfw-cad-research/probe-20261019/`：bim-agent-acceptance.json、bim-agent-full-snapshot.json及单Run／独立核验脚本；本机凭据仅在请求内存使用，未写入这些证据或提交仓库。交付提交包括`3e57cb7a`（BIM／IFC）、`25c7ff72`（原位保存）和`cfe90a7b`（历史重跑）；最终代码门禁为workspace38项、串行全包19任务、typecheck26任务及lint零错误，默认skip／既有warning另计。用户现存GUI／AX未被操作，main／future未动；本次外部模型流失败保留在验收矩阵，不阻止已完成CAD适配的交付。
