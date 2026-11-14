# Harness 改进清单

> 角色：源码检查快照与执行建议；2026-10-22，采样基线 `e0af10ac`。本轮未修改运行代码、运行产品测试或调用真实模型。条目编号仅供本目录引用。

## 阅读口径

- **源码确认**：已读到条件与消费路径；涉及缺陷时仍须用真实实现复测。
- **能力限制**：当前明确没有接通的行为，不自动表示现有设计错误。
- **待验证**：尚无足够证据判定问题存在。
- 优先次序由[阅读指南](阅读指南.md)说明；插件生命周期问题另见[插件架构检查](插件架构检查.md)。

已有能力应继续复用：持久 Task/Run、LocalActor、授权代际、Unix/Windows 进程隔离、文件版本和已读范围校验、按路径串行写入、后台 TaskWork、工具真实回执、自动/手动压缩、历史分支、文件恢复、ToolSearch、Goal 独立评估。完整规格见[Code 工作域](../方案设计/Code工作域与工具内核实施规格.md)和[Harness 与 Goal](../方案设计/Harness稳定性与Goal实施规格.md)。

## 先验证现有连接

### H01：插件技能按错误模式筛选

- **源码确认**：[技能消费者](../../apps/server/src/features/skills/plugin.ts)按 `scopeHandle` 是否存在选择 Code/Design；[Run 加载](../../apps/server/src/agent/runtime.ts)的实例 loader 与[技能加载器](../../apps/server/src/agent/workspace-skills.ts)也存在默认 Code 路径。当前两模式都有 Task，Design 会被当成 Code 筛选插件技能。
- **影响**：声明 `design` 的插件技能可能缺席，声明 `code` 的技能可能进入 Design 目录。普通数据库技能及 shared 包不受该模式过滤影响。本轮未确认内置插件事故。
- **改动方向**：目录、正文、资源统一消费本轮冻结模式，不能用宿主对象是否存在推断模式。
- **完成条件**：真实 Code/Design/shared 插件包经过主 Run、子 Run、界面切换和历史恢复；目录与读取结果一致，权限仍由原服务决定。依赖：现有工作上下文与技能注册表。

### H02：技能加载失败被当成空目录

- **源码确认**：[workspace-skills.ts](../../apps/server/src/agent/workspace-skills.ts)将列表/资源错误转换为空数组，runtime 外层也有记录后继续的路径。模型无法区分无技能和加载不完整。
- **改动方向**：明确返回目录完整性与错误，显式使用技能失败应直接显示原因；保留下一轮恢复加载的能力。
- **完成条件**：空目录、数据库故障、资源缺失、停用并发和恢复后再加载分别验证；不能靠隐藏失败通过测试。可与 H01 同范围检查、按独立行为提交。

### H03：自动提交缺少修改来源边界

- **源码确认**：[git-client.ts](../../apps/server/src/features/code-git/git-client.ts)的 `commitAll` 调用 `git add -A`，自动提交复用它；[服务](../../apps/server/src/features/code-git/code-git-service.ts)没有为这次提交提供文件/hunk 来源清单。
- **影响条件**：自动提交已开启，且人工或多个 Task 共用目录时，会收集其他来源的修改。本轮未执行复现。
- **改动方向**：独占目录与共享目录分别定义提交范围；worktree 增加 Task 所有权、基准、恢复与清理记录。复用现有 Git 服务。
- **完成条件**：两个 Task 加人工修改共存时互不吸收修改；创建失败、重启、未跟踪/忽略文件、移交及删除后迟到请求有明确结果。完整 Task 工作树管理可以在先修提交范围之后交付。

### H04：模型请求治理不一致

- **源码确认**：[重试 middleware](../../apps/server/src/agent/llm-retry-middleware.ts)与底层 SDK 重试叠加，指数退避的基数和上限使用固定数值，等待本身不可即时取消；[独立请求](../../apps/server/src/agent/model-request.ts)使用固定 60 秒等待；[普通模型构造](../../apps/server/src/agent/model-execution.ts)与连接测试采用不同的重试参数路径。
- **影响**：实例设置中的尝试次数不等于统一的网络请求上限；主对话、审批、Goal 评估与压缩的等待和取消表现难以解释。
- **改动方向**：由同一模型请求服务持有总尝试预算、错误分类、退避、取消和用量归属；默认值继续由 shared governance 管理。
- **完成条件**：统计真实 HTTP 请求次数；覆盖限流、鉴权错误、流中断、部分输出、退避取消、审批/摘要请求和迟到用量。已经开始的工具操作不随模型重试再次执行。

## 完善日常执行

### H05：受限网络授权未接通

- **能力限制**：[生产沙箱装配](../../apps/server/src/features/process-sandbox/plugin.ts)固定空允许域；底层已有网络策略接口。Windows 对受限域代理明确拒绝。批准命令不自动改变网络策略。
- **改动方向**：在现有权限和 ProcessSandbox 中管理目标域、协议/端口、作用目录、有效期及撤销；明确平台支持范围。
- **完成条件**：真实包管理器访问获准地址成功，跨域重定向、IP、DNS、代理、localhost 和撤权后的请求按规则处理；不支持的平台直接说明原因。

### H06：前台命令缺少分段返回与 Agent PTY

- **能力限制**：[Bash](../../apps/server/src/features/task-work/command-tools.ts)前台等待退出，参数没有 PTY/有限等待；[人用终端](../../apps/server/src/features/code-terminal/service.ts)已有 `spawnPty`，后台 TaskWork 也已有查询、输入和停止。
- **改动方向**：复用 ProcessSandbox/TaskWork，使未知耗时命令先返回输出与可继续控制的身份，支持明确请求 PTY。
- **完成条件**：快命令一次结束，长命令按时返回，交互式 CLI 能输入；输出游标不丢不重，取消、权限变化与跨 Run 控制保留现有定义。

### H07：搜索成本随文件数放大，语义服务未接通

- **源码确认**：[搜索](../../apps/server/src/features/code-tools/file-search.ts)先递归目录，再逐文件调用 [rg](../../apps/server/src/features/code-tools/file-ripgrep.ts)；该枚举路径没有 ignore 规则。[现有索引](../../apps/server/src/features/code-index/index-store.ts)服务界面，尚未接入 Agent 检索。所查第一方代码未见完整 LSP 消费服务。
- **改动方向**：先统一授权范围内的文件枚举、ignore、批量搜索与取消，再引入按项目启用的符号查询/诊断服务。性能改善幅度需测量。
- **完成条件**：真实大型仓库比较首结果、无命中、续查时间与进程数；覆盖目录变化、符号链接、授权撤销。语言服务另验证文件版本、过期诊断、退出和内存占用。

### H08：目录规则发现、更新与去重不统一

- **源码确认**：[目录规则](../../apps/server/src/features/code-tools/project-instructions.ts)支持分层读取，但[工具接线](../../apps/server/src/features/code-tools/tool-definitions.ts)主要随 Read 附加祖先规则；连续读取重复提供，Write/Grep/Bash 等入口未见等价发现流程。
- **改动方向**：统一维护规则来源、适用目录、版本和已披露状态，写入前确保适用规则已提供给模型。
- **完成条件**：首次创建文件、连续读取、Bash 切目录、运行中修改/删除规则、压缩后访问、附加授权目录全部覆盖。依赖：现有项目上下文；与 H07 共用文件发现能力。

### H09：子代理缺少持续交谈控制

- **能力限制**：[子代理插件](../../apps/server/src/features/code-subagents/plugin.ts)主要公开 Task/TaskOutput/TaskStop；[主 Run guide](../../apps/server/src/features/code-ui/guide-model-mailbox.ts)限定 main。已有独立子会话、权限继承、后台执行及完成通知。
- **改动方向**：在现有子会话与 TaskWork 上增加补充消息、空闲继续、父子双向通知与显式恢复；消息具有稳定身份、父子关系与授权代际。
- **完成条件**：工作中补充、空闲继续、停止后继续、重启后继续和删除后迟到消息可验证；消息投递不能自动重放结果不明的写入。依赖：TaskWork 持久消息与现有子会话身份。

## 扩展能力与保持可替换性

### H10：上下文需要分层缩减，长期记忆尚未接通

- **已有与限制**：当前压缩有预算、保留策略、归档和写入后核对；[Code 工具中间件](../../apps/server/src/features/code-tools/native-tool-exclusion.ts)为保护图片关闭通用结果驱逐。所查装配未见独立的旧工具结果缩减、图片压力处理与重新计量流程；未找到第一方项目记忆提取/召回服务。
- **改动方向**：先减少可重新读取的旧工具内容，再决定摘要；长期记忆单独管理项目归属、来源、更新、删除和读取预算。保留 ReadHistory 及消息配对关系。
- **完成条件**：大量小结果、连续图片/PDF、小窗口模型下验证实际请求大小、摘要次数和最近要求保留；跨会话记忆另验证来源引用、过期事实、删除与项目隔离。

### H11：用户 Hooks 的控制事件较少

- **能力限制**：[用户 Hooks](../../apps/server/src/features/settings/hooks.ts)只有 turn-start/end，失败只记录；内部工具门不等于用户可配置的完整 Hook 系统。
- **改动方向**：增加工具前后、失败、压缩和完成检查的结构化事件与结果；修改参数后重新授权，沿用受控命令执行。
- **完成条件**：阻断、超时、失败、参数变化和完成检查都经过真实流程；Hook 不能扩大 Task 权限。依赖：插件生命周期检查中的资源释放问题先得到验证。

### H12：插件声明兼容与 MCP 协议面仍有限

- **能力限制**：[Bundle](../../packages/shared/src/plugin-contracts.ts)主要支持 kenfutwork/dsh；[MCP](../../apps/server/src/features/mcp/mcp-tools.ts)集中于 listTools/callTool，工具统一按 execute 处理并排除只读角色。ToolSearch 已实现。
- **改动方向**：将外部声明转换为现有贡献定义；按需要接入 resources/prompts/交互输入；本地可信声明决定只读能力，远端 hint 仅作参考。项目配置、OAuth、市场源与通用设置见规划盘点。
- **完成条件**：支持与不支持的字段明确可见；安装、更新、停用、权限撤销和清单变化不使旧 Run 自动获得新能力。依赖：插件生命周期、H11；原生外部插件代码的信任边界须单独定义。

### H13：运行时接口还没有覆盖全部控制能力

- **已有与限制**：[AgentRuntimeProvider](../../apps/server/src/agent/provider-contract.ts)已有中性输入、产品事件、真实宿主工具与上下文接口；[第二 Provider 测试](../../apps/server/src/agent/provider-contract.test.ts)存在。指导、模型切换与扩展仍依赖 [LangChain middleware](../../apps/server/src/agent/run-extension.ts)及 native 装配。
- **改动方向**：使用一个真实外部引擎验证恢复、分支、指导、取消、权限等待、文件变更与压缩能力，逐项声明支持范围；SDK 类型保留在适配器内。
- **完成条件**：相同 Task 授权和工具真实回执下，两个生产 Provider 通过共同场景；不支持的操作明确拒绝；原生 checkpoint 的版本、归属与迁移行为有定义。协议接通不代表状态格式互通。

## 贯穿所有批次的验证设施

### H14：真实模型兼容性、追踪与重复评测需要连接

- **已有与限制**：[用量](../../apps/server/src/agent/model-call-usage.ts)、阶段日志、业务事件和大量回归存在；[连接测试](../../apps/server/src/features/model-providers/model-connectivity.ts)只验证非流式简单调用，不能证明工具、多模态、终态与恢复兼容。未见完整统一追踪与重复任务评测入口。
- **证据边界**：部分持久化/宿主测试由显式环境开关启用；默认 CI 没有启用所有这些场景。独立 Goal 评估只服务具体目标，不等于产品级比较测试。
- **改动方向**：关联 Task→Run→模型请求→审批/工具→子代理/外部进程；固定真实任务、模型、预算，多次比较完成率、时间、token、请求次数与恢复结果。候选场景覆盖文件修改、长命令、子代理、压缩、取消和重启。
- **完成条件**：每个结果可定位到代码提交、模型配置和产物证据；传输夹具、真实模型、GUI 与发布检查分开报告。先建立基准，再扩大能力。

### H15：文件系统最后一次路径检查后的并发变化需要专项验证

- **待验证，未确认漏洞**：[文件写入](../../apps/server/src/features/code-tools/file-controller.ts)和[删除/移动](../../apps/server/src/features/code-tools/file-mutations.ts)已有版本、路径与锁检查；路径检查和最终系统调用之间仍有时间间隔。
- **完成条件**：用独立进程在检查后交换祖先目录，验证授权外文件的内容和元数据不变；只有真实复现后才决定是否改用受限文件服务或句柄级操作。不得凭静态时间间隔就宣称逃逸成立。

## 执行与验证入口

先检查该包当前 `package.json` 与测试开关。以下从仓库根执行；产品修复必须先增加针对性失败用例，下面的默认命令不代替真实模型或 GUI 验收。

```sh
pnpm test:docs
pnpm test:workspace
pnpm --filter @kenfutwork/server exec vitest run src/agent/provider-contract.test.ts src/agent/llm-retry-middleware.test.ts src/features/skills/skill-tools.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec turbo run test --concurrency=1
pnpm typecheck
```

需要真实临时数据库的范围必须检查对应测试文件所需开关，并将临时目录设在已忽略的 `.scratch/`。主 Agent 统一运行测试；新增接口继续按仓库既有 OpenAPI/Apifox 流程处理。实施回执写入所属规格与日志，本清单引用其结果。
