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
