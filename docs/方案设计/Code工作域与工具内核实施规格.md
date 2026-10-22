# Code 工作域与工具内核实施规格

> 角色：本 Goal 的实施规格与验收账本（2026-10-03，实施中）。产品方向仍以《改造计划》和《多端产品设计》为权威。既有《模式能力分离方案》记录第一轮分离；本规格承接其目录、工具与后台任务遗留。当前产品为无用户的 MVP，允许破坏性调整 Code 契约，不保留旧调试数据的运行兼容层。

## 1. 已确认的产品语义

- 本期 Code 是以编码为重点的通用工作模式，也承接调研、文档、数据处理。未来可以单独设计 Work 模式，本期不新增模式枚举或入口。

- 一套 Harness：模型、循环、压缩、持久化与协议适配共用；产品模式由持久 Task 身份决定，客户端不能靠某轮 preset 改变模式。Code/Design 的会话、模式指导与专属能力分开。
- Code 名称保留，编码优先，支持调研、文档与数据处理。Work 独立模式以后再议。
- Code 完全解除画布依赖：目录、会话、检查点、skills、终端/git、插件安装与文件交付都不再用 Canvas ID 定位。Code 项目不创建主画布或隐藏画布。
- 每个项目有一个主目录；可显式绑定真实目录，否则生成稳定的项目默认目录。Task 固定其主目录，项目默认变更不偷偷迁移既有 Task。
- 附加目录支持只读/读写；项目保存默认组合，Task 可显式调整。相对路径按主目录或显式 cwd 解析，绝对路径表示执行机器的真实路径，不伪装成虚拟根。
- 目录、权限收紧立即阻止新操作及旧 stdin，终止受影响的命令/worker；直到确认退出才报告撤销完成。扩权不自动扩大已派发 worker 的权限。
- 多 Task/worker 共用目录，本期不增加 worktree 产品功能。应用内同文件提交串行并检查观察版本；不同文件可并行。普通 shell/外部编辑器的写入不宣称具有同一提交协议。
- 内置核心能力默认随 profile 装配，用户无需安装每个 Read/Edit/Bash 工具；属主按 feature 贡献能力与指导。MCP/可选插件按需发现，并同时检查模式、角色、授权及实际后端能力。
- explore/review 只读，worker 可写。子代理继承父权限上限，声明责任范围、完成标准和返回证据；所有角色复用共同 Harness。
- 后台命令/子代理属于 Task，可跨 Run 存活，支持查询、增量输出、输入和真实停止。终态通知忙时在下一模型边界消费，空闲时自动发起同一 Task 的新 Run；不为等待任务反复请求模型。
- 主停止只停当前前台轮次；显式后台工作继续并仍可通知。后台卡片可以单独停止。删除/关闭执行资源会停止所属工作，删除墓碑与分支代际拒收迟到通知。
- 执行进程重启后后台任务标为已中断，保留记录和输出，不自动重放有副作用的执行或旧通知。
- 文本/代码、图片/PDF 是本期文件范围；原始结果、模型摘要和用户展示分别投影。用户产物在授权目录，日志/交付引用归 Task；展示不依赖 Canvas，不默认上传。
- 项目 AGENTS 按目录作用域加载，Skills 先元数据后正文；只读参考规则不成为主项目全局指令。规则和模型文本不能授权目录、工具或永久提权。
- 未来联动通过用户选择的 @Canvas/其他资源 mention，明确资源身份、权限与反馈；本期不开放 Code 画布读写，也不从当前 Design 页面借目标。

## 2. 模块与公共契约

### 2.1 项目与 Task 工作域

沿用 Project/Task/Workspace 领域模型，不另造客户端项目或账号工作区。公共 Code workspace 删除 canvasId，增加稳定的工作域身份；Project summary 按 kind 区分 Code 目录与 Design/Flow 画布。

执行作用域返回受控句柄，而非让调用方随意消费路径字符串：

```ts
interface ExecutionScopes {
  openTask(actor: LocalActor, taskId: string): Promise<ExecutionScopeHandle>;
}
interface ExecutionScopeHandle {
  describe(): CodeExecutionScope;
  derive(role: "main" | "explore" | "review" | "worker", agentId?: string): ExecutionScopeHandle;
  resolvePath(path: string, operation: "read" | "write"): Promise<string>;
  readonly backend: BackendProtocolV2;
}
```

`CodeExecutionScope` 包含 instanceId/projectId/taskId、generation、rootDirectory、additionalDirectories 与 sandboxMode；LocalActor包含instanceId/accessClientId，不包含账户别名、bearer、provider key或可由模型伪造的审批凭据。后台执行器由同一scope生成OS policy。所有消费者必须接线，禁止路径校验只存在于模型schema/提示。

Task 的持久目录授权保存到 Code session，项目默认在创建时继承。数据库/目录不可用必须返回可读原因，禁止吞错换到另一目录。路径穿越、符号链接逃逸、同路径别名、只读子目录和跨工作区身份均由统一规则处理。

chat_sessions 增加项目及产品模式归属，Canvas 外键仅为 Design 可用；Code UI session 删除 Canvas 外键。历史迁移不改 checksum，只新增前向 SQL；旧 Code 调试会话可清理，Design 数据与用户真实文件不删。

### 2.2 文件与编辑

以 ZCode 核心工具及 display 契约为主要对齐对象，复用原 V4 界面；工具名称/输入/结果适配集中在生产端，不手写第二套卡片。

- Read：真实路径、行/列范围、文件版本、分页继续指针和截断原因；超长行与 Unicode 边界可继续读取；二进制不能当 UTF-8。
- Glob/Grep：限定授权根，支持范围/过滤/行号，错误不等于零命中；截断明确并可继续获取。
- Write/Edit/补丁：新建不覆盖现存文件；既有修改须观察版本。精确替换和补丁共用版本检查、同文件锁、提交与真实 diff。多文件部分提交/失败必须明确，不伪装成跨文件原子事务。
- 图片/PDF：用户预览与模型读取分开；模型能力不足显式说明。复用现有 sharp、pdfjs/react-pdf 路线，不依赖用户手装 Poppler 才能完成基础交付。
- 预览、diff、终端/git、回滚、安装与 artifact 均消费同一真实目录规则。影子 Git 不改用户 .git；回滚核对并发变化，不能恢复掉其他会话的新修改。

### 2.3 命令与真实沙箱

命令由统一执行器持有进程句柄，foreground/background 是生命周期选择，不是两个重复 shell 后端。句柄有 Task/Run/调用归因、stdin、输出游标、退出状态与真实 stop；wait/yield 与进程 deadline 分开。

- macOS/Linux：固定 SRT 0.0.78 的官方 API；每 Task 独立 Node helper 隔离其单例/代理状态，逐调用传完整目录 policy。helper 与后台工作同寿命，命令退出逐个 cleanup，所有进程退出后 reset。
- 原生 Windows：复用/改编 Codex 独立 sandbox/broker/Job 的必要低层实现，不引其 AgentCore；Task 私有权限主体/读取域，不能沿用 stock 全局读取组或 SRT Alpha 的全局账号授权。
- 启动前功能探测与 enforcement 报告，缺少必需能力直接失败，不裸跑。派生角色只收窄；一次性审批绑定原调用与授权版本，不是 agent 的永久授权入口。
- 撤销状态 `ready → revoking → ready/failed`。禁新 spawn/stdin、杀受影响进程并等待管理范围退出；停止失败保持可见，不把逻辑 canceled 当真实退出证据。
- helper 不继承服务端数据库/provider 凭据。用户执行环境与业务服务环境分开；宿主接口与输出脱敏保留现有 BYOK 红线。

### 2.4 Task 后台工作、工具目录与提示

后台工作统一状态/持久化/输出/通知，命令与子代理是具体 executor；其他确有消费者的异步工作可贡献 executor，不预建空壳。独立 child session/run 与父调用稳定关联，不把子正文塞进主转录。

终态、通知 admission/消费与自动新 Run 都具有稳定身份和幂等记录；单 Task 不并发两个前台 Run。压缩后重新注入运行中工作及输出引用，避免重复启动。主停止与单后台停止分离，关闭页面不停止服务端工作。

`tools` 注册表扩展曝光元数据：core 常驻、可选工具 deferred，普通发现工具做宿主确定性检索，不额外调用 LLM 选工具，也不要求供应商原生 tool-search。下一模型请求只发送许可 core＋已激活工具；执行再次复核当前 scope/role/permission。卸载及授权变更撤销旧激活与指导。

prompt registry 保留：中性共享基础＋Code/Design 模式段＋实际工具指导＋角色＋项目规则＋Skills/插件段。Kimi MIT 核心提示可作底稿，改为本产品事实；Claude 镜像仅作历史机制参考。取消“方案讨论一律不能读工具”、全模式可爱人格与子代理硬编码中文。工具描述、曝光与指导同源，不宣称尚未实现能力。

### 2.5 规划状态与基础权限

Task的基础权限mode与独立planEnabled分别持有。输入接纳即冻结二者；普通纯文本guide按FIFO在同一Run下一模型边界生效，未消费的输入不能提前改变当前策略。开启规划保留基础mode，由既有逐调用解析器派生有效plan权限，工具目录、真实执行门与规划提示消费同一事实；关闭后回基础权限，仍受Task物理目录/沙箱及派生角色上限约束。

规划开关不等于退出批准。Enter/Exit必须是有限的可信控制效果，不能伪装成Read或让MCP描述签发权限；Exit复用原人审，明确approve才可批准，拒绝/取消/撤权保持可读结果。批准计划属于独立Task事实与管理文件相对引用，不能把snapshot.plan的Todo进度作为批准源，也不能为了计划扩张Task目录。批准文件、冷恢复、子任务限制和压缩后的消费者均须真实接线与验证。批准正文消费者沿code-ui owner与原PromptSection注册缝，每模型请求从真实执行Actor/Scope/branch定位Task，并核原plan.approved事务指纹、管理ref/FD/路径/SHA；不得从旧ToolMessage或摘要恢复批准权威，正文不扩张当前执行权限。

### 2.6 基础权限、独立规划与模型审批（2026-10-22）

基础权限、独立规划和审批模型各自持有事实，Code／Design 是单独冻结的 Run 工作方式。普通问答与工具任务共用 §2.7 的 Agent 工作流程。

| 基础权限 | 语义与强制消费 |
| --- | --- |
| 变更前确认（`build`） | 文件变更和命令执行逐次审批。 |
| 自动编辑（`edit`） | 受控 Write／Edit／ApplyPatch 自动允许，命令执行继续审批。 |
| 完全访问（`yolo`） | 自动执行，使用执行机器当前 OS 账户可访问的文件与网络，不等于 root 或系统提权。独立规划、派生角色、Task 身份与撤权代际继续限制实际操作。 |

独立 `planEnabled` 开启时只读调查并形成计划，保留基础权限。Bash 获人工允许后仍只能在已验证的物理只读、无网路径执行；可信退出规划批准后回到本次 Run 冻结的基础权限上限。explore／review 子任务只读，派生任务继承父权限上限，角色限制不能被人工或模型批准扩大。

输入接纳冻结模型、思考、基础权限、规划、工作内容与授权版本；排队、重启、历史重试、子代理及后台续跑消费各自的已接纳事实。后续菜单操作只影响新输入，不能读取当前选择扩大历史权限。权限收紧、Task 关闭或撤权仍即时生效。

基础权限改档作为本次真人输入的单次授权效果处理：忙时进入新Run队列，不能指导旧Run换工作域；新Run持有真实Task前台身份后、执行前消费选择。授权CAS同时核对原代际、分支、Run、canonical命令和待消费值；Stop、撤权及抢占优先。内部授权更新只承接同代active/queued输入，逐条仍用各自冻结档位；同档消费不增加代际，历史重试与后台续跑不重新签发旧全权。更新中断沿既有恢复丢弃未完成输入并提示确认重发，不自动重放。

原 ZCode 盾牌菜单只显示独立 Plan 勾选与三种基础权限，沿用原图标、间距和橙色完全访问状态。Plan 标记关闭直接修改当前 Composer 草稿，保留基础权限；发送时复制该草稿中的即时选择。权限设置独立选择审批模型，空值表示人工审批。

“帮我批准”是 Approval Gate 的可替换决策提供方，接收宿主绑定的 Task／Run／调用、参数指纹、权限与规划代际、真实操作及上下文，返回允许／拒绝／交还人工及理由。最终执行仍经同一权限 claim 和撤权复核，模型建议不能签发目录权限、越过规划或角色限制，已消费批准不能重放。模型不可用、预算不足或结果不完整时回到原人工审批。凭据只在供应商接口解析，不能进入审批参数、事件或持久日志；提供方沿现有插件能力贡献，定义、实现与消费者共同连接。

完全访问采用确定性的直接执行，不逐操作请求审批模型。审批模型只供需要审批的操作消费，独立绑定用户 BYOK 目录，不固定供应商、模型 ID 或统一默认值。当前对话模型与审批模型分别保存，切换不能借此前决定扩大已冻结权限。

审批只使用完整、受信的操作投影；未知工具、带环境值、敏感内容、过长或不完整上下文交人工。宿主从持久 canonical 输入和当前主会话真人消息恢复约束，后台通知与模型文本不能签发授权；有限 Goal 的剩余预算在请求前校验，同 Run 审查串行接纳，实际用量归原 Run。人工先答、Stop、供应商或审批选择变化取消在途审查；允许结果绑定到最终 claim，并在执行前复验配置与真人要求版本，迟到或已消费许可不能重放。提供方返回拒绝／不明／失败均保留人工门，退出规划仍由人工明确批准。

Code先对标实际ZCode应用：双方明确使用GLM5.3Flash、同一任务与相同初始文件，分别核对工具/审批和最终产物，以一次用户输入自动完成为目标；仅新建一个隔离测试文件夹，不改用户已有ZCode项目、任务或供应商配置。Kimi/DSH/Codex用于权限与模型审批机制源码核验，不照搬专有实现或削弱本项目Task、规划、撤权及Stop边界。Design对标Toonflow源码，本轮不操作或配置Toonflow应用。

真实媒体优先复用已生成原片做保存/回填；必要时图片、视频各最多一次新生成提交，失败或结果未知立即停止，不自动降清晰度、换模型或补发。源码与自动化回归先完成并冻结，再运行真实KFW任务，避免开发热重载干扰运行结果。以上为新Goal验收范围，不改变2026-10-16已完成范围的历史回执。

### 2.7 统一 Agent 工作流程（2026-10-22）

普通聊天、读取文件、编码、媒体、CAD、技能和插件任务使用同一 Harness。模型按用户请求选择已启用能力，真实执行检查 Task、角色、规划、审批、工具启用、目录与授权版本。规划、基础权限和 Goal 分别持有事实。

参考项目的执行控制比较见[《Code权限与模型审批源码对照》](../调研/Code权限与模型审批源码对照.md)首章。KFW 使用统一循环与独立控制，Plan 的实际执行限制以 §2.6 为准。

#### 交互与执行规则

- 输入框直接接收普通消息。原盾牌菜单显示独立 Plan 勾选项和三种基础权限，模型与思考选择继续使用原控件和 BYOK 目录。
- Plan 决定先调查并形成计划；人工明确批准退出后继续遵守原基础权限上限。只读子任务、物理目录和撤销结果不能被按钮、自然语言或模型批准扩大。
- Goal 使用 `/goal`、状态面板和目标控制命令。只有明确创建目标才启用持续推进；普通消息不创建或替换目标。已有 Goal 的消息按真实目标状态及原队列／指导规则处理，暂停后普通消息不自动恢复目标。
- 技能、插件或 MCP 制作属于普通任务。通过 ToolSearch 发现实际工具，制作指导由 plugins feature 注册为系统提示内容；生成文件、发布技能、安装插件、启用能力及启动进程分别检查当前 Plan、角色、目录、兼容性和审批。
- Code／Design／Flow 保持现行工作台与工具范围语义，项目共享、Task 身份、Canvas 视口、选区和内容标签不随发送、审批或 Goal 控制改变。

#### 当前消费者

| 范围 | 实际消费路径 |
| --- | --- |
| 界面与发送 | [原盾牌菜单](../../apps/web/src/components/workbench/zcode/v4/composer/V4ComposerModeControls.tsx)直接更新 Composer 草稿；[原提交配置](../../apps/web/src/components/workbench/zcode/v4/composer/composerSubmissionConfig.ts)冻结模型、思考、基础权限、规划和工作内容，再通过原 V4 envelope 发送。 |
| 输入与运行接纳 | [Task 宿主](../../apps/server/src/features/code-ui/service.ts)使用同一命令接纳普通输入、队列、指导、历史编辑和重试；每条输入保留自己的模型快照、目录及权限上限。 |
| Goal | [目标命令](../../apps/web/src/components/workbench/zcode/v4/slashCommands.ts)、[目标服务](../../apps/server/src/features/code-ui/goals.ts)和[后续 Run 接纳](../../apps/server/src/features/code-ui/goal-admission.ts)使用真实 Goal ID、修订、Run 关联和运行来源，保留预算、验收、暂停／恢复及自动化审批场景。 |
| 工具与审批 | [权限策略](../../apps/server/src/features/permissions/code-policy.ts)与真实执行作用域共同限制操作；审批模型使用独立供应商选择和原人工审批门。 |
| 插件制作 | [制作指导](../../apps/server/src/features/plugins/authoring-prompt.ts)经原系统提示注册接口提供，实际操作继续使用既有工具和插件注册表。 |

#### 升级与已接纳数据

服务停机后执行前向迁移 [20261022130155_retire_execution_modes.sql](../../supabase/migrations/20261022130155_retire_execution_modes.sql)。迁移将相关未完成输入标为 `discarded`，取消相关活动 Run，清理其队列、待处理命令与交互，并把运行中的消息投影更新为已中断。受影响的活跃 Goal 转为暂停，服务启动后需要用户明确恢复；未完成输入需要明确重新提交，不自动重放。

模型调用快照、Task 目录、基础权限上限、授权代际和命令指纹保持原值；已完成的运行结果继续保留。历史重试、恢复和后台继续不能读取当前界面选择扩大原授权，也不能把升级后的首次启动当成新的用户批准。

#### 验证记录与范围

实施、迁移检查及各项验证回执统一记录在[日志](../日志.md)。完整验收仍需覆盖普通问答、授权读取、三个权限预设下的编辑与命令、Plan 开关折返、审批模型与人工先答、只读子任务、插件制作与安装、Goal 创建／验收／暂停／恢复／重启、排队后切权限、历史重试和恢复。验证需经过真实组件、HTTP／RPC、临时 PG、Task 与工具消费者；当前记录不表示这些场景已经全部完成。

## 3. TDD、治理与来源

用户已授权代理代为决定实现细节；测试 seam 固定为：执行作用域/真实文件工具、进程与 Task 后台公共接口、Agent 公共运行事件、原 Code 宿主 RPC/frame/组件操作、Design 画布与助手不变量。使用临时真实 FS/子进程；真实 PG 测试标 integration，外部模型边界可替身。一次一条 red→green，所有测试由主代理串行调度，worker 不另跑测试实例。

治理仍只有 shared governance 默认/护栏、设置表与 env 两入口。沿用深度/并发/重试配置；新增读取、搜索、输出、yield、终止宽限和后台 deadline 的值集中登记，不在业务代码写死。默认模型预览 8000 字符、单命令采集 64 MiB、yield 1000 ms、终止宽限 2000 ms；后台 deadline 默认不设，用户可配置。输出达到采集上限明确记录丢弃量；不自动删除用户产出。

来源固定并记录提交、原/现 SHA、许可证、修改与消费方：ZCode 29628c9、DSH 639ed01、Codex e53e932、Kimi 21406fb、SRT c7adb1e（官方 anthropics/sandbox-runtime，Apache-2.0）。保留 LICENSE/NOTICE；可借原工具契约、纯编辑/parser/分页与低层执行器，不引另一条 Agent loop，不把镜像版权声明当原作者授权。

## 4. 实施顺序与完整验收

1. 按用户后续指令，统一在主checkout的 `codex/完整移植ZCode-Code界面` 并行开发，不再在独立worktree施工。共享Schema先协调，保留其他线程的路径/hunk，测试只启动单实例；提交按功能模块分批，不整体暂存。
2. Code Project/Task/schema/作用域改造，移除隐藏画布与画布目录载体；全链追问、刷新、重连仍绑定同一真实目录。
3. 文件工具＋受控 backend：Readonly/Worker、精确编辑/补丁、分页/搜索、真实 diff。
4. 真实命令与三平台 sandbox/helper，前后台句柄、stdin/输出/stop/撤销。
5. Task 后台工作＋独立子运行＋自动通知/续跑＋重启中断，接原 V4 activeWorks/卡片。
6. 工具目录/按需发现＋prompt/rules/skills＋图片/PDF/输出引用。
7. 清理被替代 Code runtime、工具、路径/Canvas 契约与测试；共享 Design/Flow 不变量保留。
8. 依次完成窄回归、`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm api:spec`；历史 SHA、实际 schema、空库全量重放、二次 no-op。HTTP 变化导入 Apifox AI 分支，合并遵既有确认规则。

验收必须覆盖：跨工作区/路径与角色拒绝、并发同文件/迟到请求/幂等、空/超长/Unicode、真实 stop 与撤销、Task 删除/重启/分支通知、忙闲自动续跑、压缩恢复与跨轮产物、三协议工具发现、图片/PDF、真实模型链路、原 UI 交互与 Design 回归。没有证据的项仍是未完成，不以窄测试替代全目标。

## 5. 当前回执

2026-10-07原生准备租约更新：默认adapter在首次目标写入前以已有Agent persistence store持久认领，复制完成保存opaque引用；重建Provider可按匹配租约清理未发表目标，已释放目标不可清理。发布方await持久释放，原文件/命令不重放；真实PG全部池关闭后冷装配与原生/历史边界映射已取得对应实际证据，最终九文件24条交叉及全量门禁通过。命令准备清单、部分复制崩溃和全部附件/输出资源的启动reconcile尚未完成，不将此租约阶段当完整恢复链完成。

2026-10-07运行输出截点更新：以已持久TaskOutput的保留/总计/丢弃字节事实冻结只读前缀，源日志随后增长不进入副本，源执行不被分叉停止；frozenAt保留观察时源状态，statisticsComplete=false明确不是源最终统计。真实Bash追加、截短拒绝/恢复/同键失败重放、两个祖先删除、再次分叉与新模型读取已通过，并与原完整输出、事务发表、子历史、原生资源及控制权限七文件25条交叉通过。尚未覆盖所有子/生成产物与native准备重启恢复，不将该范围当作完整Goal完成。

2026-10-06终端重连更新：真实SSE断线确认旧PTY已结束，服务恢复后原终端曾复用失效缓存；现按本客户端真实create回执记录归属，服务换代与解绑仅释放本客户端的原终端缓存，原组件重挂取得新PTY，不重放旧命令。换代/关闭后的迟到create回执拒绝发表，实例/Task/目录与后台权限不扩张。实际断线场景与默认归属/迟到回归已通过；全键盘/resize/权限恢复、视觉、历史截点/产物/媒体、Design/Flow及三平台完整验收继续。

2026-10-06原终端更新：原TerminalSession/xterm实际绑定持久Task，原粘贴输入经HTTP/SSE/真实PTY产生文件及DOM输出，卸载/重挂保留同一PTY与期间输出，原退出回调实际通过。第一方终端服务代理观察原void销毁的外层Promise拒绝，外部await仍收到真实取消；不修改原源码、不把取消改成成功。终端断线重连、完整键盘/尺寸/权限恢复、用户旧页面与视觉以及其它全目标仍继续。

2026-10-06原文件撤销更新：安全拒绝现在持久化rejected并显示原弹窗原因，失败同键重放保持rejected；成功恢复仍沿原accepted/duplicate语义。原SessionPane真实Edit拒绝、Edit成功后重开、空目录Write撤销与外部文件保留三场景通过，并与审批/队列/全文/子停止四场景交叉；原RPC成功重放和冷服务聊天/reverted另有真实回归。只证明这些公共链，不替代全场景视觉、大文件/媒体、运行中截点/产物、终端、Design/Flow及三平台验收。

2026-10-06空目录快照更新：Task首轮空目录现在取得真实影子Git空树基线，无变化时复用已有HEAD；真实Git十二条通过，原SessionPane首轮Write撤销删除目标新文件并保留后来外部新建文件与聊天，已与Edit拒绝/成功及其它四原组件场景交叉通过。只改管理目录内的影子仓库，不修改用户.git；完整GUI/视觉、历史截点与产物、终端、Design/Flow及三平台仍继续。

2026-10-06原队列更新：原SessionPane实际指针排序、删除、撤回到原composer、立即发送真实抢占、Esc停止与原恢复已通过服务端/DOM双侧验收，并与原审批/全文/子停止交叉。完整视觉/其它操作、用户旧页面、媒体/历史截点/全部产物、Design/Flow及三平台继续，证据与命令见《日志》本条。

2026-10-06审批计时更新：模型start/end/error事实决定无输出计时，人审/工具等待不再误报模型停滞，取消与真实模型超时仍保护；agentStreamIdleTimeoutMs接实例治理、0关闭与原env兜底。真实服务等待/批准/停止/迟到回执及当前原审批卡通过，Code/Design治理十六条实际通过。用户旧页面构建/呈现状态、全GUI视觉/媒体/历史截点/产物、三平台继续；回执见审批等待与模型无输出计时实施回执。

2026-10-06原PreviewPane文本更新：原全文按钮的真实来源已由原PreviewPane/CodeViewer在公开Shadow DOM实际显示中文emoji完整日志，原后台面板及子停止两GUI交叉通过。其它文件类型/大文件、原Root全操作和视觉等继续，具体证据见原后台Bash详情接线实施回执。

2026-10-06原后台详情更新：backgroundBashOutputV4与code-output全文读取已接原宿主，真实日志/错误/Unicode/历史副本14条交叉与原组件两GUI通过。完整门禁与范围见《日志》和原后台Bash详情接线实施回执；原PreviewPane完整渲染、全部GUI/视觉、运行中历史截点、全部生成产物、Design/Flow及三平台仍未完成。

2026-10-06更新：共享checkout的Code原宿主已接Task删除、历史编辑/重试/分叉、结构化提问与同Run指导、模型/权限/规划控制；Task工作域、角色与后台生命周期沿同一Harness。独立Plan、压缩预算与保留目标、实例治理设置以及附件/完整文件/子转录的历史归属已按功能提交。098d5bd7原前台/嵌套子独立Stop含原组件实际点击与完整门禁通过。当前完整子/Bash输出批次已获真实父删除、再次分叉、冷服务、新摘要及SQL发表失败清理证据，具体提交与命令以《日志》和完整输出历史独立归属实施回执为准。原GUI全操作/视觉、旧Code清零与完整Design/Flow、运行中日志截点/持久准备、全生成产物及三平台验收仍未完成，完整Goal保持active；不将已通过的范围替代整体产品验收。

2026-10-05更新：已回到主checkout，Code/用户系统/Computer Use共享同一分支。c0aa9f59已独立提交同Run mode指导与拒绝事件；独立规划boolean取得9446真实RED→32492三条GREEN、82942八文件12条交叉、14938全包16/16及42407全类型13/13；随后94110冷起点与原场景4条再次通过。对应独立提交以Git历史及《日志》为准。Code完整Goal继续active。Enter已独立提交e707c7ea；Exit明确批准与管理文件初链已取得真实GREEN及server2009/类型13/13最终门禁；2026-10-06批准owner/PromptSection取得真实compact排除旧Exit→新Run正文消费GREEN、篡改零模型请求与macOS FD路径竞态RED→GREEN，类型13/13与workspace/API25通过，两个全server回归各有旧时序/搜索断言失败待独立处理，原plan输入归一化、审批取消/撤权/冷恢复/压缩、guided历史/工时、媒体/子任务/摘要组合、原GUI/Design与三平台完整验收继续待完成。命令与剩余项见 `apps/server/src/features/code-ui/独立Plan开关实施回执.md`，不将默认skip计为能力通过。

以下为2026-10-03初始快照，保留当时施工位置与证据，不作为当前checkout或完成状态：

- 独立 worktree：`/Users/shigaoyu/.codex/worktrees/code-harness/KenFutWork`；分支 `codex/重构Code工作域与工具内核`；起点 `65d1097e`。
- 已完成一手调研与接口比较；总 Goal active。代码/数据库/真实 UI 全目标尚未验收。
- 实现与测试回执逐步追加；本规格不把计划勾成已实现。
- 共享 Code 项目目录契约完成首条 red→green：Code 不要求主画布，Design/Flow 仍要求；`pnpm --filter @kenfutwork/shared exec vitest run src/execution-contracts.test.ts` 1/1 通过。依拓扑构建 model-option-map、zcode-shared、shared 均通过。
- 受控文件后端首批六条窄行为回归通过（文件 worker 持唯一测试 token）：读取后整文件写入、partial 精准编辑、UTF-16 长行续读及相关边界；不代表所有文件/媒体/检索目标已完成。
- 新目录 Scope Provider、Project/Chat/Code UI 存储改造、Unix helper/真实进程管理器已在施工；Windows native backend仍未完整验收。运行时已接可信 scopeHandle 的 backend，后续仍需子代理、后台工作、工具目录及 UI 全链。
- 官方 CLI 生成前向迁移 `20261002192638_code_task_execution_scope.sql`；根会话直接人类授权审核后安全源码写入成功。仅保留/归档旧 Code 内容并解除列依赖，未连接或执行现存数据库；空库重放/实际 schema/no-op 尚待验证。
- 测试资源：文件 worker 暂持唯一 token，主代理及其他 worker 不同时启动 tests；Scope/Process green 待该 token 归还后串行运行。当前尚无 commit/push/PR，完整 Goal 保持 active。

## Code/Design 统一实施（2026-10-14 用户确认，2026-10-16 本轮验收完成）

本节取代前文的 Code/Design 会话隔离、单画布绑定与互斥项目归属规则；Task 文件授权、代际、租约及原 ZCode 协议要求继续有效。

### 已确认行为

- 项目是资源与会话容器；默认工作方式与启用列表由服务端持有。新建默认隔离，跨模式显式复用项目；同目录提示，不自动合并。共享项目默认显示全部会话，可按使用过的工作方式筛选。
- 复用 ZCode 会话聚合为唯一 Task 权威，同一 Task、历史与 Goal 可跨 Code/Design 继续。Run 接纳时冻结工作方式、能力、资源、模型及授权代际；切换界面不改当前执行。
- 未选外部目录继续使用真实托管目录。Task 固定目录与文档授权分别持有，选择画布不改变 cwd 或文件权限。画布文件继续是权威，不搬回 DB jsonb。
- 可收起项目导航、左侧原 SessionPane、右侧内容标签。Design 默认画布；用户显式打开文件/浏览器才切标签。消息、审批及恢复不抢占内容，画布状态保留。
- 项目/会话/目录/画布分别创建，画布按需创建。Design 发送自动附当前画布可移除引用；画布工具在项目内按权限搜索、读写及创建文档，跨项目需显式资源授权。
- Design 插件贡献选区、品牌素材、生成偏好、图片/视频投影、落画布与同步；图层/资源/编辑工具留在内容面。通用提问、审批、Goal、队列与恢复只使用共享会话链路。
- 同一本地实例的画布编辑即时写入IndexedDB草稿，按项目/文档/客户端隔离，保留确认基线与结果未知的在途保存。重开按持久画布做三方合并，冲突保留原稿并可逐份导出；不按时间自动删除草稿。初始化读取完成前画布只读，保存ACK仅清除匹配token，迟到ACK不得退回更新的远端基线。此范围包含多标签页、Agent与媒体回填，不引入多人实时协作。
- 已受理媒体仅在保存了供应商句柄时，可跨可信宿主关闭或同宿主排他冷恢复继续查询同一Job；不重启Agent/Goal、不重新提交生成。有效Stop或已接纳抢占的精确原Run停止意图同根事务持久化，跨自然完成、reservation晋升/丢弃与重启仍有效；发布继续核验Task、授权与分支代际、文档存活和Job取消。普通失败、未知历史及无句柄Job不借重启恢复副作用。
- 旧 Design 开发会话不兼容，本轮不做历史导入/运行兼容。备份停机后清理旧执行状态，保留画布、素材、外部目录、Code 会话及审计。

### 交付顺序与公共测试面

1. 项目与 Task 权威：项目公共接口、输入接纳/冻结、真实 FS 与文档授权；覆盖默认隔离、共享、同目录、并发、取消与迟到请求。
2. 共用 UI 与内容槽：原宿主协议、SessionPane、项目导航、标签切换及画布状态；保留 ACK/租约与来源清单。
3. Design 插件：媒体、选区、文档工具、审批、生成同步及补放；接通后删除旧运行/UI/接口生产引用。
4. 门禁与桌面验收：`pnpm test:workspace`、`pnpm exec turbo run test --concurrency=1`、`pnpm typecheck`、`pnpm lint`；`pnpm desktop` 下现有 GLM 验证真实文件、画布、审批、跨模式、重启恢复。GUI 与自动化证据分别记录。

每步独立验证与提交，日志记录实际完成项。Work 规划同步改为共享会话/内容插件接缝，不实现 Office；future OpenDesign 与 Flow 编辑逻辑不扩入本轮。

### 持续 Goal 执行账本（2026-10-15）

Goal 为本节完整目标，阶段回执不能代替完成。起点 `ec13c97f`；下表于2026-10-16按已提交实现、公共测试和真实桌面证据分别更新，早期检查点保留当时结果。

| 条目 | 状态 | 验收依据 |
| --- | --- | --- |
| 默认工作方式与显式启用列表、按需求创建基础 | 已完成 | 日志一百九十六；全量门禁与真实临时 PG |
| 同目录提示与复用/独立创建 | 已完成 | 公共选择交互、真实PG并发与重新关联；原生复用/独立创建完整结束，最近目录去重且不猜执行身份 |
| 统一 Task、Run 上下文冻结、队列/Goal/恢复 | 实现及公共验收完成 | 原V4/真实Scope、跨客户端点击策略、忙时改档与撤权PG回归；真实Flash Goal正例与公开保留约束反例已验，旧失败记录保留 |
| 共用 SessionPane 与右侧文档标签 | 已完成 | 原生同Task跨Code/Design、审批不抢占画布/设置、浏览器与文件源码/差异往返保留画布；真实冷窗口恢复与画布深链无误共享，24项导航范围与Web全包通过 |
| 文档 CRUD/权限与媒体、选区、品牌插件 | 已完成 | 文档发布取消/撤权PG、FileStore CAS、IndexedDB草稿、离线整应用冷恢复及双标签双向同步已验；真实IGM回填和读取已验；真实VGM整应用冷启动后同Job/句柄续查、单次素材/落图与原生播放已验，原10元素及运行期编辑保留 |
| 旧 Design UI/运行链路退役 | 实现及公共验收完成 | 旧生产接线与契约已删除，真实PG退役迁移通过；仅Flow使用的ChatService及审计保留不属于Design兼容 |
| Work 规划与 API/来源/日志同步 | 已完成 | Work共享宿主边界、来源与文档门禁通过；OpenAPI与Apifox AI分支8737737已同步，未合并主支 |
| 完整真实桌面 GLM 验收 | 本轮场景验收完成 | 文件/画布/跨模式/Goal/离线草稿冷恢复与双标签已有实证；真实IGM单次生成、VGM同任务冷恢复后保存/播放通过；可信中断与media waiter回归修复、最终四门禁及8b9c988e源码冷启动复验通过 |

主代理持有唯一测试/构建/提交入口；Task/Run、文档插件、内容标签按文件所有权并行实现，共享契约逐 hunk 协调。用户要求发现目标漂移时停止：新增 Work/Flow/OpenDesign 编辑范围、另写 Agent UI/第三套 Task 状态、隐式合并项目、伪造或降低验收均属漂移；停下对应改动、记录偏差并重新对齐。常规失败和接线缺口应修复，不用「已完成」掩盖。


#### 2026-10-15 集成检查点（未完成）

- Goal仍active；只在`啃啃在开发`施工，`main`/`future`和他人reference改动未纳入。
- 原Task/V4输入增加工作上下文与贡献快照；HTTP/WS正迁向同一准入，旧Design执行插件与UI被替换。源码删除不等于已完成验收。
- 文档第一轮34项通过（`/tmp/kfw-unified-document-first.log`）；后台核心第一轮106项通过（`/tmp/kfw-unified-first-core-suite.log`）。第二轮扩大UI检查73通过/8失败，包含新桥接回执和原Markdown组件测试材料差异，正在修复；不得引用为全绿。
- 全量门禁、当前HEAD完整类型检查、来源清单、真实PG发布/取消并发、桌面GLM与重启恢复尚未完成。全部实现和删除仍是WIP，不据此标Goal complete。
- 媒体统一由worker对冻结Job/Task/文档发布，以真实assetId投影到原会话；原Run取消窗口、撤销授权与最后文件发布的屏障仍需真实并发验证。文档锁经persistence专用连接，避免持池连接等待同一池的资源饥饿。

#### 2026-10-15 接线复核（仍未完成）

- 原UI独立类型检查通过（`/tmp/kfw-unified-ui-sixth-typecheck.log`）。媒体偏好从Next依赖迁入宿主共享入口，Next画布通过编译入口复用同一实现，没有复制媒体UI。
- 扩大前端回归72项：71通过、1个旧显式项目打开夹具失败；该夹具已补真实项目ID，待复跑。媒体、文档桥接/标签、原Markdown、预热与独立文档通知在该轮通过，不能代替完整桌面验收。
- 服务端定向123项：122通过、1个迟到截图错误措辞夹具失败；已核RPC返回后重新验权且未上传/登记文件，修正夹具后待复跑。
- 同目录409恢复和重新关联显式共用正在实现；Goal能力改为逐Run捕获，旧Run保持冻结。原Goal模型/目标不因此变化，后台续轮不借用已完成Goal的旧上下文。
- 临时PG真实并发和退役迁移本轮在运行，结果未定；完整门禁、Apifox和pnpm desktop/GLM仍未完成。品牌冻结套件ID，工具读取时核真实资产版本；未声称Run启动即冻结套件全部资产内容。

#### 2026-10-15 扩大验收与审阅（仍未完成）

- 完整 `pnpm typecheck` 26/26、`pnpm test:workspace` 38/38通过；原UI构建成功。它们是对应检查时的WIP证据，后续审阅修复必须复验。
- 全包串行第一轮未通过：服务端2790通过、29失败、345默认跳过，12个失败文件。旧运行夹具与退役聊天入口测试正在修正，EmptyProviderResultError闸门不放宽。不能把此轮描述为全包green。
- 根线程后续窄回归：服务端退役/公共Run/文件工具49项通过；UI恢复/媒体/共享宿主43项通过（含断线删除后GET事实清理旧编辑器和引用）。新增Code/Design不能走旧聊天写入的两项负向测试还待下一轮执行。
- 临时PG第五轮12项10通过2夹具失败（Task创建顺序、Canvas实例权限join），均已修材料待复跑。目录PG12项11通过1失败；失败为手工影子Git路径与生产short-layout不同，已改用同一helper并加强真实Git/excludes及缺仓拒绝证据，待复跑。
- 双轴源码审阅发现原ACK去重前重新验资源会阻断已接纳输入重放，Task实现代理正在修正并补PG回归。导航审阅发现深链重试、迟到目标与初始跨方式准入缺口；容量错误前已有部分源码写入，根线程接管并补RPC迟到选择guard及真实Zustand存储修正，行为测试正在补齐。审阅不是GUI或执行通过证明。
- SessionPane改为通用ComposerContext贡献接口，品牌/媒体/画布header和移除引用留在宿主插件侧；贡献指纹规范化由Kernel/MCP共用内部实现。原UI独立类型检查第七轮通过。
- OpenAPI已生成189端点/169组件，尚未同步本轮Apifox AI分支；首次lint有格式阻断，已只修所属第一方文件，未格式化来源原件，最终lint待跑。尚未提交后续里程碑，Goal仍active，桌面GLM/媒体/重启恢复尚未执行。

#### 2026-10-15 重放与导航回归阶段结果（未完成）

- 公共Runtime/审批/原输入定向8文件78项通过（`/tmp/kfw-unified-runtime-retirement-second.log`）；正常Provider夹具产生实际消息，空结果闸门保持拒绝，autoCommit未延长超时。
- 导航4文件27项通过（`/tmp/kfw-unified-navigation-first.log`），含真实TabStore与HTTP client；权威404清理引用后的Web类型检查也通过。贡献指纹/Canvas工具/Flow旧聊天限制/MCP定向53项通过。
- 临时PG8文件14项通过、TaskWork独立开关4项跳过；随后单独打开该开关4/4通过。目录先前11项通过，手工Git夹具纠正后的Code检查点场景单独1/1通过，保留额外缺仓拒绝证据；这不是本轮完整桌面证明。
- Task发送ACK重放已通过真实PG；Goal控制与Session创建同类准备顺序仍在补修，不把发送路径green等同所有命令幂等已完成。全包、最终typecheck/lint、Apifox、真实桌面与分步提交仍待闭合。

#### 2026-10-15 收口检查点（仍未完成）

- Goal实时核对为active，HEAD仍`ec13c97f`，暂存区为空；只有`啃啃在开发`主工作区。后续实现和退役文件尚未提交，不改动main/future或其他作者分支。
- Goal控制、会话创建与输入原ACK重放的临时真实PG回归4/4通过（`/tmp/kfw-unified-control-replay-pg-first.log`）；真正macOS沙箱内的Task MCP场景1/1通过（`/tmp/kfw-unified-mcp-native-second.log`）。首次MCP材料误传shell启动器的失败保留，不据此声称产品故障。
- Canvas编辑器准备注册改为同步的当前文档ref，保存前后复核画布身份；恢复准备、挂起保存、缺失revision与切换文档14/14通过（`/tmp/kfw-unified-canvas-prepare-sixth.log`）。
- 最新workspace门禁38/38通过（`/tmp/kfw-unified-workspace-final.log`）；完整串行包测试第四轮正在运行。此前第三轮Web失败未被当作完成证据，最终typecheck/lint待跑。
- Apifox仅更新AI分支`ai/20261014-from-main-code-design-unification`（8729198）：189个spec端点完整存在、无重复，10个旧Design端点已移除；36个原有spec外接口保留。未合并Apifox主支。
- 停机备份已取得7498文件/2600583312字节核验回执；当前尚未启动本轮pnpm desktop，没有GUI/GLM/媒体/重启恢复完成证据。真实桌面数据迁移与验收仍待执行。

#### 2026-10-15 首轮真实桌面结果（未完成）

- 原仓`pnpm desktop`已启动`KenFutWork.app`（API3301/Web3400），实际日志完成两条新前向迁移。新项目无画布，显式共享后出现Design文档入口，手动创建才产生画布和可移除引用；这一GUI链已观察。
- “启用Design”误报已实际复现：PATCH成功204，但宿主继续JSON解析。真实204进入原导航测试后RED，修复后导航/宿主19/19 GREEN，重建并重启后的新项目显式共享成功。首个已共享项目保留，未以重复mutation抹掉失败。
- 合成项目`9f7c96dd-54ad-44c1-9e81-bf384cdfbdb7`的首发Task`6b9fb047-14b6-4acb-8db0-a9f6cef70327`、Run`d75f28fd-ac69-4176-9e5e-ee87aeb68e0f`失败：创建回执把界面自动切回Code；真实Run报“系统提示工作模式与可信Task不匹配”。没有文件/画布工具执行成功证据。
- 只读PG回执证明该Run仍冻结Design、画布`87fe795b-78d6-4230-bc3c-421f8217e988`与原选区，Task初始预热上下文是Code。Task身份不等于Run工作方式；提示校验与原Task导航接线分别修复，不能删除强校验、覆盖失败Run或自动重放原输入。
- Runtime+真实Scope+PromptRegistry回归已取得对应RED（`/tmp/kfw-unified-desktop-prompt-red.log`）；GREEN和原桌面复验待执行。当前图片/视频模型列表仍为空，媒体真实验收等待可用配置。此前全绿门禁只对应首轮桌面前的实现，最终门禁需覆盖桌面发现的修复。

#### 2026-10-15 桌面缺陷回归（待真机复验）

- Runtime+Scope+PromptRegistry修复23/23通过（`/tmp/kfw-unified-desktop-prompt-green.log`）：使用绑定同一真实Task句柄、Run与实例的冻结工作方式，未放宽跨Task/Project/只读角色/缺失身份拒绝。原失败文件实际不存在，原Run仍failed且activeRun为空，没有重放。
- UI最初缺真实共享Provider的材料2/2未登记为GREEN；补齐后取得Design/Flow自动切Code的两项RED。原Root导航修复后，新建会话又取得画布面板被收起的真实RED。最终四文件23/23通过（`/tmp/kfw-unified-desktop-task-nav-green-second.log`），保留显式Code切换与文档同一iframe实例，Task文件/终端不扩入保留规则。
- 项目导航读取服务端项目名，不再把托管目录UUID当项目名；名称更新不改Task/目录身份。独立RED后与共享导航11/11通过。只登记App实际适配复制哈希及说明，原始来源SHA/基线未改。
- 第三次原仓`pnpm desktop`正在重建/启动；真实工具、审批、Goal重启恢复和最终四门禁仍待执行，媒体配置仍待用户提供。

#### 2026-10-15 真实GLM文件与冻结目标验收（全目标仍未完成）

- 第三次原桌面构建/启动通过；同一Task`6b9fb047-14b6-4acb-8db0-a9f6cef70327`保留旧失败后接纳新Design Run`f12fec32-8a3e-4244-8ff8-45ed306541b8`。manipulate_canvas与Write真实到达原共享“本次允许”审批，批准一次后两工具成功、Run持久状态completed。
- 等待画布工具审批时，手动创建并切到画布B`2189b678-e295-4d86-a840-b1b1d382abe4`。实际文件/API核对：19字节`统一验收B.txt`等于`unified-recovery-B\n`（SHA256`1e14099de8f134024d9ad207cb428819ae7dc47a1b95fecf48715adfe7e2f149`）；蓝色矩形与“统一会话 B”实际落在冻结画布A，B仍为空，界面仍显示B。不是以模型文字当操作证据。
- 同一Task显式切Code，Run`8b76f494-6de8-4a73-8645-86d017dd62a9`实际Read成功；Bash审批等待期间切界面到Design，批准后真实`cat 统一验收B.txt`exitCode0、19字节、未截断，Runcompleted。持久Run上下文仍为Code，未借当前界面切换改变执行。
- GUI三栏/导航收起、共享项目名称、手动文档创建、审批期间内容不抢占与跨模式同会话已有对应观察；原错误仍在历史且原失败文件不存在。证据位于ignored`统一工作台验收`目录，GUI与持久Run/文件/API回执分开记录。
- 正在同一Task创建有限文件Goal以核对暂停、冷重启和显式恢复；尚未完成这一项或最终门禁/提交，媒体模型仍为空。

#### 2026-10-15 Goal冷恢复与独立评估真实回执（仍未完成）

- 合成Goal`01a13c99-3448-7421-b738-6992e27f242f`在Write审批前暂停：Run`9f5c3cab-8d9e-4f5f-9dcd-e75f921c72aa`canceled，C文件不存在，保留21841tokens/103秒。冷关闭再原仓启动后，同Goal保持paused、用量不变、新Run数0、C不存在；旧操作没有重放。
- 在Design视图显式恢复后，新Run`4ccc61d6-33b3-4507-837c-f5b226ffb4f4`仍冻结Code，实际重新Read并创建C文件。C实际16字节等于`goal-recovery-C\n`，SHA256`f0ce81030fb442c3ba6119bd446d22e5f5bcfd35c56f75bea9da5d4019b7d806`，既有B文件未变。但独立评估报缺用量并暂停，不能算Goal已验收。
- SDK源码与真实SDK后台queue gate取得RED：默认后台handleLLMEnd可能晚于invoke返回，旧port已关闭用量接收。回调与返回AIMessage共享一次真实记账、等待成功后才返回的修复44/44 GREEN（`/tmp/kfw-unified-model-request-usage-green.log`）；缺用量/非法字段/异步失败/取消仍拒验，无估算、假零、睡眠或重试。
- 再恢复的新Run`c74f4fb3-73dc-4f14-a1fc-10f3ffbb4e73`取得真正独立评估，明确notSatisfied：本轮证据只有Read，缺上轮真实Write创建回执，assistant叙述不能替代它。已暂停测试Goal（rev15），无活跃Run，原拒绝及实物保留。正在修同一Goal跨Run可信证据归属，不重复写既有文件、不放宽验收标准。
- 原Goal轮次投影及真实验收轮次持久化40/40 GREEN；未知旧轮次保留审计不猜。最终门禁和分步提交尚未执行；图片/视频配置仍待用户提供。本聊天整体实施Goal仍active，未因测试Goal暂停而停止目标。


#### 2026-10-16 真实视频冷恢复在途（最终终态未完成）

- 一秒请求20261016B在旧工具schema阶段被拒，未创建Job/提交供应商；原失败回执保留。实际目录能力投影修复与旧默认回归已提交561ccdf5，最终全包19任务、全类型26任务、workspace38项和lint通过。
- 新独立20261016C仅提交一次：Job`8a80ea70-5ac3-4af9-85ae-19f80f704374`，原Run`64c6e1de-77d3-421d-8680-6d083fa81c8e`，H3一秒/480p/16:9、无参考图/音频flag、同原画布。正常退出整应用并重启后，Run持久`canceled/host_shutdown`，无新Agent Run/Goal续轮，同Job和供应商句柄继续处理。没有重提旧dead_letter Job。
- 真实PG只读两次核对`next_action_at`在冷启动后持续前移；既有句柄分支只有供应商pending回执才会排程，恢复扫描和心跳均不能制造该字段前移。因此已证明实际续查，未将旧phase当恢复证据。供应商终态仍未到，不据此宣称视频保存或播放通过。
- 原10画布元素的ID/内容/完整几何经API对照零变化，Run期间新增H也保留，当前11元素。接下来仅观察同Job终态、核一次素材/落图和实际播放器；失败或未知不得重提。

#### 2026-10-16 真实视频最终结果

- 同Job`8a80ea70-5ac3-4af9-85ae-19f80f704374`在10:14:34UTC成功，attempt0、原供应商句柄不变；输出、素材与视频元素各一份。本机素材认证读取200，原生Play→Pause实际播放白底蓝色圆环，画布保留原10元素、运行期H及100%视口，最终12元素。
- 请求参数是一秒/480p/16:9且不传音频开关；供应商原片实测H264、864×480、1.625秒并含AAC音轨，未裁切或重编码。请求成功不等于供应商精确满足一秒或静音，原片事实保留。
- 最终只读PG/API对账确认latest Run仍为原`64c6e1de-77d3-421d-8680-6d083fa81c8e`、`canceled/host_shutdown`，零active work，未重启Agent/Goal；本Task两条视频Job分别为本次成功和旧dead_letter。B的schema失败无Job，未重复付费提交或改写任何旧失败记录。
- 回执、原片、媒体探测及原生播放截图保存于ignored验收目录。正常退出的前台工具误报与媒体等待取消窗口属于独立回归，后续记录其修复与最终门禁，不以视频本次成功掩盖该时序缺口。

#### 2026-10-16 本轮最终验收

- 可信工具中断与已受理媒体等待修复提交`8b9c988e`。真实SDK/Registry/公开快照回归保留同名业务失败和先到成功/失败；私有native迟到取消只在严格身份及空结果负载下去重，Provider证明门不放宽。图片/视频的正常退出与真人Stop跨轮询间隔、原句柄冷恢复及撤权/分支等12项真实PG回归通过；不回写旧工具失败历史。
- 最终`pnpm exec turbo run test --concurrency=1`19任务通过（server3096/shared160/Web1049），`pnpm typecheck`26任务、`pnpm test:workspace`38项及`pnpm lint`通过；核心五文件48项通过。默认skipped不计作真实PG或平台实测，既有lint warning/info保留。
- 固定源码提交后，原仓`pnpm desktop`冷启动完成11任务构建，API3301/Web3400就绪；显式重新打开原Task、切Design并选回原画布，100%视口与12图层保留，已有视频实际播放。随后只读PG/API确认原Run未重启、零active work、同Job仍成功、旧失败未动，原10元素/完整几何和H不变。原生截图与结构化回执在ignored`统一Harness最终冷启动复验-20261016.*`。
- 本节已确认增量完成；前文历史检查点保持当时事实，不代表所有旧Harness或三平台事项均已验。多人实时协作、Office/Flow/OpenDesign编辑与未来审批模型实现不扩入本轮；型号和入口布局等待grilling项继续保存在《Code与Design共享Harness对标核验》。OpenAPI/Apifox AI分支已同步且未合并main，main/future保护引用不变。
