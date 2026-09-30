/**
 * zcode 照搬（P2 补充）：`@zcode/shared/zcode-protocol-v4` 子路径的消费切片 barrel。
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：上游为 index.ts 全量 `export *`；此处只 barrel 本仓 zcode 照搬件实际消费的
 * 符号面（toolResultDisplay / execute renderer / fileSummaryTypes / v4 conversationCuaGroups
 * / toolCallRowAdapter / conversationTurnFlowItems），成员文件逐字照搬见同目录。
 */

import { z } from "zod";
import { timestampSchema } from "./core";
import {
  conversationInputDispatchSchema,
  conversationInputIntentSchema,
} from "./input-intent";

export {
  type ModelSelection,
  modelSelectionSchema,
} from "../../zcode-shared";
export { bashOutputDisplaySchema } from "./bash-output-display";
export * from "./core";
export {
  type ToolCallCreateWorkflowCausalityGraph,
  type ToolCallCreateWorkflowDisplay,
  toolCallCreateWorkflowDisplaySchema,
} from "./create-workflow-display";
export * from "./cuaPermission";
export {
  type ExecutionOutputPreview,
  executionOutputPreviewSchema,
} from "./execution-output-preview";
export * from "./rows";
export {
  type ToolCallEvalWorkflowSnippetDisplay,
  type ToolCallGetWorkflowRunDisplay,
  type ToolCallListModelsDisplay,
  type ToolCallListWorkflowRunsDisplay,
  type ToolCallResumeWorkflowRunDisplay,
  type ToolCallSavedWorkflowListDisplay,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
} from "./workflow-observation-display";
export type { WorkflowRunState } from "./workflow-runs";

/* ---------- snapshot.ts 的 queue 切片（P6 补充，照搬声明） ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts
 * 消费方：v4/ConversationQueuePanel（queueStateSchema/QueueState）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（input-intent 切片见同目录 input-intent.ts）。
 */

export {
  type ConversationInputIntent,
  conversationInputDeliverySchema,
  conversationInputDispatchSchema,
  conversationInputIntentSchema,
  conversationInputOrderSchema,
  conversationInputSteerSchema,
} from "./input-intent";

// ── queue（不持久化，裁决：CLI 进程死亡即丢，客户端对账后由用户决定重发）──
export const queueItemSchema = conversationInputIntentSchema.extend({
  dispatch: conversationInputDispatchSchema.extend({
    state: z.enum(["queued", "reserved", "promoting"]),
  }),
  toolDisallowlist: z.array(z.string().min(1)).optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const queueStateSchema = z.object({
  items: z.array(queueItemSchema),
  // stop 后 = false（暂停队列）；setAutoDrain 恢复。
  autoDrain: z.boolean(),
  // additive：旧快照缺省时 UI 使用通用暂停文案；Stop/TurnError 可显示原因文案。
  pauseReason: z.enum(["stopped", "manual", "error"]).optional(),
});
export type QueueState = z.infer<typeof queueStateSchema>;

/* ---------- snapshot.ts 的 errorAttribution 切片（P5 补充，照搬声明） ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts
 * 消费方：lib/zcodeUiError.ts（ZCodeError → errorAttributionSchema.parse）。 */

export const errorAttributionSchema = z
  .object({
    source: z.enum(["provider", "runtime", "tool", "network"]).optional(),
    reason: z.string().min(1).max(160).optional(),
    errorPhase: z
      .enum([
        "prepare",
        "configuration",
        "connect",
        "response",
        "stream",
        "parse",
        "validation",
        "unhandled",
      ])
      .optional(),
    exceptionKind: z
      .enum([
        "api_call",
        "generic",
        "protocol",
        "provider_business",
        "transport",
        "type_error",
        "validation",
      ])
      .optional(),
    providerId: z.string().min(1).max(160).optional(),
    modelId: z.string().min(1).max(160).optional(),
    providerKind: z.string().min(1).max(160).optional(),
    transport: z.enum(["http", "sse", "websocket"]).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    providerErrorCode: z.string().min(1).max(160).optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type ErrorAttribution = z.infer<typeof errorAttributionSchema>;

/* ---------- snapshot.ts 的 backgroundWorks / runningSubagent / goal / plan 切片（P6 补充，照搬声明） ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts
 * 消费方：v4/ConversationStatusPanel / conversationStatusPanelModel / conversationGoalSummaryModel
 * / v4/workflowRunCardJoin 依赖面（BackgroundWorkSummary 摘要与 goal/plan 状态）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（timestampSchema 已在 ./core）。
 */

export const backgroundWorkSummarySchema = z.object({
  workId: z.string(),
  // workflow = workflow run（CreateWorkflow）。**闭集加值的偏斜代价**：
  // 旧桌面收到未知值时整个 state.updated patch 解析失败（已知键的非法值是错误，不是剥离），
  // 于是整帧被 assembler 拒收，且 resync 的 snapshot 携带同一个值、同样失败——不能优雅降级。
  // CLI 与桌面同批发布才使它可接受。
  kind: z.enum(["bash", "subagent", "workflow"]),
  title: z.string(),
  // resultPending = 已完成、结果在 continuation inbox 等待前台空闲；
  // 投递后条目消失（结果本体成为 origin=backgroundResult 的 userInput row）。
  status: z.enum(["running", "resultPending", "failed", "cancelled"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  cancellable: z.boolean().optional(),
  blocked: z.boolean().optional(),
  anchorRowId: z.number().nullable(),
  childSessionId: z.string().optional(),
});
export type BackgroundWorkSummary = z.infer<typeof backgroundWorkSummarySchema>;

// subagent 运行态属于 conversation 权威投影，而不是 renderer 查询缓存。
// ended 详情保持 cursor query；snapshot 只携带目录总数，避免运行中并发数量依赖查询时序。
export const runningSubagentSummarySchema = z.object({
  childSessionId: z.string(),
  agentId: z.string().optional(),
  toolCallId: z.string().optional(),
  subagentType: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  status: z.enum(["running", "waiting", "blocked"]),
  startedAt: timestampSchema.optional(),
});
export type RunningSubagentSummary = z.infer<
  typeof runningSubagentSummarySchema
>;

// ── goal / plan ──
export const planItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "inProgress", "completed"]),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const goalIterationStateSchema = z.object({
  iteration: z.number().int().positive(),
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type GoalIterationState = z.infer<typeof goalIterationStateSchema>;

export const goalStateSchema = z.object({
  // default 仅用于旧快照兼容；新投影始终携带当前 target 身份和计时事实。
  targetId: z.string().default(""),
  objective: z.string(),
  summaryTitle: z.string().nullable().default(null),
  timeUsedSeconds: z.number().int().nonnegative().default(0),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().default(null),
  // paused：stop 作用于任何 foreground work 时 target 强制进入（stopPausesActiveGoalTarget）。
  // notSatisfied 与 failed 分离：前者是有效结论，后者是验证过程失败。
  status: z.enum([
    "active",
    "paused",
    "verifying",
    "verified",
    "notSatisfied",
    "failed",
  ]),
  iteration: z.number(),
  verifications: z.array(
    z.object({
      iteration: z.number(),
      outcome: z.enum(["pass", "notSatisfied", "failed"]),
      at: timestampSchema,
      anchorRowId: z.number().nullable(),
      reason: z.string().optional(),
      nextAction: z.string().optional(),
    }),
  ),
  iterations: z.array(goalIterationStateSchema).default([]),
});
export type GoalState = z.infer<typeof goalStateSchema>;

export const planStateSchema = z.object({
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type PlanState = z.infer<typeof planStateSchema>;
