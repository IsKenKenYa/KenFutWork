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

import { conversationRowTargetSchema } from "./core";
import { toolCallDisplaySchema } from "./toolDisplay";
import { amendWorkflowRunSettingsResultSchema } from "./workflow-run-settings-command";
import { WORKFLOW_RUNS_LIMITS, workflowRunSchema } from "./workflow-runs";
import { workspaceHookReviewRequestPayloadSchema } from "./workspace-hook-review";

/* ---------- zcode 照搬（P9 补充）：成员文件 barrel 扩面 ----------
 * attachment-ref（AttachmentRef）、workflow-artifacts（产物类型）、toolDisplay（toolCallDisplaySchema）、
 * workflow-runs（run 图类型）、workflow-run-settings-command / workspace-hook-review（成员文件见同目录）。
 * 许可证：Apache-2.0（zcode）。
 */
export * from "./attachment-ref";
export {
  type ToolCallDisplay,
  toolCallDisplaySchema,
} from "./toolDisplay";
export * from "./workflow-artifacts";
export * from "./workflow-run-settings-command";
export {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunConcurrency,
  type WorkflowRunNode,
  type WorkflowRunsState,
  workflowRunActorSchema,
  workflowRunSchema,
  workflowRunsStateSchema,
} from "./workflow-runs";
export { workspaceHookReviewRequestPayloadSchema } from "./workspace-hook-review";

/* ---------- snapshot.ts 切片（P9 补充，照搬声明） ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol-v4/snapshot.ts
 * 消费方：ConversationTimeline / ConversationTurnGroup / useConversationTimelineFind（phase/apiRetry）、
 * chatLoadingVisibility（activeWorks/pendingInteractions）、sessions-index 会话摘要（meta/phase）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（timestampSchema 已在 ./core；
 * zcodePermission 系列 / zcodeInteractionRequestOrigin 切片来自 zcode-protocol-legacy-types.ts，随块照搬）。
 */

// ── SessionControl ──
export const sessionPhaseSchema = z.enum([
  // draft 裁决保留——纯内存态、sessions-index 可见、无 row、
  // 不落盘、CLI 重启即消失；firstInput 到达 → prewarming/running。
  "draft",
  "prewarming",
  "running",
  "completedSuccess",
  "completedInterrupted",
  "error",
]);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

// ── meta（会话级元信息：标题）。renameSession/自动标题落此。──
export const sessionMetaStateSchema = z.object({
  title: z.string(),
  // default = 未命名；generated = 模型自动生成；custom = 用户显式重命名（不再被自动标题覆盖）。
  titleSource: z.enum(["default", "generated", "custom"]),
});
export type SessionMetaState = z.infer<typeof sessionMetaStateSchema>;

export const apiRetryStateSchema = z.object({
  attempt: z.number(),
  maxAttempts: z.number(),
  nextRetryAt: timestampSchema,
  reasonCode: z.string(),
});
export type ApiRetryState = z.infer<typeof apiRetryStateSchema>;

export const activeWorkSummarySchema = z.object({
  kind: z.enum([
    "primaryTurn",
    "foregroundSubagent",
    "compact",
    "goalVerifier",
    "goalContinuation",
    "turnSteer",
  ]),
  foregroundExecutionId: z.string().min(1).optional(),
  startedAt: timestampSchema,
});
export type ActiveWorkSummary = z.infer<typeof activeWorkSummarySchema>;

// ── pendingInteractions（权限确认 / userInput / workspace Hook review）──
// zcode-protocol-legacy-types.ts 切片（interaction origin / permission response 依赖闭包）。
export const zcodePermissionDecisionSchema = z.enum([
  "allow",
  "deny",
  "escalate",
  "modify",
]);
export const zcodePermissionRuleBehaviorSchema = z.enum([
  "allow",
  "deny",
  "ask",
]);
export const zcodePermissionRuleValueSchema = z
  .object({
    toolName: z.string().trim().min(1),
    ruleContent: z.string().optional(),
  })
  .strict();
export const zcodePermissionUpdateSchema = z
  .object({
    type: z.literal("addRules"),
    behavior: zcodePermissionRuleBehaviorSchema,
    rules: z.array(zcodePermissionRuleValueSchema).min(1),
  })
  .strict();
export const zcodePermissionResponseSchema = z
  .object({
    decision: zcodePermissionDecisionSchema,
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    permissionUpdates: z.array(zcodePermissionUpdateSchema).optional(),
  })
  .strict();
export type ZCodePermissionResponse = z.infer<
  typeof zcodePermissionResponseSchema
>;
export const zcodeInteractionRequestOriginSchema = z
  .object({
    kind: z.literal("subagent"),
    agentId: z.string().trim().min(1),
    agentType: z.string().trim().min(1),
    childSessionId: z.string().trim().min(1),
    childTurnId: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    parentSessionId: z.string().trim().min(1),
    parentToolCallId: z.string().trim().min(1).optional(),
    parentTurnId: z.string().trim().min(1).optional(),
  })
  .strict();
export type ZCodeInteractionRequestOrigin = z.infer<
  typeof zcodeInteractionRequestOriginSchema
>;

export const PERMISSION_FULL_ACCESS_OPTION_ID = "fullAccess";
const permissionOptionSchema = z.object({
  optionId: z.string(),
  label: z.string(),
  kind: z.enum(["allowOnce", "allowAlways", "deny", "custom"]),
  response: zcodePermissionResponseSchema.optional(),
});

export const permissionRequestPayloadSchema = z.object({
  kind: z.literal("permission"),
  toolCallId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  detail: z.unknown(),
  // additive：旧 snapshot 缺省时 UI 不显示反馈输入；V4 新投影可显式开启。
  freeText: z.boolean().optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
  // 工具自报的确认预览，复用 row 的 display 投影（同一有界形状）。缺省 = 纯文本 ask。
  display: toolCallDisplaySchema.optional().catch(undefined),
  // 独立 additive 能力：旧 UI 忽略此字段，仍只显示原 options，不出现半实现授权入口。
  fullAccessOption: permissionOptionSchema
    .extend({
      optionId: z.literal(PERMISSION_FULL_ACCESS_OPTION_ID),
      kind: z.literal("custom"),
    })
    .optional(),
  options: z.array(permissionOptionSchema),
});
export type PermissionRequestPayload = z.infer<
  typeof permissionRequestPayloadSchema
>;

export const userInputOptionPayloadSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
export type UserInputOptionPayload = z.infer<
  typeof userInputOptionPayloadSchema
>;

export const userInputQuestionPayloadSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(userInputOptionPayloadSchema),
  multiSelect: z.boolean().optional(),
});
export type UserInputQuestionPayload = z.infer<
  typeof userInputQuestionPayloadSchema
>;

export const userInputRequestPayloadSchema = z.object({
  kind: z.literal("userInput"),
  prompt: z.string(),
  freeText: z.boolean(),
  options: z
    .array(z.object({ optionId: z.string(), label: z.string() }))
    .optional(),
  // true → 输入框按密码处理，客户端不入草稿/历史。
  sensitive: z.boolean().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  traceId: z.string().optional(),
  input: z.unknown().optional(),
  schema: z.unknown().optional(),
  questions: z.array(userInputQuestionPayloadSchema).optional(),
  currentQuestionIndex: z.number().optional(),
  answerDrafts: z.record(z.string(), z.array(z.string())).optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
});
export type UserInputRequestPayload = z.infer<
  typeof userInputRequestPayloadSchema
>;

export const interactionAutoResolutionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.enum(["hiddenGrace", "visibleCountdown"]),
    startedAt: timestampSchema,
    visibleAt: timestampSchema,
    deadlineAt: timestampSchema,
  }),
  z.object({
    state: z.literal("snoozed"),
    startedAt: timestampSchema,
    snoozedAt: timestampSchema,
  }),
]);
export type InteractionAutoResolution = z.infer<
  typeof interactionAutoResolutionSchema
>;

export const pendingInteractionSchema = z
  .object({
    interactionId: z.string(),
    kind: z.enum(["permission", "userInput", "workspaceHookReview"]),
    // null = 会话级（如 provider 交互和 workspace Hook review）。
    anchorRowId: z.number().nullable(),
    createdAt: timestampSchema,
    autoResolution: interactionAutoResolutionSchema.optional(),
    payload: z.discriminatedUnion("kind", [
      permissionRequestPayloadSchema,
      userInputRequestPayloadSchema,
      workspaceHookReviewRequestPayloadSchema,
    ]),
  })
  .superRefine((interaction, context) => {
    if (interaction.kind !== interaction.payload.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "pending interaction kind must match payload kind",
      });
    }
    if (
      interaction.kind === "workspaceHookReview" &&
      interaction.autoResolution
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoResolution"],
        message: "workspace hook review must not auto-resolve",
      });
    }
  });
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

/* ---------- sessions-index.ts / sessions-index-workflow-activity.ts 切片（P9 补充，照搬声明） ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol-v4/{sessions-index,sessions-index-workflow-activity}.ts
 * 消费方：v4/{taskListRowActivity,mapSessionSummaryToTaskMeta} 与 taskList 展示链
 * （lib/taskListItemPresentation / lib/taskListOrdering）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（派生函数 deriveSessionWorkflowActivity
 * 本仓无消费方，不搬运）。
 */
export const SESSION_WORKFLOW_ACTIVITY_MAX_RUNS = 4;

/** 站点灯的四态，与卡片时间线同一词汇（STATUS_DOT）。 */
export const sessionWorkflowPhaseStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "failed",
]);
export type SessionWorkflowPhaseStatus = z.infer<
  typeof sessionWorkflowPhaseStatusSchema
>;

export const sessionWorkflowPhaseSummarySchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  status: sessionWorkflowPhaseStatusSchema,
  /**
   * 进入本站时仍在跑的其他站的下标（下标落在本 phases 数组上），来自 run.phaseAlongside。
   * 只有声明表那条路有这个事实——退化路（已进入的 phase）是按进入序拼出来的，没有并行可言。
   */
  alongside: z
    .array(z.number().int().nonnegative())
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
});
export type SessionWorkflowPhaseSummary = z.infer<
  typeof sessionWorkflowPhaseSummarySchema
>;

export const sessionWorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /** 发起行的工具调用 id：点击运行行打开 run pane 的键；直接启动的 run 也有（launch- 前缀）。 */
  toolCallId: z.string().min(1).optional(),
  /** 工作流后台工作的标题（= run 的展示名）；投影里没有对应后台工作时缺席。 */
  name: z.string().min(1).optional(),
  status: workflowRunSchema.shape.status,
  stopReason: workflowRunSchema.shape.stopReason,
  /** 后台工作的开始时刻，tooltip 的 elapsed 用；没有后台工作时缺席。 */
  startedAt: timestampSchema.optional(),
  /** 站点表，声明序：run.phaseNames 在场用它，否则退化为已进入的 phase + 当前 phase（进入序）。 */
  phases: z
    .array(sessionWorkflowPhaseSummarySchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPhases),
  currentPhase: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength)
    .optional(),
  /** status === "running" 的子代理数（tooltip 的「{n} agents working」）。 */
  agentsWorking: z.number().int().nonnegative(),
});
export type SessionWorkflowRunSummary = z.infer<
  typeof sessionWorkflowRunSummarySchema
>;

export const sessionWorkflowActivitySchema = z.object({
  runs: z
    .array(sessionWorkflowRunSummarySchema)
    .max(SESSION_WORKFLOW_ACTIVITY_MAX_RUNS),
});
export type SessionWorkflowActivity = z.infer<
  typeof sessionWorkflowActivitySchema
>;

export const sessionPendingInteractionSummarySchema = z.object({
  interactionId: z.string(),
  kind: z.enum(["permission", "userInput"]),
  // 只下发轻量工具身份，侧栏据此区分 AskUserQuestion 与其他阻塞确认；不携带问题或答案。
  toolName: z.string().optional(),
  autoResolution: interactionAutoResolutionSchema.optional(),
});
export type SessionPendingInteractionSummary = z.infer<
  typeof sessionPendingInteractionSummarySchema
>;

export const pendingInteractionSummarySchema = z.object({
  permissionCount: z.number().int().nonnegative(),
  userInputCount: z.number().int().nonnegative(),
});
export type PendingInteractionSummary = z.infer<
  typeof pendingInteractionSummarySchema
>;

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  // fork 树。
  parentSessionId: z.string().optional(),
  title: z.string(),
  // custom = 用户显式重命名；default/generated 都不是产品语义上的手动标题。
  titleSource: sessionMetaStateSchema.shape.titleSource.optional(),
  phase: sessionPhaseSchema,
  sessionEnded: z.boolean(),
  // 列表小圆点用（此处保留布尔，避免为侧栏订阅整个 backgroundWorks）。
  hasBackgroundWork: z.boolean(),
  // 侧栏工作流运行行：有界的 run 摘要。optional 兼容旧 frame / 旧 CLI。
  workflowActivity: sessionWorkflowActivitySchema.optional(),
  pendingInteraction: sessionPendingInteractionSummarySchema.optional(),
  // 侧栏只需要 kind/count，不下发问题、命令或答案等敏感 payload。
  pendingInteractionSummary: pendingInteractionSummarySchema.optional(),
  goalStatus: goalStateSchema.shape.status.optional(),
  // 未读推导：客户端本地记 lastSeenActivityAt 比较（不用 seq，epoch 会重置）。
  lastActivityAt: timestampSchema,
  // ≤120 字符。
  lastAssistantPreview: z.string().optional(),
  createdAt: timestampSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/* ---------- transport.ts 切片（P9 补充，照搬声明） ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol-v4/transport.ts
 * 消费方：v4/{ConversationFileSummaryPanel,ConversationFileRewindDialog,ConversationRowView,
 * conversationRowContext,useAssistantPreviewCardsForRow}（fileChanges / fileRewindPreview）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（conversationRowTargetSchema 已在 ./core）。
 */
const readonlyDiffHunkSchema = z
  .object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileChangesParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileChangesParams = z.infer<
  typeof v4ConversationFileChangesParamsSchema
>;

export const v4ConversationFileChangesResultSchema = z
  .object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    state: z.enum(["active", "reverted"]).optional(),
    items: z.array(
      z
        .object({
          path: z.string().min(1),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          writeCount: z.number().int().nonnegative(),
          toolNames: z.array(z.string()),
          patches: z.array(readonlyDiffHunkSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type V4ConversationFileChangesResult = z.infer<
  typeof v4ConversationFileChangesResultSchema
>;

export const v4ConversationFileRewindPreviewParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    target: conversationRowTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    baseLogEpoch: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationFileRewindPreviewParams = z.infer<
  typeof v4ConversationFileRewindPreviewParamsSchema
>;

const v4WorkspaceFileRewindSafeFileSchema = z
  .object({
    action: z.enum(["restore", "delete"]),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindUnsafeFileSchema = z
  .object({
    currentHash: z.string().optional(),
    expectedHash: z.string().optional(),
    message: z.string().optional(),
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.enum([
      "checkpoint_missing",
      "checkpoint_unreadable",
      "external_modified",
      "file_read_failed",
      "unsupported_checkpoint",
    ]),
    toolNames: z.array(z.string()),
  })
  .strict();

const v4WorkspaceFileRewindIgnoredFileSchema = z
  .object({
    operationCount: z.number().int().nonnegative(),
    path: z.string().min(1),
    reason: z.literal("bash_ignored"),
    toolNames: z.array(z.string()),
  })
  .strict();

export const v4ConversationFileRewindPreviewResultSchema = z
  .object({
    canApply: z.boolean(),
    ignoredFiles: z.array(v4WorkspaceFileRewindIgnoredFileSchema),
    safeFiles: z.array(v4WorkspaceFileRewindSafeFileSchema),
    unsafeFiles: z.array(v4WorkspaceFileRewindUnsafeFileSchema),
  })
  .strict();
export type V4ConversationFileRewindPreviewResult = z.infer<
  typeof v4ConversationFileRewindPreviewResultSchema
>;

/* ---------- command.ts 切片（P9 补充，照搬声明） ----------
 * 来源：references/zcode/packages/shared/src/zcode-protocol-v4/command.ts
 * 消费方：components/workflow-timeline/{workflowRunSettings,WorkflowRunSettingsPopover}、
 * v4/ConversationFileSummaryPanel（CommandAck）。
 * 许可证：Apache-2.0（zcode）。适配注记：逐字照搬符号声明（commandPayloadSchemas /
 * envelope / CommandType 本仓无消费方——v4/commandFactory 属 sessions-index 数据缝，未搬运）。
 */
// ── ACK ──
export const commandResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum([
      "createSession",
      "createSelectionSideSession",
      "forkAssistant",
    ]),
    sessionId: z.string(),
    input: z
      .object({
        delivery: z.enum(["startNow", "queue", "guide"]),
        inputId: z.string(),
        // Core admission ACK 不等待 TurnStarted；messageId 可能由后续事件补齐。
        messageId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resolveInteraction"),
    resolvedBy: z.object({
      clientId: z.string(),
      optionId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("applyFileRewind"),
    applied: z.boolean(),
    preview: v4ConversationFileRewindPreviewResultSchema,
    response: z.string(),
  }),
  z.object({
    type: z.literal("editUserQuery"),
    // fork 仅保留旧 ACK 解码兼容；新 editUserQuery 不再生成 child session。
    disposition: z.enum(["rewind", "fork", "blocked"]),
    sessionId: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    preview: v4ConversationFileRewindPreviewResultSchema.optional(),
  }),
  z.object({
    // startSavedWorkflow accepted ACK：
    // runId 联接启动轮 run 卡状态 / 通知 / 侧板；toolCallId = launch-<uuid>，联接合成 CreateWorkflow 轮。
    type: z.literal("startSavedWorkflow"),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  amendWorkflowRunSettingsResultSchema,
  z.object({
    // messageId 只在 TurnStarted 后作为旁路归因补齐；Core admission ACK 不等待
    // projection commit，不能把 messageId 作为输入 accepted 的必要条件。
    type: z.literal("inputAccepted"),
    delivery: z.enum(["startNow", "queue", "guide"]),
    inputId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    // restart discarded 过去只返回一个无差别 fault，renderer 无法区分
    // runtime-local queue 与仍需人工确认的 startNow。delivery 来自 session_input
    // 持久事实，不能由客户端按当前 UI phase 猜测。
    type: z.literal("inputDisposition"),
    delivery: z.enum(["startNow", "queue", "guide"]),
  }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

export const commandAckSchema = z.object({
  /** 会话创建期采用的 App Memory 开关；旧发送端缺省表示未知。 */
  memoryEnabled: z.boolean().optional(),
  ttftExcluded: z.literal("capacity").optional(),
  commandId: z.string(),
  // accepted 不承诺跨 CLI 进程存活；最终收口以权威数据（sourceCommandId）为准。
  status: z.enum([
    "accepted",
    "rejected",
    "stale",
    "duplicate",
    "noop",
    "failed",
  ]),
  // rejected/stale/noop/failed 必带；= guard id 或 fault code（命名空间）。
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  revisionAtDecision: z.number(),
  // duplicate 回放缓存结果；accepted 亦可即时带（fork）。
  result: commandResultSchema.optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;
