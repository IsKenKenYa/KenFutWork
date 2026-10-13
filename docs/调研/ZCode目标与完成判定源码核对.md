# ZCode 目标与完成判定源码核对

核对日期：2026-10-13。范围仅为本地 `references/zcode` 源码，未运行模型或桌面验收。版本 `3.14.3`（`references/zcode/package.json:3`），子模块 HEAD 为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（读取 `.git/modules/references/zcode/HEAD`）。本报告是调研事实与建议，不改变 KenFutWork 已确认的设计。

## 实际结论

ZCode 有真正持久、会话内跨执行轮次的 Goal，并通过一个独立的模型请求进行完成评估。评估使用会话当前所选模型，并不是必须换供应商或换模型。主执行请求与评估请求分离；评估器只能消费历史，不调用工具。它没有创建前逐项由用户确认的结构化验收清单，也没有必经的用户人工完成审批。证据要求主要由提示词约束。

一个关键限制是：评估器坏 JSON、试图调用工具、请求异常时采用 **fail-open**，返回 `passed: true`，后续运行时会写入 `complete`。因此其独立评估不能等同于保证成果正确的硬门禁。

## 源码证据

| 问题 | 当前事实 | 仓库相对源码路径与行号 |
| --- | --- | --- |
| Goal 是否独立于 Run | `SessionGoal` 存 sessionID、targetID、objective、status、累计 token/时间及 activeRun 字段；存储按 session_id 读写 SQLite `session_target` | `references/zcode/apps/zcode-cli/packages/contracts/src/tools/target.ts:46-85`；`references/zcode/apps/zcode-cli/packages/adapters/src/storage/session-target.ts:25-75` |
| 是否持久跨轮次 | Goal 循环每轮调用执行命令，随后切到 verifyBeforeContinue；运行结束仅累计 Goal 用量并记录 run_finished，不直接宣告 complete | `references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts:45-85`；`references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/target.ts:209-249` |
| 谁写入完成 | verifier 返回 passed 后，runtime 调 `updateTargetStatus({status: "complete"})` | `references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts:41-88` |
| 第三者评估是哪种 | 取得会话模型选择，再创建 runtime model；构造历史加 verification prompt 的单独请求。不是主回复的同一结果对象，也没有专门的不同模型选择 | `references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts:100-147` |
| 评估器是否检查文件 | 校验提示禁止写文件/工具；模型请求工具列表为空。证据来自完整对话历史的投影，未发现独立文件检查执行器 | `references/zcode/apps/zcode-cli/packages/contracts/src/tools/target.ts:202-224,238-243`；`references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts:133-153,339-344` |
| 验收项与证据 | 提示要求每个显式要求、命名文件、命令、测试、门禁、交付物都有证据；todo 的 pending/in_progress 应失败。计划/检查表完成和看似合理的最终回答不能单独作为完成证据 | `references/zcode/apps/zcode-cli/packages/contracts/src/tools/target.ts:181-192,238-243` |
| 文字与操作目标 | verifier 首先自行分类 objective；问候等非任务只需合理回复。SessionGoal schema 没有成果类型、结构化验收项、证据引用字段 | `references/zcode/apps/zcode-cli/packages/contracts/src/tools/target.ts:65-85,212-219` |
| 校验不通过 | 有 nextAction 时将其注入下一轮执行；没有 nextAction 时停止自动循环，避免裁判链路故障变成无限目标迭代 | `references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/target.ts:99-178` |
| 校验故障 | 坏 JSON 和意外工具调用使用 fail-open；请求异常同样 fail-open。函数实际返回 passed=true。异常事件字段却叫 failed_closed，不能仅凭事件标签推断行为 | `references/zcode/apps/zcode-cli/packages/contracts/src/tools/target.ts:289-310,324-332`；`references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts:204-209,266-295` |
| 用户控制 | CLI `/goal` 支持查看、pause、resume、clear、replace；已有 Goal 替换有确认选择。该 handler 未提供 complete/验收通过命令 | `references/zcode/apps/zcode-cli/packages/cli/src/command-center/handlers/goal.ts:30-86` |
| Plan 与 Goal | Plan 模式能记录 Goal，但不自动继续；runtime 也在 getPlanEnabled 时拒绝 continuation candidate | `references/zcode/apps/zcode-cli/packages/cli/src/command-center/handlers/goal.ts:12-13,116-119`；`references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/target.ts:189-200` |
| Todo 与 Goal | TodoWrite 只读写会话 todo 列表及摘要，没有把 Goal 写 complete；todo 是 verifier 消费的历史证据之一 | `references/zcode/apps/zcode-cli/packages/core/src/tool/handlers/todo.ts:47-71`；`references/zcode/apps/zcode-cli/packages/contracts/src/tools/target.ts:240-241` |

## 对 KenFutWork 的建议（工程判断）

- 可借鉴“会话持久 Goal → 正常执行 → 单独校验请求 → 未达成继续”的职责分离；独立评估不要求另一个供应商或固定评估模型。
- 成果类型与验收项已经由用户明确要求，不应因为 ZCode 用自然语言 objective 就撤销；可以由 Agent 提出/提炼，让模型以真实证据判断，无需推导成所有操作目标都必须启动前人工逐项确认。
- 若允许模型验收，必须把“模型判定通过”与“文件/命令证据已验证”和“用户已验收”分开记录。对操作目标，历史中的自述不是文件当前状态的证明。
- 不建议照搬 fail-open 为 complete。评估失败应保留 Goal 进度并呈现评估失败，允许重试或用户验收；不应因评估 JSON/网络错误宣告操作成果完成。

未发现结构化验收清单的自动执行器或必经的人工验收 gate；这是上述具体源码范围的静态结论，不声称覆盖未读取的所有 UI 分支或未公开运行时行为。
