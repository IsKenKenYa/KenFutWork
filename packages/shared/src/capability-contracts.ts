import { z } from "zod";

/**
 * 能力层共享契约（《改造计划》§5）：工具注册表条目、权限档位、
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

// 执行方式枚举：会话级工作方式（自主/计划/对话/目标/创造），
// 由 `/api/execution-modes` 持久化到线程，run 接纳时冻结并传给 pre-step 与工具策略。
export const executionModeSchema = z.enum([
  "agent",
  "plan",
  "goal",
  "loop",
  "solo",
  "creative",
]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

/** 无人值守轮次（目标/循环）使用「自动化任务」审批场景。 */
export function isAutomationExecutionMode(mode: ExecutionMode): boolean {
  return mode === "goal" || mode === "loop";
}

// --- 权限档位（DEC-4：code 模式默认 default 档；R5-3 补第 4 档「自定义配置」） ---

export const permissionTierSchema = z.enum([
  "default",
  "auto-approve",
  "full-access",
  /**
   * 第 4 档「自定义配置」（参考图 `agent-设置-权限.png`）：按下面的 `permissionRules`
   * 逐条判——`deny` 命中即拒、`allow` 命中即放，都没命中回落 default 档的规则。
   */
  "custom",
]);

/**
 * 自定义配置的规则表。名字支持两种写法：
 * - 精确名（`execute`、`mcp__py-helper__echo`）；
 * - 前缀通配（`mcp__*` = 所有 MCP 工具、`write_*`）。
 * 判定顺序固定为 **deny → allow → default 档兜底**（拒绝优先，避免「放行表写宽了」把危险工具带出去）。
 */
export const permissionRuleSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((rule) => !rule.includes("**"), "通配只支持一个 * 且只能在末尾");

export const permissionRulesSchema = z.object({
  deny: z.array(permissionRuleSchema).max(200).default([]),
  allow: z.array(permissionRuleSchema).max(200).default([]),
});
export type PermissionRules = z.infer<typeof permissionRulesSchema>;

/**
 * 三态规则的动作（参考 WorkBuddy 安全中心）：
 * - `allow`：直接放行，不再问；
 * - `ask`：交给人审批（现在 `deny` 的行为）；
 * - `deny`：直接拒绝，连审批机会都不给。
 *
 * 旧的两张表（`rules.deny` / `rules.allow`）继续按 deny-first 判，语义不变：
 * `deny` 表命中即审批阻断（= ask），`allow` 表命中即放行。三态表是它的替代形态，
 * 允许同一工具名显式写成「拒绝」而不只是「需审批」。
 */
export const permissionRuleActionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionRuleAction = z.infer<typeof permissionRuleActionSchema>;

/** 一条三态规则：匹配式 + 动作。匹配式与 `permissionRuleSchema` 同一写法。 */
export const permissionPolicyRuleSchema = z
  .object({
    pattern: permissionRuleSchema,
    action: permissionRuleActionSchema,
  })
  .strict();
export type PermissionPolicyRule = z.infer<typeof permissionPolicyRuleSchema>;

/**
 * 工具启停：被禁用的工具在执行前**直接拦截**，不进入审批。
 * 存的是匹配式（支持 `mcp__*` 前缀），便于整组关闭 MCP 服务。
 */
export const permissionDisabledToolsSchema = z
  .array(permissionRuleSchema)
  .max(500)
  .default([]);

/**
 * 路径规则（参考 WorkBuddy 的「文件安全」）：按路径前缀配三态动作。
 *
 * 只按**前缀**匹配，不做通配符：路径通配（`**`、`?`）会让人误判覆盖面，
 * 前端也难解释「这条规则到底管到哪些文件」。前缀匹配的口径是「这个目录/文件及其下层」。
 */
export const permissionPathRuleSchema = z
  .object({
    path: z.string().min(1).max(4096),
    action: permissionRuleActionSchema,
  })
  .strict();
export type PermissionPathRule = z.infer<typeof permissionPathRuleSchema>;

/**
 * 命令规则：按命令**前缀**配三态动作（与 WorkBuddy 的「命令安全」同口径）。
 * 匹配的是执行命令的规范化首段，例如 `rm ` / `git push`。
 */
export const permissionCommandRuleSchema = z
  .object({
    prefix: z.string().min(1).max(500),
    action: permissionRuleActionSchema,
  })
  .strict();
export type PermissionCommandRule = z.infer<typeof permissionCommandRuleSchema>;

/**
 * 工具策略：三态规则表 + 禁用清单 + 路径/命令规则。
 *
 * 判定顺序（拒绝优先，全部在档位之前）：
 * 1. 命中禁用清单 → 硬拒绝；
 * 2. 工具三态规则按表内顺序取第一条命中；
 * 3. 文件/命令规则按表内顺序取第一条命中（前缀匹配）；
 * 4. 都没命中 → 回落档位判定（与改造前完全一致）。
 */
export const permissionPolicySchema = z.object({
  rules: z.array(permissionPolicyRuleSchema).max(500).default([]),
  disabledTools: permissionDisabledToolsSchema,
  pathRules: z.array(permissionPathRuleSchema).max(500).default([]),
  commandRules: z.array(permissionCommandRuleSchema).max(500).default([]),
});
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;

export const EMPTY_PERMISSION_POLICY: PermissionPolicy = {
  rules: [],
  disabledTools: [],
  pathRules: [],
  commandRules: [],
};

/** 规则是否命中工具名（精确或「前缀 *」）。 */
export function matchesPermissionRule(rule: string, toolName: string): boolean {
  if (rule.endsWith("*")) {
    return toolName.startsWith(rule.slice(0, -1));
  }
  return rule === toolName;
}

export function anyPermissionRuleMatches(
  rules: readonly string[],
  toolName: string,
): boolean {
  return rules.some((rule) => matchesPermissionRule(rule, toolName));
}

/**
 * 权限场景（R5-3 分场景）：`interactive` = 你盯着跑的普通轮次；`automation` = 目标/循环
 * 这类「无人值守的自动化轮次」——它们各设一档，自动化档可以把标准放得更严。
 */
export const permissionScenarioSchema = z.enum(["interactive", "automation"]);
export type PermissionScenario = z.infer<typeof permissionScenarioSchema>;

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
  instanceId: z.string().min(1),
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

/**
 * 用户侧使用统计（R4-2，设置「使用统计」页）：按天的 token 活动、
 * 连续天数等派生指标与按模型聚合。日期为 UTC 口径（YYYY-MM-DD）。
 */
export const usageStatsResponseSchema = z.object({
  rangeDays: z.number().int().min(1).max(90),
  totals: z.object({
    tokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /**
     * 窗口内记录到的花费（美元）。只有供应商回传成本时才累加；
     * 一行成本都没有时如实为 null（「未上报」），不把未知成本伪装成 0。
     */
    costUsd: z.number().nonnegative().nullable(),
  }),
  /** 单日峰值 token 数。 */
  peakDayTokens: z.number().int().nonnegative(),
  /** 当前连续活跃天数（从今天或昨天往回数）。 */
  currentStreakDays: z.number().int().nonnegative(),
  longestStreakDays: z.number().int().nonnegative(),
  /**
   * 最长聊天时长（秒）：**单会话首尾消息的时间跨度**里的最大值。
   * 口径与取向见 `features/usage/repository.ts` 的 `longestSessionSeconds`——
   * 不是「agent 跑了多久」，也不是「所有消息的首尾差」。
   */
  longestSessionSeconds: z.number().int().nonnegative(),
  /** 窗口内逐日序列（缺数据的天补 0，保证连续）。 */
  daily: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      tokens: z.number().int().nonnegative(),
    }),
  ),
  /**
   * 热力图用的**近一年**逐日序列（365 天，缺数据补 0）。
   *
   * 与 `daily`（7/30 天窗口）分开：热力图是「一年活动全貌」，不该随范围切换而变窄
   * （参考图就是一整年的格子铺满）。上限：只统计最近 {@link STATS_ROW_LIMIT} 行
   * 用量记录覆盖到的天数——超出这个行数的老数据不在图里。
   */
  heatmap: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      tokens: z.number().int().nonnegative(),
    }),
  ),
  byModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      tokens: z.number().int().nonnegative(),
    }),
  ),
  /**
   * 窗口内**逐日 × 模型**的 token 序列（趋势图按模型画多条线用）。
   *
   * 每个 `tokens` 数组与 `daily` 等长、按下标对齐（缺数据的天补 0）；
   * 按 `byModel` 同序（用量降序）。老服务端可能没有这个字段。
   */
  dailyByModel: z
    .array(
      z.object({
        model: z.string(),
        tokens: z.array(z.number().int().nonnegative()),
      }),
    )
    .default([]),
});
export type UsageStatsResponse = z.infer<typeof usageStatsResponseSchema>;
