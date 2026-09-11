import { z } from "zod";

/**
 * 能力层共享契约（《改造计划》§5）：工具注册表条目、执行模式、权限档位、
 * agent-run 事件、用量记录。kernel 侧类型在 apps/server/src/kernel/types.ts，
 * 本文件是跨端（前端可见）的 zod 单一事实源。
 */

// --- 工具注册表条目（模型可见的目录描述） ---

export const toolScopeSchema = z.enum(["design", "code", "shared"]);
export type ToolScope = z.infer<typeof toolScopeSchema>;

export const toolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  scope: toolScopeSchema,
  /** 模型可见的 JSON Schema 参数描述。 */
  parameters: z.record(z.string(), z.unknown()),
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

export const toolListResponseSchema = z.object({
  tools: z.array(toolDescriptorSchema),
});
export type ToolListResponse = z.infer<typeof toolListResponseSchema>;

// --- 执行模式（DEC-3：v1 只实现 agent + plan，词汇表开放） ---

export const executionModeSchema = z.enum([
  "agent",
  "plan",
  "goal",
  "loop",
  "solo",
]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

// --- 权限档位（DEC-4：code 模式默认 default 档） ---

export const permissionTierSchema = z.enum([
  "default",
  "auto-approve",
  "full-access",
]);
export type PermissionTier = z.infer<typeof permissionTierSchema>;

export const toolPreExecuteDecisionSchema = z.enum(["allow", "deny"]);
export type ToolPreExecuteDecision = z.infer<
  typeof toolPreExecuteDecisionSchema
>;

// --- agent-run 事件缝（DEC-1：只 3 个事件，新增须评审） ---

export const agentRunEventNameSchema = z.enum([
  "pre-step",
  "tool-pre-execute",
  "turn-stopping",
]);
export type AgentRunEventName = z.infer<typeof agentRunEventNameSchema>;

// --- 用量记录（DEC-6：BYOK v1 必备；credits 关闭后是唯一计量） ---

export const usageRecordSchema = z.object({
  workspaceId: z.string().min(1),
  providerInstanceId: z.string().min(1).optional(),
  /** 目录来源名（如 "openai-compatible"），实例缺失时兜底标识。 */
  provider: z.string().min(1),
  model: z.string().min(1),
  capability: z.enum(["chat", "image", "video"]),
  /** agent 链路关联 runId；直连生成链路关联 jobId。两处采集落同一张表。 */
  runId: z.string().optional(),
  jobId: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  occurredAt: z.string().min(1),
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const usageSummaryResponseSchema = z.object({
  totals: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  byModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      capability: z.enum(["chat", "image", "video"]),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative().optional(),
    }),
  ),
});
export type UsageSummaryResponse = z.infer<typeof usageSummaryResponseSchema>;
