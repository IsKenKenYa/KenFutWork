# Codex 目标与完成判定源码核对

核对日期：2026-10-13。对象：本仓库 `references/codex`，commit `806d9732c974bc8a51b8317c1bd8985544fe627c`。本文只报告这份本地源码快照；没有拉取上游，不代表所有已发布 Codex 客户端都已启用该能力。只读研究，没有运行模型或测试。

## 结论

这份 Codex 源码有真正的持久、会话内跨 turn Goal。它不是 `update_plan` 的别名：Goal 持有目标、状态、预算及用量，宿主在空闲时为 active Goal 自动发起后续 turn；完成通常由执行模型调用 `update_goal(status="complete")`。完成证据的逐项审计是提示词约束，当前完成工具没有结构化证据参数，也没有调用独立裁判模型的硬性检查。

用户控制和模型判断并存：用户可通过客户端/API 改目标、暂停、恢复、清除；模型只能用 Goal 工具标 complete/blocked/paused，不能自行恢复或把状态设成额度/预算耗尽。本次未发现 Goal 的强制「每次创建先批准验收项」或「完成必须用户验收」协议。

## 逐项源码证据

下列路径均相对仓库根目录。

| 问题 | 核对结果 | 一手源码位置 |
| --- | --- | --- |
| Goal 的领域对象 | `ThreadGoal` 持有 thread_id、objective、status、token_budget、tokens_used、time_used_seconds、时间戳；状态有 active/paused/blocked/usageLimited/budgetLimited/complete。没有文字/操作成果类型、验收项列表或 evidence 字段。 | `references/codex/codex-rs/protocol/src/protocol.rs:4182-4222` |
| 是否持久 | `GoalStore.get_thread_goal` 从 SQL `thread_goals` 按 thread_id 读取；snapshot 写入也以 thread_id 冲突更新。不是单 turn 的内存变量。 | `references/codex/codex-rs/state/src/runtime/goals.rs:40-105` |
| 一个会话几个当前 Goal | 模型创建调用 `insert_thread_goal`；SQL 冲突时只有原 Goal 为 complete 才替换，并重置用量，其他未完成状态拒绝替换。 | `references/codex/codex-rs/ext/goal/src/tool.rs:204-244`；`references/codex/codex-rs/state/src/runtime/goals.rs:214-268` |
| 创建授权 | 工具说明要求仅在用户或 system/developer 明确要求时创建；不能由普通任务推断 Goal。参数只有 objective 与可选 token_budget；objective 非空且最多 4000 字符。授权意图属于提示约束，创建 handler 校验文本/预算/持久线程及现有 Goal，并非识别自然语言授权的裁判。 | `references/codex/codex-rs/ext/goal/src/spec.rs:25-57`；`references/codex/codex-rs/ext/goal/src/tool.rs:171-175,204-244`；`references/codex/codex-rs/protocol/src/protocol.rs:4194-4205` |
| 跨 turn 的调度 | `on_thread_idle` 调用 `continue_if_idle`；后者读取持久 Goal，仅 active 时构造 continuation 提示，调用 `start_turn_if_idle`，并设置 turn_trigger 为 goal。新 turn 继承保存的 TurnStartOptions。 | `references/codex/codex-rs/ext/goal/src/extension.rs:180-202`；`references/codex/codex-rs/ext/goal/src/runtime.rs:436-515` |
| turn 结束是否完成 Goal | `on_turn_stop` 记账并结束当前 turn 的 accounting，不把 Goal 自动改为 complete；active Goal 在后续空闲钩子继续。提示也明确 ending this turn 不等于缩小/完成目标。 | `references/codex/codex-rs/ext/goal/src/extension.rs:350-377`；`references/codex/codex-rs/ext/goal/templates/goals/continuation.md:9-12` |
| 谁给出完成状态 | 模型提交 `UpdateGoalArgs { status }`；handler 只允许 complete/blocked/paused，记账后直接 `update_thread_goal` 写状态，再发 Goal updated 事件。没有文件断言、命令回执或独立评估请求。 | `references/codex/codex-rs/ext/goal/src/tool.rs:57-61,247-316` |
| 完成的提示要求 | 工具要求 objective 真正达成且无剩余工作，不能因停止或预算将尽而标完成。continuation 要模型逐项导出真实要求、检查当前文件/命令/测试/PR/渲染/运行行为，证据弱、缺失、间接时继续。明确不能凭回复看起来合理、意图、记忆或部分进度完成。 | `references/codex/codex-rs/ext/goal/src/spec.rs:60-93`；`references/codex/codex-rs/ext/goal/templates/goals/continuation.md:35-46` |
| 独立模型裁判 | 在本次核对的 Goal extension 的 `tool.rs`、`api.rs`、`runtime.rs`、`extension.rs` 与 templates 中未发现 Goal 完成调用第二模型的路径。不能由此推断整个 Codex 没有 review 模式，只能说此 Goal 完成路径未接独立 judge。 | `references/codex/codex-rs/ext/goal/src/tool.rs:247-316`；`references/codex/codex-rs/ext/goal/src/runtime.rs:465-515`；`references/codex/codex-rs/ext/goal/templates/goals/continuation.md:35-46` |
| 用户操作入口 | TUI `/goal` 支持 clear/edit/pause/resume，并将其他输入解释为 objective 草稿。该分支没有 `/goal accept` 命令。API `ThreadGoalSetParams` 能携带 objective、status、预算和 origin，GoalService 可更新它们。 | `references/codex/codex-rs/tui/src/chatwidget/slash_dispatch.rs:965-1026`；`references/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:853-883`；`references/codex/codex-rs/ext/goal/src/api.rs:150-265` |
| 用户来源记录 | app-server 在 origin=user 且目标/状态有修改时，先记录 user goal update；API 中 missing provenance 不提供 user authorization。这里是来源记账/注入边界，不能误称来源为 null 时所有修改都会被 API 拒绝：processor 仍把修改交给 GoalService。 | `references/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:853-874`；`references/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs:179-215` |
| 计划与待办 | `update_plan` handler 自称 TODO/checklist tool，只解析参数、发 `EventMsg::PlanUpdate`、返回 Plan updated。此路径不写 Goal、不启动续跑、不裁定 Goal 完成。Goal 提示仅把它作为进度展示，并要求不要以 plan 更新代替工作。 | `references/codex/codex-rs/core/src/tools/handlers/plan.rs:65-99`；`references/codex/codex-rs/ext/goal/templates/goals/continuation.md:27-28` |
| 模型与宿主的停止边界 | blocked 连续三轮无进展的规则在工具/continuation 提示里；宿主另在不可重试/重试耗尽错误时停止 active Goal，避免自动续跑循环耗 token。预算/用量状态由用户/系统控制，模型工具不能设置。 | `references/codex/codex-rs/ext/goal/src/spec.rs:74-83`；`references/codex/codex-rs/ext/goal/templates/goals/continuation.md:48-56`；`references/codex/codex-rs/ext/goal/src/extension.rs:423-446`；`references/codex/codex-rs/ext/goal/src/tool.rs:251-259` |
| 插件形态 | 实现独立 `GoalExtension`，持有 GoalService、state DB、thread manager、事件与 metrics；续跑挂 idle、生命周期与记账扩展点。 | `references/codex/codex-rs/ext/goal/src/lib.rs:1-28`；`references/codex/codex-rs/ext/goal/src/extension.rs:53-68,180-202` |

## 对 KenFutWork 的设计含义

以下是建议，不是 Codex 已实现的事实。

1. 可以采用「持久 Goal + 独立 Run 生命周期 + 宿主续跑」：Run 正常结束只意味着本轮结束；Goal complete 要走明确状态工具。续跑不能单靠模型输出文本触发，应按持久状态及宿主空闲准入处理。
2. 不应声称主流 Harness 都要求用户启动前确认每个验收项。此 Codex 快照支持执行模型自主判完成，辅以很强的逐项证据提示。若 KenFutWork 要求启动前确认，应说明这是自己的产品策略。
3. 用户已经认可的「明确成果类型与验收项」可保留。执行模型负责提出要求、搜集证据与评估是否满足；程序对操作成果的真实回执、路径和检查结果做可自动检查的约束。文字成果无需伪造文件/命令证据。
4. 独立评估模型与用户验收可以作为明确选择的验收方式，但不能宣称来自此 Goal 完成实现，也不必默认每轮调用裁判。若用户要求必须人工验收或独立评估，则模型提交完成申请而非直接变 complete。
5. 「证据提示」和「证据硬门禁」必须在文档与 UI 中区分：Codex 的完成工具没有结构化证据字段，不能拿其严格措辞证明服务端已经验证全部成果。

## 核对范围与限制

通过 CodeGraph MCP 先查询 `references/codex Goal create_goal update_goal get_goal completion persistent goal plan todo`，工具报告该项目无可用索引，随后使用 `rg` 与精确行号源码读取。未修改 reference，未拉取网络源码，未运行测试。本文覆盖目标模型、Goal 工具、SQLite 存储、自动续跑、TUI/API 控制与 plan handler；不等同于 Codex 桌面产品的端到端验收，也不证明该 feature 在所有客户端默认开启。
