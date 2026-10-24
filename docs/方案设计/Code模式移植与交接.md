# Code 模式 ZCode 移植与交接

> 角色：**方案稿 + 执行手册 + 施工回执 + 临时交接**（四合一，按「为什么这么做 → 怎么施工 → 已做了什么 → 现在接到哪」的顺序成章）。
> 当前已移植源码基线：ZCode 3.14.3 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；逐文件来源、校验和与宿主适配记录由 [`packages/third-party/zcode/来源清单.json`](../../packages/third-party/zcode/来源清单.json) 单处持有。3.16.2 的升级分析与计划见下一章；计划不代表运行代码已升级。
> Code 的工作域、工具与权限契约见 [《Code工作域与工具内核实施规格》](./Code工作域与工具内核实施规格.md)；服务 key 与扩展点仍由 [《改造计划》](./改造计划.md) 持有；落轮次与回执记 [《日志》](../日志.md)。
> 当前口径：下方 3.14.3 施工与交接正文按当时检查点保留，其中「实施中」「active」「待验」、独立 Design 壳及旧身份/凭据描述不作为当前状态。Code/Design 的共享会话、持久 Task、内容标签及 2026-10-16 本轮完成状态，以《Code工作域与工具内核实施规格》「Code/Design 统一实施」和《日志》「Code/Design 统一工作台本轮最终验收（2026-10-16）」为准；本篇历史回执不覆盖现行产品不变量。

## ZCode 3.16.2 界面升级分析与计划（2026-10-22）

> **角色：升级实施规格。** 2026-10-22 用户确认开始全部批次，优先直接移植新版原组件、功能及装配，在宿主边界连接 KFW 现有服务。项目编辑、多目录、Task 跨项目移动、Plugin UI／Gen UI 均纳入实施和独立验收。当前已移植基线仍为 3.14.3；下文按实际批次更新，不把计划或校验器更新计为 UI 升级完成。

### 1. 比较依据与完成条件

比较使用三个固定对象：原移植基线 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（3.14.3）、KFW `da07da8a`、上游 `3c5b227649371507ddc4eb46ac5133afe6db1cab`（3.16.2）。新版位于用户提供的 `/Users/shigaoyu/Develop/ReferenceRepo/ZCode`。3.15.1 的 `aac4755666d09fdcd70272fcf063c077a639015f` 用于识别此前已经出现的变化，不作为 KFW 已完成升级的证据。

判断单位为真实功能及其调用路径。新版新增文件、字节不同、旧文件被删除，都不能单独证明 KFW 缺少功能。每一批记录原始源码、当前适配、新版原件、实际消费方、验证结果与需要删除的旧引用。原始源码哈希和适配后哈希分别维护；不以更新清单掩盖不明变化。

升级完成需要同时满足：

- 使用新版原组件和实际装配，项目编辑、输入框、内容标签、消息展示、插件管理均连接真实服务。
- 项目、模型、插件安装、工具发现、Task、权限、运行与媒体仍由现有 KFW 服务管理；没有第二份业务存储或 Agent 执行循环。
- 既有 Canvas、Flow、OpenDesign、浏览器、子会话、审批、Goal 和恢复操作通过相应回归；同一操作只有一个有效入口和消费者。
- 新来源可独立核对，每批 HEAD 可以构建；最终通过串行包测试、类型、lint、构建、实际本机交互和已改变接口的真实服务验收。

### 2. 差异与复用清单

| 功能 | 上游 3.16.2 的实际变化 | KFW 当前实现与升级处理 |
| --- | --- | --- |
| 项目与目录 | `WorkspaceSidebar` 转为 `ProjectSidebar`；独立 Project ID、多目录编辑和按项目导航 | 已有服务端 Project、主目录、附加读写目录及 Task。采用原 `ProjectEditor`／`ProjectSidebar`，由适配器连接这些服务，替换旧目录入口。[U1][K1] |
| 项目名称 | 编辑名称并持久保存，保持项目 ID | 已有项目名称 PATCH，当前项目菜单没有编辑操作；连接原输入框，保持物理目录与 Task 归属。[U1][K1] |
| 历史归档 | 设置页增加按项目分组、默认收起、搜索及批量操作 | 已有归档、置顶和任务操作；升级组织方式和列表，不建立第二套归档数据。[U2][K1] |
| 会话分组服务 | 原分组方法改为独立 `ITaskGroupService`，项目目录 Provider 统一消费 | 已有任务列表和界面分组组织，但新版独立服务与完整持久化尚未接通。复用现有 Task 身份和设置；补齐分组保存、移动、移出及通知，不能用项目归属代替手动分组。[U15] |
| 模型与思考 | `ComposerModelMenu` 将模型、连接与思考滑杆整合到同一弹层 | 已有模型选择、思考档位、供应商实例及发送配置固定。更新原菜单，消费当前候选；审批模型保持独立，不导入套餐连接服务。[U3][K2] |
| 权限与 Plan | 独立菜单继续存在，新增 Guarded 展示，隐藏 Edit 选择但能显示历史 Edit | KFW 原盾牌菜单提供三种基础权限与独立 Plan；模型审批单独设置，普通聊天与任务共用 Agent。已实施规则见《Code工作域与工具内核实施规格》§2.7。[U4][K2] |
| 文件面板 | 新 `FileManagerPane` 将目录树与文件预览放到独立、多标签内容面板 | 已有文件、Canvas、浏览器、OpenDesign 标签。采用新版文件面板并保留当前内容宿主；每个文件目标携带真实项目或 Task 身份。[U5][K3] |
| 图片预览 | 文件图片增加复制、下载、添加到聊天；Markdown 图片另有自己的预览入口 | 已有附件预览、媒体消息和画布／OpenDesign 送入素材。更新原图片操作，统一进入现有可信附件处理，保留上传完成和新草稿保护。[U6][K3] |
| 分享弹层与资源预览 | 原分享改为顶栏弹层，新增预检、进度、工作流和资源展示 | KFW 已有组件和代理，但服务端没有会话分享处理方，按当前派发逻辑会返回 501；本轮未发送实际 HTTP 请求。分享组件可以复用；公开发布入口需按真实能力隐藏。上游 OAuth 公网发布服务属于独立功能，不随 UI 更新引入。OpenDesign 静态发布是另一项已有能力。[U7][K7] |
| 插件商店 | 同页管理、按服务实例隔离状态、侧面板商店及安装后打开插件界面 | 已有官方 bundle、本机包、来源安装、启停、卸载和独立管理文档。更新原商店，继续使用同一注册表；市场源和通用配置的现有缺口单独处理。[U8][K4] |
| Plugin UI | MCP Apps 工具卡片、侧面板、后台页面、上下文及后续消息 | 现有静态插件面板只覆盖部分承载能力。补齐 bridge、资源、沙箱通信、会话作用域和生命周期后再接原卡片，完整范围见第 4 节。[U9][K4] |
| Gen UI | 完成消息中的 visualize 指令显示交互页面，支持状态、主题与后续消息 | 补齐原 `IGenUiService` 对应的页面、状态、文件与上下文消费者；复用 Task 文件权限、消息服务和沙箱宿主，不增加另一套聊天或生成循环。[U10][K3] |
| 工具搜索 | 新增 auto／local／off 设置和上游延迟工具机制，默认 off | KFW 已有真实 `ToolSearch`、延迟 schema 激活和执行权限检查。继续使用现有实现；不能用新版默认 off 静默关闭当前能力，也不能展示无执行支持的 native 选择。[U11][K5] |
| Computer Use | 开源版没有完整执行提供方 | KFW 保留现有原界面、宿主权限检测及 `plugins/computer-use` 混合实现。开关从真实库存取得安装 ID，启停与输入入口消费同一记录；安装启用与 macOS 系统授权分别显示、分别验证。 |
| 消息与工具展示 | 长命令展开、MCP 进度、独立 `ToolPresentation`、Plugin UI／Gen UI 展示 | 复用当前完整输出、真实 diff、媒体 renderer 和父子会话。只有真实进度事件才显示进度；新 renderer 不替换既有贡献入口。[U9][U10][K3] |
| 内容完整视图 | 新内容面板完整视图及浮动输入区 | 采用原布局控制和同一 SessionPane 的浮动承载，Canvas 保持挂载，Flow 主区保持原样。未保存宽度时 Code 会话区域默认 52%、Design 约 33%；用户保存宽度优先。[U12][K3] |
| 远程设备、手机登录、团队套餐 | 新页面依赖官方账户、远程 Host、relay 和套餐服务 | 按现行本机产品范围保持能力显隐，不随 UI 更新接入另一套账户、计费或远程执行服务。[U13][K6] |
| Windows 未读提醒 | renderer 加 Electron 原生 overlay／托盘逻辑 | 界面状态可更新，原生提醒需要 Tauri 对应实现与 Windows 验证；不能宣称更新 React 文件即可完成。[U14] |

源码中存在但本次未发现实际挂载的 `TaskSearchDialog`、`TodoPanel`、`MessageChangeSummaryPanel`、`ChatModeSwitchControl`，不自动加入产品入口。现有搜索仍有 `CommandCenterDialog` 消费，不因文件名称相似再建立一个搜索弹窗。

### 3. 项目编辑与多目录的具体适配

新版原 UI → KFW `projectService` 适配 → 现有项目 API／数据库；创建会话 → 现有持久 Task／executionScopes。`IProjectService` 是新版 UI 需要的接口，不能借此引入上游 `project-storage`／SQLite。

| 操作 | 处理方式 |
| --- | --- |
| 创建项目、多选目录 | 原编辑器保存一个项目。选定主目录写 `work_dir`，其余目录写 `additional_directories`；每个附加目录提供现有只读／可写选择。确认前保持草稿。 |
| 编辑名称 | 更新原项目 ID 的名称；刷新侧栏及标签显示，保持文件夹名称、会话与目录身份。 |
| 编辑已有项目目录 | 普通编辑保持主目录固定，附加目录修改影响新建 Task。目录缺失的恢复继续使用已有专门流程；不连接为任意替换旧 Task 主目录。 |
| 同目录、重复选择、符号链接 | 沿现有真实路径校验与目录冲突选择。用户选择复用或独立创建；不按路径自动合并项目。 |
| 旧 Task 更新权限 | 使用现有 Task scope 操作明确修改，保留授权版本、并发检查与旧执行资源关闭；项目保存不自动为旧 Task 增加权限。 |
| 打开历史会话与查看文件 | 继续解析真实 Task 目录；项目前置查看使用项目只读范围，不能从当前 UI 选中路径推导 Agent 权限。 |
| 分组、归档与工作方式 | 新侧栏读取当前项目 ID 与任务分组；保存现有手动分组、归档与置顶。Code／Design 列表按已启用工作方式显示，Flow 按插件可用状态显示。 |

项目多目录细节与固定源码证据见[《ZCode 3.16.2 多文件夹项目源码分析》](../调研/ZCode-3.16.2多文件夹项目源码分析.md)。本章不另建一份项目数据规格。

**Task 跨项目移动（2026-10-22 用户确认）**：采用新版任务行拖到项目行的原交互。移动前要求没有活动 Run、后台工作、待处理输入或审批，Goal 已暂停或结束；停止结果未知时拒绝移动并说明原因。Task 主目录、附加目录与原权限保持，目标项目补充目录须明确确认。历史画布、OpenDesign 文档和媒体保留原项目归属，按精确引用继续读取；新 Run 使用目标项目资源，原项目写入需要单独授权。Goal 保留正文、预算、计量和历史，移动不自动恢复；沿用原恢复入口，服务端重验当前项目及资源，失败时说明需要调整或授权的对象。

移动使用实例、Task、源项目、目标项目及观察修订组成稳定业务键，规范化参数指纹用于同键冲突检查，冲突返回 409。前向迁移区分当前项目归属与历史来源，历史资源关联稳定 Task Owner 并保留实例和类型隔离；更新当前归属、必要读取授权与状态投影在同一事务完成，并使旧控制请求失效。删除后迟到请求不得恢复 Task 或资源。不能只修改两处 project_id，也不能级联改写全部历史资源的来源。

**分组持久化与并发**：原 `task-groups` 的 `read`、`save`、`ungroup`、`move`、`admit` 经所属插件的宿主 RPC 贡献接入同一 PostgreSQL。分组属于本地实例，成员通过 `execution_task_owners(instance_id, task_id, task_kind)` 关联稳定 Task；界面 `workspaceKey` 和排序键由当前项目及 Task 固定目录投影，不作为持久归属。Code／Design 共用 Task 的实际类型取其 Owner，不能从当前工作方式推导。

读取在同一只读快照返回分组、成员、根节点顺序和独立组织修订；不因读取登记 Task 或推进修订。创建、编辑、取消组及手动移动固定操作时的组织修订，事务内重新核对来源组、目标组及锚点，冲突返回 409。创建使用表单持有的稳定创建身份；编辑、取消组和移动以实例、稳定目标及观察修订组成业务键，规范化参数形成指纹，回执与变更同事务提交。连接关闭取消未接纳事务并等待在途操作退出，不用重新读取的新修订替换旧动作。

`admit` 仅登记经过宿主核验的稳定 Task；重复登记不改变现有顺序和人工整理结果。创建 placement 绑定真实 Task 创建身份，同一次重放保持原结果，不能覆盖之后的人工移动。取消组把原成员按原顺序放回根层，不删除 Task。Task 软删除时清除对应成员和顺序，迟到登记不能恢复它；归档保留成员，恢复仍归原组。组及操作的删除墓碑只保留必要的不透明身份，不保留名称、路径或内容指纹；实例物理删除时级联清除。前向迁移分别验证历史 SHA、空库重放和第二次无变化。

### 4. Plugin UI／Gen UI 完整接入要求

**共用实现**：现有插件注册表的 `listUiEntries()`、`readAsset()`、插件入口、安装启用态、LocalActor、Task 文件读取和内容标签继续使用。沙箱页面的创建、消息通道、可见性与关闭清理共用一个宿主实现；两类页面分别提供其业务接口。

**Plugin UI** 需要完整处理 MCP Apps 资源与模板读取、资源订阅、工具 `_meta`、`McpAppInstance` 身份及代际、模型上下文、sampling、App-Provided Tools、实时增量和后续消息。工具卡片、用户主动打开的侧面板与后台页面使用原页面复用逻辑。安装／启用／项目范围改变后重新核查，不让旧页面继续使用被撤销能力。

**Gen UI** 同时包含生成端与展示端。为当前 Task 准备持久输出目录并建立目录授权，成功后才由现有系统提示扩展点提供目录和生成指导；生成指导通过现有 Skills／官方插件能力提供，不建立第二套技能目录。模型生成 HTML 文件后，在已完成消息中提供原格式引用，再由原卡片读取和显示。还需要原 `IGenUiService` 对应的状态读写、模型上下文、页面引用投影、受 Task 授权的 HTML 读取、页面资源与生命周期。流式参数未完成时不执行指令。原卡片使用现有主题与原调节控件；后续消息由当前会话控制入口发送，不能直接启动另一套执行过程。[U17]

**共同验证边界**：页面使用沙箱和 MessagePort；原 Electron `ownerWebContentsId` 在宿主边界映射为 KFW 可信窗口及页面身份，不接受 renderer 自报身份。校验页面实例、消息来源、当前 Task／项目与可见性。资源读取沿当前授权，不把本机接入凭据写进工具参数、普通事件或生成 HTML。页面发起的工具、模型和写入操作经过现有审批、Plan、角色及目录限制；页面内按钮不代表任意执行授权。关闭、取消、切换项目、停用插件后清理订阅，忽略迟到响应。用户交互或后续消息确认沿实际操作逐项核查。

现有静态插件面板继续通过同一注册表工作；完整 MCP Apps 和 Gen UI 需各自真实验证，不能用静态面板能打开作为完成证据。新增服务定义、提供方和消费者在所属 feature 内共同提交，不在 `app.ts`／`worker.ts` 增加手工分发。

### 5. 分批实施与提交顺序

各批次按依赖推进，每批同时提交原组件、需要的接口、实际适配、测试和来源记录。存在跨文件依赖时，以可编译的完整调用路径为批次范围，不按目录机械分割。下面是完整目标的依赖顺序，全部批次验收后才算升级完成。

| 批次 | 文件／职责 | 交付与验证 |
| --- | --- | --- |
| 0：来源与基准 | `scripts/zcode-provenance.mjs`、`vendor-zcode.mjs`、来源清单、仓库来源测试 | 支持分批记录真实上游提交；保留本机参考目录与并行修改。增加来源变化、目标变化、缺源、错误提交及新旧混合来源的真实 Git 对象测试。此批只改变校验，不改变产品。 |
| 1：新版 UI 所需接口 | `packages/zcode-shared`／`zcode-services` 的浏览器接口、V4、`host/upstream/remoteServiceAccess.ts`、当前 feature RPC | 统一 Agent 的接纳与旧选择清理已由 `199a44f0` 完成，制作指导已由 `e2143604` 提供，本轮保持并验证。按实际依赖升级接口与客户端实现，连接已有文件／模型方法及新增 accessor；项目和分组完整接口随第 3 批共同引入。新增方法必须有真实提供方，原 UI 仍可工作，类型和构建通过。 |
| 2：输入框与通用展示 | 原 `ComposerModelMenu`、模型控件、图片预览、长命令／进度与共享展示组件 | 使用已有模型、附件、完整工具输出、媒体和审批服务。验证模型与思考选择、发送期间新草稿、Plan、权限、剪贴板／下载失败及 Unicode／长输出。 |
| 3：项目侧栏与归档 | 原 `project-sidebar/*`、`ProjectDirectoryProvider`、项目编辑器、项目／分组接口与提供方、必要前向迁移、现有设置服务 | 同批连接同一项目多目录与改名、独立分组持久化／置顶／归档、同目录选择、历史 Task 与跨工作方式导航。切换根装配时删除被取代的旧侧栏和目录入口引用；通过真实项目 API 与临时 PG 验证。 |
| 4：文件面板与统一内容标签 | 原 `FileManagerPane`、`workspaceSidePane`、`AnimatedSidePanePanel`、`DocumentPane` 及宿主适配 | 多目录多标签、文件身份、浏览器／OpenDesign／子会话与完整视图共同工作。保留 Canvas 持续挂载、视口／选区与当前文件；发送、审批、Goal 和恢复不切换内容。 |
| 5：插件管理与 Plugin UI | 原商店管理、`plugin-ui/*`、现有 plugins／MCP feature、新 bridge 与共用沙箱宿主 | 使用同一安装注册表、管理文档和作用域；补齐第 4 节 MCP Apps 能力后连接原工具卡片和侧面板。验收安装停用、资源更新、真实 MCP App 通信及撤销后的迟到事件。 |
| 6：Gen UI 与分享能力显隐 | 原 `gen-ui/*`、Task 输出目录与生成指导、提示扩展、正文引用、共用沙箱、页面状态／Task 文件／会话消费者；分享能力检查 | 完成模型生成文件→完成消息引用→原页面显示，以及交互、状态与后续消息；未连接发布服务时不显示可点击的公开分享入口。验证生成目录失败、引用识别、刷新恢复、文件权限、交互来源和重复操作，不重建聊天服务。 |
| 7：完整装配与清理 | App／Root／SettingsPage、构建别名、公共资源、来源清单与文档 | 检查未采用的新入口、已取代文件与所有引用；移除因本轮替换产生的无用实现。复核样式、主题、焦点和原生平台适配；完成全量检查及本机交互。 |

批次 2 中的叶子更新与批次 3 的项目组织可以分别准备，实际写入共享 App／Root／SessionPane／样式／语言文件时串行集成。禁止同时运行多个测试或构建实例。

### 6. 来源、构建与数据处理

- `verifyZcodeInventory` 支持记录上的可选 `sourceRevision`，默认使用全局 `revision`；额外提交及 package 版本由 `revisions` 对象登记。按提交分组校验版本和原始字节，`copiedSha256` 继续验证当前适配文件。非法或未登记提交直接报错，单份 `--source-root` 镜像不用于混合提交；`--prepare-source` 逐提交准备 Git 对象，保持参考仓分支和工作目录。现有 `syncSource` 是 KFW 历史同步记录，不用它冒充上游提交。
- 全局版本仅在所声明范围完成统一复核后更新；仍使用旧来源的文件保留明确来源。删除来源记录必须同时证明对应文件及消费者已退役，或登记其真实新路径。
- 不删除来源清单后重跑复制脚本；该分支会清理目标目录。也不把新版目录当旧 `--source-root` 镜像校验。参考仓的工作分支、暂存指针和用户目录保持独立；所需 Git 对象由来源准备流程获取。
- `@zcode/client` 在 KFW 已由宿主实现接管；Vite／类型／测试别名和 `host/upstream` 适配必须共同核对。`@zcode/services` 只引入 UI 实际依赖，禁止整包带入上游 Node 装配、SQLite、CLI 或账户服务。
- 新 accessor 的必选成员逐项处理：`sourceServerWorkspaceService` 的本机身份解析映射到现有 Task／项目登记，远程操作继续按能力控制；`highspeedCardService` 的 SessionPane 直接调用必须加真实能力守卫；`outputStyleService` 本轮未发现实际 UI 消费，不因此创建新的持久化与提示风格功能。没有提供方的能力在宿主接口中明确可选并在消费前检查，不用固定空列表或成功结果满足类型。[U18]
- 新版 V4 包含 `runtimeInitialization`、`historyFirst`、`retryInitialization`、`sourceCommandId` 等变化。每项同时检查产生端、HTTP／SSE、解析、状态合并和原 UI 消费；当前宿主没有实现的能力不宣告支持。创建和发送中的附加目录、页面来源、模型及执行材料都须由服务端验证，不直接信任 renderer 新增字段。[U16]
- Plugin UI 的资源变化、实例关闭和页面工具调用属于 live-only delta，包含页面作用域和代际。冷历史不能重放这些执行请求；重连重新登记页面。只进入页面的 `_meta`、`privateContent` 和平台身份不得混入模型上下文；可进入模型的 `modelContent` 标记为不可信内容。[U16]
- 项目、Task、供应商、插件、技能、命令和钩子继续使用当前存储。若新版确实需要新增持久字段，按现有前向迁移规则提供首次执行、二次无变化及历史校验；不修改历史 SQL，不删除现有开发数据。
- 新依赖与资产先查许可、来源和注册表可用性，仅登记实际引入部分。法律文件修改遵守现有共同所有者批准规则；不整体覆盖本项目 notices 或变更公开许可。

### 7. 验证矩阵与完整命令

| 行为 | 必须证明的结果 |
| --- | --- |
| 新建／编辑项目 | 多选保存一个项目；取消、关闭和迟到选择均不写入；重复及符号链接路径归一化；名称修改保持 ID。 |
| 项目与 Task | 项目修改后，新 Task 使用新设置，旧 Task 保留原授权；明确撤销后旧请求不能执行；目录失效提供处理方法。 |
| 输入框 | 新菜单只显示可用模型；思考选择有效；点击发送时的配置保持原值，等待期间的新正文／附件／选择不被清除。 |
| 权限／Plan／Goal | 独立 Plan、审批模型和完全访问保持真实语义；计划状态与只读角色不能借新按钮扩大权限；停止和重试仍指向真实执行与修订。 |
| 内容标签 | 同名文件、多目录、连续打开／关闭／重开使用正确身份；Canvas、OpenDesign 和浏览器保留状态；后台文档不接收输入。 |
| 插件管理 | 无项目管理、官方／本机来源、安装与启用区分、未知响应只读核查、并发编辑与删除后迟到请求均正确。 |
| Plugin UI／Gen UI | 各自使用真实资源和消息通道；Gen UI 验证 Agent 生成文件、完成引用和原页面显示；刷新恢复、多个页面、重复交互、取消／关闭、权限撤销、卸载及迟到响应都有行为验证。 |
| 媒体与子会话 | 生成结果保持原片读取与原消息归属；复制／下载失败可恢复；子会话继续复用 SessionPane 和真实订阅。 |

实施时先运行对应批次的真实组件／服务回归，再按以下顺序运行；本轮分析只运行文档和来源核查，不把以下命令记为已通过：

```bash
node scripts/vendor-zcode.mjs
pnpm test:workspace
pnpm exec turbo run test --concurrency=1
pnpm typecheck
pnpm lint
pnpm build
```

项目与宿主改变后，单独开启已有真实临时 PG 测试：

```bash
TMPDIR="$PWD/.scratch" KENFUTWORK_CRUD_TEST_PG=1 pnpm --filter @kenfutwork/server exec vitest run src/features/projects/projects.integration.test.ts --maxWorkers=1
TMPDIR="$PWD/.scratch" RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/host.integration.test.ts --maxWorkers=1
TMPDIR="$PWD/.scratch" RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/web exec vitest run test/code-approval-session-public.integration.test.tsx test/code-queue-session-public.integration.test.tsx test/code-file-rewind-session-public.integration.test.tsx --maxWorkers=1
```

原有相关回归包括 `shared-project-navigation`、`code-directory-choice-race`、`code-directory-recovery`、`code-model-defaults`、`code-attachment-composer`、`animated-side-pane-panel-model`、`code-plugin-store`、`code-plugin-source-install`、`code-goal-control`、`open-design-pane` 等；实施时按实际改变的公开行为补充用例，不重复测试内部函数形状，不使用伪造结果证明完成。

HTTP 接口变化时同步 shared、中文 OpenAPI registry、`pnpm api:spec` 与 Apifox AI 分支；WS／流字段变化更新各自协议文档。原生目录多选、剪贴板、下载和布局还需 `pnpm desktop` 的实际交互验证，使用 DOM／可访问性与行为结果；未执行 Windows 的原生功能不得计为已验。真实模型沿当前供应商设置读取，不写入固定实例 ID、Key 或另建模型配置。

### 8. 当前证据与状态

新 Task 创建事务在项目行锁内读取当前附加目录，已通过原项目 PATCH、创建命令及真实 PostgreSQL 锁竞争回归；项目保存先提交时新 Task 使用当前目录，已有 Task 的授权保持。

已有项目采用 3.16.2 原 `ProjectEditor`，通过现有宿主贡献接口连接真实 PostgreSQL 项目、目录和归档服务。原项目菜单可改名及修改附加目录，新旧 Task 的授权分别保留；目录选择保持真实路径中的空格，绑定失败可再次确认。保存按观察修订处理同值、并发、重放和冲突，跨连接广播重新读取项目，关闭等待在途事务退出。原 Root 浏览器验证确认名称、Task、草稿和内容目标保持；该证据使用原组件生产构建、真实 HTTP／SSE、临时 PostgreSQL 和独占浏览器，不计为 Tauri 原生交互或真实模型验收。Apifox AI 分支 `ai/20261023-from-main-project-editor`（8768607）的两个接口及五个模型已导入并读回核对，主分支未合并。

已有项目编辑及其归档调用已提交。原项目创建表单已连接真实创建输入与 PostgreSQL，Code／Design、多目录权限、原主目录选择、明确目录确认和保持当前 Task／草稿／内容的行为已取得真实回归；同名并发创建、同键重放、参数冲突及归档／物理删除后的迟到请求已通过。真实 COMMIT 回包丢失后沿同一创建身份恢复唯一项目的回归已通过，项目创建已提交为 `8eefdf9c`。原生目录的剩余生命周期验证、完整原 ProjectSidebar、分组、排序、跨项目移动和第 4–7 批仍待完成；全局来源基线保持 3.14.3，不能按已更新文件数量计算整轮升级完成。

同目录创建沿原表单明确选择复用或独立创建。复用重新核验活动项目及真实主目录，保留原设置、工作方式与当前 Task，不写项目；独立创建沿原稳定创建身份保存名称、目录和权限。候选读取、选择队列及表单关闭使用本次取消信号和所属 Provider 身份，关闭等待已有保存或归档退出；旧响应不能进入下一轮选择。复用只消费目录归属复验结果，不再读取无人使用的完整项目；真实只读响应延迟的原组件回归已取得失败与修复证据。归档旧候选返回可读原因并保留名称、目录草稿，实际验证命令和范围见《日志》对应记录。

原生目录单选／多选已连接原平台接口、可信 Tauri 命令与原 `ProjectEditor`，Web 保留原目录浏览。`pnpm desktop` 重建后，系统多选、取消、重复选择、主要目录调整、附加目录明确权限、关闭不保存及重开空草稿已取得原生交互证据；Root 单目录入口的系统选择框与取消也已验证。真实桌面 API 与 PostgreSQL 确认保存恰好一个项目、两个附加目录、目录末尾空格和权限完整，Task／Canvas 为零，关闭草稿未产生项目。系统选择等待期间经菜单正常退出应用，再以源码开发入口重开，新表单为空、创建禁用且可再次打开并取消系统选择；API 与只读 PostgreSQL 确认等待草稿没有创建项目，原保存结果保持。切换 Task 的迟到结果及 Windows 系统选择仍待验收。许可已由 `6d9b457c` 交付；完整原侧栏继续按依赖装配，当前旧标签侧栏尚未展示刚保存的空项目。

分叉附件使用新 Task 的同一可信作用域，七项真实附件回归通过；普通分叉保留当前 Task 的只读目录及完成轮配置，两项正常／提交回包丢失回归通过。宿主工具结果的非空普通记录列表现完整保留为 JSON 文本，明确的图像内容块继续保持原字节；原 TaskOutput 完整输出、再分叉及冷恢复，以及默认模型线与宿主回执回归通过。项目创建已从首条真实回归的 400 继续连接，当前验收范围见上一段。压缩目录的三项预算／摘要识别回归继续核查，未计入完成验收。实际命令与提交见《日志》对应记录。

截至 2026-10-23，已提交分来源 Git 校验 `e0d66b97`、可信连接与关闭清理 `ec7fe8c4`、原长命令与审批预览 `e0af10ac`、Computer Use 真实库存开关 `bf46e68b`、原合并模型与思考菜单 `37dd79e0`。原 Composer 的禁用文件事件已取得真实回归，并覆盖禁用／恢复编辑的两次往返；具体命令与提交范围见《日志》。当前仍为逐文件升级，全局原移植基线保持 3.14.3。

图片操作采用新版原菜单、复制及下载实现，图片和 SVG 沿打开时固定的真实 Task／Project 读取原字节，添加到聊天复用原素材预算、采集及预传。可见草稿与实际附件 Task 分别保存，关闭或切换目标后取消在途添加；缺少来源只在原预览中显示错误。当前公共回归及提交范围见《日志》同日“原图片操作与固定文件来源”。文件面板、多目录、Git、编辑器及内容完整视图的其余消费者继续按第 4 批实施。

Git 忽略查询保留仓库内符号链接的名称，并逐项验证真实 Task 的读取权限；其他 Git 内容与写入操作保持原真实路径规则。真实 HTTP／SSE／临时 PostgreSQL 已验证 `.gitignore` 变化、未授权 Task 拒绝、仓库外原路径拒绝和权限保持。该服务修复独立交付，不代表完整文件面板验收；实际命令与范围见《日志》“Git 忽略查询保留仓库链接路径”。

原 `TaskGroupedView`、原分组组件和独立 `taskGroupService` 代理已装配到同一 Code 壳；Root 常驻目录持有组织及名称草稿，复用已交付的 PostgreSQL 接口。首发归属使用真实接纳命令身份，等待期间重新定位的草稿保持独立。原文件按钮固定所选 Task 的身份，目录、搜索、watcher、Git 和预览共同消费该身份。原菜单、拖动、选色、取消组及吸顶键盘操作已通过原 Root 的真实回归；保存等待、读取故障和连接恢复分别保留已确认修订及后来输入。旧分组组件与六个旧服务方法已清理，仍被其他 Task 行消费的共享按钮保留。

本轮公开组合为 12 文件 13 项全部通过，使用原组件生产构建、独占 Chrome、真实 HTTP／SSE、临时 PostgreSQL、文件及本机受控模型 HTTP 流。来源为 3054 项、两个提交、零漂移；全局基线继续保持 3.14.3。完整原 ProjectSidebar、跨项目移动、第 4–7 批、压缩目录、剩余原生与外部真实模型验收继续按依赖实施，完整 Goal 保持 active。具体回执与提交检查见《日志》“原持久分组界面与固定文件身份”。

原 `ProjectComposerMenu` 已装配到同一 SessionPane 的草稿头部，按真实 Project ID 展示当前工作方式可用的项目，包含尚未打开的空项目；同目录项目分别选择。`project.prepareSession` 经所属 feature 的原宿主 RPC 贡献连接现有目录准备，返回真实主目录及标准身份，后续 Task 仍使用原预热／首发接纳。客户端收到回执后复验目录、身份及工作方式，导航同时核验原 Tab、Task、草稿版本和当前方式；旧响应保留后来的选择。创建与编辑继续复用已交付的原表单，准备失败通过原提示显示处理方法。完整原侧栏仍待装配，当前证据与提交检查见《日志》“原项目选择与新草稿准备”。

项目侧栏、多目录、分组与移动继续按第 3 批实施。移动候选已有准备事务提交后回包丢失、同键并发及顺序重放、参数冲突、删除后迟到请求的真实回归回执。原输入框发送及 Stop 按钮已通过独占浏览器的项目往返回归：旧请求使用原 Task 观察值返回 stale，发送期间的新正文及当前模型流保持。空 Task 创建回执返回数据库生成的初始观察值，预热首发在快照未到时也能使用该回执。原项目侧栏、历史资源精确读取、其余控制命令与预热清理及 Goal 移动恢复仍需完整连接，不能作为移动功能交付。

创建时的首条输入沿原 Task 创建事务与运行接纳机制保存，真实 HTTP／SSE／PostgreSQL 已验证唯一运行、并发与顺序重放、参数冲突、删除后迟到创建、COMMIT 回包丢失及首次回执读取同时失败后的恢复。该行为独立于项目移动候选；完整命令、审查和提交范围见《日志》“Task 创建首条输入原子接纳”。

原模型设置的同值保存已补真实 HTTP／PostgreSQL 回归：当前修订的同值普通配置保持修订，旧修订仍返回冲突；并发修改只接受一个请求，重新读取后可保留两项修改。真实凭据变化继续推进修订，删除后的迟到保存返回可解析的 404。中文 OpenAPI 与 Apifox AI 分支 `ai/20261023-from-main-model-revision`（8765515）同步，主分支未合并；提交与完整检查回执见《日志》。

原供应商设置的管理链接使用现有实例元数据保存，聊天与生成设置读取同一记录；省略保留、单独清除链接与清除完整访问配置分别验证，供应商协议和模型保持原值。真实 HTTP／PostgreSQL 回归与 Apifox AI 分支 `ai/20261023-from-main-provider-management-url`（8767356）读回通过，主分支未合并；完整检查和提交以《日志》对应回执为准。

原模型恢复推荐沿原 `clearManualModelConfig` 保留系统声明，并重新计算现有模型记录中的容量、输出与输入能力；空个人配置不再发布为个人精确规则。原设置的真实 HTTP／PostgreSQL 回归验证停用、Text／Audio、名称与扩展参数保留，思考映射和手动能力恢复默认，刷新及同值保存保持结果。连续两轮运行曾复现容量显示保留旧缓存，现由接纳输入固定有效容量，实际调用通过既有用量事件回报；同一 Task 的第一轮 260000／9000、恢复推荐后第二轮 200000／32000 与历史保留回归已通过，其余运行消费者按《日志》继续扩大验证。

原归档管理已在工作区连接本机项目树、条件删除与恢复服务。项目与 Task 在同一 PostgreSQL 快照读取，归档操作固定当前项目及分支；恢复承接 Goal 分支与修订，保持目标内容、计量和暂停状态，由用户明确继续。真实服务 11 项与原组件创建／编辑／归档组合 8 项通过，包括 COMMIT 回包丢失、并发、删除后迟到请求、明确继续 Goal、删除取消和当前草稿保留；完整命令与提交检查由《日志》记录。本次归档管理不代表完整原侧栏、持久分组、排序和跨项目移动已完成。

Plugin UI／MCP Apps、Gen UI 的完整生成与页面服务、内容标签及 Canvas／Flow／OpenDesign 往返、`pnpm desktop` 和真实模型验收仍未完成。最终串行全包测试、lint、构建及新增行为的真实服务验收随对应批次继续执行。2026-10-23 用户恢复原 Goal 后，实时读回已为 active，目标仍覆盖全部 0–7 批次。逐文件来源仍由来源清单持有，媒体线程文件与共享修改段按归属逐项核查。

本轮源码比较材料保存在已忽略的 `.scratch/ZCode界面升级/`；可交接的结论和计划由本章持有。后续按各批实际提交和验证结果更新本章状态及《日志》，未完成的批次保持未完成。

分组结构读取已通过所属插件的 `task-groups.read` 接入真实 PostgreSQL，只读快照返回分组、稳定 Task 成员、根节点顺序及独立组织修订。真实 HTTP／SSE 回归覆盖空实例、重复读取、多连接、非法参数、项目当前目录变化后的固定 Task 身份，以及两次归档／恢复、删除后的成员清除和迟到删除；没有把读取作为首次登记。完整原侧栏、分组界面、排序及登记仍按本章继续实施；实际验证和提交由《日志》对应回执记录。

分组创建与编辑已通过 `task-groups.save` 连接同一 PostgreSQL 和原 SSE 状态通知。真实回归覆盖稳定创建、改名及改色、同键并发创建、同修订编辑竞争、同值保存、规范化重放、错误输入、SQL 等待期间关闭连接，以及 COMMIT 回包丢失后的原回执读取。旧创建回放不覆盖后续编辑。原分组服务代理、操作开始时固定修订的界面与排序仍需完整接入；本次服务验证不计为原分组界面交互完成。

取消组通过所属插件的 `task-groups.ungroup` 连接同一组织事务与最小删除回执。原组节点由全部持久成员按原顺序替换，归档隐藏成员保留，Task 正文、目录及权限保持。公开读取和取消共用完整投影键排序，已通过相同位置而目录身份与 Task ID 次序相反的真实回归；连续及并发重放只推进一次组织修订，迟到创建和编辑不能恢复分组。当前仍需完整原侧栏消费，服务与最终验证回执由《日志》持有。

首次登记与创建时分组归属通过 `task-groups.admit` 接入同一真实 Task Owner、组织事务和原 SSE 通知。重复登记不改变人工顺序，新成员按真实创建时间进入根层顶部；创建别名绑定该 Task 的持久首发事实，并与真实 TaskId 归为同一意图。登记、归属与回执同事务保存，尊重既有人工位置，取消组及 Task 删除后的迟到请求不恢复原组织。真实组合 18 项通过，覆盖首发与 Stop 区分、批量顺序、非法及旧地址、连接关闭、SSE、COMMIT 回包丢失和删除后的重放；具体命令与范围由《日志》持有。原分组界面、手动移动与排序、完整侧栏和跨项目移动仍按依赖继续，不将服务回归计为完整第 3 批验收。

手动分组移动与排序已通过 `task-groups.move` 的 shared 定义、所属 feature 提供方与原宿主 RPC 贡献连接同一 PostgreSQL。真实公共回归验证组和 Task 的组间／返根／根排序、未登记 Task、隐藏归档成员、精确来源与锚点、并发和同键重放、连接关闭及删除后的迟到请求。真实 COMMIT 确认后抑制回包，沿原意图读取唯一顺序，不重复推进组织修订；迁移通过历史 SHA、135 项空库重放、第二次零变化及实际 Schema／删除清理。该服务只改变组织事实，Task 项目、目录、权限和 Goal 保持。原代理与完整原分组界面、ProjectSidebar、跨项目移动及第 4–7 批继续；自动化、原生和外部真实模型证据分别以《日志》记账。

原项目侧栏所需的项目置顶事实已由同一 PostgreSQL `projects.pinned` 持有。`project.saveProject` 接收携带项目观察修订的严格稀疏输入，复用原锁、保存回执、关闭上下文及状态通知；项目读取投影返回置顶状态，旧回执缺字段按 `false` 解析。真实回归覆盖置顶／取消、双连接并发、旧回执重放、COMMIT 回包丢失、目录失效、连接关闭、归档及隔离维护删除后的迟到请求。已有 Task 所属项目置顶后再完整编辑，置顶、旧 Task 目录、权限、历史和控制保持。该阶段交付原节点依赖的持久接口，不计为完整 ProjectSidebar 的界面装配；命令、迁移与接口读回证据见《日志》“原项目置顶持久接口”。

Task 移动的原 RPC 参数已改为严格单元素，准备事务接纳前使用当前连接取消信号，关闭等待在途操作退出；接纳后的移动继续完成资源关闭与归属提交。同键在线等待者保留自己的连接与原观察值，项目树和原 Controller 的元信息保留当前项目、分支及正文修订。历史边界按稳定 Task 与当前 Owner 校验，原来源项目保持；继承历史只随同一移动事务更新当前 Owner 的项目。原 Controller 往返及已接纳关闭的三项真实回归通过，完整命令与其余验证以《日志》“Task 移动观察与连接生命周期”持有。完整侧栏、客户端移动身份、文件与其他历史资源消费者继续实施，本段不代表第 3 批全部完成。

旧移动回执的退订通知现携带实际接纳代际，宿主按会话租约读取时的 Task 代际限制清理。项目往返后，新租约可继续恢复，首次移动前的旧租约继续失效；实际公开 SSE 回归与提交检查由《日志》“旧移动回执保留新会话租约”记录。

### 9. 源码依据

上游链接均固定到 3.16.2 的提交；以下 KFW 路径基于本轮 `da07da8a`，行号是核查位置，不代替后续实时读取。

- **[U1] 项目**：[侧栏导出](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/WorkspaceSidebar.tsx#L1-L3)、[ProjectEditor](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L173-L361)。
- **[U2] 归档**：[ArchiveManagement](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ArchiveManagement.tsx#L31-L50)、[默认收起](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ArchiveGroupCard.tsx#L45-L109)。
- **[U3] 模型**：[ComposerModelMenu](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/chat-input-toolbar/ComposerModelMenu.tsx#L102-L195)、[原工具栏消费](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/v4/composer/V4ComposerToolbar.tsx#L1304-L1378)。
- **[U4] 权限**：[V4ComposerModeControls](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/v4/composer/V4ComposerModeControls.tsx#L43-L103)。
- **[U5] 文件**：[FileManagerTarget](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/lib/workspaceSidePane.ts#L50-L77)、[真实渲染](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/app-shell/AnimatedSidePanePanel.tsx#L1294-L1337)。
- **[U6] 图片**：[原预览操作](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/previewPaneImageContent.tsx#L54-L154)。
- **[U7] 分享**：[ConversationSharePopover](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/conversation-share-interaction/ConversationSharePopover.tsx#L17-L78)。
- **[U8] 商店**：[PluginStorePage](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/settings/PluginStorePage.tsx#L72-L136)。
- **[U9] Plugin UI**：[真实能力检查](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/plugin-ui/adapters/usePluginUiHost.ts#L18-L60)、[会话能力提供方](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/plugin-ui/adapters/PluginUiProviders.tsx#L32-L68)。
- **[U10] Gen UI**：[正文消费](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/v4/ConversationRowView.tsx#L1699-L1718)、[服务及沙箱检查](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/hooks/useGenUi.ts#L13-L43)。
- **[U11] 工具搜索**：[设置入口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/settingsPageHelpers.tsx#L522-L557)。
- **[U12] 内容完整视图**：[控制器消费](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/app-shell/WorkspaceShellLayout.tsx#L558-L581)。
- **[U13] 远程功能**：[设置能力条件](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/SettingsPage.tsx#L1944-L1975)、[手机入口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/web/src/main.tsx#L396-L445)。
- **[U14] 未读提醒**：[原生实现](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/src/main/desktopWindowLifecycle.ts#L331-L399)。
- **[U15] 分组与项目目录服务**：[task-groups/contract.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/task-groups/contract.ts#L4-L50)、[window-project-directory/contract.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/window-project-directory/contract.ts#L7-L27)。当前 KFW 已处理的任务列表方法见 [service.ts](../../apps/server/src/features/code-ui/service.ts) 第 1998–2012 行。
- **[U16] V4 与页面元信息**：[snapshot.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/shared/src/zcode-protocol-v4/snapshot.ts#L476-L492)、[transport.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/shared/src/zcode-protocol-v4/transport.ts#L341-L353)、[live-only delta](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/shared/src/zcode-protocol-v4/delta.ts#L122-L154)、[Gen UI 状态格式](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/shared/src/gen-ui/contract.ts#L30-L62)。
- **[U17] Gen UI 生成端**：[提示段](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/context/sections/desktop.ts#L4-L19)、[输出目录准备](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/runtime/helpers/gen-ui-output.ts#L4-L20)。
- **[U18] 必选服务与窗口身份**：[accessor.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/accessor.ts#L92-L120)、[页面沙箱接口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/shared/src/mcp-apps/contract.ts#L183-L198)。
- **[K1] 项目与 Task**：[project-service.ts](../../apps/server/src/features/projects/project-service.ts) 第 190–222、373–405 行；[service.ts](../../apps/server/src/features/code-ui/service.ts) 第 5025–5078、5099–5108 行；[SharedProjectNavigation.tsx](../../apps/web/src/components/workbench/zcode/host/SharedProjectNavigation.tsx) 第 55–73、190–211 行。
- **[K2] 模型与审批**：[V4ComposerToolbar.tsx](../../apps/web/src/components/workbench/zcode/v4/composer/V4ComposerToolbar.tsx) 第 1025–1091 行；[composerSubmissionConfig.ts](../../apps/web/src/components/workbench/zcode/v4/composer/composerSubmissionConfig.ts) 第 14–45 行；[V4ComposerModeControls.tsx](../../apps/web/src/components/workbench/zcode/v4/composer/V4ComposerModeControls.tsx) 第 171–251 行；[ModelDefaultsSection.tsx](../../apps/web/src/components/workbench/zcode/host/ModelDefaultsSection.tsx) 第 47–95、154–208 行。
- **[K3] 文档与媒体**：[DocumentPane.tsx](../../apps/web/src/components/workbench/zcode/host/DocumentPane.tsx) 第 41–64 行；[AnimatedSidePanePanel.tsx](../../apps/web/src/components/workbench/zcode/app-shell/AnimatedSidePanePanel.tsx) 第 1112–1346 行；[GeneratedMediaRenderer.tsx](../../apps/web/src/components/workbench/zcode/host/GeneratedMediaRenderer.tsx) 第 139–195 行；[useComposerAttachments.ts](../../apps/web/src/components/workbench/zcode/v4/composer/useComposerAttachments.ts) 第 1031–1084 行。
- **[K4] 插件**：[managementDocument.tsx](../../apps/web/src/components/workbench/zcode/host/managementDocument.tsx) 第 139–167 行；[plugins.ts](../../apps/server/src/features/code-ui/plugins.ts) 第 215–300 行；[platform.ts](../../apps/web/src/components/workbench/zcode/host/platform.ts) 第 86–122 行；[PluginSidebarNavigation.tsx](../../apps/web/src/components/workbench/zcode/host/PluginSidebarNavigation.tsx) 第 22–78 行。
- **[K5] ToolSearch**：[catalogue.ts](../../apps/server/src/features/tool-catalog/catalogue.ts) 第 55–165、168–232 行；每次发现和执行重新检查当前权限、定义与代际。
- **[K6] 现有宿主与校验**：[main.tsx](../../apps/web/src/components/workbench/zcode/host/main.tsx) 第 166–197 行；[platform.ts](../../apps/web/src/components/workbench/zcode/host/platform.ts) 第 59–99 行；[zcode-provenance.mjs](../../scripts/zcode-provenance.mjs) 第 131–180 行；[vite.config.mjs](../../apps/web/src/components/workbench/zcode/vite.config.mjs) 的别名装配。
- **[K7] 分享尚未接入**：[service.ts](../../apps/server/src/features/code-ui/service.ts) 第 1995 行最终返回未处理；[code-ui.ts](../../apps/server/src/http/code-ui.ts) 第 418–424 行返回 501。上游发布提供方使用独立公网与 OAuth 服务，见 [node.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/node.ts#L2613-L2635)。

---

## Code 模式 ZCode 全量源码移植方案


> 状态：2026-10-02 用户确认，实施中。唯一执行规格见本篇下一章《[Code 模式 ZCode 全量源码移植执行手册](#code-模式-zcode-全量源码移植执行手册)》。

### 确认的范围

Code 工作台及其设置/插件市场全部使用 ZCode 3.14.3 开源提交 29628c9acdb81b703bbd4080c207a0e7ce5e276e 的原源码。DSH 只用于参考插件机制与 WebUI 设计，dsh bundle 兼容仍限打包/清单层，不扩为运行时服务图兼容。

Design 保留原界面与行为；旧开发调试数据不兼容、不转换、不恢复。Code 可选能力按真实安装和可用状态显示，云套餐/账户入口移除。

### 现状核对

此前 572 个复制文件只是叶子和局部装配；原 App、workspace shell、SessionPane、设置、完整右栏缺失。transport/sessionDataLayer/projection/subagent 目录使用恒空替身；所有文本固定 complete，turn 身份和 childSessionId 不完整，自有 Code 壳仍在运行。因此此前日志的“旧 Code 清零/收口”不作为本轮完成证据。

后端还存在子正文串入主历史、工具文本/大 JSON 丢失、终态缺失、并发子代理归属不可靠、权限无法恢复和子转录不持久化等缺口。本轮同时改造后端，不再遵循“归约层和服务端协议不改”的旧限制。

### 实现与验收

直接搬完整原 UI 树及 browser-safe 契约；保留原组件和消息流装配。宿主通过插件提供真实 V4 会话、文件/终端、设置/供应商/插件服务，并隔离 Code 样式和门户。

只允许机械构建/类型、宿主、资源、品牌/模式、能力显隐偏差，逐项登记。四处 TDD 接口、来源清单、同环境原 ZCode 视觉/交互对照、GLM 真实链路、旧 Code 零残留与 Design 回归全部满足后才交付完成。详细接口、顺序和门禁均以执行手册为单源。


---

## Code 模式 ZCode 全量源码移植执行手册


> 状态：实施中，2026-10-02 用户确认。此稿替换旧 P0–P8 施工单及其收口结论。
> 唯一源码基线：ZCode 3.14.3，29628c9acdb81b703bbd4080c207a0e7ce5e276e。
> Code 全部 UI 直接搬源；Design 保持不变；DSH 仅参考插件机制。旧调试数据不兼容、不转换、不恢复。

### 1. 移植边界与来源

完整复制原 UI 树，保留 App、workspace shell、SessionPane、消息时间线、Markdown、全部工具 renderer、输入器、左右栏、设置和插件市场的真实装配关系。子代理详情复用只读 SessionPane。

来源清单为 `packages/third-party/zcode/来源清单.json`：源路径、目标路径、源 SHA-256、复制 SHA-256、适配记录。保留原版权及第三方 notices。

允许偏差仅限导入映射、构建/类型兼容、公共资源路径、宿主接口、品牌与模式文案、真实能力显隐。禁止手写用户气泡、工具卡、消息装配、子代理目录、动作行、分隔线等仿制组件。

上游 UI 由独立 TypeScript/Vite 工程检查和构建，Next 消费构建产物；宿主 adapter 保持 strict/exactOptionalPropertyTypes。不扩充手写 zcode-shared stub，不搬原 Node 服务实现和 Agent CLI。

### 2. 宿主与模式隔离

`/workbench` 采用客户端 mode 导航，默认 code。Code 挂完整原界面；Design/Flow 挂保留的原界面。Code 原菜单的 office 入口仅映射为进入 Design，Code store 保持 coding，不激活原 office 功能。

隔离 Code CSS、主题/字号 DOM 目标与 portal 容器。Store 初始化也不得修改 Design 的 document theme。ZCode 云账户/套餐移除；远程、CUA、定时任务等按真实插件能力隐藏。

真实 store、services、transport、projection 必须接通。禁止以恒空租约、恒空列表、无效回调或抛“未接通”的必需服务宣称接入完成。

### 3. 后端及公开契约

保留 DeepAgents，新增 codeUi 插件的 Definition/Provider/Consumer，服务 key 登记《改造计划》§4.2。禁止在 app.ts/worker.ts 手工堆装配。

原 V4 ConversationTransport、SessionDataLayer、rows/snapshot/command/frame 为 UI 契约。首屏初始化原 workspace tab/draft 与模型 view；V4 subscribe 返回 ACK-only，snapshot 经所属 frame 通知发送。

根 session 对应 Task；运行绑定 Project 的固定工作目录。每次子派发建立稳定 childSessionId，按 parentToolCallId 关联，禁用名字/派发顺序兜底。主/子正文、思考、工具和终态独立持久化。

工具结果保留完整文本、结构化 output/display、真实 diff、实时输出预览及 success/error/cancelled。长输出按引用读取，不能整段丢弃。事件/命令有稳定身份、单调序号、幂等重放、终态保护与删除墓碑。

必须接通发送/停止、排队、编辑/分叉、文件查看/回退、终端、子代理独立停止、权限请求-应答-恢复及结构化提问。新 Schema 仅新增前向 SQL 迁移；治理值沿用 shared 的单一配置来源；BYOK key 只写不读。

### 4. TDD 与完整验收

用户已确认四个测试接口：Agent 公共运行事件；Code 宿主快照/订阅/命令/文件服务；原组件真实用户操作；Design 画布与助手不变量。

逐条 red→green，覆盖并发同类型子代理、父派发收尾、失败/取消、关闭侧栏后继续运行、刷新/断线、重复与迟到事件、删除后迟到请求、空/Unicode/超长输出和真实 diff。

真实模型冒烟使用本机公共模型目录所列 glm-4.5-air；不读取或输出 API key。确定性回归在外部模型边界使用替身。

在相同浏览器/视口/字体/语言/主题中，与同一 ZCode 提交使用相同数据逐场景截图及交互对照。源码来源、视觉/交互、真实后端、旧 Code 清零、Design 回归全部满足后才算完成。

### 5. 实施顺序与交付

1. 已确认技能配置、更新方案/手册、来源清单与测试场景。
2. 子派发→原 Agent 行→目录→子 SessionPane 的首个完整切片，再逐条接通工具和运行交互。
3. 完整工作台、设置、右栏与真实宿主服务。
4. 删除所有旧 Code 分支、组件、展示归约、空 stub、旧测试及无用引用；共享 Design 实现保留，不设旧界面回退开关。
5. 顺序执行 pnpm test、pnpm typecheck、pnpm lint、pnpm build、pnpm api:spec；同步 HTTP/WS 文档。HTTP 契约变化按既有规则导入 Apifox AI 分支，合并由用户确认。

交付一个完整替换 PR，按可验证切片提交；每次提交遵守显式路径暂存与门禁规则，日志同步记录实际证据及未完成项。

### 6. 实时实施记录（2026-10-03）

- 分支：`codex/完整移植ZCode-Code界面`，目标 active。已按独立切片提交：`613ed706` 产物忽略、`dae8ee1b` 技能配置、`fca5bab9` 原契约依赖、`5c9dd46b` 运行事实、`1574d031` V4 会话宿主。另已提交 `07d8657d` 完整原 UI 恢复检查点、`65d1097e` 认证/模式接口。尚未推送、未创建 PR。
- 来源核对 3051 条、零漂移。完整原 UI、资源、契约源码及模型规则已随检查点入库。原版权/notices 保留，独立 vendor 检查与 strict/exactOptional 宿主检查通过。
- 原 UI 整树和真实 host/main 已存在，独立 Vite 文档构建通过。使用原 RemoteServiceAccess/ProxyChannel、providers/store、RootWorkspaceContent/App/SessionPane；Code CSS/portal/主题在独立文档内。原 diff worker 构建副作用设置与 PDF CMap 插件已补齐，产物含非空 worker 和 168 个 CMap。
- 原输入器已实际发送 GLM 4.5 Air 请求；真实子代理派发后，原 Agent 行打开右侧只读子 SessionPane，独立 Markdown/工具转录可读，原文件 chip 呈现。真实文本、幂等、主区刷新恢复已验证。完整 source-vs-host 视觉/交互对照尚未进行。
- codeUi 插件持有真实 Task/Project 主画布绑定、固定工作目录、命令去重与事务 ACK、原快照/行、owned SSE 订阅、恢复、Task 索引、安全模型 view 与文本文件读取。原 subscribe 服务入参为 sessionId，返回 ACK-only；不传项目 UUID 作 workspaceIdentity。
- 事件日志与主/子快照同事务持久化。已覆盖正文/思考、成功/失败/取消、重复派发、主/子分流、前台子终态、恢复与迟到保护。真实参数在事件日志保留，UI 文件工具路径适配为实际项目路径。
- SQL `20261002133704_code_ui_projection.sql` 已执行且不可修改。前轮历史 SHA、71 条迁移临时库重放及二次 0 条验证通过。
- 最近检查：server 1478 测试通过，shared 80 测试通过，原事件窄回归 38、会话/model view 范围另通过；server/shared、vendor/host 类型检查通过；四项公开接口 integration（含 GLM 真实文本）通过；暂存独立快照 workspace/API 文档门禁和 frozen-lockfile 通过。不能将范围检查称为最终全仓完成。

#### 所有权与下一步

用户安排其他 Agent 接续后端（主要 Agent 运行时）。本 Agent 聚焦前端原件接线、宿主适配、模式隔离、Code 旧实现清零及视觉/Design 回归，不再并行改 Agent 核心。后端现有改动已经提交，后续按明确接口集成。

1. `/workbench` 已默认挂原 Code 文档，Design/Flow 独立客户端导航；旧 Code 自有装配、本地转录、归约、右栏及其测试共 53 个文件已退役。Design 侧栏/画布和共享设置保留，原共享输入叶子单独编译；web 368 测试和类型检查通过。继续原版视觉、长会话与服务集成回归。
2. 宿主仍未接全部命令：停止、队列、编辑/分叉、权限/结构化提问恢复、文件回退、终端等必须由真实能力实现。availability 目前仍有待纠正的预设 true；不能把未实现能力宣称可用。
3. 后端需继续：官方 LangGraph interrupt/Command.resume、waiting/checkpoint 恢复、Code PG fail loud、GraphInterrupt 穿透、精确 child 停止与后台终态；Code 不依赖名称/顺序兜底。
4. 设置写入/原市场与插件服务、模型选项执行、Gemini 适配、真实 before/after diff 与完整长输出引用仍未完成。BYOK 表单保持原件，成功保存后只清对应未继续编辑的 key 草稿，服务端不回传 key。
5. Code store 恒为 coding；原 office 菜单仅导航 Design。Footer 云登录/账户/套餐及购买查询已按真实平台能力隐藏；模型设置预置云账户/套餐导航与无模型套餐提示也已从原组件装配按 supportsCloudAccounts 隐藏，停止云凭据/权益查询，原 BYOK 配置/刷新保留。自动化/浏览器控制等不可用入口仍待真实能力显隐，不能认定全局显隐完成。
6. 原版同场景截图/交互、GLM 工具链锁定回归、旧 Code 清零、Design 回归、完整 pnpm test/typecheck/lint/build/API spec 与 Apifox AI 分支仍必须完成，之后一个完整 PR。

#### 供应商设置宿主的已核实前置契约

原 `IProviderSettingsService` 方法面必须完整接入，不能用现有执行模型目录代替设置候选。固定版本的原 `ProviderSettingsFacade` 在 `packages/provider/src/facades.ts`，草稿写入语义在 `config-service.ts`：

- `createPersonalProvider` 立即持久化无凭证/无模型草稿并返回 `{providerId,view}`；未完整配置仍显示在 Settings，执行 Registry 只收完整可执行项。
- 保存稀疏 provider overlay，保留未编辑叶子；omit Key 保留旧凭证，新 Key 加密替换，明确 clear 移除凭证。所有读面、通知和 mutation response 剥离 Key 与 headers 值，返回真实 presence；禁止伪 Key/星号占位。
- 模型 add/rename/delete/reorder/enabled 和 `savePersonalModelDraft` 更新成员、顺序、精确配置必须原子化；`basedOnRevision` 作冲突检测。删除后迟到保存必须拒绝而不重建。
- Settings View 的 revision 是整个 workspace Registry 的单调修订，持久 mutation 成功后推进，commit 后广播相同 View；没有配置变化的 refresh 不增修订。禁止 Date.now、数组长度、各实例 revision 求和。
- 原 Key 表单依赖旧明文作脏比较，宿主不回读后必须在原组件增加最小 presence/明确 clear 接线；不重新手写供应商 UI。

KenFutWork `modelProviders` 持有身份、workspace 隔离、加密和真实实例库，扩此聚合承接上述语义。草稿切片已新增前向迁移 `20261002210045_provider_draft_registry.sql`：凭证允许真实 NULL，读面 hasCredential 反映实际配置；workspace 修订随配置写入同事务推进，探测缓存及同值写入不推进。原宿主已接无 Key/无模型的创建、读取、刷新和删除。既有 HTTP create/update 仍要求完整实例；完整原 overlay、模型原子操作/CAS、顺序、通知和凭证 clear 继续实施，不另建明文 ZCode 配置文件或第二套模型真相。原 `providerFacades` 的原样 serializer 会含 Key，不能直接跨网络返回。

草稿公开 RPC red（未实现时 501）→green 已在独占临时数据库验证，含创建/删除 revision +1、读取/刷新不增修订、不可执行和凭证不回读。72 条迁移空库重放、历史 SHA、二次 no-op 和实际可空字段检查通过；server 1478 回归、server 类型检查与 25 项 workspace/API 门禁通过。该切片只证明空草稿链路。

后续快照/通知切片已将完整实例配置与 workspace revision 合为单一 MVCC 查询；模型目录只补该快照的元信息，不二次查询实例。原 Settings 保留停用供应商与模型，Selection 按实际启用与凭证资格过滤。create/delete 提交后向 owned SSE 广播原两服务的 `onDidChange`，数据与 mutation response 同源。两条新增公开宿主测试分别从缺失通知、误把停用模型标为可执行的 red 到 green；包含同值保存不推进修订。其他保存入口的事件、全量 overlay/CAS 与原表单仍继续实施。

Provider 保存切片已接 `savePersonalProviderOverlay`，复用原 ProviderConfig parser/overlay，保留 API 格式、品牌、Key 管理地址及未编辑字段。前向 `20261002215830_provider_code_settings.sql` 只保存非敏感扩展叶子，DB 约束禁止 Key、headers、endpoint、模型成员在扩展列复制，原规范列仍唯一属主。显式 Key/null 清除与 headers/null 清除、真实 credentialConfigured、提交后原通知和删除后迟到保存 404 已通过公开接口；原 Key 组件 presence/明确 clear 与模型完整操作/CAS、模板基线仍继续。73 条空库重放、历史 SHA、二次 no-op 和实际 schema 约束检查通过，迁移执行后不可修改。

原 Key 控件的宿主接线已完成：原 Input/Button、卡片/投影/稀疏保存链保留，增加可选 credentialConfigured 与原按钮的明确 clear；不返回旧 Key、不用假星号。按 Key 草稿修订和 providerId 只清成功提交且未继续编辑的字段，失败、重试、迟到应答不覆盖新草稿。原模型/Provider/View 类型从 packages/shared 直接导出；9 处允许偏差逐项登记，3051 来源校验零漂移。原组件操作 red→green 及三项回归、全量 pnpm test/typecheck、原 UI 构建通过。隔离真实数据库的完整原页面验证创建→保存→空输入/真实 presence→clear→刷新；截图见 `验收/Code模式ZCode/原供应商只写凭证.jpg` 与 `原供应商凭证清除.jpg`，仅使用无外部效力的测试文本，未验证模型执行。模型原子操作/CAS、模板基线与全局能力显隐继续实施。

完整模型设置/错误横幅的云能力显隐：沿原 ModelProviderSection、导航/权益 Hook、套餐入口和 ChatErrorBanner 判断宿主能力，未提供云账户时不展示预置账户/套餐、不查询凭据/权益、不显示“正在查询套餐”，保留原自定义供应商及配置操作。没有声明能力的原宿主仍保留原套餐入口语义。两项原组件操作 red→green，Web 374 回归/类型与原 UI 构建通过；真实完整页面截图 `验收/Code模式ZCode/原设置云入口隐藏.jpg`。此证据不覆盖自动化/CUA/远程等能力。

原模型解析/添加宿主切片已接 resolveModelConfig/addPersonalModel。原推荐 JSON 内容不变，移到 modelProviders 域；原 ModelConfigRules 负责精确/手动合成。配置与模式标记保存于实际 models 成员，不另存一套 UI 模型；运行侧容量由同一规则推导。公开接口覆盖原通配推荐 200000/32000、个人覆盖 256000/8192、Unicode ID、刷新恢复、并发成员不丢失、同键一次成功/409、删除后迟到添加 404。六项供应商/模型 integration、server 1478 回归/类型、25 门禁、3051 来源校验通过。此切片未证明原模型保存/CAS、启停/改名/排序/删除、指定模型测试或真实模型执行完成。

只读审计基线仍为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。上述缺口说明当前模型读取冒烟不证明原设置写入完成；服务接线验收必须覆盖空草稿→模型配置→写 Key→真实 executable、清 Key、删除最后模型、并发/CAS、通知和刷新恢复。

原模型草稿保存/CAS 切片已接 `savePersonalModelDraft`：改名、精确规则和成员位置同事务写入，保留兄弟模型；所有 HTTP/原宿主配置写入口统一先锁 workspace revision，再修改实例。公开宿主从 501 red→green，验证原成员改名与 260000/9000 配置、同修订重放/并发、跨供应商过期修订及目标重名均不部分写入。七项原供应商/模型 integration、server 158 文件/1478 回归与类型检查、25 workspace/API 门禁通过。恢复智能规则的空配置语义、独立成员操作与指定模型测试仍未完成，不能认定模型设置完整。

恢复智能规则已补齐：仅导出原 `isStructurallyEmpty` 供宿主复用，原函数不变，偏差登记来源清单；recommended + 结构空配置不持有个人精确规则，Code 模型身份仍保留，继续从原推荐推导容量。同值重存不增修订，手动空配置仍按原 schema 拒绝。公开接口 red→green 与八项供应商/模型 integration、server 1478 回归、全量 typecheck 通过；原完整模型弹窗实际完成添加 260K→重置表单→保存 200K→刷新，截图 `验收/Code模式ZCode/原模型推荐恢复.png`。此证据不代表启停/删除等剩余模型操作和真实外部模型执行完成。

#### 验收进程与文件审计

- 本任务临时 API 3301、生产静态 preview 3300；只连接现存开发 PG，不管理其生命周期。开发主服务监听源码变化时可能停/起 PG 并换端口；临时回环转发 3332 跟随当前 PG 端口。临时脚本位于 `/tmp/ken-code-api.mts` 与 `/tmp/ken-code-db-proxy.mjs`，不入库；先检查实时监听再使用，PID/exec handle 不作为长期事实。
- 公开接口命令：`RUN_CODE_UI_INTEGRATION=1 RUN_CODE_UI_MODEL_SMOKE=1 CODE_UI_TEST_BASE=http://127.0.0.1:3301 CODE_UI_TEST_ORIGIN=http://localhost:3300 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/host.integration.test.ts`。测试临时建项目/目录并归档清理。
- 前端浏览器验收目录 `/tmp/ken-code-ui-browser-6T6wxE`（临时项目 id `f6387289-4da8-44c2-ac94-96aea078984a`）尚保留供后续交互，需要结束时清理；不恢复或迁移其他旧调试数据。
- 本轮审计发现 121 个 `apps/server/data/checkpoints/` 影子 Git 运行文件并补忽略；约 3109 个新增/修改源文件与必要资源应入库。dist/types/host/design 编译产物、node_modules、public/code-ui 静态产物、.env.local 已被忽略，凭据模式扫描 0 匹配。不能忽略原源码、图标、许可证、契约、来源清单或前向迁移来减少文件数。

原模型启停已接 setPersonalModelEnabled，事务内只叠加最新 enabled，保留手动/智能模式与全部精确叶子；停用成员仍在 Settings，移出 Selection，同值保存不增修订，未知成员 404，非法布尔 400。公开接口 501 red→green 与九项真实 integration、server 1478 回归/类型通过；原开关实际停用并刷新仍未选中，截图 `验收/Code模式ZCode/原模型停用.png`。改名/排序/删除、连通性与其它设置仍继续。

原模型删除已接 deletePersonalModel：同事务删除成员与精确规则，保留兄弟模型；并发删不同成员不丢失，刷新不复活，迟到的保存/启用及重复删除返回 404，非法空 ID 400。十项真实宿主 integration、server 1478 回归/类型通过；原删除按钮实际删除最后成员且刷新仍为空，截图 `验收/Code模式ZCode/原模型删除.png`。临时 API 重启后原 SSE 连接关闭仍需手动重载，此缺口尚未修复，不能计为断线自动恢复通过。

通知恢复前置策略已接：新增前向 20261003035733_code_ui_reconnect_setting.sql，workspace_settings 库值优先于 env/default，原 hello 不改，宿主 ready 单独提供 reconnectDelayMs。公开宿主测试覆盖真实持久化、刷新、ready 读面与非法范围拒绝；74 条独占空库重放、历史 SHA、二次 no-op 和实际 schema 约束通过，迁移执行后不可修改。

API 单源链已生成 SSE 媒体类型与完整原快照引用组件；不裁剪原契约。Apifox 批量导入曾因内联原快照过长失败，改为原 snapshot/row/toolCall 实例的复用引用后，同一 AI 分支 ai/20261003-from-main-code-ui-recovery 最终接口/schema errorCount 均为 0。该分支主线合并仍需用户确认；并不代表整个 Code UI 验收或 PR 完成。

HTTP 通知恢复接线已完成：物理断线先转原 unavailable，新连接沿同一客户端握手、刷新原两种模型 view，再转原 restarted/available；原 transport 与 SessionDataLayer 自行清 ownership/重订阅。四条宿主测试含同主/子连接、独立恢复、子面板释放、认证失败和关闭取消；原组件的外部 HTTP 夹具补真实通知握手，没有改组件。全量 web 378 测试/类型、原 UI 构建、3051 来源核对通过。真实页面主动切断一条预览通知流，在离线窗口更新供应商，原设置页无需重载/刷新便追上最新 view；截图 验收/Code模式ZCode/原通知断线恢复.png。此证据不代表实际 Agent 运行断线、全部命令对账、长会话或视觉全矩阵已完成。

原 DirectoryBrowser 的 readdir 已接真实 FS 元信息；原组件、隐藏开关、错误显示与图标保持原件。共享接口导出原 FileEntry 和参数 schema，宿主复用既有 Project 本机路径校验；不放宽正文读取的归属边界。公开接口 501 red→green，十二项宿主 integration 通过，包含隐藏/Unicode/空目录/符号链接/损坏链接和不可用路径。真实原弹窗导航及隐藏切换已实证，截图 验收/Code模式ZCode/原目录浏览.png。目录选择后的 Project/主画布绑定、最近项目写入与实际 run 工作目录继续实施。

目录绑定切片已接原 platform.activateOrSetWorkspace → workspace.open → Project 聚合与固定主画布。真实路径规范化后按目录身份复用；冷并发、目录 symlink/.. 别名同一项目，同名不同目录各自独立。recentProjects 沿原 setting 接口持久化，过滤已归档目录，非法归属写入整条拒绝；前向迁移 20261003060836_code_ui_recent_projects.sql 已执行，禁止改写。原 DirectoryBrowser 仅拓宽异步宿主回调并沿用原 loading/error 状态，原 Root hook 可把选择错误交回宿主，失败不关闭弹窗。源码偏差登记且 3051 项零漂移。

十三项公开宿主 integration、原组件失败/重试 red→green、pnpm test（15 任务；web 64 文件/379 测试）、pnpm typecheck（12 包）及原 UI build 通过；独占临时库 75 条空库重放、历史 SHA/缺失零漂移、二次 0 条与实际 text[]/NULL/default 核对通过。原完整页面中文目录选择、刷新恢复、归档错误保留弹窗实证见 验收/Code模式ZCode/原目录项目绑定.png 与 原目录绑定失败.png。两根真实会话共用该主画布已通过，实际活动 Agent/child 工作目录与工具运行尚未验证；整体目标 active。

当前验收使用本任务独占临时 Postgres/API 3341，经回环转发 3301 与静态 preview 3300 接浏览器，不管理共享开发 PG。临时数据和脚本不入库。工作树审计的剩余源码、测试、迁移、文档、许可证、截图及参考指针应入库；依赖/构建/本地凭据/运行数据已忽略。并行 Agent 的 README/许可证/调研与参考指针不由本切片代提交。

宿主能力显隐已接原平台接口：当前未接通的自动化/嵌入浏览器/CUA/远程工作区明确关闭，原组件、设置分区、统一远程门与 CUA 前置平台门消费支持态。自动化的原侧栏、分组入口、主视图、草稿/行上下文回调、Cron/OffPeak 跳转按钮和闲时通知轮询均受门控；保留工具结果正文与全部原实现供后续接通。原设置隐式跳转到隐藏分区保持当前可见页；未声明能力的原宿主语义不变。原接口/schema 从 shared 直接再导出；10 处偏差登记、3051 来源零漂移，原装配/CSS 不变。

原完整 App 与原组件用户操作 red→green 覆盖额外闲时查询、Windows Web CUA 插件查询、工具卡按钮、设置跳转及默认宿主点击。pnpm test（web 381 测试）、pnpm typecheck、原 UI build 与双轴审查通过；真实页面证据见 验收/Code模式ZCode/原能力显隐主界面.png、原能力显隐设置.png。完整 lint 的既有 Agent/Computer Use 错误仍未通过；插件市场/设置服务、核心运行交互、活动 Agent/child、完整视觉与 Design 验收继续，不以能力显隐代替完整接线。

根停止切片已接原 stop 命令与既有 cancelRun。固定原版 expectedForegroundExecutionId 变化返回 noop/guard.stopTargetChanged，无目标空闲停止 accepted 且快照不变；命令 ACK、关闭状态和重放同事务。启动句柄登记与停止共用根锁，延迟登记期间已停止的运行不再执行模型；命令裁决在根锁后锁定活跃 Code 项目，归档先完成则拒绝迟到请求，不记录 accepted。旧事件回写用当前权威 runId，避免污染新一轮。没有修改原 UI 装配、Agent 核心、历史 SQL 或 Design。

五项真实数据库/DeepAgents/本机模型替身接口测试通过，覆盖空闲/重放/对账、流式真取消、迟到停止、新 ACK 后旧取消结算、启动前取消及在途归档；延迟场景以独占 PG 作外部故障注入，行为断言仍走 HTTP/SSE/模型边界。基础命令：RUN_CODE_UI_INTEGRATION=1 CODE_UI_TEST_BASE=http://127.0.0.1:3341 CODE_UI_TEST_ORIGIN=http://localhost:3300 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/stop.integration.test.ts；三个延迟场景还须以环境注入独占 CODE_UI_TEST_DATABASE_URL，实际验收已注入并全部通过，不输出连接凭据。

最终 pnpm test、pnpm typecheck、server build、pnpm api:spec（生成零差异）、来源 3051 零漂移及范围 Biome 通过；原默认并发出现的既有 Vitest 日志 RPC teardown 未计通过。VITEST_MAX_WORKERS 被 Turbo strict 过滤，server 单一测试资源配置改默认 maxWorkers=2 后标准命令退出成功，CLI 可覆盖、不忽略错误、不改业务绕过。原页面点击停止后显示原“已停止”；刷新后从原目录重开可恢复两轮转录，证据为 验收/Code模式ZCode/原停止运行中.png、原停止已取消.png、原停止刷新重开.png。静默模型替身触发既有停滞保护的错误状态另存原模型停滞错误.png，未将该次超时冒充按钮取消。新任务/标题热同步和刷新自动焦点仍待原 controller 接线；子独立停止、队列/权限/提问等其它运行面与完整视觉/Design/GLM 工具验收继续，目标 active。


原 Controller 读面切片已搬入 desktop/host 的 windowHostControllerService、Projection、SessionsIndexObserver 与许可证，原件零偏差。宿主只提供真实 Task/Agent ProxyChannel、工作区目录和 owned SSE 载体；不重新实现集合/标题/游标。首输入事务后广播 task_created，原目录无需刷新即可重读任务；空 thoughtLevel 省略符合原 schema。每个外部连接独占 Runtime/源订阅，关闭释放，非法目录和跨连接/释放后 resync 拒绝。原帧先于 ACK 的装配保留。源码清单 3055 项漂移 0，范围 Biome 与全量 test/typecheck/build 通过，api:spec 生成零差异。真实数据库 Controller + Stop 共 9 项通过（目录查询在途关闭公开接口 red→green，迟到订阅 404 且无 ACK），原完整页面在桌面验收视口（截图 1248×900）连续新建两任务后，项目侧栏立即显示任务与标题，停止后保留转录，证据为 验收/Code模式ZCode/原目录任务热更新.jpg。分组视图此次仍为空，不计验收通过；Controller mutate/search、断线租约恢复、刷新自动焦点继续实施。完整 lint 的 Agent/Computer Use 既有错误未通过，整体目标 active。


Controller/Task 目录恢复已接真实 HTTP 连接换代：原 Controller registry 不消费 Agent lifecycle，故宿主在握手与模型 view 追平后换真实 Controller proxy，更新原 ServiceProvider 与 base services；Agent 等代理保持稳定。项目视图的 Task 左表沿原 membership 版本函数重读，补断线期间丢失的成员事件，不伪造事件或另写目录投影。公开原 Hook red→green 覆盖全局目录两次断线、空 sessions-index 下项目成员恢复、恢复握手/view 的 401/403 立即拒绝与不重连；与主/子会话原恢复共 10 项通过。原完整页面暂停通知、真实命令创建独立Task、恢复后目录自动补入且正文保留，原停止按钮显示已停止；新连接两类Controller租约经200/原ACK记录对账，公共快照确认停止终态completedInterrupted，见 验收/Code模式ZCode/原Controller重连租约.json 与三个原Controller截图。首次场景的静默模型停滞错误未冒充停止成功，最终场景已真实点击。源码 3055 项零漂移，未改原registry/Hook/UI装配或后端核心。分组/mutate/search、刷新自动焦点和其它运行能力仍未完整接通，整体目标 active。

原 App 装配审计已确认：host/main.tsx → RootWorkspaceContent → memo(App) → WorkspaceShellLayout 保留完整消息流、主/子SessionPane、设置覆盖与两栏，不应再写一套App。下一步直接复用原Root的缺失非云生命周期：RootShell（Alert/Confirm）、useRootPlatformEffects、useTabPersistence、fileDisplay base path与初始Task定位；设置引导的可见入口需真实consumer或按宿主能力隐藏。不得扩充WorkspaceHost仿写RootInner，也不得把web-remote-replayable伪装成desktop-continuous以绕过恢复规则。


原 Root 设置前置已接完整原 AppSettings get/update：仅真实非敏感 UI 偏好保存到 workspace_settings.code_ui_app_preferences，recentProjects 原列仍为单源；原 schema 校验，单 MVCC 读取和原子稀疏 merge。Project 引用在写入中持有活跃 Code 行共享锁，归档先完成则无部分写入。归档 tab 过滤同时重映射激活索引/清焦点；最近项目沿固定原 UI 去重/前10语义。新前向迁移20261003153631已执行，不可再改；76条空库重放、历史SHA、二次no-op及实际JSONB/NULL/default/约束核对通过。6项公共设置 red→green及现有宿主/Controller/Stop合计31项通过，真实GLM一项未启用。旧recent四个死接口已删除，写参数改具名对象；原Root尚未直接挂载，云能力门/默认工作目录/onboarding及运行偏好消费者继续接线，不以设置存储代替完整设置/UI验收。

原 Root 直接挂载切片已接入：host/main 删除自有 WorkspaceHost 与重复 Provider 装配，直接消费固定原 Root→RootWorkspaceContent→App→SessionPane。原 RootShell、全局提示/确认、目录/设置覆盖层、快捷键、tab 持久化与文件显示基准沿原生命周期运行。真实宿主身份与 hello.clientMode 透传；Code store 保持 coding，原 office 菜单仅导航 Design。无云宿主停止 OAuth/旧账户迁移/套餐查询；未接引导、设置导入和运行偏好服务按可选能力门关闭，保留原实现与缺省行为，后续需接真实 consumer。

file.ensureConversationWorkspace 按真实 Workspace 身份在配置的 sandboxRoot 下建共享目录，经既有 Project 服务绑定单一 Code Project/固定主画布；不造空路径、不转换旧数据。全新独占库冷并发只创建一个目录/Project，warm 重放保留身份和文件；归档后的迟到 ensure 返回 409，不复活。原目录选择 await resolvePath 与绑定成功后才关闭，失败在原错误区保留重试；同源父工作台和 Code 文档自身 reload 均保留原恢复资格，普通冷启动不误判。

公开组件 red→green 锁定默认/指定目录、目录失败重试与规范化、原全局提示应答；真实默认目录接口验收命令：`RUN_CODE_UI_INTEGRATION=1 CODE_UI_TEST_FRESH_DATABASE=1 CODE_UI_TEST_BASE=http://127.0.0.1:3341 CODE_UI_TEST_ORIGIN=http://localhost:3300 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/conversation-workspace.integration.test.ts`。该用例归档自己创建的默认项目，只允许全新独占开发库，普通测试默认 skipped。真实页面经 DeepAgents 与本机外部模型替身验证默认目录运行、父工作台刷新恢复并停止、⌘N、独立文档自身刷新、原设置保存和跨文档读取、原菜单导航 Design 的 canvas iframe。不把这些证据认定为 GLM 工具链、原版全场景对照或完整 Design 画布验收。

原主标题已接真实轻量元信息。此前目录标题正确，但原 active header 的 session/readSession 尚未接通，导致显示“新建任务”。宿主明确 `sessionMetadataSource: task-index`，原 Hook 消费原 Task.getTaskMeta；原标题组件、App、SessionPane、消息原V4数据层与renderer无改。元信息来自同一真实Code快照，按Workspace/Project归属读取；不构造第二套消息DTO，不兼容旧调试数据。未声明策略时保留固定原session snapshot/converter；取消、空与失败分支仍沿原生命周期。原契约/Schema直接从shared再导出，定义仍属固定源码，无HTTP/WS schema变化。

原插件市场库存读面已接通：Definition 的 `readPackageInventory` 保留真实 installed 与 enabled 的区别，Provider 读取本机记录与自带 bundle，Code Consumer 沿原 `plugin-management` 两个读取方法输出原协议。未把内核 feature 装成市场包，未把工具装成 MCP，未改原 Page/store/card/detail/CSS。项目层配置尚未接通时返回明确诊断；安装、卸载、启停、describe、来源维护等写面仍待实施，不能计为市场完成。公开读面 red→green，真实安装→停用→原库存→卸载通过；损坏 JSON、错误 installed 类型、缺失必需安装字段均从假空 200 改为明确 500，恢复原文件后读取成功。原组件测试使用外部 HTTP/SSE 替身，按原名称格式化显示 Probe、版本 1.2.3 与原详情，不误报未安装或孤立。真实独立宿主经原目录选择器绑定隔离目录后，在原个人分段显示五个真实自带包，截图为 验收/Code模式ZCode/原插件市场真实库存.jpg；公开分段仍沿固定原版官方市场身份，不把本机包冒充 ZCode 官方目录。

完整集成调用：`RUN_CODE_UI_INTEGRATION=1 CODE_UI_TEST_ISOLATED_PLUGINS=1 CODE_UI_TEST_BASE=http://127.0.0.1:3341 CODE_UI_TEST_ORIGIN=http://localhost:3300 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/plugins.integration.test.ts`。隔离插件标记只允许本任务独占临时宿主，不得在共享开发插件目录执行损坏库存测试。全量源码、视觉、运行交互、GLM 工具链和完整 Design 验收继续。

原包操作切片：自带包安装、用户层启停、彻底卸载已接既有注册服务与管理员门；原卡/已安装管理/开关/确认弹窗均未改。原完整params/result schema由shared再导出，扁平宿主寻址只转换workspace引用；原启停结果的顶层enabled与plugin同时返回。并发两包安装曾均200但只剩一份记录，公开接口red→green后所有旧HTTP/原Code/工具写入口共享宿主库存队列，失败不毒化队列，JSON以临时文件原子替换。真实managed用户读取200、三项变更403；local-trust仍消费既有管理员策略。

浏览器在独占临时PG/API通过原安装按钮、原User开关与原确认弹窗验证安装→停用（数量仍1）→卸载（数量0/安装按钮恢复）；证据为原插件按钮真实安装.jpg、原插件开关真实停用.jpg、原插件确认真实卸载.jpg。数据库重启前的旧目录上下文未作兼容，使用原选择器重建当前临时库的真实绑定后验收。仍未计为完整来源/describe/项目覆盖/更新/取消操作或完整市场验收。完整调用：`RUN_CODE_UI_INTEGRATION=1 CODE_UI_TEST_ISOLATED_PLUGINS=1 CODE_UI_TEST_BASE=http://127.0.0.1:3341 CODE_UI_TEST_ORIGIN=http://localhost:3300 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/plugins-actions.integration.test.ts src/features/code-ui/plugins.integration.test.ts --no-file-parallelism`；多个真实库存文件故障场景禁止并行，以免测试互相覆盖。managed权限用例另需注入独占CODE_UI_TEST_DATABASE_URL，令牌/连接地址不输出；该用例创建独立插件目录、真实注册用户和完整managed app，不mock内部权限服务。

原安装重放沿用用户停用选择，Definition的activation明确区分ensure-package与原HTTP安装启用意图，Code选择preserve，Design入口原默认启用不变。原removeCache=false卸载保留缓存/数据，移除安装/贡献并返回enabled:false，默认彻底卸载行为不变。宿主真实ready等待原插件恢复；preClose等待全部恢复/写队列和卸载释放，关闭后拒绝新变更。完整app/真实TCP断开/外部阻塞包夹具公开关闭回归已red→green，不再使用void shutdown冒充释放完成；命令 `RUN_CODE_UI_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/code-ui/plugins-lifecycle.integration.test.ts --no-file-parallelism`，需另以环境安全注入独占CODE_UI_TEST_DATABASE_URL。

自带包的真实重启恢复已锁定：禁止第三方的宿主仍装载原命令安装的可信自带包；可信性必须同时符合安装source与本次自带目录id，不能只按名称/id。公开完整app关闭重建后，自带路由200及实际注册工具导出可读；同名URL包不恢复，原启用接口也明确失败，不绕过实际策略。原目录的enabled配置不作为运行恢复的充分证据。本项未改原GUI或引入自有卡片，详情与完整插件发现仍继续。

自带目录统一采用原安装器的ID规范化，包括scoped npm名称。原overview与安装记录按同一稳定id关联，资产、恢复与启用不另猜身份；公开scoped包目录installed:true、重启路由和启用均通过。与自带同名同id的URL来源包仍被策略阻止，不以目录命中替代真实source。


BYOK 零供应商空态已补齐：supportsCloudAccounts:false 关闭云账号后 presetProviders 恒空、preset 分组整组移除，零自定义供应商时导航项为零，原 Detail 的 !selectedNavItem 分支（上游仅作加载期兜底，上游稳态必有预置项）把合法稳态渲染成永久加载占位。现 ModelProviderSection 在非加载且导航为空时改渲染 EmptyState 引导卡（「还没有供应商」+「添加供应商」，复用原 ProviderTemplatePicker），加载期原加载卡语义保留。源码偏差登记：ModelProviderSection.tsx（空态分支接线）与 zh-CN/en-US locale（新增 settings.modelProvider.emptyTitle），清单哈希同变更更新，漂移 0。

---

## Code界面阶段同步记录


### 2026-10-04：固定UI分支与Task内核双亲合并

先按功能完成17批提交至`6e746f55`，再合并原UI固定`29fb8c09`；60处冲突按双方意图融合，保留原Root/主子SessionPane/品牌、资源删除与CanvasWorkbench提取，保留Task/Project UUID、固定Task根、权限与配置代际及终端/附件消费者。删除被terminal-api取代的code-git-api与旧panel-layout测试；第二settings/model config写面未复活。历史迁移均保留原字节。

合并后全量test（web449/server1866/shared90）、typecheck、Code/Design与Web/server构建、API生成和文档门禁通过；独占临时PG上compact FIFO、完整rewind、卸载及Controller/设置竞争5条通过，TaskWork迁移重放/no-op3条通过。3027项来源零漂移，Kimi登记源码逐项SHA验证；第一方改动安全format/import整理不改vendor字节。现存20项历史lint错误保持common base字节，未声明全lint通过。

这只证明合并与上述行为，未证明全部原UI操作/1:1视觉或Design完整回归。新引入默认skip的HTTP fixture仍有路径替UUID/旧Canvas/缺hello及外部DSN问题；下一切片改显式client与独占临时PG/random端口，再继续describe/list真实组件、队列/权限/结构化提问/子停止和历史编辑/分叉。权威施工清单仍见《Code内核实施交接》最新节，原UI交接的“主链已替换但未全部验收”结论保留。

### 第1阶段：原能力显隐、目录等待、URL模式

来源：`e58fe8ce029be5ea0462fdf9d6e8a3c599b05fe5`；以基线`65d1097ec398c0c8bb42f38816f4033a98ad109d`到来源提交的精确hunk同步，未整体cherry-pick。

- 原平台5项可选能力及原App/设置/侧栏/卡片守卫；未声明保持原行为，Code宿主仅声明实际接线。
- DirectoryBrowser等待项目绑定结果，失败保持选择器与可读错误；目录metadata仍走Human-only lane。
- SessionPane仅接自动化可用性守卫，保留Task附件预算与V4传输。
- 父工作台仅补Code/Design URL初始化和导航，Design/Flow主区逻辑保留；不接受裸Flow URL作为插件安装态。
- TaskWorkspaceRegistry、terminal activate/listeners、watcherId、Uint8Array、provider keyPresence/Native协议/模态及附件同键预算链保留。

验证：`pnpm --filter @zcode/shared build` exit0。单runner8文件首轮7文件21个用例通过、1个suite仅fixture共享包import无法解析；只修fixture import后该文件2个用例通过。累计23个用例通过，未重复broad。命令：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-cloud-capability.test.tsx test/code-cloud-settings-capability.test.tsx test/code-host-feature-capability.test.tsx test/code-directory-open.test.tsx test/workbench-modes.test.tsx test/code-host-channel.test.ts test/code-task-workspace.test.ts test/code-workbench-frame.test.tsx --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-host-feature-capability.test.tsx --maxWorkers=1
```

以下为源blob/SHA256；当前复制SHA由`packages/third-party/zcode/来源清单.json`单处持有。

| 文件 | e58 source blob | e58 source SHA256 |
| --- | --- | --- |
| apps/web/src/components/workbench/zcode/App.tsx | 5bd6a6b2222d9a244b44edea31fba1cdb72ae10d | 5965100a3e79e89da85d93ea6ebb89f6c6b9800365a90274873ac3fcf514b3c0 |
| apps/web/src/components/workbench/zcode/ChatErrorBanner.tsx | 0f782c827a992dfb27b30dda77ed2a8b49ae1254 | bd5dd19b0d16329588ab5de2c4ca5cc74cfecd1493f9c84cff74dfa8947c21a6 |
| apps/web/src/components/workbench/zcode/SettingsPage.tsx | 904ccbeb282d4b7d1406d351803c9a47401c9bfd | d6faf56deabb98bb3f46380f7919f5c25b326f60ed72a0ba6a29fe137859a0bf |
| apps/web/src/components/workbench/zcode/WorkspaceSidebar.tsx | 32f8a06ee137cfd4d19123e0d1220cd26275233b | ba936a62ca192934c79092e0ce4d36ed2fb011bd4e2b5de5b2dede3fd2201c50 |
| apps/web/src/components/workbench/zcode/WorkspaceSidebarFooter.tsx | 00d61371f7f3c8e2c8d61e3da629818b44205c03 | d629e1a425137083914bb23793ec685f07d8faee02bd1b869781caacd4acc604 |
| apps/web/src/components/workbench/zcode/WorkspaceSidebarFooterUsageSummary.tsx | 7b3046f9e75676f1f51e4f1a992e61754884d3cf | 8d28e70c09d8153b310d40354865d4e5b512241c15b90fa3156f5951e40258a2 |
| apps/web/src/components/workbench/zcode/hooks/useCodingPlanEntryPlanList.ts | e44961d78053e8b780bfc506d8addc5ca4d89ada | b22fefe89b30c6a9e49c3f59d1f6975ce7f5272edcc305d4b0e36fff0620adef |
| apps/web/src/components/workbench/zcode/hooks/useRemoteConnectionEntryVisibility.ts | 63a6e5b6364563cd385cdae85d2bcffc71af3070 | 9d51bdbf9b04245952b26e043c9bbce859093aa535cd65461d762c43d3f3ab0e |
| apps/web/src/components/workbench/zcode/settings/CodingPlanEntryButton.tsx | 977ecef2f8b16c9bca9a1d7ff37fac4b172889b5 | 223a0265ad00f9bf4912dd0376d6749a88b90d703eff9d6a80c39b98c7ca3f70 |
| apps/web/src/components/workbench/zcode/settings/CodingPlanUpgradeDialogProvider.tsx | f8d40ebe33a79a5a283e4b03691ce1e0e8ea80c1 | f6af7a7786eb2cce3e970a7ce7d019862f472474e4e848135e19c96f66694ea2 |
| apps/web/src/components/workbench/zcode/settings/ModelProviderSection.tsx | a30fb44b22c1f9ed4e872b256012a484a2fa6797 | 8f25c623cccdb45f91cd85cee690e697319f8956d1cffe3ff77c3041d2ce3d17 |
| apps/web/src/components/workbench/zcode/settings/model-provider-section/useModelProviderNavigation.ts | fcbbf927546230bc32fca487206a0002bf028e92 | 7e55c1341ec8a9fdc69c9b2ad24df47ab9d2dff3bd9d2af999715d30c0f4dd9f |
| apps/web/src/components/workbench/zcode/settings/settingsPageConfig.ts | b8343e745289597440d8bba540db03f0d25f5da8 | cf9f15a59edbbe068d6510357f4645f8e3a769b5967994eb18f331d6f9ba5d55 |
| apps/web/src/components/workbench/zcode/lib/cuaPlatform.ts | 25b982e2ec5abcd0ba0e04743493c4e56d5893db | c815992e6b47e40d361ff72530cd8d1a2db795574998f12239716bf6786e4e1c |
| apps/web/src/components/workbench/zcode/DirectoryBrowser.tsx | 50b4a8a4adabf748dbebd96419129fa4d4f6f2fe | 597bc464509c2e2a4a4b2cb27385249fcc0d4adeb11e7f6cf1f20b1a56c649e3 |
| apps/web/src/components/workbench/zcode/root/useRootWorkspaceActions.ts | 011330d0feab04c17464e3d4cc4eddb1c774b943 | 8fbe3d73d30ca6037b2a7fccedf5b88294d3c88e004c1acc2aab68e75b315837 |
| apps/web/src/components/workbench/zcode/ToolCallBlocks/renderers/cron-create.tsx | f7eb278e10eae67c2e80456bcf25b5967ba85481 | 8dd18b0b803f0dc8cb9eab7a387dc7432cb3877e119948a0a0722cb0f050cdae |
| apps/web/src/components/workbench/zcode/ToolCallBlocks/renderers/offpeak-create.tsx | 01d81b41e8acebf0a91373f1db8d7204819ce5f4 | 584036baf8ff87e1b8dd333a0bc5043533f9c2b25f767d04dd450435ed656e7d |
| apps/web/src/components/workbench/zcode/v4/SessionPane.tsx | 3ce202afa3cd1e7b1cde1652f47c6e6451c6a7d6 | 231ebee6ecda8977d72bd81fafb36e357aa0aad58ef7b7837df4f58104a724c7 |
| packages/zcode-shared/src/platform.ts | 59ed9fef53f574ff6f42ca4f44f30ce339fb00fc | cce231dfeca3241f1a2ad8309fe7ab2118e54a5cf269421fa3fb976f9b158315 |
| apps/web/src/components/workbench/zcode/i18n/locales/en-US.ts | 8b57627e81470fac8b1e541c5778692856477386 | 044909e8dc6bf1ba1ce088af74b9837ac425e6267500d98d8cbf3ceacaecda30 |
| apps/web/src/components/workbench/zcode/i18n/locales/zh-CN.ts | 9abada12f0b957978bdff359d6b52b8ce68ebdfc | a8d064a8f5d673aaeed7fd85b6afc1ca5383eb4d7f894605195438830d1415ee |

### 第2阶段：Controller与通知恢复

来源仍冻结为`e58fe8ce029be5ea0462fdf9d6e8a3c599b05fe5`。沿用原SSE解析、hello恢复、模型视图刷新、Controller代理换代与原membership版本链；命令、终端写入和附件不重放。

- 主React树用`useSyncExternalStore`观察服务快照，原工作区服务注册同步换代。宿主`workspaceServiceController`经原RemoteWorkspaceSession/identity绑定链给可信source挂HTTP service attachment；原UI按identity识别服务目标的行为保持。
- `TaskWorkspaceRegistry`从真实Project DTO/Task meta建立Project UUID与固定根目录关联；`workspaceIdentity = JSON([ProjectUUID, fixedRoot])`仅作为公开索引键，客户端与服务端都不能从调用方字符串解码权限。
- 同目录项目必须有明确身份；path-only匹配出现歧义即不推测项目。刷新项目默认目录不能重绑旧Task。
- `onDynamicControllerFrame`与列表结果观察真实Task meta；`projectId`须由共享schema保留。动态终端/文件watcher仍按原精确ID过滤。
- 重连延迟消费服务端`ready.reconnectDelayMs`，缺省与护栏来自shared治理值。401/403停止恢复并拒绝挂起调用。
- 原hook恢复回归已按真实UUID、qualified identity与旧Task固定根目录适配；新测试另覆盖多次恢复、不重放、refs引用计数、同根身份隔离与CRLF分片。

验证：公开`windowHostControllerTaskFrameSchema.parse`先实际RED（Project UUID被strip，期望真实UUID却得到undefined），随后仅扩`zcodeTaskMetaSchema`的optional UUID字段并按拓扑build。单runner10文件首轮31 passed/1 failed；唯一失败暴露qualified identity缺原attachment，完成上述宿主接线及稳定fixture props后只复跑相关2文件，9 tests全部GREEN、exit0。命令与收据：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-host-controller-recovery.test.tsx --testNamePattern '公开Controller frame解析保留真实Project UUID' --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-host-controller-recovery.test.tsx test/code-host-reconnect.test.ts test/code-host-channel.test.ts test/code-task-workspace.test.ts test/code-directory-open.test.tsx test/code-host-feature-capability.test.tsx test/code-cloud-capability.test.tsx test/code-cloud-settings-capability.test.tsx test/workbench-modes.test.tsx test/code-workbench-frame.test.tsx --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-host-controller-recovery.test.tsx test/code-host-reconnect.test.ts --maxWorkers=1
```

构建收据：`/private/tmp/kfw-code-controller-project-meta-build.log`；最后窄GREEN收据：`/private/tmp/kfw-code-client-recovery-current.log`。测试令牌已归还主任务，无live runner。

| 文件 | e58 source blob | e58 source SHA256 |
| --- | --- | --- |
| apps/web/src/components/workbench/zcode/host/httpChannelClient.ts | 632cb0c3dcf3c19431c050d2e0ab3c423e6b7929 | fad278de58b1f04de162610ccacd8da30146862f0cf0a6770c9b2f29d206a7cc |
| apps/web/src/components/workbench/zcode/host/main.tsx | 26c30be7e32d7fb4f0305364c9e6af5b95abedc0 | 2234e51aa28a445be86cd005640ef3943dcdf68f7c47583fc37305374f725170 |
| apps/web/src/components/workbench/zcode/host/workspaceServices.ts | 3f0b6a215d3b4d1bd55333b95b84512590e95311 | 89bb6a392ef02535323328f6f1b6cab4da801da5ac54f323ebba3cba3104e1d7 |
| apps/web/test/code-host-controller-recovery.test.tsx | 42cae050f5b6ea16d3d91850a584a37e9888f478 | bb88d2c0d84b57e5926684be62f52ba5886f27b1bf86fe1004c9682155bee91e |
| apps/web/test/setup/code-host-controller-http.ts | 1619b3844dbd4e77211cee9da0f8e8970052ec5b | 3e3f524586c0554868de01269d77ac6effab9f8c8862a59aaebb651242a1ccf0 |

### 第3阶段来源冻结与版权通知

第3阶段来源冻结为`92fad1ca182fcdd224d5f8f0c15ab4202d7b8754`，相对e58的前端增量包含原Root入口、平台能力守卫、默认目录与父文档reload恢复资格。该增量删除原自建宿主`WorkspaceHost`，其真实Project/固定Task根目录/new Task默认解析/viewer上下文已按下节收进必要宿主能力缝。

版权通知已独立按原字节同步：`apps/web/src/components/workbench/zcode/THIRD-PARTY-NOTICES.md`，1,978,939 bytes，保留原CRLF。冻结source与target SHA256均为`874bf7c10bdcadd0df0b50fc782f39f077669c6e41bbdbccd868409cd714dec3`，与原来源清单记录一致。

### 第3阶段实施：直接挂原Root与完整身份消费

已按上述冻结范围同步原Root/能力守卫并直接接入`host/main.tsx`，原自建`WorkspaceHost`及重复provider树已移除。没有整体复制donor main，也未带回旧Canvas后台。

- `activateOrSetWorkspace`的可选canonical path/identity由真实Project DTO供给，原选择动作按该结果开tab/草稿；目录失败继续由原DirectoryBrowser保留重试与错误。
- `resolveNewTaskWorkspace`在原新任务动作前只读取最新Project默认；Ctrl+N进入B的新qualified草稿桶，旧Task UUID/固定A保持。同根邻Project的既有桶不被清空或合并。
- Root在layout阶段安装明确viewer上下文，子组件首次文件请求前生效；读取失败继续拒绝，不切到另一Project。原Human目录服务独立注入，选目录不走当前Task的file.resolvePath。
- 原`file.ensureConversationWorkspace`的真实additive DTO经共享schema验证后登记Project UUID，并仅附原UI可消费的opaque identity；原对话选择/草稿及默认兜底全部透传该identity。该链不创建Task/Canvas、不签执行scope。
- 原onboarding/云账号/导入/运行时偏好等能力按宿主实际安装态守卫，未声明的平台保持原行为；BYOK宿主仍不调用未接通的云服务。
- 新草稿应用逻辑从动作解析中提取，保留原pane/group reset、mention尾空格、预填与draft事实源；附件、terminal动态ID、watcher、Uint8Array、provider凭证presence与Controller恢复消费链保留。

producer范围说明：`ensureConversationWorkspace`完整DTO已由主任务/minimal实际RED到GREEN；`createDefaultWorkspace`与`createScratchWorkspace`尚未在此阶段声明完整DTO，也未提前改其返回契约。原scratch路径继续经canonical workspace.open绑定。

验证：原Root4个公开UI用例首轮4/4实际RED（云/引导请求及登录面）；完成启动/身份/context消费后单独取得Ctrl+N默认B实际RED（context仍A、期望B），再补默认解析。实际main接线及生产viewer helper、原草稿逻辑提取后，单runner9文件34 tests全部GREEN、exit0。`@zcode/ui typecheck`（vendor+host）与实际build均exit0。保留收据：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-root-host.test.tsx --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-root-host.test.tsx --testNamePattern '原Root新建任务动作读取Project新默认B' --maxWorkers=1
pnpm --filter @zcode/ui typecheck
pnpm --filter @zcode/ui build
pnpm --filter @kenfutwork/web exec vitest run test/code-root-host.test.tsx test/code-host-controller-recovery.test.tsx test/code-host-reconnect.test.ts test/code-host-channel.test.ts test/code-task-workspace.test.ts test/code-directory-open.test.tsx test/code-host-feature-capability.test.tsx test/code-cloud-settings-capability.test.tsx test/code-provider-credential.test.tsx --maxWorkers=1
```

日志：`/private/tmp/kfw-code-root-public-red.log`、`/private/tmp/kfw-code-root-default-public-red.log`、`/private/tmp/kfw-code-root-client-final-narrow.log`、`/private/tmp/kfw-code-root-ui-typecheck.log`、`/private/tmp/kfw-code-root-ui-build.log`。常规vendor chunk与jsdom canvas提示不影响退出状态。测试令牌已正式归还主任务，无live runner。

阶段3来源blob/SHA256如下；当前复制SHA与适配理由由`packages/third-party/zcode/来源清单.json`持有。本阶段仅更新14个owned vendor记录，另保留validation必要optional Project UUID记录；其他并行修改记录未覆盖。

| 文件 | 92 source blob | 92 source SHA256 |
| --- | --- | --- |
| apps/web/src/components/workbench/zcode/Root.tsx | 3d6ba31f4cb5602181ce390b39036b1f4d68b5ab | 990afced028894f2f605337d17f5dbe71dd5f0533dcdbbaf9765e4d55f5f6e90 |
| apps/web/src/components/workbench/zcode/SettingsPage.tsx | d9cdb23ae327334145c3310aa65fa7593cb1e1e3 | f2f16d2c46ad559068e77638f684975bf6b0445bd2ebd3ca26910271b6a3b1b9 |
| apps/web/src/components/workbench/zcode/THIRD-PARTY-NOTICES.md | 64b78e5af1251f7c1519e857f57be7d53143c8d6 | 874bf7c10bdcadd0df0b50fc782f39f077669c6e41bbdbccd868409cd714dec3 |
| apps/web/src/components/workbench/zcode/hooks/useDynamicWorkflowAvailability.ts | 68d7c810e584a0c7e2cad4b41aa9793804e71c0d | e91f0c96af43247e0ad7c709c40f722b882503ab86f0f022eabe2f877236e42c |
| apps/web/src/components/workbench/zcode/hooks/useOnboardingRecordService.ts | d1a84d6185655399d84b5a7830153b966af032cb | 3a9f883988b3e8e69a6b0e0ce9fbac5a420fc742b84a03f4652279505d2a65a8 |
| apps/web/src/components/workbench/zcode/host/main.tsx | 78c441c03d307a4f13a66d99dbc2d4b4dfdcaa3a | 9af5f15c4c01e01309b582c491b117e325e3a6c0781e332350a6d0a6e461b191 |
| apps/web/src/components/workbench/zcode/host/platform.ts | 33a820202279968e82b8bd26a243e595f78b0fe4 | b2f74db44af46c8db383fc42c392e326f4b6cdbc1107684fbbad7218af92f4db |
| apps/web/src/components/workbench/zcode/lib/rendererNavigation.ts | 80c788ab9cb5d058919bd9c52f27e7013548dac2 | d37b918a1c6bbfa05ed7792a63878e67471c8005cb3e6109bffa57e0363a4b1e |
| apps/web/src/components/workbench/zcode/onboarding/OccupationOnboarding.tsx | 32cde8adb57ef0e18ef7a7b3ea6bbb33bff2ef2b | dd327c588b9470fc46d6aad980beb1fbd2cb61234a13c01084c3597b286b480e |
| apps/web/src/components/workbench/zcode/root/types.ts | 4955946399e2be047ee0ea108aea77f270f7f10d | ab7d4fd930ebfa6adcab25d927e0fa94bd0d4d67e3eea90ce579888629bdd595 |
| apps/web/src/components/workbench/zcode/root/useAccountConnectionLossNotification.ts | db5f06742d63f903ee474a186cf50a45b4f08a26 | fc1e2d3e2a27ff79dba2b1cbdab59fb24674576619eec89abc0808fd458e0423 |
| apps/web/src/components/workbench/zcode/root/useRootOAuthEffects.ts | 40b3ace5e791cdde89841b21be8a33176b0b7705 | 6a2cc6740d4b778c80d1766a76dbd1f9b7cbce412c69601b3ed8627369d40dbd |
| apps/web/src/components/workbench/zcode/root/useRootWorkspaceActions.ts | b6db1188ebb53645751af0fd77cea46f6b53f5c7 | 28f72f153fd9a5954bfca7bd9e6dedd287f525ce9dff128d319c160228c779f1 |
| apps/web/src/components/workbench/zcode/settingsPageHelpers.tsx | a58433f6bd4fce3839f4c584bbff0d7dcd706bd3 | 60786f18381f9a4014f126f132d6bc99e00bd65e9188a83798a164fccf962e4c |
| apps/web/test/code-root-host.test.tsx | 28c9828c0fb4538febcdc71988a60fbbff749415 | c40a7fc360f6db9f63b64c35a813b1d23d45d8eb3e5c631dff493ab234510d1a |
| apps/web/test/setup/code-root-host-http.ts | af12715631c7d06ed278d01459d98f4d73be4f61 | b042819b1e5e49e07c8cb8836ed270a5b8bb1accfcd9cc5b9a5075eeefc5136e |
| packages/zcode-shared/src/platform.ts | 30a05361b1f77c0549da4a6d6726765b8615fe4a | a9441821ce8fdb426c575231278a2159b5898b73e737b948d177c4f03ea3c11f |

### 第4阶段：真实轻量标题与三创建消费完整

冻结来源：`3f5c38732f151fa64e99856f456623b303dbe14e`。该commit相对92实际包含14文件；本阶段仅同步原`useActiveTaskSnapshotMeta`、平台`sessionMetadataSource`及适配回归/来源记录，不带回donor后台、snapshot API或截图。

Code宿主声明`sessionMetadataSource: task-index`，原Root标题读取真实只读Task meta；未声明的平台保留原session snapshot投影。回归使用真实Task/Project UUID、qualified固定A与Project新默认B；缺失/删除不退回旧session读取，不初始化Task/Scope。服务端单Task点读与root-only/actor/project校验由主任务另行实际验证。

原三创建方法ensure/default/scratch统一经CodeUiWorkspace schema验证真实DTO后登记Project UUID，只附opaque identity给原消费方；不根据path/调用方qualified字符串伪造身份，不修改旧Task。Default/Scratch各自先实际公开IFile proxy RED（identity undefined），统一消费后6用例全GREEN。原UI没有createDefaultWorkspace call site，因此没有制造新空壳入口。

原Root标题首公开case实际RED（真实heading不存在），精确接线后title/缺省legacy/null/deleted 4/4 GREEN。平台源hunk因现有canonical/newTask适配冲突未整体应用，手工仅补metadata字段；原根目录/UUID/viewer缝保留。

最后单runner6文件31/31 GREEN、exit0；独立Code UI typecheck与实际build均exit0，令牌正式归还，无live runner。收据：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-session-metadata.test.tsx --testNamePattern '原Root主标题读取真实轻量元信息' --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-workspace-creation.test.ts --testNamePattern 'createDefaultWorkspace消费真实canonical DTO' --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-workspace-creation.test.ts --testNamePattern 'createScratchWorkspace消费真实canonical DTO' --maxWorkers=1
pnpm --filter @zcode/ui typecheck
pnpm --filter @zcode/ui build
pnpm --filter @kenfutwork/web exec vitest run test/code-root-host.test.tsx test/code-session-metadata.test.tsx test/code-workspace-creation.test.ts test/code-host-controller-recovery.test.tsx test/code-host-reconnect.test.ts test/code-host-channel.test.ts --maxWorkers=1
```

日志：`/private/tmp/kfw-code-session-metadata-public-red.log`、`/private/tmp/kfw-code-session-metadata-green.log`、`/private/tmp/kfw-code-workspace-default-consumer-red.log`、`/private/tmp/kfw-code-workspace-scratch-consumer-red.log`、`/private/tmp/kfw-code-workspace-consumers-green.log`、`/private/tmp/kfw-code-metadata-creation-final-narrow.log`、`/private/tmp/kfw-code-metadata-creation-ui-typecheck.log`、`/private/tmp/kfw-code-metadata-creation-ui-build.log`。

| 原vendor文件 | 3f source blob | 3f source SHA256 |
| --- | --- | --- |
| apps/web/src/components/workbench/zcode/hooks/useActiveTaskSnapshotMeta.ts | 73032d01fb51c51862e021232c6101fa254a28fd | ffb36d0e0abd8665458a818256c56da0b3b30b4d5d1d005260e695e89cb1e8d7 |
| packages/zcode-shared/src/platform.ts | 168c98a39a54362457a0c9572445c957def593b8 | f2623badafecaf4eb3d9c23507f22017f40dc6ee6ddcf73d075fa7c0f6189c7c |
| packages/zcode-services/src/file/file.ts | ea5f6c67753c63a30249d4ed9fcca244ae7e9f6b | 9cd8de18048a2834cbba5da953a568012f58cc47191b9bad85e7b292ac07a0a9 |

第一方platform source blob为`c362472d08f5c591b8df194d71f16a6dd4be898d`，source SHA256为`37768d5facd5c3a19006138cb04ca9d9e902cf342e1192a7d178cfa8f2c77dee`。原外部browser夹具按字节复用，source/target SHA256均为`a832fe72cdb4aa434e4b289e4afd5d8c9db4fafc504896c5d6f7aa604e6097f4`。

### 第5阶段：原生文件提交到原工具卡的真实补丁展示

第一方native Write/Edit从真实`FileCommit.structuredPatch`产生`file_diff`，ApplyPatch只从实际提交的`result.files`产生`file_diffs`。完整canonical提交与modelContent保持独立；bridge artifact保留display，原公开生命周期只克隆用于事件的ToolMessage，由既有Harness stream进入原V4投影。部分ApplyPatch已提交的文件保留真实diff，失败项不伪造diff，公开行状态如实为error。

原`ToolOutput`结果display联合复用原单文件schema补齐`file_diffs`；row顶层display联合保持原契约。第一次真实公开Edit RED为事件未携带display，多文件解析另取得file_diffs被strip的实际RED；接线后原`toolCallRowToLegacyNode`与原summary消费真实结果，文件按钮实际打开patch详情。该阶段未修改runtime/deep-agent/stream-adapter生产循环。

展示预算读取Task文件域`codePatchMaxBytes`，仅保留完整hunk，真实总增删计数不因预览截断而缩水，也不修改canonical补丁。最小shared治理预算下，真实Edit一次提交两个非相邻hunk，公开预览仅保留一个。截断case首RED明确原summary丢失truncated；随后只补原摘要optional字段、原卡可见提示及中英文文案，卡片收起时也明确说明仅展示部分变更。没有制造加载完整详情按钮。

最终公开文件链单runner4/4 GREEN，涵盖真实Edit完整提交、ApplyPatch部分提交、原结果schema及截断原UI消费；服务端4文件26/26 GREEN。Code UI vendor/host typecheck与实际build均exit0。该阶段较早server typecheck收据仅记录同期OpenAPI三项worktree schema导出缺失，属主任务并行范围；最终server全量门禁由主任务收口。验证命令：

```sh
pnpm --filter @kenfutwork/web exec vitest run test/code-file-display-public.test.tsx --testNamePattern '真实Edit完整提交但预览受Task预算截断时' --maxWorkers=1
pnpm --filter @kenfutwork/web exec vitest run test/code-file-display-public.test.tsx --maxWorkers=1
pnpm --filter @kenfutwork/server exec vitest run src/features/code-tools/file-display.test.ts src/features/code-tools/tool-definitions.test.ts src/agent/kernel-tools-bridge.test.ts src/features/code-ui/tool-lifecycle.test.ts --maxWorkers=1
pnpm --filter @zcode/ui typecheck
pnpm --filter @zcode/ui build
```

收据：`/private/tmp/kfw-code-file-display-public-red.log`、`/private/tmp/kfw-code-file-diffs-schema-public-red.log`、`/private/tmp/kfw-code-file-display-truncated-red.log`、`/private/tmp/kfw-code-file-display-public-current.log`、`/private/tmp/kfw-code-file-display-server-current.log`、`/private/tmp/kfw-code-file-display-server-typecheck.log`、`/private/tmp/kfw-code-file-display-ui-typecheck.log`、`/private/tmp/kfw-code-file-display-ui-build.log`。首截断GREEN运行只因夹具使用未配置的jest-dom matcher而失败，改为原vitest文本断言后4case全通过。jsdom canvas提示与vendor chunk大小提示未改变成功退出状态。唯一测试令牌已正式归还主任务，无live runner。

来源清单只更新本阶段6个owned vendor记录：toolDisplay、fileSummaries、fileSummaryTypes、edit renderer与两种locale。原source revision/blob与既有locale donor syncSource保留；使用原checkout只读Git对象核对source SHA、donor SHA及当前target copiedSha，6项全部一致。工作树未初始化references子模块，也未复制或建立符号链接。owned paths的`git diff --check`通过；全仓diff中`THIRD-PARTY-NOTICES.md`的原CRLF字节保真例外保留，未为清除trailing whitespace修改版权原字节。

后续V4文件详情必须从已持久事件的完整canonical/journal聚合真实提交，不从有界display还原完整补丁。单Write/Edit canonical带解码`originalFile`与`content`，ApplyPatch files仅有path/type/structuredPatch/counts/version；恢复原字节必须使用真实checkpoint/ledger。Git只保存可执行位，材料化文件mode不代表完整原权限：现存文件保留最终native实际观察mode；已删除文件恢复为owner读写`0600`，仅继承Git保存的owner执行位，执行文件为`0700`。这些POSIX位是权限语义常量，不是运行时限额，不另造完整mode元数据历史。真实`0600` Edit回退首RED为权限扩大到`0644`；修正后19个文件回退边界用例全GREEN，收据为`/private/tmp/kfw-file-rewind-mode-red.log`与`/private/tmp/kfw-file-rewind-boundaries.log`。已删可执行文件`0700`与完成顺序也已回归；后者实际RED暴露按启动行顺序重建会误拒绝合法提交，改为持久completion日志顺序后GREEN，收据为`/private/tmp/kfw-file-rewind-completion-order-red.log`。原V4 RPC独立PG/Scope/Checkpoint/ShadowGitExec/SRT正例1/1 GREEN，UTF16/BOM、`0600`、cold聊天/reverted摘要、旧CAS duplicate与新代际已验证，收据为`/private/tmp/kfw-file-rewind-v4-current.log`。delete.version是删除前版本；move的filePath是源路径、movePath是目标路径、version为目标提交后版本，patch来自目标新建；移动目标已提交但源未删的partial结果如实为目标add加failure，不得冒充成功move。

### 第6阶段：输入框语音入口（宿主接线）

来源冻结仍为`3f5c38732f151fa64e99856f456623b303dbe14e`。本阶段只做宿主接线，不同步donor的新hunk：语音能力本身（录制/WAV/手势/改写与撤销窗口）来自第一方`@kenfutwork/voice-ui`与既有`/api/voice/*`，不在ZCode来源内。

`v4/ConversationComposer.tsx`三触点：输入卡摊`onPointerDown`语音手势与状态行，转写经`inputApiRef.appendText`受控写回（TextContentPlugin→handleEditorChange落草稿）；完整回路在撤销窗口后走组件自身`submit`——文本先落草稿，`submit`未就绪也不丢，不另起发送通道。transport由树级宿主桥`@zui/voice/binding.js`（`zcode/voice/binding.tsx`，第一方文件，不进清单）注入，`host/main.tsx`装配multipart转写（`CodeHttpChannelClient.transcribeVoice`，cookie认证、不手写content-type）与设置读；`styles.css`追加共享语音包扫描面`@source ../../../../../../packages/voice-ui/src/**/*.{ts,tsx}`（探针类实测证明扫描生效、随后移除，状态行类在两个构建的产物CSS均齐全）。

验证：`@zcode/ui` typecheck（vendor+host）与build均exit0；web定向用例（接线守卫源码级、语音桥组件级、宿主通道multipart）全GREEN。命令：

```sh
pnpm --filter @zcode/ui typecheck
pnpm --filter @zcode/ui build
pnpm --filter @kenfutwork/web exec vitest run test/code-voice.test.tsx test/voice-wiring-guard.test.ts test/code-host-channel.test.ts --maxWorkers=1
```

本阶段仅更新2个owned vendor记录（`v4/ConversationComposer.tsx`、`styles.css`）：source字节不变（source blob/SHA沿用《ZCode源码清单》既有记录），copiedSha与适配理由由该清单单处持有；`host/`与`voice/`下的第一方文件不在清单范围。

### 第7阶段：语音补全接线（「想」段上下文 + 「说」段播报）

承接第6阶段，补齐规划 §2.3 与 §4.2 的两端：① `snapshot.rows.window` 提取指代消解上下文（新第一方 `zcode/voice/recent-messages.ts`：只取 `origin === "realUser"` 的 userInput 与 `state === "complete"` 的 assistantText，经 `buildRefineContext` 单条截断 500 字 / 封顶 6 条）注入 `useCodeComposerVoice` 的 `recentMessages`；② 助手回复**从 streaming 转为 complete** 时调 `speakReply` 播报（先见 streaming 的 rowId 才消费——打开历史会话的最后一行本就 complete，不能重念）。`speakReply` 只在完整回路档 + 朗读开关打开时工作（与设置页同一口径）。

宿主通道新增 `CodeHttpChannelClient.speakVoice`（`POST /api/voice/speak`，二进制响应、打断走 signal），`host/main.tsx` 装配为 transport.speak；`voice/binding.tsx` 增加播报实例（打断口径与 Design 侧同一份：新播报 / 开始说话 / 卸载即停）。

验证：`@zcode/ui` typecheck（vendor+host）exit0；定向用例 4 文件 32 例全绿（含播报开关三态、上下文注入、转录提取纯函数、接线守卫新增断言）。

```sh
pnpm --filter @zcode/ui typecheck
pnpm --filter @kenfutwork/web exec vitest run test/code-voice.test.tsx test/code-recent-messages.test.ts test/voice-wiring-guard.test.ts test/code-host-channel.test.ts
```

本阶段更新 1 个owned vendor记录（`v4/ConversationComposer.tsx`）：source字节不变，copiedSha随适配更新（见《ZCode源码清单》）；`host/`与`voice/`下的第一方文件不在清单范围。


---

## Code 内核实施交接


> 2026-10-04，Goal active，按用户要求分模块提交并准备合并UI。此文件是施工交接，不取代实施规格或服务key权威表。下方较早状态与“未commit”均为历史取样；最新状态以本节为准。现存数据库未执行新迁移。

### 2026-10-05 主工作区并行施工（当前唯一入口）

- 用户要求停止独立worktree施工，现已将内核分支快进整合到主checkout：`/Users/shigaoyu/Develop/KenKenDev/KenFutWork`，分支`codex/完整移植ZCode-Code界面`，功能合并点`6f5fd45b`。提交树与旧内核分支完全一致，无冲突；包含先前双亲UI合并`b234f8f8`，双方正确修改和删除均保留。旧`code-harness`工作树保持干净、停止编辑，不再作为施工入口；`main`及`啃啃在开发`未切换或修改。
- 已通知“重新设计用户系统”线程（`01a107eb-b461-7eb2-958a-9ebc564bc28d`）共用上述目录与分支：本线程负责Code/Harness与原UI能力接线，另一线程负责用户系统。涉及auth、viewer/bootstrap、persistence、shared、profiles或内核类型的共享hunk先协调；显式路径暂存，不替对方提交，测试单实例。
- question首RED测试已原字节搬入主checkout，初始SHA-256一致；随后仅修正它的协议导入到现有shared公开入口，主区类型检查通过。broker/tool/答案消费者尚未实现，不把该测试草稿当能力完成；当前不由冻结的旧Agent继续编辑。
- 主checkout依赖已用`CI=true pnpm install --frozen-lockfile --offline`同步；初次类型检查读到旧shared声明，强制`pnpm exec turbo run build --force`后13任务成功，再`pnpm typecheck`13成功。来源3027项零漂移；合并前全test16成功、模式拒读拒写真实HTTP4GREEN。收据`/private/tmp/kfw-main-checkout-{install-final,build,types-final,source}.log`与《日志》一百一十六。未push/PR/运行库迁移，完整Goal active。

### 2026-10-04 提交冻结与UI合并入口（最新）

#### 合并验证收口（优先于下方冻结取样）

##### 合并后原UI接线进展（最新）

###### 运行初始化拒绝与迁回主工作区（2026-10-05）

- 旧POST启动消费者已接Store新语义：显式activate或Scoped hydrate真实失败均503，不能吞错按默认agent创建Run。真实PG读/写拒绝各RED→GREEN，公开组合4GREEN；registry/spec与Apifox独立AI分支同步见《日志》一百一十五。AI分支未合主，历史3条退役接口的审阅清理另行完成。
- 用户最新指令：此模块提交后快进整合到主checkout的codex/完整移植ZCode-Code界面，之后停止在code-harness worktree编辑，与用户系统线程共用主工作区。question仅首真实RED、无生产broker；测试草稿保留并迁入主checkout。完整Goal active，后续施工位置以合并回执为准。

###### 可信执行模式指导接线（2026-10-05最新）

- runtime以已接受Run与scopeHandle描述提供pre-step事实（实际runId/preset/workspaceId/taskId/sessionId）；agent-modes在Code输入前await Scoped hydrate恢复原指导。真实内核+PG+Harness冷服务与同Task真实分支换thread/冷Kernel2条GREEN，最新HumanMessage含goal，不靠历史前缀假绿。V4工具权限仍是唯一执行授权，本轮只恢复指导，无新事件/key/runtime。
- 组合27GREEN，全test16/types13/build13、owned11路径与docs通过，来源3027零漂移；全lint仍20个历史error。详见《日志》一百一十四。下一结构化提问沿原协议接真实答案消费者、取消与刷新，未将unknown已处理ACK计为成功；完整Goal active。

###### 执行模式持久化与缓存收口（2026-10-05）

- 沿既有agentModes实现，Code不经Canvas join；Project/Workspace复合归属、stable session/current native thread双入口、冷恢复与真实编辑换绑均经独占PG验证，old alias无效。Scoped hydrate读权威存储，foreign miss不借owner暖缓存；save反馈真实受影响行，零行或DB失败不发布新缓存。Design/Flow六档保持。无新迁移/服务key/模式枚举。
- Store/cache真实6条与既有Service19条、下一指导2条组合27GREEN；全test16/types13/build13成功，来源3027零漂移，全lint仍20个历史error。证据与具体命令见《日志》一百一十三。模式存储不等于V4工具执行授权，可信pre-step消费已在上节独立接线；完整Goal active。

###### 原行内编辑与上下文分支接线（2026-10-05最新）

- 原editUserQuery latest-realUser/idle/preserve已真实HTTP与原行内组件验证：native分支成功再切Task，线程/state/输入/ACK原子保存，同目录、权限冻结、editRerun/rootSource来源与重放保持；绑定事务失败保旧正文/文件、清未发布target，不执行新模型。SDK普通/Delta/tool messages、完整祖先、占用与lease/部分put故障见《日志》一百一十二。系统Prompt/工具/GUI原链不仿写。
- 仍需完整history其它分支、workspace rewind/retry/fork、guide、question broker/tool/答案消费者、子停止及全部插件/跨平台/视觉回归。原question协议/组件已在，本树resolve仅permissions，不能把unknown已处理ACK当回答成功。通用agentModes的Canvas join已由下一持久化切片修复，Code按Project/Workspace直接存储并在换context thread后恢复，详见上节；可信模型指导亦已独立接线，不能以V4权限mode保存代替。

###### 可靠持久化与释放接续（最新）

- 历史控制前置持久化实际故障已修：明确配置PG却初始化失败不再Memory fallback，真实Harness模型不执行、run.failed；原服务共享单初始化promise顺序建SDK资源，部分失败清理后可重试。dispose由agent-runs插件的释放栈持有；关闭拒绝新getter、等待在途初始化、幂等释放SDK连接，CodeUI夹具不再强制get或手工end/stop。真实RED/GREEN与独占PG组合6条（本模块5/队列1）、全test16/types13/build13成功详见《日志》一百一十；来源3027项漂移0，全lint仍20个历史error。未将此前关闭延迟归因为此问题。
- 原Goal仍active；当前修复不等于history consumer已完成。下一独立模块沿最新realUser的idle preserve编辑，先接原生context恢复与真实durable ACK，再打开原canEdit，不从UI DTO或隐藏subagent凑分叉。

###### 原队列公开与实际页面收口（最新）

- 合并后原UI队列编辑撤回、指定项立即抢占、Stop暂停、刷新恢复、继续真实消费与最终停止均有实际页面证据。独占HTTP/SSE/PG与真实Harness新1条通过，另锁重排、输入身份、stale revision与duplicate无二次效果；测试脚本与截图见《日志》一百零九。未把拖拽鼠标操作/guide当成完成。
- 历史控制只读核验：原三命令/回调保留，服务尚无consumer，行action未开启；fork总availability仍需随真实实现修正。下一最小切片先可靠持久化，再idle最新realUser的preserve编辑，原生上下文restore与文件/branch/ACK逐步接通，不用flat DTO或subagent替代。

###### 默认Task真实恢复收口（优先于下方较早样本）

- 真正跨模式试验暴露local qualified身份被原远程启发式漏存tab、共享迁移丢Q、后端Q焦点当path、侧栏强制remote折叠及本机精确services绑定回退base。统一parser与原pure resolver修复，Q只取自身绑定并local；缺绑定等待，旧无identity才base，不削弱remote或同路径Project隔离。后端由真实Project/Task规范化唯一Q，legacy有证据才升级；Task固定A/Project新B、recent归属与invalid/archived原子保护均保持。
- 公开Root 4与metadata/config/lease 19、偏好16均GREEN；独占PG3GREEN；最后串行全test16成功（shared90/web453/server1871、174默认skip、Unhandled零）、types13、build13通过，来源3027漂移零，当前10登记source copiedSHA已刷新。全lint20个历史error未代改。源码/测试/文档为单一恢复bug切片，原checkout/UI分支未改、未push/PR/运行库迁移。
- 实际新预览重演：默认Task发送/真实流/停止，Design→Code之后Task侧栏仍可见，原Task转录与已停止可读，第二次刷新自动恢复。截图在《日志》一百零八。Design矩形实际绘制与刷新保存、助手真实发送/取消/转录恢复亦通过；此前未观察图形是坐标落在属性面板/未到桌面布局，不再作为未验收结论。两图视口不同，不代表全视觉1:1或Design全场景已经完成。
- 原Goal仍active。下一步沿已授权原协议逐条queue/guide/history edit-retry-fork/权限与提问/子停止真实UI，剩余插件agent-command-hook-MCP与技能执行消费者、默认SDK持久化silent fallback/partial pool、Project-before-Task readonly lease、附件lineage、真实外部模型与Windows实机、全部视觉/旧UI零残留/Design矩阵、Apifox与可审阅交付。不得用本轮真实停止或默认skip代替这些能力。

- 双亲merge已完成`b234f8f8`；原Root可选模型参数HTTP还原独立提交`151d8669`（实际浏览器横幅RED→消失，provider12GREEN）；独占HTTP/client/ProjectUUID/思考档位与真实根停止已独立提交`3f3b2a77`。后续源码继续按模块提交，未push/PR/运行库迁移，原checkout仍干净。
- 插件本轮只实现真实技能与版本描述，Registry→原list/describe→原DetailView同一读面。首候选/安装列表分别实际RED→GREEN，公开unknown/remote/symlink4GREEN；UI3GREEN仅为真实组件+外部HTTP/SSE契约补证，实际私有HTTP候选与根stop2GREEN另有证据，不能混称全插件组件已实现。其它agent/command/hook/MCP、author及技能运行消费者继续。
- 最终全量`pnpm test`16成功（shared90/web451/server1871、server171默认skip、Unhandled零），`pnpm typecheck`13成功；server build与owned10路径Biome无error，来源清单保真。全lint20个common-base错误仍在。收据`/private/tmp/kfw-code-ui-wiring-{full-test,types-final,server-build,owned-lint}.log`、`/private/tmp/kfw-code-isolated-http-green.log`、`/private/tmp/kfw-plugin-detail-ui-final.log`。
- 新独占HTTP夹具真实viewer→SSE/hello→ProjectUUID→preferredSelection→run/stop，客户端退出明确await reader.cancel/releaseLock与app/native/PG关闭；没有force-close/放大timeout。此前79s关闭和首次候选超时不计GREEN，阶段trace无证据，不能声称确定根因。旧stop5例/其它外部DSN矩阵尚未迁移。
- 浏览器独占预览：原Root真实输入/Task建立/流式文本/原按钮停止到“已停止”通过；Design创建项目、canvas iframe与真实两层Excalidraw及助手侧板仍装配，未被Code对话替代。矩形绘制尝试未观察到图形，未计绘制/持久化GREEN，也未据自动化坐标单独判产品故障。全视觉/完整Design回归仍待完成。
- 关闭审计另发现历史AgentPersistence首次读并发建SDK schema、失败静默退Memory且部分pool无清理。这是源码事实、尚无本轮故障归因；后续按公共Harness+数据库边界验证真实durability/生命周期，不把本次描述或fixture切片扩成混合重写。

- 已先完成17批提交，冻结ours `6e746f55`，再以双亲merge整合UI固定提交 `29fb8c09`。保留原Root/主子SessionPane/renderer、品牌与资源删除；保留Task UUID/Project UUID、固定根、权限代际、配置租约、附件/终端和Code无Canvas。原checkout未编辑/切支；尚未push/PR，Goal仍active。
- 偏好只保留`code_ui_preferences`/workspace-rpc，模型只保留`compat.codeUi`与实例CAS；删掉无consumer的第二settings/config helper，双方历史SQL原字节保留。根锁内登记Run同时检查ready/activeRun/授权与分支代际及canonical输入；插件串行变更、等待restore/disposal/shutdown与失败贡献物保留同时生效。
- 合并首全量4失败及1未处理异常均已修复：显式清空API后原SDK端点校验同时约束选择器与运行快照；旧SQL夹具识别实际insert/update而非事务begin；畸形卸载拒绝且库存无副作用；搜索授权复验期间撤销的真实取消窗口actualRED→GREEN，在创建流前拒绝已中止signal并等待文件/子进程收尾。窄回归77+21通过，未skip/吞异常。
- 最新`pnpm test`通过：shared90、web449、server1866（170默认跳过），16任务成功且没有Unhandled；`pnpm typecheck`13任务成功；`pnpm build`13任务成功，包含原Code/Design两bundle；`pnpm api:spec`、`pnpm test:docs`通过。日志`/private/tmp/kfw-merge-{test-final,types-commit,build,api-spec,docs}.log`。3027项ZCode来源零漂移；Kimi明确登记源码逐项SHA验证，不批量格式化第三方。
- 独占临时PG验证5条：V4 compact FIFO、真实文件rewind、真实卸载/缓存与加密数据、Controller固定Task根、设置与归档竞争；另TaskWork真实库3条含全迁移重放和二次no-op。日志`/private/tmp/kfw-merge-private-pg-green.log`、`/private/tmp/kfw-merge-pg-replay-green.log`。未连接现有开发库、未执行运行库迁移。
- lint仍须区分基线：本Goal新增与merge第一方格式/import已整理；Computer Use与两份历史Web文件保持common base原字节，现存20个错误尚未修，不能称全lint绿色。原源码与版权按来源SHA验证。旧Code已删资源静态import零残留，不等于全视觉验收。
- 新UI分支若干默认skip的HTTP integration仍使用目录替Project UUID/旧Canvas或缺ClientHello，公共fixture默认3001且stop会直接锁外部DSN；不能以skip当GREEN，也不放宽生产身份来迁就。后续先显式client+独占PG/buildApp/随机端口，再验证原UI命令。describe/list真实组件发现、edit/retry/fork/guide、子停止/权限/队列完整UI、全视觉与Design回归及Windows实机仍待完成。

- 用户要求先提交全部暂存/未暂存/未跟踪工作，按功能模块分批，之后合并固定UI提交 `29fb8c09c03e99bd55d60ea491dfbda076f1eae1`，由本线程统一继续。原checkout该分支干净，只在隔离 `codex/重构Code工作域与工具内核` 操作；尚未push/PR。
- 已按源码许可、契约/依赖、存储、Task/文件、沙箱/PTY、后台任务、审批、扩展/释放、供应商、检查点、附件、Harness、原UI、Code宿主、装配与测试拆分提交。逐批日志在《日志》末尾；不得把多个模块重新压成一个大提交。
- 冻结工作树 `pnpm test` 与 `pnpm typecheck` 全通过，日志 `/private/tmp/kfw-precommit-all-green.log`、`/private/tmp/kfw-precommit-full-types-final.log`；`pnpm api:spec` 与文档门禁通过。真实native/PG/V4FIFO压缩、完整文件恢复与独占临时PG重放证据继续有效，运行库未迁移。旧OpenAPI3失效注册已按本次“正确处理删除与提交”授权清理，不补假schema。
- 全量门禁补证修复：旧shared检查点/供应商夹具、路由startup空库端口、Web原provider/casing/可选接口、原生Responses断言、Git upstream真实fixture；真实PTY晚订阅丢尾部已actualRED→GREEN，沿真实offset/seq有界补交付，exit等待drain且幂等。没有把夹具回压调整当新产品修复。
- 两份施工规格未实现且不计GREEN：Darwin系统Git实际路径首test明确skip；插件uninstall integration默认显式PG门禁，尚无生产action。UI分支另外的describe integration亦是已确认501的未完成项。merge时保护双方测试意图，不能因已入库声称能力完成。
- 原UI交接已读：主链替换完成、不是所有操作/1:1验收完成。merge必须保留原Root/主子SessionPane/renderer/品牌/资源清理，同时保留新Task/权限/Harness权威。原分支的旧Canvas后端不能带回。后续继续queue/权限/结构化提问/子停止/历史控制、终端/文件、插件详情等真实消费与Visual/Design回归；Windows实机、Project-before-Task Git及真实guide仍待验。

### 2026-10-04 手动维护与插件消费接续（最新）

- 原UI最新审计固定 `eef278394714ffab4d416503fa5b1f1a37025315`，只读Git对象；相对前一固定 `ea3b79ec` 共4文件，新增规范化bundle ID、第一方恢复策略及真实重启测试。原树dirty文件未取入。不得整体覆盖registry，donor仍有不等待unload的路径，会丢失本树awaited disposal/失败保留。
- 原compact进入canonical FIFO并复用同一前台运行身份；仅产生manual运行标记，不造Human/turnHeader。实际公共RED→GREEN修复完成后原标记不结束/多造auto标记，以及noop/failure/cancel仍running；原成功/无变化/失败/Stop取消均接同一marker，维护通知归task_status_changed。输入18+会话11共 **29 GREEN**，`/private/tmp/kfw-code-compact-outcomes-green.log`。真实native compact/PG与CodeUi FIFO组合仍在验证，不能用LLM边界替身证明原生提交完成。
- 插件库存adapter真实example-clock与registry **5 GREEN**，损坏JSON/schema明确拒绝而不发假空或覆盖原磁盘。Root主消费HTTP实际RED501→接CodeUiPlugin既有plugins注入→两文件 **6 GREEN**，`/private/tmp/kfw-code-plugins-host-consumer-green.log`。user机器库存不读/创建Project、Task或执行scope；携带target使用既有真实Project/固定Task根只读解析。三写动作、规范化ID/策略、串行持久化与启动关闭生命周期仍下一切片，未声称已完成市场。
- 原UIworkspace-config消费者全9及相关四文件共 **23 GREEN**，新在线完整态取代恢复帧后旧flight阻塞下一恢复的实际RED已修；pendingACK末lease回收、source失败与显式重读、同Project共享/同根不同Project隔离均通过。vendor+host types与真实UI build exit0，6owned固定source/copy SHA一致，收据 `/private/tmp/kfw-workspace-config-consumer-final-public-green.log`、`/private/tmp/kfw-workspace-config-ui-final-{types,build}.log`。旧下方2/4/6条状态为历史，不作为最新验收。
- Goal仍active；历史edit/retry/fork、真实guide、附件lineage、Project-only Git、真实账户/模型/浏览器与全量门禁仍未完成。旧OpenAPI3/Git写/旧转录物理清理的精确审批与Windows实机环境仍pending，不绕过或假成功。HEAD仍65d1097e，运行库未迁移，未commit/push/PR。

### 2026-10-04 最新完整控制接线（优先于以下历史状态）

- 原UI分支已更新，最新审阅基准固定 `5633106034e74b9320eafc1a2d5224947976b369`：相对3f5c共12文件，仅插件真实包库存bridge/registry/shared event/tests及回执。原树同文件还有未提交动作/授权与brand/assets工作，严禁整体复制moving/dirty文件。file负责只读库存增量审计，Root再接DSH真实权威，不带回Canvas backend或第二插件库存。
- 原V4 fileChanges详情已走私有原生完整canonical journal；卡片预算预览与完整详情分开。两非邻hunk真实Edit在卡片仅一hunk时详情仍完整两hunk，公共 **5 GREEN** (`/private/tmp/kfw-code-native-detail-full-public-green.log`)；提交journal私有PG **1 GREEN**（`kfw-code-native-detail-full-green.log`中该文件成功，公共3失败为缺defaultModel的夹具已另修），同run20k只读Read不占文件预算。字段、计数、Project/Task根、entity、epoch/revision均锁住，读取不造Run/scope。
- `file-history.ts`真实消费已有metadata pre/post与file journal，接原preview/apply；CodeUiPlugin注入既有checkpoints，没有新ctx key。恢复采用真实scope.backend.commitBatch+process/file双barrier；准备后beginRewindTask事务再检查epoch/revision，持久reverted事实与原命令ACK后才开放readiness，重放先命令回执而不再执行文件effect。缺provider给可读拒绝，缺捕获/日志/冲突给真实不安全原因，不截聊天。
- File preparer每条实际RED→GREEN后最终 **19 GREEN**（UTF16/BOM、partial update/add/delete、缺日志/引用、实体/CAS、外部或shell混入、预览后竞争、同/异Task真实process barrier、completion真实顺序、0600/0700）。Git仅保存exec位：现存文件保最终native observation权限，删除恢复仅owner600+owner exec，避免644扩大权限。原V4真实PG **1 GREEN** `/private/tmp/kfw-file-rewind-v4-current.log`：native tools→bridge→生命周期→stream→真实journal/metadata，preview/apply/cold聊天保持与reverted、旧revision duplicate不二次覆盖外部新文件、ready新generation/旧scope撤销，全部真实SRT/ShadowGitExec。Mac夹具gitBinDir使用xcrun发现的已安装实际Git；系统shim首失败是环境问题，尚未证明默认system Git profile无缺口。
- native durability/storage故障实际RED→GREEN **3 GREEN**：有checkpointer时adapter通过公开参数固定sync、显式checkpoint_id重读确认新summary；存储put拒绝仍run.failed、没有run.compacted与Unhandled，旧摘要复用/冻结ref正例保持。代价是每superstep等待持久化，SDK参数不露到产品层。accepted未消费取消actualPG GREEN、重复stream所有权actualPG GREEN（第二消费者不能释放首个活Run或写post）；真实Git无文件变化effective引用消费下一case待验。公共source回执见 `/private/tmp/KenFutWork-Harness轮次边界实施回执.md`。
- workspace-config producer与三原topic owned epoch/seq/lease fence **16 GREEN**；原Conversation/Index旧snapshot同样会全替换，已在生产发送端统一阻止迟到旧seq/旧epoch，合法新epoch归零与同seq recovery保持。逐订阅真实错误隔离并精确dispose，不发假空目录，initial读取中source更新重读已实证。CodeUI主consumer实际RED→GREEN **3文件30 GREEN** (`kfw-code-workspace-config-host-green.log`)：强握手/用户归属、真实CodeProject与固定Task根A来源，Project默认B不重绑，原presentation与配置frame共享commands来源。
- SettingsService深化原服务，新增只发workspaceId/changedKeys的onUpdated；成功保存/回读后再通知，插件消费defaultModel/commands变化刷新同配置source。provider原notifyViews也已刷新，失效订阅精确释放。Settings/HTTP稀疏更新/配置主consumer/owned lease组合 **5文件47 GREEN** (`kfw-settings-config-fact-green.log`)。未引第二设置/模型目录。
- 客户端配置消费现 **2 public GREEN**：原V4Pane/toolbar/真实typed agent/HTTP/store链，默认目录/模型/slash实时可见，当前Task选择保留；原prepare从同existing lease读完整态，三个真实调用点与main/pane共用entry，不造Task/Run。reconnect/resync/精确退订、旧lease与同根不同Project矩阵仍在下一slice，不能把两条通过当整体UI完成。
- 最新env扫描2362文件GREEN；本轮Root types/owned Biome仍在收口，旧OpenAPI3精确审批与Windows实机环境继续pending。整Goal仍active，manual compact/edit/retry/fork、attachment lineage、真实guide、Project-only Git、真实账户/模型/浏览器与当前全量门禁/迁移收据/PR仍未完成。运行库未迁移，HEAD仍65d1097e，未commit/push/PR。
- 后续最新：shared第三配置frame与冻结563两条插件读schema实际build GREEN；Settings新增onUpdated Definition所需Controller/MCP mock补齐，fixtureUnknown commands按原schema解析，Root本域类型零错；最新TSC只剩explicit新failure测试两条待修fixture错误与旧OpenAPI3（explicit已修两条，尚待最终再检）。最新env **2364文件GREEN**，Rootowned diff check exit0。根Registry/API退役审批仍未绕过。
- Core补证：actual native+PG failure/cancel **2 GREEN**（hook失败记录failed而非captured null，真正取消在post保存后才释放active），actualGit两轮无文件变化 **1 GREEN**（唯一旧checkpoint归首run，但两run各自phase/run均消费effective ref）。这两个证明现有正确实现，未伪造RED/多加补丁；日志 `kfw-harness-active-failure-cancel-public.log`、`kfw-harness-effective-files-public.log`。explicit已进入已授权manual compact的公共原生hook/graph operation seam方案，Root将接canonical FIFO与非用户行投影。
- UI配置消费者最新 **4 public GREEN**：初始metadata/source/currentTask隔离、完整prepare、断线重订阅、坏physical原typed resync恢复；no Task/Run命令重放、generation/decoder/barrier均回收。当前minimal准备3pane同Project共享/同根不同Project隔离与最后lease/pending ACK精确cleanup，未宣称全UI完成。file当前完成563冻结审计并开始仅两读插件库存adapter首TDD（新plugins.ts fail-closed骨架/单publictest待RED）；Root尚未接该adapter，不能声称插件市场库存已同步完成。

### 2026-10-04 最新接续（优先于以下历史状态）

- 实施树仍为隔离 `codex/重构Code工作域与工具内核`、HEAD `65d1097e`。原UI分支实时复核仍在冻结 `3f5c38732f151fa64e99856f456623b303dbe14e`，不覆盖其dirty修改，不带回旧Canvas backend。
- 轻量 `getTaskMeta` 先按Task读取，不依赖工作区全量会话枚举，不授予执行作用域。真实空Task已允许无模型创建，持久空model/thought且省略modelSelection；第一条sendText仍要求可执行真实模型。公共项目/输入/Controller组合最新 **3文件35 GREEN**，证据 `/private/tmp/kfw-code-no-model-task-{red,green}.log`。
- 三个人类目录创建入口（ensure/Default/Scratch）均返回真实CodeProject UUID+canonical目录；原UI三消费者使用完整DTO，拒绝非法UUID，旧Task固定根不重绑。偏好仍在code_ui_preferences，内部默认项目引用不公开。cold复用、archive失效与save失败已GREEN；跨host默认唯一性尚未实证。原Root标题/metadata/目录/Controller/channel最新 **6文件31 GREEN**，vendor+host类型/build exit0，证据 `/private/tmp/kfw-code-metadata-creation-{final-narrow,ui-typecheck,ui-build}.log`。
- 文件worker接通native工具display→bridge独立artifact→canonical公共事件→原toolOutputSchema→原ToolCallBlock。单文件真实Read/Edit、ApplyPatch两文件真实部分成功与第三文件失败、canonical/model不改、治理预算截断已 **server4文件26 GREEN / public UI3 GREEN**；UI类型/build exit0。最后truncated提示/来源收口仍持唯一测试令牌，随后归还explicit。Root负责原V4详情与file-only rewind公共消费链，不能靠row-level display union或展示补丁猜原文件。
- 实际Graph/MemorySaver两轮自动压缩：第一轮实际新Command.update写入并确认checkpoint，第二轮只复用已有摘要；实际RED→GREEN first=1/second=0，证据 `/private/tmp/kfw-compaction-reuse-{red,green}.log`。explicit继续RunService稳定Human身份、原生context history与现有agentRunMetadata ledger；新adapter/Harness组合仍待本次窗口验证。
- Root已准备原V4文件详情首public RED；minimal继续独立workspace-config producer接线。整体Goal active，仍待真实历史控制/附件lineage/steering/Project-only Git/当前全量门禁/真实UI模型环境验证。Windows缺实机；3个worktree OpenAPI退役、Git UI写RPC与旧原始terminal/转录物理删除的精确审批仍未解除。没有迁移运行库、commit/push/PR。
- 此后Root详情actual RED→GREEN已接原V4 fileChanges与turnHeader摘要；ApplyPatch部分失败仅计已提交两文件，revision/epoch/entity/Project/固定目录拒绝矩阵GREEN。FIFO的canonical输入身份与后台host.task-work持久命令身份首RED→GREEN接共同Harness，不以新runId冒充原输入；重复后台通知不增加Run。精确pre文件原始字节读取只materialize选定path，UTF16/BOM与真实工作文件均验证；详情/输入/snapshot/真实Git **4文件37 GREEN**，`/private/tmp/kfw-code-detail-input-snapshot-green.log`。
- 私有PG原生提交journal读取actual RED→GREEN **1 GREEN**，工作区/Task/Run归属、完整canonical保真、事件数/字节预算和删除后迟到读取均验证（`/private/tmp/kfw-code-file-journal-{red,green}.log`）。该文件随后新增afterCommit回执先落库再开放readiness的下一RED，尚未实现，旧1GREEN不替代此新增场景。Root尚未把安全file-only preview/apply接到V4；file已准备真实FS/精确pre/post/native Edit与两种restore barrier首slice，测试令牌目前归file，其完成后explicit runtime ledger GREEN、Root控制consumer按次序串行。
- 文件展示最后truncated首RED→GREEN：server26、public UI **4 GREEN**，UI类型/build exit0，6个owned来源SHA精确验证。版权通知CRLF按来源原字节保留，owned diff check通过；不能为消除全diff trailing whitespace而改版权bytes。native ApplyPatch delete.version是删除前版本，move.version是目标提交后版本且filePath为源，patch files没有originalFile/content；恢复绝不能误用这些字段或按UTF8近似。
- actual native contextHistory port **2 GREEN**，真实摘要有效消息、冻结旧checkpoint读取与最小白名单引用已验证。深化现有agentRunMetadata的record/read与前向`20261004010540_agent_turn_boundaries.sql`私有PG **1 GREEN**（全量replay/no-op、并发同值幂等/异值409、cold pre/post与跨actor拒绝）；RunService真正durable pre/post首RED已记录，runtime consumer实现待下一GREEN窗口。service key没有新增，仅深化既有agentRunMetadata；未进入graph的失败/取消只记录partial/unavailable，未知branch=null，控制consumer须拒绝。

### 2026-10-04 第二批界面接线（优先于下方历史状态）

- 继续完整 Goal，没有回到访谈阶段。唯一实施树仍是隔离 `codex/重构Code工作域与工具内核`，HEAD `65d1097e`；原 UI 分支只读保护。首批同步冻结 `e58fe8ce`，第二批只读增量冻结 `92fad1ca182fcdd224d5f8f0c15ab4202d7b8754`；原分支仍有品牌/素材等未提交修改，不能覆盖或批量取入。版权通知已按原字节同步（SHA256 `874bf7c10bdcadd0df0b50fc782f39f077669c6e41bbdbccd868409cd714dec3`）。
- 已离线补齐 `@zcode/window-controller`、server RPC/services 和 shared services workspace 依赖；固定原 Controller 的 7 个文件与 Apache LICENSE/来源记录入树。shared/window-controller 依赖拓扑构建通过。一个 Project 的旧 Task 根 A 与当前默认 B、同根的不同 Project 都以 `JSON([真实ProjectUUID,固定根])` 为独立公开 Controller/cache/topic 身份；服务端只匹配可信来源表，不解码调用方字符串授予权限。Project UUID 仍独立保存，原 `zcodeTaskMetaSchema` 新增 optional UUID 防止帧解析丢失该归属。
- Root新增 `controller-host.ts` 真实 readonly consumer：来源是可见 Code Project 默认目录与未删除根 Task 的固定目录（包括归档列表）；真实列表/排序/正文搜索与 sessions-index 来自现有 repo，没有 Canvas JOIN、运行或执行授权。每个人类通知连接一个 Controller，每个 source 独立索引连接与租约；source 不接全局 service 广播。主宿主匹配 qualified Task/Project，SSE/侧栏事件也保留该身份。原 Controller 首 source 分区、joined dispose、ACK前 physical wire observer 三个切片已 GREEN；外部 subscribe/resync/unsubscribe、refresh/来源变动/迟到租约回收仍由 explicit 继续，尚未完整验收。
- Root最新公共回归 **20/20 GREEN**：输入 FIFO/冻结模型/附件、队列 CAS/held/sendQueuedNow、连接用户、Stop 取消 reserved 输入以及已保存未启动输入、同一 publish 并发只能派发一次、真实 localhost HTTP 响应丢失后仍派发且重试不重放、Project 默认与 Task 固定根、同路径不同 Project 原 physical wire 组装、qualified Skills 归属、原元信息未选 thought 档位省略空字符串。命令：`pnpm --filter @kenfutwork/server exec vitest run --config vitest.config.mjs src/features/code-ui/input.test.ts src/features/code-ui/project-identity.test.ts --maxWorkers=1 --no-file-parallelism`；日志 `/private/tmp/kfw-code-root-publication-identity-green.log`。这不替代真正 Harness/数据库/浏览器全链验收。
- 客户端第一批恢复/能力/目录/identity回归先取样 31 GREEN/1 RED，发现原 UI 把 qualified identity 走 remote 分支；宿主通过原 RemoteWorkspaceSession 注册把可信本地来源绑定现有 HTTP services，再定向 2文件9/9 GREEN（包含唯一失败的 membership 与 schema parse）。没有声明远程云能力，没有 mutation/附件重放。file继续 direct Root 的三处必要宿主缝：激活目录返回 canonical target、新 Task 刷新 Project 默认、viewer 上下文先安装；不能整文件复制 donor main 丢掉固定 Task 根与真实 UUID。
- 偏好仍由现有 `code_ui_preferences` 一处持有，不取原分支第二套 app preferences 表。recent读写保序/去重/前10先实际 RED→GREEN，保存前验证全部引用（含会被截到前10之外的非法尾项，整条拒绝）；公开 settings-host/workspace RPC **13/13 GREEN**，私有PG归档whole-patch竞态+重放/no-op **1/1 GREEN**，日志 `/private/tmp/kfw-code-settings-public-current.log` 与 `/private/tmp/kfw-code-settings-archive-pg-current.log`。shared reconnect治理 **9/9 GREEN**，SSE ready 输出 DB ?? env ?? default 的实际延迟。默认空会话/默认/临时目录入口的真实CodeProject DTO与持久默认引用仍在下一slice，不能声称完成。
- Root最近完整server类型检查仅旧 OpenAPI 3 个失效导入报错，没有本轮 Controller/输入/HTTP 类型错误；本轮Root8文件Biome执行exit0（仓库既有 non-null 等警告未当成 error）。三个退役 worktrees API 的本地注册与生成描述清理再次向用户提出精确授权，仍等待答复，禁止 stub/alias/其它工具绕过此前自动拒绝。Git UI写 RPC、旧 raw terminal/转录物理删除、Windows实机环境此前的阻断也仍有效。运行库未迁移，未 commit/push/PR。
- 后续Root搜索全局计数 actual RED（2命中被source裁成1且hasMore=false）→移除source静默截断、在主宿主最终query用治理限额→输入/项目公共 **21/21 GREEN**（Root52505 exit0，`/private/tmp/kfw-code-controller-search-count-green.log`）。这是顶节20条之后的最新取样。Root3文件Biome最后exit0，types仍仅旧OpenAPI3；explicit原subscriber也actual RED→GREEN，实际原frame parser保留projectId与qualified address（`/private/tmp/kfw-controller-subscribe-green.log`），当前list/subscribe与observer/dispose已接。
- 原Root直接接入已完成：main删除自建WorkspaceHost，三个必要宿主缝与真实Project/Task/viewer、ensure DTO opaque identity消费接好；先4/4启动实际RED，再单独Ctrl+N A→B目录实际RED，最后**9文件34/34 GREEN**（`/private/tmp/kfw-code-root-client-final-narrow.log`）。同根两个Project不合桶，旧Task请求仍A；原vendor+host `@zcode/ui typecheck`、实际build均exit0。14个owned Root/守卫/IFile消费者来源记录更新，16个owned SHA无漂移；详见《Code界面阶段同步记录》（已登记文档地图）。这不是原生桌面/完整浏览器/后端全链验收。
- Human `ensureConversationWorkspace`真实入口首public实际RED→GREEN **1/1**（`/private/tmp/kfw-code-conversation-workspace-green.log`）：同workspace单flight、新factory/cold复用现有code_ui_preferences内部defaultConversationProjectId引用、返回真实CodeProject UUID与当前canonical默认目录，不创建Canvas/Task或签scope，不因recent get创建。公开setting隐藏并拒写内部ID。默认/临时创建入口仍仅path，完整DTO的下一public RED已准备未实现；默认引用archive失效/保存false和跨host原子唯一性仍待实证，不偷加第二真相或DB表。
- explicit原Controller refresh、owned resync/unsub及迟到source ACK lease都已实际RED→GREEN；正在当前独占窗口继续local搜索预算/权限错误fail loud与完整兼容回归，最终token尚未返。Root消费者尚须把refresh接到archive/delete/project源变化，不能只完成adapter不接线。Harness真实边界方案在 `/private/tmp/KenFutWork-Harness轮次边界公共接口方案.md`：深化现有agentRunMetadata ledger，不加空ctx key；稳定Human ID来自Task+client/source原输入，自动压缩只认本次实际Command.update且最终graph checkpoint已提交。runtime/deep-agent/ledger尚未改。
- Root私有PG `input-restart.integration.test.ts`已补reserved输入的真实持久回执与不重放断言，源码恢复分支此前已包括reserved；尚未跑本次新场景，不能沿用旧1GREEN证明它。下一Root窗口运行 `KENFUTWORK_CODE_INPUT_TEST_PG=1 pnpm --filter @kenfutwork/server exec vitest run --config vitest.config.mjs src/features/code-ui/input-restart.integration.test.ts --maxWorkers=1 --no-file-parallelism`，只创建临时localhost数据库，绝不读运行库凭据。
- **上述待验项的最新覆盖**：Controller公共完整 **10/10 GREEN**、production factory/真实repo/CodeUiConnections/全migration replay+no-op私有PG **1/1 GREEN**（`/private/tmp/kfw-controller-public-complete.log`、`/private/tmp/kfw-controller-private-pg.log`）。Root已实际RED→GREEN接archive/delete后的host.refresh，timeline正文搜索复用原membership谓词避免置顶重复；输入/主消费者/Controller组合 **3文件33/33 GREEN**（`/private/tmp/kfw-code-controller-consumer-public-current.log`）。reserved输入私有PG新3receipt/不重放/不同host隔离也 **1/1 GREEN**（`/private/tmp/kfw-code-restart-archive-consumer-slice.log`中该文件通过）；首次失败是foreign新Task夹具复用了旧Task的代际，被真实scope fence拒绝，已按真实repo描述修夹具，未放宽业务fence。该日志同轮archive消费者仍RED，之后33GREEN证明archive修复。
- Root最新完整server tsc仍仅旧OpenAPI3；Root本轮4文件Biome exit0、diff check exit0。新增Controller私有PG测试开关已登记，另补既有附件三个env（maxPerInput/retries/retryDelay）的登记与示例；`node scripts/check-env.mjs`扫描2350文件GREEN。没有运行库连接、迁移执行、commit/push/PR。
- 原分支又前进到冻结 `3f5c38732f151fa64e99856f456623b303dbe14e`（相对92实际14文件，先前git diff仅筛UI范围显示4文件，不能当完整范围）。file只审UI轻量标题hook/platform必要增量，不取donor旧backend/shared快照/截图；下一actual Root标题public RED已准备。token当前minimal Default/Scratch DTO边界；explicit已返token，准备本轮新压缩实际Graph loop第一个public RED。Root不改其runtime/deep-agent/ledger所有权；剩余整合与强审批/Windows阻断继续有效，Goal active。
- 测试始终单实例：最新 Root52505和explicit subscriber均exit0，token当前短租minimal默认入口slice；file directRoot4个真实原Root操作case已准备，explicit public refresh/源删改/错误fail loud尚待RED。后续继续真实 turn boundary/稳定模型消息ID/手动 compact/edit/retry/fork/files rewind。旧摘要出现不能当作本轮新自动压缩，现 emitter 仍待修。最后需要当前完整 workspace/server/web/shared/types/lint/build/license/source/env/schema/replay/no-op 与真实账户/模型/Design、非空网络和 Windows环境证据。

### 2026-10-04 接续状态（覆盖以下历史施工状态）

- Goal active。用户再次明确继续完整目标，并要求阶段性同步 `codex/完整移植ZCode-Code界面` 的持续修改；原 checkout 只读，仍在隔离 `codex/重构Code工作域与工具内核` 实施。同步审计固定原分支 HEAD `e58fe8ce029be5ea0462fdf9d6e8a3c599b05fe5`；该分支尚有设置域未提交内容，不能整文件覆盖或当作已完成交付。共享契约的原 `canvasId` 不得带回新 Code Task。原目录 `.codegraph/` 与隔离目录都没有可用 index，已先尝试 CodeGraph，未初始化。
- Root 接通纯附件 `sendText`、canonical 附件/clientId、私有可信 `codeInputs`。模型输入实证：文本 bytes 创建 Run 后不被调用端改写；图片尊重显式能力；PDF走原生文件或真实提取/页图路径，超过治理预算可读失败。共同 Harness 定向 11 GREEN；原 UI Completions `false` 优先于 Responses 探测的真实 HTTP 路径另已 GREEN。没有把 renderer 任意路径交给模型。
- Root 输入状态含持久 canonical intent、冻结 ModelInvocationSnapshot、scope/branch 代际及宿主 owner。忙时 FIFO、前台真实释放后原子消费、队列 pause/reorder/delete/edit CAS 已接；busy `requestedDelivery=startNow` 是先认领、真 stop barrier、再投影新轮，竞争认领拒绝。输入公共 5 GREEN 是加入 held 确认前的取样。held 全集合确认/clear/keep 已补 source，最新回归曾被新 terminal profile 缺链接阻断而未收 GREEN；离线依赖已成功补齐。`sendQueuedNow`、Stop 对 reserved 输入的取消、真正 guide 仍需继续；不可用 guide 当前明确降为 queue。
- 重启私有 PG 1 GREEN：同宿主旧 active/queued 回执标记 `fault.command.inputDiscardedOnRestart`，返回原 `inputDisposition`、保留转录、不重放，不改其它宿主 Task。后续新增 reserved 状态纳入恢复，须再回归。模型 dispatch 重新核 scope/branch，并将 admission mode 作为 approval ceiling。自动 `run.compacted` 已真实投影 auto marker；没有伪造 token 数。手动 compact/edit/retry/fork/files rewind 尚未接完整语义。
- 附件服务 lease loss/pending Begin 关闭 2 GREEN；真实 Task release/purge 私有 PG 1 GREEN，先关闭执行资源、revoking 精确代际只清自身 opaque blobs、UPDATE 最小墓碑，保留归档 committed 与外部 sentinel。Root 已接 branch/archive release 和 delete purge；beginClose 返回锁定的真实 generation。原运行库没有迁移或删除。
- 附件 renderer 三文件 15/15 GREEN：同 chip/Task uploadId 网络重放、chunk ACK 丢失不自动 Abort、显式取消后 Begin/Commit 迟到回执拒绝、手动新 attempt、runtime 中断不自动重发、ready 保留、旧 Task 预算回执不能污染新 Task、path-only 明确失败、实际 File 即便含 localPath 仍上传真实 bytes。九项有效预算由宿主治理查询，workspace-only metadata 不授予上传；Node/renderer同源。三层共享包与原 UI vendor/host declarations build GREEN，web tsc GREEN。原生可信 path import 仍待真实 seam，未接受任意 path ref。
- 原 workspace-installed Skills host list/toggle/buildPromptContext + Code loader/use_skill/resource_path 已接同 repo；不使用 Canvas JOIN，不给 Native Read 伪 `/workspace-skills` 路径，DB 资源走只读资源缝。本域早期 22 GREEN；Git/watch/prefs/Skills 后续 server 20 GREEN、原 channel 8 GREEN。readonly Git 的后续 untracked/ref 边界测试待重验。Root已接 Git/watch consumer、watcher Task/connection/revoke/Kernel cleanup、原 terminal profile preferences 与 server `@zcode/services` workspace 依赖（offline install exit0）。这不等于端到端宿主验收。
- Windows source：真实 ConPTY/private controller/预赋外层 Job、MXC/PSEC、严格 physical range-empty、双流 ACK/UTF8/EOF/tail。portable TS 8 GREEN + native ACK 3 GREEN，WindowsGNU cargo check/fmt/Biome GREEN，没产 v2 EXE，6 条 Windows 实机测试未执行。已异步请求用户提供 Windows 环境，尚无答复。Mac/Linux已完成证据见下文，未因 Windows slice 重跑。
- Root当前拥有唯一 test token；全部子代理本轮测试已结束。file 子代理只读审 UI 分支；explicit 只读审 Harness 历史控制；minimal已完成附件 slice。其它 chat 仍可能测试，Root已只读检查全机测试 PID 后确认当时为空，继续遵守全局单 runner。最新 Root 开始 `input.test.ts -t 同workspace其它用户` 的实际 RED（连接只核 workspace、需要真实 hello user binding），该 source 尚未修；worker已指出同 workspace 不能代替连接用户归属。
- 新自动审批阻断：Git UI 写 RPC 小 hunk 两次正常审查均拒绝，未应用。原有受控 discard/commit/push HTTP/Service 存在，但 review 仍要求精确用户授权；不能换 alias/HTTP consumer 绕过。保留 10 只读方法，8未支持方法明确错误。当前 Goal 未执行任何 worktree git commit/push/discard。原 3 worktrees endpoint retirement、旧 raw terminal/旧转录删除阻断仍有效；OpenAPI缺3 exports不能伪称 types/build全绿。
- 仍未验收：分阶段 UI 分支同步与 settings 合并；connection user binding；remaining V4 控制与精确 context/file boundaries、fork附件 lineage；原 host 完整真实浏览器/空账户/模型/Design回归；native desktop trusted file import、Project-before-Task Git、非空网络配置、Windows实机；当前全 server/web/shared/workspace/types/lint/build/license/OpenAPI/Apifox、迁移终检及可审阅交付。未 commit/push/PR。

### 最新状态（本节取代下方历史施工状态）

- 本 Goal 仍 active，完整授权来自既有实施阶段；不要重新访谈或缩小目标。Code 是编码优先的通用工作，本期不新增 Work 枚举。
- 测试 token 当前 parent；所有测试只一实例。最新完整 server round3：1607 passed / 0 failed / 109 skipped，JSON `/private/tmp/kfw-code-harness-server-tests-round3.json`。之后新增 PTY tracer actual RED（spawnPty 未实现），所以不是当前全绿。Web 全套正在跑，session 57950，报告 `/private/tmp/kfw-code-harness-web-tests.json`。
- parent 已接完整逐调用 broker -> Kernel args owner-schema normalization -> final claim -> 原 V4 pendingInteraction/resolveInteraction。`permissionInvocation` 和 `approvedExecutionMode` 是 private 执行事实；原 plan 或 final plan 只能只读，不因后续 yolo 放大。edit 仅 Write/Edit/ApplyPatch 自动，其他 write/execute 仍人审。
- Code 子代理 Task 工具已接同 AgentRunService，独立 child Session/Run、真实事件投影、主/子转录隔离、稳定 child UUID、治理 depth/ownership/criteria、冻结 worker ceiling、durable full result + TaskOutput。foreground 消费标志阻止重复后台消息；detached 保留父停止后生命周期。Task work 终态补救丢失的 child 终态，拒绝迟到正文。
- ToolCatalogue 实际 SDK graph 已验证并修复不允许替换已注册实例的问题；模型过滤曝光、执行换 current owner。每模型/发现/执行边界刷新纯 mode/role/ceiling policy；systemPrompt registry 每模型重 compose，真实目录/角色/模式与插件指导不会残留旧事实。
- Project AGENTS/本地 Skills loader + Read 局部规则已接。metadata 读取用只读派生账本，不能污染主模型已读事实；完整/截断/继续指针、UTF8预算、多页frontmatter、主根 canonical 限制与附加根局部性有真实回归。
- Scope/Human 宿主已按显式 Project/Task/viewer 身份，绝不从历史 root_directory 猜 Project。同路径多 Project 409，旧 Task/draft A 后续创建用其同 Project 最新 default B，selected Project 与后台 metadata 缓存分离。packed 文件树/递归 fuzzy search/授权复验已接。
- TaskWork/Process/PG 收口回执：manager12、Process25（含 provisional barrier race 八次回绕）、private PG session1 + production store3 GREEN。Process readonlyExecution provider 保证 + consumer 接线；私有 HOME/temp canonical；全部迁移重放/no-op独立临时 PG 已做，无现存 DB 连接或 node_modules 修改。
- FS+Process restore barriers 已接并覆盖 postSnapshot；foreign writer/pending 409，不杀对方；release 后才 After(true) CAS ready。旧失败 callback 按 expected generation CAS，不污染新关闭动作。真正 Git snapshots 使用 ls-files/NUL/literal pathspecs，readonly 反向 gitignore 不破边界。
- create_mcp_server 仍 Canvas/native stdio，现只允许 Design，Code 创建/stdio沙箱 lifecycle 仍未完成；已有 MCP/compat未知效果以 execute/deferred 分类，readonly不露。
- 独立产品 worktree retirement 的 source hunks由minimal正常审核通过已应用，但parent移除 OpenAPI 3 entries/imports script遭自动拒绝（未执行）。已异步问真人精确批准 GET/POST /api/code/git/worktrees 和 POST /api/code/git/worktrees/remove，不能绕过。最新 server tsc仅这3 missing exports，其余已绿。generic Code chat transcripts物理删除、旧raw terminal bulk retirement先前同样拒绝，仍未应用。
- PTY 实施当前 explicit agent：ProcessSandbox.spawnPty -> ManagedTerminalProcess.resize/onOutput，同 Task helper内 node-pty + SRT + sanitized env/range-empty/restore barrier；实时流独立于有界日志。它 owns process-sandbox/** 与 legacy terminal-session必要小export，不删除legacy。first真实TTY tracer已actual RED，parent等其source后短租token。Parent owns WS/shared/CodeUI人类终端consumer。不能把人类终端伪造 originRun/toolCall 的 Agent TaskWork。
- file agent owns command-tools.ts+test/policy 最后补覆盖；已3真实 producer GREEN，readonly/worker只能控制own record.agentId，main可控wholeTask；TaskOutput仍可读Task记录。最后coverage还需纳入全 suite。
- minimal agent已收口 Scope/Projects/Chat/Git/Checkpoints、package扫描、Human files/host identity；最新原 UI build+host tsc已GREEN。它的最后UI draftalias/host channel新增case在此次Web suite中验证。
- 总体尚未验收：原UI浏览器/空账户/真实模型、原host Provider CRUD/terminal/ignore/watcher缺口，三协议原UIGemini当前unsupported，Windows真实运行和非空受限网络，全 pnpm test/typecheck/lint/build、最新 api:spec、Apifox AI分支导入、迁移历史SHA/实际schema完整交付账本、review与commit/PR。不要把已过的窄/服务端suite说成完整目标。

下方条目保留为历史施工背景，其未完成描述以本节为准。

### 工作区

- 实施 worktree：`/Users/shigaoyu/.codex/worktrees/code-harness/KenFutWork`，分支 `codex/重构Code工作域与工具内核`，基于 `65d1097e`。
- 原 checkout `/Users/shigaoyu/Develop/KenKenDev/KenFutWork` 的 ZCode UI 迁移要保护。上游 refs 在原 checkout 可读，worktree refs 未初始化。
- CodeGraph 已尝试，不可用，不重新初始化索引。所有 tests 共用一个 token，禁止并行测试实例。

### 已接源码

- Code Project/Task/Chat 持久身份与目录 scope，不创建 Canvas。目录/权限代际、branch generation、只读派生、恢复期私有 handle 均已有接口。
- 文件 core Read/Glob/Grep/Write/Edit/ApplyPatch/preview/diff、真实目录/版本/原子 bytes 发布、取消与撤销、图片/PDF 已接。Kimi/Codex 纯算法来源和 LICENSE/NOTICE/SHA 已核对。
- SRT 每 Task helper，真实 stop/stdin/EOF/argv/统一采集 cap 和 stdout/stderr 分流；可信更新与关闭屏障；发布 helper 完整依赖闭包；Mac CJS/SEA 使用独立 Node 路径。
- `features/task-work` 已有 durable store、manager、Bash/TaskOutput/TaskInput/TaskStop、私有日志引用/快照统计；Code 已不装旧 Run-owned registry，不再按旧轮末闸门 LLM 轮询。Design 旧路径仍在，需最终审计。
- runtime private `eventSink` 统一投影，`cancelTaskRuns` 等待真正 stream 完成；Code main 具有 Task foreground lease。HTTP/WS Code 起 Run 必须 open 实际 Task，再经过 CodeUi.admitExternalRun；不能伪造 Canvas 或改变持久模式。
- CodeUI onTaskWorkChanged、resumeTaskWork（bool admission）、rewindTask/finishTaskRestore、Task actors cache、Task close resource callback 已落。恢复整个 batch+后快照结束前维持 revoking，普通 Run 不可进入。
- 旧 Code Workbench 已替换为原 CodeWorkbenchFrame；Visual 只 Design/Flow。Vite 原 UI 生成+stage public/code-ui，Web prebuild/predev 已接拓扑构建。明确孤儿旧 Code UI family 已清理。
- Human directory picker / workspace.open / 默认与 scratch Code 项目 / 真实 UI preferences / Task 或 Project 显式 viewerScope 正由 scope worker收口；不按路径猜 Task。
- ToolCatalog feature 初稿：常规 ToolSearch，core 常驻，optional schema deferred，动态 wrapModelCall/wrapToolCall，SDK context 经 AgentRunExtension 传入。MCP/browser/search/CU 曝光元数据已调整，**还未行为测试，不能算完成**。
- 中性共享 base prompt已改；Code prompt由工具属主贡献。项目 AGENTS/本地 Skills 与 workspace skills 的 Code 加载尚未实现。
- Code user hooks 的 governed timeout/preview 已改，新增 scoped-hook-command 经 ProcessSandbox argv 执行；**尚未测试，Design raw hook/旧 native terminal 仍需审计**。

### 最新证据

- Process public真实回归 13/13；18 own files Biome；Windows GNU cargo check --locked/rustfmt green。Mac 发布 helper独立 Node 实际命令运行已测。Windows 实机与非空网络 allowlist仍未完成（fail closed，不能用编译替代）。
- FS/producer/profile/diff串行4文件30/30，FS21、producer4、profile1、diff4；23 own files Biome、来源 SHA核验 green。
- 原 ZCode UI拓扑构建及 Web tsc green；空账户 E2E和真实浏览器尚未验证。
- TaskWork首3测试 green；随后真实四并发 stop修复为join，同域4/4；host lease manager5/5；独立私有PG session lock1/1。后续 worker仍施工，不能把这些窄 tests 当总验收。
- 最近 server tsc仍 exit1：runtime-checkpoints.test旧canvas hook、个别root已退役ensureCodeSession fixture，以及新 PersistenceSessionLock要求的 runner fixtures；这些正分属parent/worker处理。

### 当前代理 ownership

1. scope_interface_minimal：execution scope/types/repos、projects/chat、Code UI storage与Human workspace/viewer、CodeGit/checkpoint接口/HTTP/shared契约与fixtures、Web原入口接线。parent保留CodeUi service新Run/BG/restore methods、plugins接线、runtime/WS/registry/docs。
2. scope_interface_explicit：process-sandbox实现已收口（parent plugin.ts）；当前TaskWork types/service/repository/test-store/测试、Persistence session lock Provider/契约与必要fixtures。parent保留TaskWork command-tools/plugin/model-mailbox/close-resources。**持唯一test token**，真实PG只临时私有集群。
3. file_tools_implementation：文件实现已收口；当前permissions feature、HTTP、agent-modes工具策略和必要shared permission契约/tests。parent保留kernel/context/types、runtime/deep-agent、CodeUI投影与ToolCatalog。未持test token。

### 紧接下一步

1. 完成 TaskWork stop/close/lease-loss/restart/false-admission/代际场景及生产PG store COALESCE；parent已接onHostLost→cancelTaskRuns+revokeTaskFileOperations，onReady await initialize。
2. 权限 worker给出完整call/admit/peek/claim与pending/resolve/revoke接口后，parent接kernel payload、async SDK gate、原V4 pendingInteraction及审批command。build/edit/plan/yolo、旧worker审批ceiling、同参数与scope generation的一次许可不可用工具名永久记忆代替。
3. **Code子代理仍未实现新共用Harness**：当前Code不装旧子代理，API清单/提示须最后与实际工具同源。用同createAgentRunService/factory，独立child session/run和eventSink，readonly explore/review与writable worker，Main stop不终止显式BG。不得恢复旧createAgent单独loop。
4. ToolCatalog需公共SDK行为测试（真实Scripted Model或公开middleware seam）：core/已激活optional才进请求，安装/卸载更新，Readonly未知effect拒绝，activation不是授权，providers无native tool-search也可用。optional插件提示段需对应实际激活，不挂所有安装能力的过时指导。
5. 根/嵌套 AGENTS与本地Skills先metadata后正文；Code workspace skills不得Canvas JOIN。真实选中模型的vision/pdf能力目前仅credential.vision，需与目录声明/hints一致，保留显式false。
6. 核对所有残留 Code Canvas / 旧裸执行：plugins install、MCP创建路径、preview/terminal/CodeIndex、代码文件交付、old generic chat collector、Code AGENTS不变量与文档。WS Code collector已限制不写generic Chat，Code UI唯一转录聚合。
7. Scope worker checkpoint/CodeGit新契约需更新OpenAPI所有query/body为taskId，optional rootDirectory说明，expectedVersion恢复；`pnpm api:spec`后Apifox AI branch import，合并按repo确认规则。
8. 加真实 TaskWork Bash/停止/重启日志和Code UI host integration、原UI从空账户建目录/Task/工具/后台结果/审批/回滚/媒体/Design/Flow浏览器验收、真实模型链路。
9. 历史SHA、临时空PG全链重放、实际schema、二次no-op；主test/typecheck/lint/build；第三方校验脚本/目录Biome排除；docs/日志/AGENTS同步；逐hunk review、明确路径commit/PR。

### 自动审批阻断（不得绕过）

- 特定 Code Task的 generic chat_sessions/转录物理DELETE源码，两次正常审核均拒绝（含parent按真实chat_session_id/Code/workspace/root限定hunk）；理由具体记录删除授权不足、不可逆数据破坏。补丁未落、没有DB执行。已用异步问题请求用户选择“仅该Task关联Code转录删除”或“保留归档”，**目前等待回复**。
- scope worker整批退役旧terminal_* WS schema/helpers、raw terminal-session/git-exec源与测试的操作也被拒绝，理由可能中断现有终端功能，缺明确移除能力的人类授权。未落，不可通过只删consumer/改名等方式规避。可准备迁移同一Scope/ProcessSandbox保留能力的安全替代；若仍需移除，提供具体可审阅范围并请求审批。

### 新迁移

- 20261002192638_code_task_execution_scope.sql
- 20261002202429_code_checkpoints_task_scope.sql（含branch generation）
- 20261002204235_task_background_work.sql（parent新表）
- 20261002222123_code_ui_human_workspace.sql

所有旧迁移不可修改；当前仅新源码，无现存数据库执行、无用户真实文件删除。

### 补充交接：后续宿主与门禁状态

- Web first全套481 passed/2 failed（`test/zcode-message.test.tsx`缺IntlProvider）；父已修真实provider fixture，单文件4/4 GREEN。完整Web需复跑。env权威登记12项新治理数值+isolated PG gate，`node scripts/check-env.mjs`GREEN。workspace gates22/25，仍有worktree API/spec/retiredimports两个等待真人批准项（不得绕过）。
- Parent三次完整server：round1 46fail→round2 3fail→round3 1607 passed/0failed/109skipped（尚未加入后续PTY/provider/red）。报告在/private/tmp/kfw-code-harness-server-tests-round{2,3}.json，失败修复证据保存log。HTTP/app probes用public memory TaskWork manager override，生产onReady真实PG host lock fail-loud不被放宽。Agent assembly补显式dependencies，旧Code virtual-path chip改真实absolute语义。
- 唯一test token此刻root，无live。explicit继续PTY source不tests；file Provider CAS source不tests；minimal原Provider adapter source不tests。
- PTY4条actualGREEN：真实TTY/创建尺寸/stdin/stop、resize/raw方向键Ctrl+C、cap之后live ANSI、UTF8全量byte cursor。native node-pty安装spawn-helper0644是真失败原因，Task私有复制品0755，不改共享node_modules；仅此次PTY启SRT官方allowPty。public onOutput(data,{sequence,offset,nextOffset})，seq每process从1，cursor全量UTF8（不等retainedBytes），reader Promise后ACK/pause回压，一帧pending，无无界queue。
- **PTY job-control第五条仍actualRED**：stop宣称rangeEmpty后自己创建的后台job heartbeat98→105，不能宣称完整停止。explicit正在Mac native getsid/libproc birth+SID/PGID范围inspection/helper；ps sess0不是SID，不能杀单PTYpid就假退出。Linux bwrap new-session/pidnamespace与controlling TTY需真实接线；Windows同样不许pipes假PTY，目前failclosed。旧WS terminal仍canvasId?且不传时宿主cwd rawPTY，必须父consumer改显式Task并保留真实能力；不能bulkdelete绕自动拒绝。
- 新BYOK闭环分工：file owns model-provider service/repo/types及shared create/update/response credential/draft/CAS hunk、nullable前向migration、providers/types/resolve/OpenAI index必要explicit dialect hunk。first draft RED→GREEN service19/19；create无key/models[]是真draft，hasCredential真、configRevision库default1，resolve无key409。update null clear/protocol/CAS待继续。minimal owns providerCompat安全codeUi/chatApi、packages/zcode-provider nativeGemini闭集、CodeUI provider-settings-rpc/model-views及69d31706必要凭证UIhunks。双方避免整shared文件格式覆盖。
- Parent runtime已转发credentials.useResponsesApi/responsesApi，!==undefined保留false。原CodeUImodel optionMap必须按selected options编译每Run再交三协议adapter，当前Anthropic/Gemini参数还未完全在线；不能把view配置当执行已接。minimal建议adapter.readModels(actor,selection)->{settings,selection}；call(actor, service,method,args)->{result}|null，notifyViews回调父owned connections。
- 原IProviderSettings真实get/refresh/create/saveOverlay/delete/reorderProviders&models/add/rename/delete/saveModelDraft/setModelEnabled/resolveModelConfig/testConnectivity；IModelSelectionService仅getView，模型选择通过原V4持久command（需核对实际command名称，不另造loop）。UI安全metadata放providerCompat.codeUi；providerOrder放existing code_ui_preferences，不另造第二份供应商。Gemini要google-generative-language真实闭集，不谎报OpenAI。
- 任务总目标active，所有外部DB未执行migration，未commit/push/PR。PTY/provider/watch/ignore等原host缺口、模型参数三协议、用户输入附件/排队/重试/rewind/fork/compact真实原V4入口、browser/empty account/live模型、Windows实机/network配置、全gate/docs/OpenAPI/Apifox/review仍待完整推进。不要用本补充里的局部green结束Goal。

### 续轮增量（终端consumer与Provider）

- Parent新增 `features/code-terminal/types.ts/service.ts/service.test.ts`，首public准入case actual RED→GREEN 1/1（`/private/tmp/kfw-code-harness-terminal-admission-green.log`）：显式Task+owned用户连接；同步reserve后await scope、同ID复用启动Promise、参数换绑冲突；断线/Task关闭夹紧pending，迟到授权不能spawn，stop等待rangeEmpty否则保留stop_unconfirmed。此模块目前**尚未注册plugin/consumer或激活输出**，下一slice必须接线，不能称人类终端完成。Root owns这个模块、WS/shared、CodeUI terminal listener/activation。
- Explicit PTY5真实 GREEN，随后既有Process25+PTY5同runner GREEN30（`/private/tmp/kfw-code-harness-process-pty-regression.log`）。Mac小C inspector编译通过，getsid+libproc birth校验，session所有PGID冻结再TERM/CONT/KILL与实际empty扫描；natural退出同样等残余jobs清空。原test第5 heartbeat泄漏已修，仍要包装发布资源和后续边界矩阵。Linux/Windows PTY仍未完成，明确failclosed，不冒称三平台都实现。
- token最近explicit正式返root（runner35361exit0），Root末次自己的terminal admission session6883exit0，无live；file/minimal只source，不跑tests。所有新tests还需最后fullsuite重新取样。
- Provider接口进一步一致：file新增实际 testModelConnectivity(user,{instanceId,modelId,...})→{modelId,success,error?{code,message}}，必须当前真实native adapter/headers/extraBody，错误脱敏，不把capability探测bool拼success。API dialect明确选型采用SDK真正export的ChatOpenAICompletions/Responses，false也不能模型族启自动responses；缺省才保留probe自动纠偏。Parent runtime已透传两个dialect事实保留false。
- minimal adapter/readModels方案已给parent；原option map必须每Run编译选择选项（Anthropic/Gemini/显式null/缺档位不能读时静默最高档），实际ModelSelection command名称仍要核实，不照交接泛称盲加新命令。safe compat metadata、Gemini闭集与原凭证UI必要69d31706 hunk在隔离分支推进。
- 环境变量权威登记和样例已完成，static env check GREEN。Worktree 3 endpoint退役metadata自动拒绝的明确真人选择仍pending；该hunk不能间接绕过。Goal active/no commit/push/PR，目录/Scope编译与门禁不代表PTY、Provider及原UI全目标完成。

### 最新接续状态（2026-10-03 下午，覆盖前述历史待办）

- 总Goal仍active。主树仍保留，唯一实施树为 `/Users/shigaoyu/.codex/worktrees/code-harness/KenFutWork`，未commit/push/PR。Code定位仍coding-first general work，本期不增加Work枚举。
- root完成Task人类终端模块、plugin/key/profile、WS显式taskId、原CodeUI TerminalService/SSE绑定；前端data+exit监听均装好才activate，terminalId隔离，关闭连接/Task等待真实rangeEmpty。并发预算terminalMaxSessions进governance。Service+WS12GREEN、原Channel6GREEN、发布helper2GREEN。@zcode/ui host严格类型与web类型曾GREEN，后续附件wire改动仍需复核。
- explicit完成Mac PTY job-control与两条drain缺陷：慢listener等ACK、native node-pty200ms强制close丢尾部。只改Task私有SDK副本，保留MIT来源；Mac Process25+PTY7合计32GREEN（在后续stdio改动前）。Unix spawnStdio首真实1GREEN：非TTY双流、UTF8、EOF、live/capture独立。当前compiled helper `/private/tmp/kfw-process-helper-stdio-5rnki1u1/task-helper.mjs`，含两流RPC和PTY新readerRPC；早期artifact不能验新协议。
- Linux/WindowsPTY及Windows双流仍未验收/部分未实现，failclosed。Docker Desktop已启，曾瞬态退出；日志是Electron requested shutdown→dockerd healthy exit，触发者未知，不能推断OOM/CUA/用户。现在CLI ready，无我们容器，16GiB机器内存余量较低，测试按单文件串行；独占平台/test token时再开1GiB/2CPU临时容器，不动既有镜像/容器/用户配置。CUA getApp(Docker)异常等待1767s超时，别重复。
- file已完成Provider草稿NULL/clear/protocol/完整模型声明读回、workspace与system原子CAS及外workspace404、显式OpenAI API类、实际connectivity。36unit/HTTP GREEN，私有PG1GREEN含全迁移replay/noop，75既有SHA不变。新NULL草稿SQL未执行运行库。
- minimal的原provider-settings-rpc/model-views/model-execution-options已17GREEN，并由root接到constructor/hostRpc/广播/native connectivity。真实ModelSelection通过sendText.modelSelection持久，没有虚构V4 setModelSelection。Root已接内部ModelInvocationSnapshot并校configRevision，完整body不再重并静态extraBody；三native协议消费真实参数，修复OpenAI SDK覆盖max_tokens。实际Harness HTTP与陈旧配置拒绝已GREEN。最新新增snapshot.useResponsesApi锁UI方言（保留false、避免probe改到另一协议）尚需针对复验。
- root async disposer首RED→GREEN27；核心与compat/plugin registry生产unload均await，失败保留loaded/资源以便retry，不删bundle/假称卸载。ResourceDisposer类型是两个函数类型union，兼容同步cleanup返回array.push数字；drain识别thenable。ToolDefinition.projectArguments已接canonical middleware、runtime公开tool.started/deny与审批displayArgs，执行/指纹仍用原始normalized args。public args只给副本，投影失败隐藏；52GREEN验证原始env不被改写且公开只envKeys。
- file正推进MCP Task service：stdio SDK transport4GREEN、Task基线8GREEN；合法ASCII配置name+中文/点/长RPC名的wire alias先RED，后Task9+transport4共13GREEN。下一tools/plugin6已5RED/1GREEN，当前实现唯一mode dynamic create dispatcher与Task/revoke/hostlost/unload关闭接线，保留Design HTTP。Unknown效果execute，不能信remote readonlyHint；aliases<=64 ASCII，description可按原名搜，RPC仍原名；env projector必须幂等。
- minimal的附件service首unavailable RED→真实private Blob/metadata1GREEN，bounded local Blob11GREEN；新Begin协商chunkMaxBytes/totalChunks，renderer去固定384KiB，wire默认20MiB/64限制移到governance（固定frame护栏保留）。privatePG第一次真实RED为新草稿FK指auth.users兼容view，已仅改未发布未入账SQL到public.accounts，待同file复跑。原历史SQL/账本不变。新附件SQL、6项governance/env registry/examples已登记，node scripts/check-env.mjs GREEN。
- root新增attachments/host.ts作为CodeUI归属回调（workspace/rootTask/session/row target+index）；主service.ts/plugin/HTTP已接附件RPC与private repo/blob，lazy init由附件模块确保，连接before-call先require。**此接线仍未完成Run输入与rows附件消费，也未验首begin断线竞态**。minimal下一slice需hostLease在Blob写时丢失的非aborted save护栏、同步closedConnections pending fence、releaseTask及softdelete仅我们私有附件清理、composer20MiB/8件前置门预算。别把plan只读执行当Human上传禁令；archive历史附件read不看canUpload。
- V4原入口审计：`/private/tmp/kfw-v4-original-entrypoints-audit.md`。忙sendText应FIFO/held，不直接拒绝；attachments/clientId/canonical intent待持久；compact是真上下文操作且同FIFO，不新造user row；普通retry按钮原UI不渲染；队列编辑是deleteQueueItem后恢复composer。编辑会话回退走editUserQuery（默认preserve，显式rewind才文件恢复）；文件专用applyFileRewind不截聊天。fork是独立可选Task，不能用隐藏subagent parent_session_id。Checkpoint当前kind=turn无法分pre/post且未变snapshot为null，须精确边界，不猜上一条。
- remaining：附件/队列/真正compact/edit/fork/file rewind、原Git/watch/ignore/终端偏好/skills等host缺口、Code workspace-installed skills、nonempty network设置及三平台实证、私有真实空账户/模型/浏览器/Design、当前全server/web/shared/workspace/typecheck/lint/build与源码来源门禁、迁移最终replay/noop、OpenAPI/Apifox AI分支、reviewable delivery。历史1607GREEN不代表当前全绿。运行DB未迁移。
- reviewer拒绝的3worktree endpoint OpenAPI retirement仍pending真人准确回答，不用alias/stub/apply_patch间接绕过；server总typecheck最后仅剩该3exports时仍不能称绿。旧Code chat_sessions物理删除等拒绝也未执行。
- 更新：MCP工具/plugin/legacy21GREEN，加Task9/transport4共34及compiled-helper actual1全部GREEN；MCP本域Biome23files及owned类型无错误，说明在features/mcp/任务MCP与stdio生命周期.md。两个native test env已进权威表。附件native accounts FK修正后privatePG全流程1GREEN8.72s无unhandled；新hostLease Blob写期间释放public RED已验证（旧代码返回committed，应拒绝），source已修等待同caseGREEN；连接首begin/close race RED已写待运行。
- root HTTP optional publish闭包已改捕获const调用，避免附件RPC返回类型新增后unknown/possiblyundefined；当前server全量类型仍需重新跑（minimal附件测试fixture隐式any正在其owner修复，OpenAPI3保持review pending）。新attachments/host.ts与主service绑定没有model-input消费证据，不能宣称附件已可供模型使用。
