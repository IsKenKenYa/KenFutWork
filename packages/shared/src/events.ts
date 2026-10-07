import { z } from "zod";

import { toolArtifactSchema } from "./artifacts.js";
import {
  conversationIdSchema,
  messageIdSchema,
  runIdSchema,
  sessionIdSchema,
  timestampSchema,
  toolCallIdSchema,
} from "./contracts.js";
import { kenfutworkErrorSchema } from "./errors.js";
import { taskWorkStateSchema } from "./execution-contracts.js";

export type {
  ImageArtifact,
  Placement,
  ToolArtifact,
  VideoArtifact,
} from "./artifacts.js";
export {
  imageArtifactSchema,
  placementSchema,
  toolArtifactSchema,
  videoArtifactSchema,
} from "./artifacts.js";

export const runStartedEventSchema = z.object({
  type: z.literal("run.started"),
  runId: runIdSchema,
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  timestamp: timestampSchema,
});

export const messageDeltaEventSchema = z.object({
  type: z.literal("message.delta"),
  runId: runIdSchema,
  messageId: messageIdSchema,
  delta: z.string(),
  /** 子代理内部正文：按 agentCallId 路由到子代理视图，不进主对话流。 */
  agentName: z.string().min(1).optional(),
  agentCallId: z.string().min(1).optional(),
  timestamp: timestampSchema,
});

export const toolStartedEventSchema = z.object({
  type: z.literal("tool.started"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  /**
   * 子代理归因（DEC-19）：该工具调用发生在哪个具名子代理里。
   * 来源是 langchain run metadata 的 `lc_agent_name`（`parent_ids` 在
   * @langchain/core 1.x 不存在，归因只能走 metadata）；主 agent 的调用缺省。
   */
  agentName: z.string().min(1).optional(),
  /**
   * 派发调用 id（父 run 里 task/task_background 的 toolCallId）：子代理内部
   * 事件按它路由到对应子代理视图（zcode 右栏模型），不进主对话流。
   */
  agentCallId: z.string().min(1).optional(),
  timestamp: timestampSchema,
});

export const toolCompletedEventSchema = z.object({
  type: z.literal("tool.completed"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  output: z.record(z.string(), z.unknown()).optional(),
  /** 完整文本结果，与结构化 output 分开保留，不能用摘要代替正文。 */
  outputText: z.string().optional(),
  /** 权威工具终态；Code renderer 不得从摘要文案猜成功或失败。 */
  status: z.enum(["success", "error", "cancelled"]).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
  /** 子代理归因，同 {@link toolStartedEventSchema.agentName}。 */
  agentName: z.string().min(1).optional(),
  /** 派发调用 id，同 {@link toolStartedEventSchema.agentCallId}。 */
  agentCallId: z.string().min(1).optional(),
  timestamp: timestampSchema,
});

/**
 * 后台任务终态通知（DEC-15）：后台子代理 / 长命令结算后发一次。
 *
 * 定位是「模型可见 + 用户可见」的同一份事实：服务端把它注入下一轮模型输入
 * （`<task-notification>` 包裹的 user 消息），同时经本事件推给前端渲染成
 * 静默通知行。只有**终态**（completed/failed/canceled）才发——运行中进度走
 * 既有 tool.* 事件，不在这里重复。
 */
export const taskNotificationEventSchema = z.object({
  type: z.literal("task.notification"),
  runId: runIdSchema,
  /** 后台任务 id（run 内唯一，`task_` 前缀）。 */
  taskId: z.string().min(1).max(128),
  kind: z.enum(["subagent", "command"]),
  /** 展示名：子代理为「名字 · 任务描述」，命令为命令行。 */
  label: z.string().min(1).max(2_000),
  status: z.enum(["completed", "failed", "canceled"]),
  /** 结果摘要（已截断，模型与用户看到的是同一份）。 */
  summary: z.string().min(1).max(8_000),
  /** 失败时的下一步建议（DEC-17：失败带恢复指引）。 */
  nextStep: z.string().max(2_000).optional(),
  /** 派发调用 id：后台子代理结算时据此关掉对应目录条目。 */
  agentCallId: z.string().min(1).optional(),
  timestamp: timestampSchema,
});

export const taskWorkUpdatedEventSchema = z.object({
  type: z.literal("task.work"),
  runId: runIdSchema,
  work: taskWorkStateSchema,
  timestamp: timestampSchema,
});

export const runCompletedEventSchema = z.object({
  type: z.literal("run.completed"),
  operationResult: z
    .object({
      kind: z.literal("compact"),
      origin: z.literal("manual"),
      status: z.enum(["applied", "unchanged"]),
      reason: z.literal("insufficient_history").optional(),
    })
    .optional(),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

/**
 * 本轮模型的用量快照（每次「一次新的模型调用」发一次，值均为**累计**口径）。
 *
 * 用途是「上下文容量 / 缓存命中」浮层（R4-1）：容量 = `inputTokens` 与模型目录里
 * `contextWindow` 之比；缓存命中 = `cachedInputTokens / inputTokens`。
 * `cachedInputTokens` 只在**上游确实上报**时出现（部分网关不返回 prompt 缓存字段）——
 * 缺省时客户端显示「上游未上报」，不拿 0 冒充。
 */
export const runUsageEventSchema = z.object({
  type: z.literal("run.usage"),
  runId: runIdSchema,
  /** SDK实际模型调用身份；同一次stream/end累计更新共用此键。 */
  modelCallId: z.string().min(1).optional(),
  /** 本次模型调用的提示词大小（一轮里随工具结果增长）。 */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** 本次调用命中缓存的输入 token；上游不报时为 undefined（不拿 0 冒充）。 */
  cachedInputTokens: z.number().int().nonnegative().optional(),
  /**
   * 本轮 run **累计**的输入 token（历次模型调用求和）。
   *
   * 「平均缓存命中率」要用它做分母：命中率 = 累计命中 ÷ 累计输入（按 token 加权），
   * 不是各次百分比的算术平均——短调用多的一轮里，后者会把命中率算虚高。
   * 与 `inputTokens` 一起下发，客户端不必自己累加，断线重连后也能立刻拿到正确分母。
   */
  runInputTokens: z.number().int().nonnegative().optional(),
  /** 本轮各模型调用的累计输出token；由同一调用账本导出。 */
  runOutputTokens: z.number().int().nonnegative().optional(),
  /** 本轮 run 累计命中缓存的输入 token；一次都没上报时为 undefined。 */
  runCachedInputTokens: z.number().int().nonnegative().optional(),
  /**
   * 上下文容量的**分类占比**（R4-1 浮层的那一栏）：按模型实际输入的**字符数**分段。
   * 口径是字符数而不是 token——上游不提供分类 token，编不出来（界面会写明）。
   * 段名由服务端给（系统提示词 / 消息 / 技能 / MCP 工具 / 系统工具 / 其他）。
   */
  composition: z
    .array(
      z.object({
        label: z.string().min(1),
        chars: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  timestamp: timestampSchema,
});

/**
 * 上下文**自动压缩**发生了（R4-1「输出预留线」的执行面，见 server `agent/auto-compact.ts`）。
 *
 * 为什么要有这个事件：压缩改变的是**模型看到的上下文**，而用户转录（库里）保持完整——
 * 两者本来就会不一致。不给信号的话，用户只会觉得「模型突然忘了前面的事」。事件每轮最多发一次，
 * 客户端据此在转录里插一行说明（被压掉的消息原文在 `historyPath`）。
 */
export const runCompactedEventSchema = z
  .object({
    type: z.literal("run.compacted"),
    origin: z.enum(["auto", "manual"]).optional(),
    runId: runIdSchema,
    /** 触发线（token）与它的来源：reserved-output / fraction / fallback。 */
    triggerTokens: z.number().int().positive().optional(),
    triggerSource: z
      .enum(["reserved-output", "fraction", "fallback"])
      .optional(),
    /** 本次摘要配置的近期原始消息保留目标；不是 SDK 实际保留条数。 */
    keepMessages: z.number().int().positive(),
    timestamp: timestampSchema,
  })
  .superRefine((event, ctx) => {
    if (
      event.origin !== "manual" &&
      (event.triggerTokens === undefined || event.triggerSource === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "自动压缩必须携带实际触发策略。",
      });
  });

/**
 * 用户钩子跑过了（R5-2「钩子」）。事件在每个钩子点**逐条**发，退出码与输出摘要如实带上。
 *
 * 为什么要有：钩子跑在服务端的工作目录里，用户看不到终端——不给信号就等于「配了不知道跑没跑」。
 * 钩子失败**不影响本轮**（旁路），所以这个事件不是错误事件。
 */
export const runHookEventSchema = z.object({
  type: z.literal("run.hook"),
  runId: runIdSchema,
  event: z.enum(["turn-start", "turn-end"]),
  command: z.string().min(1),
  /** 被超时杀掉时为 null。 */
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  /** 输出摘要（已截断）。 */
  output: z.string(),
  durationMs: z.number().int().nonnegative(),
  timestamp: timestampSchema,
});

export const runCanceledEventSchema = z.object({
  type: z.literal("run.canceled"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const runFailedEventSchema = z.object({
  type: z.literal("run.failed"),
  runId: runIdSchema,
  error: kenfutworkErrorSchema,
  timestamp: timestampSchema,
});

/**
 * 失败后自动重试（服务端行为，判定见 apps/server/src/agent/run-retry.ts）。
 *
 * 客户端据它丢弃上一轮已流出的半截内容并提示进度——否则重试产生的新内容会**续写**在
 * 失败那轮的残句之后，读起来是乱的。`runId` 是**新**一轮的 id（客户端据此更新跟踪值）。
 */
export const runRetryingEventSchema = z.object({
  type: z.literal("run.retrying"),
  runId: runIdSchema,
  /** 即将开始的尝试序号（2 = 首次失败后重试）。 */
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1),
  reason: z.string(),
  timestamp: timestampSchema,
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal("thinking.delta"),
  runId: runIdSchema,
  messageId: messageIdSchema,
  delta: z.string(),
  /** 子代理内部思考：路由同 {@link messageDeltaEventSchema.agentCallId}。 */
  agentName: z.string().min(1).optional(),
  agentCallId: z.string().min(1).optional(),
  timestamp: timestampSchema,
});

export const canvasSyncEventSchema = z.object({
  type: z.literal("canvas.sync"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

/**
 * flow 运行事件（P5，《flow 集成方案》事件缝）。
 *
 * 定位：flow 网关（独立子系统）把 run 事件经宿主回调（`POST /api/flow/host/events`）
 * 透出后，宿主**原样转发到本仓 WS 通道**——flow 自己的事件词汇表是移动靶
 * （Dify SSE 事件随引擎版本演进，`DEC-13` 不锁版本），故这里不做逐事件镜像，
 * 统一包一层 `flowRun.event`：`eventType` 保留 flow 侧的原类型名，`payload` 原样携带。
 *
 * `seq` 是 **run 内**单调序号（flow 侧生成），宿主侧不重排——客户端据此去重/续传
 * （宿主侧 WS 信封自身不带 seq，断线重连会全量重放，见 ws 层的 lastSeq 口径）。
 */
export const flowRunEventSchema = z.object({
  type: z.literal("flowRun.event"),
  /** flow 的 run id（宿主不解析，只透传）。 */
  runId: z.string().min(1).max(128),
  /** run 内单调序号（flow 侧生成）。 */
  seq: z.number().int().min(1),
  /** flow 侧原事件类型名（如 `workflow_started` / `node_finished` / `workflow_finished`）。 */
  eventType: z.string().min(1).max(128),
  /** flow 侧原始载荷（原样携带，宿主不解释）。 */
  payload: z.unknown(),
  /** 事件产生时间（flow 侧，ISO 字符串）。 */
  at: z.string().min(1).max(64),
  timestamp: timestampSchema,
});

export const streamEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  messageDeltaEventSchema,
  thinkingDeltaEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  taskNotificationEventSchema,
  taskWorkUpdatedEventSchema,
  runCanceledEventSchema,
  runCompletedEventSchema,
  runUsageEventSchema,
  runCompactedEventSchema,
  runHookEventSchema,
  runFailedEventSchema,
  runRetryingEventSchema,
  canvasSyncEventSchema,
  flowRunEventSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
