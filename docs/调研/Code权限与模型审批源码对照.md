# Code 权限与模型审批源码对照

> 角色：**调研**。核验日期：2026-10-17。范围是下列固定提交的源码与装配链；没有运行参考应用、模型、测试、构建或同条件编码基准。源码存在、宿主接线、功能默认值与实际桌面启用分别陈述。
> 本文只说明机制与本轮已确认的适配边界，不替代[《Code 工作域与工具内核实施规格》](../方案设计/Code工作域与工具内核实施规格.md)、[《Harness 稳定性与 Goal 实施规格》](../方案设计/Harness稳定性与Goal实施规格.md)或[《改造计划》](../方案设计/改造计划.md)。实施与验收回执由《日志》记录。

## 结论

**“全权直接执行”“确定性自动策略”“模型帮忙审批”是三种不同机制。** 固定版本的 ZCode `yolo`、Kimi `auto/yolo` 主要依靠确定性规则；DSH 的实验性 `auto-review` 与 Codex 的 AutoReview/Guardian 则确有额外模型审查链。任何一种“自动允许”都不能由菜单名称推导为扩大 Task、目录、角色或操作系统权限。

本轮 KFW 用户已确认：Code 先与真实 ZCode 以相同 GLM-5.3-Flash、相同题目对比，尽量一次用户输入完成；对比只使用一个隔离目录，不干扰用户正在使用的 ZCode。“完全访问”直接执行，不调用审批模型；“帮我批准”使用独立 BYOK 模型设置，本机先选择已有 Flash 配置，不硬编码供应商或模型 ID；审查失败回人工。Stop、撤权、规划及持久 Task 工作域边界继续有效。一次 prompt 内的多工具循环与跨轮 Goal 自动续跑是不同机制，不以新增 Goal 替代工具循环。

## 固定来源与证据层级

以下 origin、HEAD 与工作区状态在本次整理时通过只读 Git 命令核对；四个参考子模块的 `status --short` 均为空。链接固定到 commit，不使用会漂移的 `main`。

| 对象 | 固定提交 | 一手来源与说明 |
| --- | --- | --- |
| ZCode | `aac4755666d09fdcd70272fcf063c077a639015f` | [zai-org/ZCode][z-repo]；核验 CLI core、V4 协议与 Desktop host 消费方，不把源码版本当作正式发布或本机运行版本 |
| Kimi Code | `fed19d24f00203205b1fa4d23e60afce0609cc00` | [MoonshotAI/kimi-code][k-repo]；核验 agent-core-v2 的权限策略、执行前门与 turn 状态机 |
| DeepSeek Harness | `d743267388641bc76f17c45ce8b4c231aed1d32c` | [deepseek-ai/deepseek-harness][d-repo]；区分稳定组合与实验性 Web auto-review 层 |
| Codex | `12cca49c81c8aa6a37a5cc4e39964ee3b70f9458` | [openai/codex][c-repo]；核验 Rust core、Guardian 扩展与 TUI；不能据此推定当前 Codex Desktop release 启用了所有分支 |
| KFW 核验基线 | `fc68888887d13c858ab5f3e5f52209e1fbf8f86b` | 本仓库；本篇记录现有 broker 与最终执行门的接缝，不宣称新增模型审批已完成 |

KFW 的源码链接使用仓库内路径，标注的是该基线的符号与行号；后续实现变化不自动刷新本篇快照。参考仓库使用可追溯的固定提交链接。

## 先区分权限、审批与模型审查

| 层次 | 回答的问题 | 与其他层的关系 |
| --- | --- | --- |
| 执行作用域与沙箱 | 当前 Task、角色和进程能访问哪些文件、网络与系统能力 | 审批或 reviewer 的 allow 不能扩大这一上限 |
| 确定性权限策略 | 当前模式、工具效果、命令规则和已有授权是否直接 allow/deny/ask | 无需调用模型；全权应从此分支直接执行 |
| 模型 reviewer | 在仍需审批的这次真实动作上，是否能代替用户给出一次许可 | 是额外模型请求或受限审查会话；不是主 Agent 自称“用户已同意” |
| broker 与最终执行门 | 谁先结算请求、回答是否仍有效、授权是否已被消费 | 审查结束仍须核对取消、动作、授权代际与工具注册，不能看到 allow 文本就执行 |
| Agent loop | 一次用户输入如何经历多次模型请求、工具调用和结果回灌 | 权限等待是 loop 的暂停点；获准后应继续原轮，不要求用户再输入“继续” |

这些层的边界有直接源码依据：Codex `Never` 不解除沙箱；DSH 的 `never` 将仍需 ask 的操作确定性拒绝；KFW `admit` 与最终一次性 `claim` 分开。[Codex 审批政策][c-never]、[DSH 审批政策][d-policy]、[KFW broker 接口][f-types]

## ZCode：全权直通与确定性 Guarded

### 权限预设与实际工具入口

当前共享模式目录公开 `build / guarded / plan / yolo`；`edit` 保留历史恢复，菜单隐藏。`auto` 在 core 中明确返回未实现的拒绝，不能把该值解释为现成模型审批。[模式目录][z-modes]、[权限服务][z-policy]

- `build` 自动允许满足条件的只读、低风险无副作用或会话内更新；一般写入、命令执行及高风险效果进入 ask。
- `edit` 对 workspace 范围的 edit 能力免确认，其余复用 build。
- `yolo` 对普通工具直接 allow。`requiresUserInteraction`、工具声明的 `alwaysAsk` 与独立 Plan 状态仍各有分支。
- `guarded` 以 yolo 为基础；Bash 解析器只在识别到既定危险形式时生成 `userApprovalRule`，转为单次用户确认。超长命令、旧 shell、解析失败等可得到 `unsupported`；这不是 LLM 风险判断，也不是“未知一律询问”。单次确认不提供项目始终允许，不启用 Hook 代答。[Bash 能力判定][z-bash]、[危险命令匹配器][z-danger]、[单次确认流程][z-flow]

真实调用链是 `executeToolCallImpl`：注册工具定位 → schema/语义校验 → `resolveInput` 归一为实际执行输入 → PreToolUse → `resolveToolPermission` → `ToolCallStarted` → handler。权限、预览与执行读取归一后的输入；Hook 改写输入还会校验。并非仅通过 UI 隐藏审批。[工具入口][z-call]

### 宿主接线与审批结算

Desktop host 创建 `createLocalServices`；服务集合装配 `createZCodeAgentService` 与 `createZCodeTaskServiceAdapter`。adapter 将权限切换、停止和审批回答分别送入 V4 `switchCollaborationMode / stop / resolveInteraction`，CLI handler 再驱动 runtime。[Desktop 装配][z-desktop]、[服务装配][z-services]、[模式命令消费方][z-mode-host]、[审批回答消费方][z-answer-host]

普通审批有一次允许、匹配项目规则的持久允许与拒绝；工具也可要求每次询问或仅会话允许。项目规则保存失败会使当前调用失败，不当作已保存。V4 注册表先移除请求再交付回答；重复或迟到回复无害收口。普通拒绝的 model-visible 结果明确说明工具未执行，并要求等待用户指示。[审批选项][z-options]、[规则持久化][z-rules]、[V4 回执注册表][z-registry]

弹窗里的 Full access 不是普通 `allow` 载荷：它走同 session 已登记的特殊能力，事务保存任务执行状态、授权 receipt 与当时捕获的排队项 ID，提交后发布模式事件，再解除当前等待。重试复用同 receipt，不把后来入队的项目重新纳入授权；mode 改为 yolo，同时保留 `planEnabled`。[完全访问提交][z-grant]

### 不能从 ZCode 照搬的边界

1. **全权不是 Task 目录隔离。** `resolveWorkspacePath` 明确不阻止 workspaceRoot 外路径；默认 bootstrap 使用 Node 文件系统和执行适配器，执行器直接 spawn。Bash 请求虽带 `sandbox.enabled`，不能据这个字段声称存在实际 OS 沙箱。[路径策略][z-path]、[默认适配器][z-adapters]、[进程启动][z-spawn]
2. **普通 yolo 的规则优先级较宽。** yolo allow 在 disallowedTools/project deny 之前；KFW 不应据此取消撤权或其他服务端硬拒绝。[权限顺序][z-policy]
3. **Plan 不是所有工具一律只读。** `checkPlanMode` 允许非 destructive MCP；alwaysAsk 分支也先于 Plan。ExitPlanMode 则是单独用户交互，获批后才退出。KFW 保留自己的严格规划边界，不把模型审批变成退出规划的批准。[Plan 判定][z-plan]、[退出规划工具][z-exit-plan]
4. **模型与权限的冻结时机不同。** ZCode 在 turn admission 冻结模型选型，但每次工具入口读取当前 mode。KFW 既有 Run ceiling 与授权代际合同不能因模仿菜单切换而退化。[模型冻结][z-turn-admission]、[逐工具读取 mode][z-call]

这条内建工具审批链未发现 LLM reviewer 调用；配置 Hook 类型仅 `process / command`。自定义脚本可以自行调用模型，但不能将扩展可能性写成内建模型审批。AskUserQuestion 的倒计时也只是结束问题并返回空答案，非模型代批。[Hook 类型][z-hook-types]、[问答自动结束][z-question-timer]

## Kimi Code：自动模式与会话授权均为规则

`AgentPermissionPolicyService` 按顺序取第一个非空结果：auto 下禁用 AskUserQuestion、用户 deny、交互环境中的危险命令策略、auto approve、会话批准历史、用户 ask/allow、敏感文件、Git 控制路径、yolo approve，再到默认工具和 fallback ask。这是服务实际使用的策略顺序。[策略装配][k-policy]

`auto-mode-approve` 与 `yolo-mode-approve` 都只是检查 mode 后返回 approve，没有模型请求。两者仍不同：auto 跳过危险命令检查；yolo 对已识别危险命令仍 ask，对无法分析的命令不因此询问。危险 guard 在 nonInteractive 组合中不装配，因此不能把交互环境结论外推到全部执行形态。[auto][k-auto]、[yolo][k-yolo]、[危险命令策略][k-danger]

“本会话始终允许”记录的是已批准工具提供的 `approvalRule`，后续由会话历史规则匹配，不是再次询问模型。审批 await 结束后重新 `throwIfAborted`，工具 body 前还有取消检查；角色工具限制在 preflight，approve 不能越过角色禁用。[审批与规则记录][k-approval]、[会话匹配][k-session-rule]、[执行前检查][k-executor]、[preflight guard][k-preflight]

Plan 有独立 guard。auto 可以自动退出计划，但源码明确说明这不代表人工批准，仍不得违反用户 Stop/Wait 指令。KFW 不照搬自动退出 Plan。Bash 交给当前 runtime/process provider 执行，权限策略本身不等于 OS 沙箱。[Plan guard][k-plan]、[auto 退出计划][k-plan-exit]、[Bash provider][k-bash]

**判定：该版本 Kimi 的 auto/yolo 与批准历史可以作为确定性自动策略对照，不能作为独立模型 reviewer 已存在的证据。**

## DSH：实验性逐动作 LLM reviewer

### 确有模型调用，但有启用边界

`experimental/auto-review` 的 `apply` 以 prepend 方式监听 `tools/pre-execute`，依赖 approval、llm、permissionPresets、sessions、tools 和 workingDirectory。只在当前 session 选择 Auto 时审查；外层 `run_code` 运输调用跳过，已开始的 PTC inner tool 调用进入逐动作审查。该层不是默认 Web/Headless 的普遍行为；其 README 明确列出需要启用实验性 Web 层的范围。[插件入口][d-review]、[启用和已知限制][d-readme]

Auto 预设为 `danger-full-access + ask`；Full access 使用全权沙箱值与 `never` 审批政策。`never` 的含义是所有仍需 ask 的请求自动 rejected，不是审批服务无条件 allow。Auto 的模型 deny 在 ask 政策下可回人工，而不是把模型 deny 伪装成人工拒绝。[Auto bundle][d-preset]、[默认全权 bundle][d-full]、[审批政策实现][d-policy]、[下游组合][d-review]

### 模型选择、输出与失败

`classifyRisk` 冻结当前动作和相关来源事实，读取最新主请求的 provider/model，调用 `ctx.llm.stream`，`temperature: 0`，没有工具；固定政策与动作作为独立审查输入，不写入主 session 日志。这是额外模型请求，但不是独立可配置 BYOK reviewer。[模型调用][d-model]

`readDecision` 要求完整 terminal stop、零个或多个 reasoning block 后恰好一个 JSON text block；不完整终止、工具块和错误格式均失败。**技术失败转为 deny，不会自动回人工**；模型正常判 deny 与 reviewer 技术失败是不同结果。该实现没有自己的 retry layer。[输出检查与失败][d-model]、[限制说明][d-readme]

### 可借鉴与不可照搬

- reviewer allow 后仍调用 `next()`，保留下游 deny/cancel/ask；最终 `ToolGuard` 只有收紧能力，没有把拒绝改回允许的返回值。工具 dispatch 前重查取消。[插件组合][d-review]、[单调最终门][d-guard]、[执行前取消][d-tool-gate]
- 人工审批请求与 signal 竞争；abort 先发生后，迟到回答对已结算 Promise 无效。[审批取消][d-cancel]
- 卸载 auto-review 会把 live Auto session 改为 Full access，再 abort/drain 审查。KFW 不能照搬这种失去 reviewer 后放宽权限的降级。[卸载行为][d-review]
- 外层 `run_code` 和 PTC 内直接 Node effects 不经过 inner-tool review；Auto 不提供文件沙箱。不能将其称为完整进程副作用审查。[覆盖缺口][d-readme]

**判定：可借鉴逐动作插件门、来源区分和下游只能收紧；KFW 按已确认口径改为独立 BYOK 选型、全权零审查、技术失败回人工，不移植其卸载放宽或覆盖缺口。**

## Codex：Full Access、同步 Guardian 与异步分类分开

### Full Access 不调用 reviewer

内置 Full Access 组合为 `AskForApproval::Never + PermissionProfile::Disabled`；`Never` 单独表示不询问人工，并不自行解除沙箱。Guardian routing 在 full_access 时只执行动作校验后直接 Approved，不调用模型；动作校验和显式 forbidden 仍可拒绝，因此也不能写成“全权取消所有限制”。[预设][c-presets]、[政策含义][c-never]、[直通路由][c-routing]、[危险命令硬拒绝][c-forbidden]

### “Approve for me”是真实路由，独立 BYOK 设置不是现成字段

`ApprovalsReviewer` 有默认 User 和 AutoReview；TUI 的 Approve for me 真实选择 AutoReview。app-server 安装 Guardian 扩展；core 的 MCP 路径也实际检查 GuardianApproval feature、受管要求和 AutoReview 选型。`guardian_approval` 与 V2/远端对照分支不是同一个开关，不能把一个默认值当成全部机制已启用的证据。[reviewer 契约][c-reviewer-type]、[UI 选型][c-reviewer-ui]、[扩展装配][c-install]、[MCP 消费][c-mcp]、[feature 状态][c-features]

同步 reviewer 从父模型目录的 `auto_review_model_override`、provider preferred 与目录可用性选模型，必要时回落父模型，并优先较低支持推理档。reviewer config 从父 Config 复制、继续使用父 provider/auth 上下文；`AutoReviewToml` 没有独立 provider/model 绑定字段。因此它确有与主执行不同的模型选择机制，却不能描述为“用户可独立选择任意 BYOK reviewer”。源码中的默认别名或模型 ID 也不能被复制成 KFW 的默认供应商/模型。[模型选择][c-model]、[父配置复制][c-review-config]、[配置字段][c-review-toml]

### 同步 reviewer 是受限审查会话，不保证仅一次 LLM 请求

core 捕获发起动作时的模型、环境、策略、项目指令和父响应，将原动作与真实 tool-call provenance 分开。审查输入区分 root human 授权/撤权、工具输出、assistant 内容等来源；工具描述不因此变成可信授权。同步 reviewer 使用隔离 session、read-only/Never 配置和受限工具集，可以先做只读检查，再以匹配审查 turn 的 TurnComplete 与最终输出结算；不能看到流里一段 allow 文本就放行。[动作捕获][c-capture]、[授权来源][c-authorization]、[受限配置][c-review-settings]、[匹配 turn 结算][c-execution]

审查失败与危险判定分开；超时、取消、解析或会话故障并非成功 allow。该版本有最多三次尝试和共享 90 秒预算，仅对可恢复错误重试；不应以反复重评直到 allow 代替人工审批。[失败结算][c-completion]、[尝试预算][c-budget]、[重试判定][c-retry]

### Stop、撤权与迟到 allow

工具取消传入 reviewer；thread stop 关闭池并取消/回收活动审查。extension callback 结束后再次检查 history reset 与取消，缓存决策也不能绕过。审查 attempt 绑定 user-message revision、root 授权与 review-context 版本；allow 发布前先完成 checkpoint/锁获取，再重查授权，注释明确要求有效校验至 publication 之间没有 await。授权过期回滚，Stop/重置丢弃。[工具取消传递][c-tool-cancel]、[池关闭][c-pool-stop]、[取消后重验][c-cancel]、[attempt 失效条件][c-invalidation]、[发布前重验][c-publication]

**这能证明防止迟到 allow 的执行门，但不能据此宣称存在 KFW 逐调用 broker 那样的跨进程 durable exactly-once claim。** 同步决策服务注明捕获一个 action，未按 tool-call ID 存储结果。[同步决策边界][c-decision]

### V2 分类与远端对照不扩展成本轮范围

V2 async scorer 是另一条低风险分类/缓存加同步复核链，源码有固定分类模型、无工具请求和按权限/环境/授权/模型等条件约束的缓存；不能简化成每动作都精确独立审查。另有远端 decisions 的可选对照请求，失败只影响测量，不能据此反推远端别名对应的权重或服务端内部实现。本轮 KFW 不需要移植该异步缓存、模型 ID、会话池或远端测量分支。[异步分类][c-v2-sampler]、[分类与复核][c-v2-approval]、[缓存授权条件][c-v2-auth]、[远端对照][c-decisions]、[测量失败边界][c-decisions-startup]

## 一次用户 prompt、多工具循环与 Stop

以下是普通 Agent turn 内的模型—工具循环，不是 Goal 完成评估，也不是新增用户指令。审批只决定当前真实工具是否可以越过等待点；它不应让每个工具都变成一个需要用户重新发送的 Run。

| 项目 | 已核验的普通轮循环 | 停止或收口边界 |
| --- | --- | --- |
| ZCode | `runRegularTurnLoop` 持续请求模型；有工具时保存 tool calls、执行、按 call ID 回灌成功/错误结果，然后继续原 turn | 无工具才进入最终收口；Stop Hook/行内引导可继续，取消终止 loop；预算/重复调用在该路径是提醒。[循环][z-loop]、[结果回灌][z-results]、[提醒][z-warnings] |
| Kimi | LLM 返回工具时从 thinking 转 acting，等待全部工具 outcome，收集结果后进 draining，再回 gating/thinking | 中止等待工具收口；paused、maxSteps 或终态分支可结束本轮。不是每个工具都需新的用户 prompt。[状态机][k-loop] |
| DSH | 一个 turn 的 while 循环执行 step；模型有工具则执行并返回未完成状态，继续下一 step；工具结果进入 session | 无工具或显式 concluded 才结束；每个边界检查 signal；max-tokens 有独立终态。[turn loop][d-loop] |
| Codex | sampling 结果累积 `needs_follow_up`，工具 future 与结果进入现有执行链；仍需 follow-up 或有 pending input 则继续本轮 | 无 follow-up 才进入 Stop Hook/终轮路径，Stop Hook 可要求继续；请求贯穿 cancellation token。[普通 turn][c-loop] |

ZCode 的用户 Stop 使用 `expectedForegroundExecutionId`：目标已变时 noop，命中才取消实际前台执行，并暂停 Goal、hold 后续队列。冷恢复把未完成工具补成 interrupted 结果，不直接重放副作用。该语义适合作为 KFW “Stop 优先，迟到审批不能重启任务”的对照，而不是把停止解释为删除 Task 或丢失会话。[Stop 入口][z-stop]、[恢复状态][z-resume]、[中断工具恢复][z-interrupted]

## KFW 的现有接缝与本轮适配边界

### 现有事实：允许、结算与消费分开

核验基线的 `CodeApprovalService` 已有 `admit / peek / claim / resolve / cancel`；`admit` 内部建立 Promise 等待，不存在另一个独立 `wait()` API。调用身份含 instance、Task、Run、toolCall、agent、role、授权/分支代际与可选规划代际；参数指纹绑定完整实际 args。相同调用不能换参数复用，`claim` 消费后不能再执行。[approval-types.ts:15–118][f-types]、[code-approval.ts:121–311][f-broker]

`kernel/context.ts` 从可信宿主构造 invocation；审批结束后还检查 signal、工具注册、作用域可用性、授权/分支/规划代际，最后调用 `permissions.claim()` 才进入工具 body。模型 reviewer 应作为这个既有链路的应答来源，不能新增一条绕过最终门的执行路径。[kernel/context.ts:525–628][f-gate]

全局 `PermissionTier.full-access` 与 Task 的模式不是同一状态；Task mode、Run ceiling、角色和 Plan 的 deny 不进入模型审查。全权只跳过 ask，不扩大执行作用域。ExitPlanMode 是独立 userInput/规划批准交互，不能交给“帮我批准”自动退出规划。[code-policy.ts:18–76][f-task-policy]、[规划交互创建][f-broker]

### 已确认的落地口径

1. **先规则，后模型。** 现有策略 allow 直接执行，尤其 Task 完全访问零 reviewer 请求；deny 直接拒绝；只有真正的 ask 可以进入独立 BYOK reviewer。不得把全权改成“先让模型判断要不要执行”。
2. **独立选型，目录解析。** 审批模型和主 Agent 模型分别配置；未配置、配置不可用或审查失败保持人工请求。GLM-5.3-Flash 是本机当前选择，通过真实 provider/model 引用解析，不能在业务代码里写死 ID、provider 或凭据，也不能静默借用聊天默认模型。
3. **只处理这次动作。** reviewer 消费受信操作摘要、必要参数与授权事实；输入中的命令、内容、工具输出均作为不可信数据，不接受模型传回新身份、替换参数或权限升级。完整明确 allow 之外不自动执行，技术失败与模型判拒分开记录；一次允许仍由原 broker 结算与最终 claim 消费。
4. **先发布请求，再开始异步审查。** 现有 requested listener 会逐个 await。若直接在普通事件 listener 中调用 reviewer 并 resolve，可能在 requested 尚未完成持久化时先落 resolved。应在原 requested 成功发布之后才启动审查，并与原人工请求竞争，保留同一个 interaction。[事件顺序][f-broker]
5. **Stop/撤权优先。** 人工先回答、Stop、Task 关闭、授权/分支/规划代际变化、工具撤销或 reviewer 配置变化后，旧模型结果不能放行。审查前冻结模型引用与 provider revision；返回后重验，再由既有最终门消费许可。已经开始执行的工具失败不能被当成“审批失败”自动重放。
6. **最小且完整的能力缝。** 用现有设置、BYOK 解析与权限扩展点承接 reviewer，保持 Service Definition、Provider、Consumer 完整；ctx key、插件装配和凭据规则仍由《改造计划》持有，本文不复制第二份清单。第一期不引入 DSH/Codex 的异步评分缓存、会话池或另一套 Agent/Goal loop。

### 验收证据应覆盖的行为

这些是本轮实现的可验证结果，不是本篇已执行的测试：

- 完全访问原题可连续多工具执行，reviewer 请求数为零；相同 Flash/题目对标应单列模型、权限、工具、循环与成果证据，不能用最终文案长度比较能力。
- ask 下 reviewer 明确 allow 后原 loop 继续，且同调用最多一次 claim；人工先答、重复回答、迟到 allow 不二次执行。
- 模型超时、请求失败、输出不完整、格式异常或必要上下文缺失时，保留原人工请求，不默许、不制造第二个 interaction、不重评直到 allow。
- Stop、撤权、分支切换、工具卸载及审批模型/provider 配置变化与慢审查竞争时，旧回执不能恢复执行。
- Plan 与角色/目录硬拒绝不因全权或 reviewer allow 扩权；审批事件、错误和 UI 不泄漏 BYOK Key、请求头或原始敏感环境。

## 核验限制

- 本次复用同轮已完成代理的一手源码核验，按固定版本归并，并定点核对装配、关键分支与循环；没有重新开展全仓研究。
- 没有运行模型、安装依赖、读取本机供应商密钥或操作用户自己的 ZCode。没有建立或写入对比测试目录。
- 源码装配只能证明该入口真实可调用；默认 feature、实验层启用条件和当前已安装桌面进程是不同证据。Codex 远端 alias、真实权重和云端内部决策不在开源源码可证范围。
- 本文不复制上游代码/schema/字段到实现；不将模型审批与 Goal 成果验收混为一谈，也不将“无额外询问”当作 OS 权限证明。

[z-repo]: https://github.com/zai-org/ZCode/tree/aac4755666d09fdcd70272fcf063c077a639015f
[k-repo]: https://github.com/MoonshotAI/kimi-code/tree/fed19d24f00203205b1fa4d23e60afce0609cc00
[d-repo]: https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c
[c-repo]: https://github.com/openai/codex/tree/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458
[z-modes]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/shared/src/zcode-agent-model-state.ts#L19-L45
[z-policy]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/permission/service.ts#L101-L265
[z-bash]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/tool/handlers/bash.ts#L114-L140
[z-danger]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.ts#L51-L129
[z-flow]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts#L170-L207
[z-call]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts#L179-L368
[z-desktop]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/desktop/src/host/index.ts#L2949-L2959
[z-services]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/services/src/node.ts#L2259-L2266
[z-mode-host]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L1220-L1244
[z-answer-host]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts#L2575-L2600
[z-options]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/permission-options.ts#L6-L112
[z-rules]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/tool/executor/permission-rules-persistence.ts#L78-L127
[z-registry]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/interaction-registry.ts#L155-L190
[z-grant]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/permission-full-access.ts#L17-L109
[z-path]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/tool/path-policy.ts#L15-L39
[z-adapters]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/app/create-app.ts#L420-L436
[z-spawn]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts#L62-L143
[z-plan]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/permission/service.ts#L447-L488
[z-exit-plan]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts#L60-L103
[z-turn-admission]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts#L111-L115
[z-hook-types]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/contracts/src/hooks/index.ts#L377-L400
[z-question-timer]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/interaction-registry.ts#L256-L342
[z-loop]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts#L44-L233
[z-results]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/tool-result-settlement.ts#L55-L90
[z-warnings]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/turn-tool-warnings.ts#L14-L82
[z-stop]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts#L270-L336
[z-resume]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/runtime/methods/resume.ts#L194-L224
[z-interrupted]: https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts#L196-L210
[k-policy]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts#L39-L65
[k-auto]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/permissionPolicy/policies/auto-mode-approve.ts#L7-L16
[k-yolo]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/permissionPolicy/policies/yolo-mode-approve.ts#L7-L16
[k-danger]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts#L129-L145
[k-approval]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/toolApproval/toolApprovalService.ts#L144-L203
[k-session-rule]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/permissionPolicy/policies/session-approval-history.ts#L16-L39
[k-executor]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/toolExecutor/toolExecutorService.ts#L512-L520
[k-preflight]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/toolExecutor/toolExecutorService.ts#L750-L769
[k-plan]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/features/plan/planService.ts#L93-L123
[k-plan-exit]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/features/plan/tools/exit-plan-mode/exitPlanModeTool.ts#L155-L163
[k-bash]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts#L157-L188
[k-loop]: https://github.com/MoonshotAI/kimi-code/blob/fed19d24f00203205b1fa4d23e60afce0609cc00/packages/agent-core-v2/src/human/agent/turn.ts#L572-L858
[d-review]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/experimental/auto-review/src/index.ts#L675-L737
[d-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/experimental/auto-review/README.md#L83-L119
[d-preset]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/interaction/permission-presets/src/index.ts#L81-L92
[d-full]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/interaction/permission-presets/src/index.ts#L183-L197
[d-policy]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/interaction/user-approval/src/index.ts#L57-L75
[d-model]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/experimental/auto-review/src/index.ts#L587-L672
[d-guard]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/tools/src/index.ts#L724-L732
[d-tool-gate]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/tools/src/index.ts#L1499-L1560
[d-cancel]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/interaction/user-approval/src/index.ts#L267-L306
[d-loop]: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L308-L555
[c-presets]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/utils/approval-presets/src/lib.rs#L28-L59
[c-never]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/protocol/src/protocol.rs#L1114-L1117
[c-routing]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-reviewer/src/routing.rs#L54-L90
[c-forbidden]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/exec_policy.rs#L793-L806
[c-reviewer-ui]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/tui/src/chatwidget/permission_popups.rs#L120-L147
[c-reviewer-type]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/protocol/src/config_types.rs#L175-L202
[c-install]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/app-server/src/extensions.rs#L84-L99
[c-mcp]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/session/mcp.rs#L908-L925
[c-features]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/features/src/lib.rs#L1817-L1875
[c-model]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-reviewer/src/model.rs#L18-L75
[c-review-config]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-v2/src/sync_reviewer/reviewer_config.rs#L12-L69
[c-review-toml]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/config/src/config_toml.rs#L578-L595
[c-capture]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/guardian/mod.rs#L86-L181
[c-authorization]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/guardian-context/src/authorization.rs#L12-L93
[c-review-settings]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-reviewer/src/settings.rs#L43-L65
[c-execution]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-reviewer/src/execution.rs#L66-L200
[c-completion]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-reviewer/src/completion.rs#L20-L158
[c-budget]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-reviewer/src/lib.rs#L40-L41
[c-retry]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-reviewer/src/retry.rs#L128-L173
[c-tool-cancel]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/approvals.rs#L580-L585
[c-pool-stop]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-v2/src/sync_reviewer/mod.rs#L217-L225
[c-cancel]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/guardian/decision.rs#L55-L119
[c-invalidation]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/guardian/review_request.rs#L11-L78
[c-publication]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/guardian/review_session_setup.rs#L299-L334
[c-decision]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/guardian/decision.rs#L1-L2
[c-v2-sampler]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-v2/src/async_scorer/sampler.rs#L232-L237
[c-v2-approval]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-v2/src/async_scorer/approval.rs#L103-L155
[c-v2-auth]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-v2/src/async_scorer/authorization.rs#L8-L49
[c-decisions]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-v2/src/async_scorer/decisions.rs#L29-L35
[c-decisions-startup]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/ext/guardian-v2/src/async_scorer/startup.rs#L17-L27
[c-loop]: https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/session/turn.rs#L532-L693
[f-types]: ../../apps/server/src/features/permissions/approval-types.ts
[f-broker]: ../../apps/server/src/features/permissions/code-approval.ts
[f-gate]: ../../apps/server/src/kernel/context.ts
[f-task-policy]: ../../apps/server/src/features/permissions/code-policy.ts

## 原生同题与单菜单验收（2026-10-17）

本节是上述固定源码调研之后的独立实测，不改写调研当时的“未操作ZCode”边界。仅使用一个隔离目录`/private/tmp/kfw-zcode-parity-20261017`：四份初始文件、同一提示词、零依赖订单汇总任务。先保全ZCode完成版，再将同一目录逐文件恢复为初始哈希，供KFW运行。没有修改用户已有ZCode项目/任务，没有新媒体请求。

| 观测项 | ZCode | KFW |
| --- | --- | --- |
| 界面模型 | 软通v2/GLM-5.3-Flash、最高 | 目录内glm-5.3-flash、max；原生usage同名 |
| 用户输入 | 1条 | 1条 |
| 变更审批 | 新项目逐调用确认，3次人工allowOnce | build、Plan关闭；独立审批配置，3次模型allow，人工0次 |
| 操作 | 两次Write、一次npm test | 两次Write、一次npm test |
| 测试 | 19/19；另跑Node核验通过 | 19/19；另跑Node核验通过 |
| 文件边界 | 仅实现与README | 仅实现与README，测试哈希未变、无额外文件 |

KFW Task`518ad419-2d96-43c8-90ea-d7edb3583438`、Run`55d7325f-5b52-4beb-b568-5fc3f56da315`最终`completedSuccess`，无遗留审批。三次requested/resolved的interactionId逐一一致、均allow，真实工具输出有`# pass 19 / # fail 0 / EXIT=0`；真实usage归原Run、provider_instance_id归本机目录引用。配置使用独立审批字段，不把本机选择写成业务默认值。中间Bash审批等待后自行完成，未人工接管或重新发输入。2026-10-18用户明确并提供ZCode配置截图：双方均使用GLM官方端点，同为GLM-5.3-Flash；“软通v2”和“Zhipu AI Coding Plan”是本机供应商显示名称，不能据名称推断网关不同。此前“实际网关不同”的表述没有依据，已撤回。该同题按同一官方模型条件比较Harness；ZCode总耗时包含后台开发时的人工审批等待，因此不比较速度。整体Code能力是否相当仍取决于对标任务覆盖范围，不能再以“网关不同”作为限制理由。

通过`pnpm desktop`冷启动的原生壳核对：一个盾牌入口内包含原Plan、权限与执行方式分组；原图标与完全访问橙色状态保留；无独立“自主”或旧全局tier触发器。原生Task已完成时菜单显示“变更前确认＋自主”，打开菜单和Run过程均保持右侧既有画布标签。未把这次常规任务当作跨Run Goal、所有危险操作模型审查或未来Jev协议的验收。

初始/完成tar、文件哈希、提示词、公开快照及脱敏审批/usage回执保存在本机忽略的`.kenfutwork-data/desktop-development/统一工作台验收/`，不把凭据或生成产物提交到仓库。
