# Kimi 与 DSH 目标及完成判定源码核对

核对日期：2026-10-13。范围：仓库现有参考源码；只读研究，没有运行模型、测试或桌面验收。路径均相对本仓库根目录。结论仅适用于下列提交，不外推到其他版本或闭源产品。

| 参考 | 当前 HEAD |
| --- | --- |
| `references/kimi-code` | `3395f5bea6c77feb6a835d1ca3f4935970f96c6b` |
| `references/deepseek-harness` | `d743267388641bc76f17c45ce8b4c231aed1d32c` |

## 结论

两者都有持久同会话 Goal 与自动续轮，而非仅有 plan/todo。默认完成判定来自当前执行模型的显式工具调用。提示词要求核对实际状态和验证结果；被核对的完成路径没有独立模型评估、必须提交结构化证据或必须等待用户最终验收的实现。Kimi 有可选的文字完成标准与创建前审批；不能将创建审批当作成果验收。DSH 的 hard guard 主要约束调用身份、目标修订与调度竞争，不验证客观成果。

## Kimi Code

1. **持久 Goal 与完成标准。** `GoalSnapshot` 含 objective、可选 completionCriterion、状态、turn/token/time 用量；`GoalCreate`、`GoalUpdate`、`GoalClear` 明确 `durable = true`。来源：`references/kimi-code/packages/agent-core-v2/src/features/goal/types.ts:24-34`；`references/kimi-code/packages/agent-core-v2/src/features/goal/goalOps.ts:41-108`。
2. **标准不是强制结构化验收项。** CreateGoal 输入将 objective 描述为必须有可验证终态，completionCriterion 为 optional string，用户提供时才带入；不存在文件、命令或成果类型的强制 schema。来源：`references/kimi-code/packages/agent-core-v2/src/features/goal/tools/create-goal/create-goal.ts:6-18`。
3. **模型直接决定完成。** UpdateGoal 输入只有 status；执行 `complete` 分支直接调用 `markComplete({}, 'model')`，随后停止当前 Turn 并生成总结提示。服务只检查当前 active Goal，写 complete 事件、发通知、清除 current Goal，没有评估模型调用或文件/命令验证。来源：`references/kimi-code/packages/agent-core-v2/src/features/goal/tools/update-goal/update-goal.ts:6-14`；`references/kimi-code/packages/agent-core-v2/src/features/goal/tools/update-goal/updateGoalTool.ts:59-75`；`references/kimi-code/packages/agent-core-v2/src/features/goal/goalService.ts:425-445`。
4. **证据是提示约束。** UpdateGoal 文案要求所有显式要求满足、验证通过，弱或间接证据不能算完成，计划/总结/初稿不算完成；但工具没有 evidence 参数，也没有对应自动验证器。来源：`references/kimi-code/packages/agent-core-v2/src/features/goal/tools/update-goal/update-goal.md:3-7`。
5. **Turn 正常结束不等于 Goal 完成。** `handleTurnEnded` 对 active、未超预算 Goal 调用 `launchContinuationTurn`；异常 Turn 另行处理。持久状态重放后，active Goal 改 paused，completed Goal 清 current 状态，避免重启后擅自执行。来源：`references/kimi-code/packages/agent-core-v2/src/features/goal/goalService.ts:612-644,790-809`。
6. **创建前用户审批，非最终验收。** 非 auto 权限模式显示 `goal_start`（objective + completionCriterion），GoalService 请求工具审批并可变更执行权限模式；auto 模式不显示此审批。来源：`references/kimi-code/packages/agent-core-v2/src/features/goal/tools/create-goal/createGoalTool.ts:60-68`；`references/kimi-code/packages/agent-core-v2/src/features/goal/goalService.ts:1134-1153`。UpdateGoal 也带通用 `approvalRule`，但这不是独立的成果检查或完成验收协议：`references/kimi-code/packages/agent-core-v2/src/features/goal/tools/update-goal/updateGoalTool.ts:44-68`。
7. **Plan/Todo 要分开。** Todo 仅 title + pending/in_progress/done 的模型维护列表；ExitPlanModeReview 是执行前用户审阅，批准后退出 plan mode 并把计划交回模型执行，不是检查 Goal 是否达成。来源：`references/kimi-code/packages/agent-core-v2/src/features/todo/tools/todo-list/todo-list.ts:7-22`；`references/kimi-code/packages/agent-core-v2/src/features/plan/exitPlanModeReview.ts:26-79`。

## DeepSeek Harness

1. **持久同会话 Goal。** Goal 定义 objective、phase、maxGoalRounds、id/revision；每次 durable mutation 增 revision，`goal/change` 写入 Session。activation 独立为进程内 armed/disarmed，不随持久快照恢复执行授权。来源：`references/deepseek-harness/packages/goal/goal/src/types.ts:19-31,44-69,71-99`；`references/deepseek-harness/packages/goal/goal/src/index.ts:608-625`。
2. **插件分层。** Goal domain、model tools、goal-round-driver 分别承担状态、模型工具和同会话续轮。driver 仅在 agent idle、无竞争提示时推进；先 flush session 后重查状态，再为 active + armed Goal 排队一个 followup。超过 round cap 标 blocked，不标 complete。来源：`references/deepseek-harness/packages/goal/goal-round-driver/src/index.ts:18-19,102-109,137-192`。
3. **模型自报完成。** `update_goal` complete 分支直接调用 `ctx.goals.complete(agent, ref)`；service 将 active/paused/blocked 转 complete + disarmed，不调用模型评估或成果检查。输入含 goal_id/revision/action/替换 objective/轮数/blocked_reason，没有完成 evidence。来源：`references/deepseek-harness/packages/goal/tool-goal/src/index.ts:234-253,291-331`；`references/deepseek-harness/packages/goal/goal/src/index.ts:384-399`。
4. **hard guard 核对权限和版本。** 工具要求 exact live calling agent；complete/blocked 必须位于直接用户的 root turn 或精确匹配当前 Goal 的自动 Round。id/revision 提供 compare-and-set；这确保调用归属，不证明任务完成。来源：`references/deepseek-harness/packages/goal/tool-goal/src/authority.ts:48-60,80-117`；`references/deepseek-harness/packages/goal/tool-goal/src/index.ts:144-153`。
5. **证据检查仍由执行模型完成。** 续轮提示要求以工作区、工具结果与持久状态为权威，完成前收集整个 objective 已达成的证据，然后 get_goal / mark complete；并无证据强制 schema。来源：`references/deepseek-harness/packages/goal/goal-round-driver/src/prompt.ts:12-25`。
6. **用户可控制生命周期，未发现默认人工完成验收流程。** `/goal` 提供 create/edit/pause/resume/clear；GoalBar 的 props 是 onEdit/onPause/onResume/onClear，complete Goal 不显示。service 的 Remote complete 能供宿主调用，但能力存在不等于默认 UI 要求人类逐次验收。来源：`references/deepseek-harness/packages/goal/command-goal/src/index.ts:16-24,144-170`；`references/deepseek-harness/packages/client/ui-goal/src/client/GoalBar.tsx:23-29,42,85-86`；`references/deepseek-harness/packages/goal/goal/src/index.ts:390-399`。
7. **Todo 不等于跨 Run Goal。** todo_write 的描述是多步进度列表；最新列表在 turn/start 被清空，turn/end 保留用于显示。来源：`references/deepseek-harness/packages/todo/tool-todo/src/index.ts:45-66,117-130`。Goal 则由独立持久域与 driver 续轮。

## 对 KenFutWork 的建议（设计判断，尚未拍板）

- 可以保留模型作为默认完成判断者；上游并未要求所有 Goal 启动前逐项人工确认。明确成果类型与验收项仍是本项目已经确认的产品要求，不应因上游较宽松而撤销。
- 将「验收标准由谁提出」「谁判定完成」「是否必须人工确认」拆开。Agent 可以根据用户目标提出可检查项；是否必须确认应是明确的产品政策，不能把当前讨论误写成已同意的硬约束。
- 操作 Goal 可允许模型依据服务端记录的工具、文件和命令结果判定达成；文字 Goal 可依据可引用成果判定。仅有一句“完成了”不能替代相应成果。独立评估 Agent 或用户验收可作为确实需要时的路径，当前参考源码未提供必须采用它们的依据。
- 最值得复用的方向是持久 Goal + 独立续 Run driver + exact goal/revision fence + 错误/审批/恢复控制；不要用 stop_reason 或 todo 全 done 推导 Goal 已完成。

## 核对限制

未运行上游产品，因此不声称其实际 UI/模型行为一定满足提示词。未发现独立完成评估仅限上述 Goal 的实际完成调用链；DSH experimental auto-review 属于工具动作授权审查，不可混为 Goal 成果验收。CodeGraph 调用返回本仓库不可查询，后续以定向源码搜索与行号读取完成核对。
