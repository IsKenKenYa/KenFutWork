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
  timestamp: timestampSchema,
});

export const toolStartedEventSchema = z.object({
  type: z.literal("tool.started"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  timestamp: timestampSchema,
});

export const toolCompletedEventSchema = z.object({
  type: z.literal("tool.completed"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  output: z.record(z.string(), z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
  timestamp: timestampSchema,
});

export const runCompletedEventSchema = z.object({
  type: z.literal("run.completed"),
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
export const runCompactedEventSchema = z.object({
  type: z.literal("run.compacted"),
  runId: runIdSchema,
  /** 触发线（token）与它的来源：reserved-output / fraction / fallback。 */
  triggerTokens: z.number().int().positive(),
  triggerSource: z.enum(["reserved-output", "fraction", "fallback"]),
  /** 保留下来的最近消息条数。 */
  keepMessages: z.number().int().positive(),
  timestamp: timestampSchema,
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
  timestamp: timestampSchema,
});

export const canvasSyncEventSchema = z.object({
  type: z.literal("canvas.sync"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const billingErrorCodeSchema = z.enum([
  "insufficient_credits",
  "model_not_accessible",
  "resolution_not_allowed",
  "concurrency_limit",
]);

export type BillingErrorCode = z.infer<typeof billingErrorCodeSchema>;

export const billingErrorEventSchema = z.object({
  type: z.literal("billing.error"),
  runId: runIdSchema,
  timestamp: timestampSchema,
  code: billingErrorCodeSchema,
  message: z.string(),
  // Credits-specific (only for insufficient_credits)
  currentBalance: z.number().optional(),
  requiredAmount: z.number().optional(),
  plan: z.string().optional(),
  dailyClaimed: z.boolean().optional(),
});

export const streamEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  messageDeltaEventSchema,
  thinkingDeltaEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  runCanceledEventSchema,
  runCompletedEventSchema,
  runUsageEventSchema,
  runCompactedEventSchema,
  runHookEventSchema,
  runFailedEventSchema,
  runRetryingEventSchema,
  canvasSyncEventSchema,
  billingErrorEventSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
