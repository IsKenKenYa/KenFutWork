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
 * 文件操作类型（WorkBuddy「文件安全」按读 / 写 / 删分别配置）。
 *
 * 判定只看工具这次**实际要做的事**：工具名与参数决定 operation，
 * 例如 `read_file` = read、`write_file`/`edit_file` = write、
 * `rm`/`del` 命令 = delete、`ls`/`cat` 命令 = read。
 */
export const permissionFileOperationSchema = z.enum([
  "read",
  "write",
  "delete",
]);
export type PermissionFileOperation = z.infer<
  typeof permissionFileOperationSchema
>;

/**
 * 路径规则（参考 WorkBuddy 的「文件安全」）：按路径前缀 + 操作类型配三态动作。
 *
 * 只按**前缀**匹配，不做通配符：路径通配（`**`、`?`）会让人误判覆盖面，
 * 前端也难解释「这条规则到底管到哪些文件」。前缀匹配的口径是「这个目录/文件及其下层」。
 *
 * `operations` 缺省 = 三种操作都管；显式列出时只对那几种生效——
 * 「这个目录只读」= `operations: ["read"], action: "allow"` 再加一条
 * `operations: ["write","delete"], action: "deny"`。
 */
export const permissionPathRuleSchema = z
  .object({
    path: z.string().min(1).max(4096),
    operation: permissionFileOperationSchema,
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
 * 网络规则：按**域名**配三态动作（与 WorkBuddy 的「网络安全」同口径）。
 *
 * 匹配口径（自上而下，第一条命中生效）：
 * - `*.example.com`：所有子域，不含 `example.com` 本身；
 * - `example.com`：该域名本身**及其所有子域**（实际用途上「整站」比「只这一层」常见）；
 * - `example.com:8080`：带端口的写法只匹配该端口。
 *
 * 不写通配符前缀之外的形式：`*example.com` 这类会让「管到哪些域名」无法解释。
 */
export const permissionDomainRuleSchema = z
  .object({
    domain: z.string().min(1).max(253),
    action: permissionRuleActionSchema,
  })
  .strict();
export type PermissionDomainRule = z.infer<typeof permissionDomainRuleSchema>;

/**
 * 判定来源（审计中心用）：回答「这次是命中哪条规则被拦/放行的」。
 *
 * 这是用户能读懂的分类，不是内部函数名——审计页直接按它显示。
 */
export const permissionDecisionSourceSchema = z.enum([
  "disabled",
  "tool-rule",
  "path-rule",
  "command-rule",
  "domain-rule",
  "custom-rules",
  "approval-memory",
  "tier",
  "approval",
  "delete-protection",
  "sensitive-data",
]);
export type PermissionDecisionSource = z.infer<
  typeof permissionDecisionSourceSchema
>;

/**
 * 一条审计记录（设置 → 权限 → 审计中心）。
 *
 * 刻意**不含工具参数**：参数里可能带文件内容、命令与凭据，审计只需回答
 * 「哪个工具、什么结论、为什么」。`blocked` 区分硬拒绝与「需审批」。
 */
export const permissionAuditEntrySchema = z.object({
  id: z.string().min(1),
  occurredAt: z.string().min(1),
  toolName: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
  source: permissionDecisionSourceSchema.nullable(),
  blocked: z.boolean(),
  reason: z.string().nullable(),
});
export type PermissionAuditEntry = z.infer<typeof permissionAuditEntrySchema>;

/** 审计记录上限：超过即裁剪最旧的（服务端写入时执行）。 */
export const PERMISSION_AUDIT_LIMIT = 5000;

/**
 * 工具策略：三态规则表 + 禁用清单 + 路径/命令/域名规则。
 *
 * 判定顺序（拒绝优先，全部在档位之前）：
 * 1. 命中禁用清单 → 硬拒绝；
 * 2. 工具三态规则按表内顺序取第一条命中；
 * 3. 文件/命令/域名规则按表内顺序取第一条命中（前缀匹配）；
 * 4. 都没命中 → 回落档位判定（与改造前完全一致）。
 */
export const permissionPolicySchema = z.object({
  rules: z.array(permissionPolicyRuleSchema).max(500).default([]),
  disabledTools: permissionDisabledToolsSchema,
  pathRules: z.array(permissionPathRuleSchema).max(500).default([]),
  commandRules: z.array(permissionCommandRuleSchema).max(500).default([]),
  domainRules: z.array(permissionDomainRuleSchema).max(500).default([]),
  /**
   * 删除保护与批量删除审批（WorkBuddy「数据安全」）。
   *
   * 删除有两条路径，`trashFirst` 对它们的作用不同：
   * - **文件工具**（`delete_path`）：`trashFirst` 开启时把文件移到
   *   `<授权根>/.kenfutwork-trash/<时间戳>/<相对路径>` 并回报位置；关闭时按系统删除。
   *   这是真实的「先移入回收站」，文件仍可找回。
   * - **`execute` 命令里的删除指令**：服务端拿不到那些文件句柄，也无法在命令执行后恢复，
   *   所以 `trashFirst` 在这里是**拦下 + 给出 `mv` 改写建议**，不去猜测命令语义。
   *
   * 档位相关的判定：
   * - `enabled` 关（缺省）：不额外干预，删除只走档位与命令规则；
   * - `enabled` 开 + 单目标删除：仍需审批（默认档本来就拦，这里保证「完全访问」下也拦）；
   * - 一批删除达到 `batchThreshold` 即需审批。
   */
  deleteProtection: z
    .object({
      enabled: z.boolean().default(false),
      /** 一批删除的目标数达到该值即需审批（默认 50，与 WorkBuddy 一致）。 */
      batchThreshold: z.number().int().min(1).max(10_000).default(50),
      /**
       * 删除前先移入回收站目录。
       *
       * 文件工具走真实移动（可找回）；`execute` 的删除命令走「拦下 + 改写建议」
       * （拿不到命令里的文件句柄，无法可靠移动）。
       */
      trashFirst: z.boolean().default(false),
    })
    .default({ enabled: false, batchThreshold: 50, trashFirst: false }),
  /**
   * 敏感保护（WorkBuddy「数据安全」）：默认开。
   *
   * 拦截的是「AI 把凭据发出去」这一类事故：工具参数里出现明显的令牌格式
   * （`sk-…`、GitHub `ghp_…`、AWS `AKIA…`、Bearer 头）时，这次调用不进审批，
   * 直接拒绝并指出命中的类型——审批也无法挽回已经泄漏的凭据。
   *
   * `patterns` 是用户自定义的正则**源码字符串**（服务端编译时校验，编译失败即拒绝保存），
   * 命中后同样按敏感数据拒绝。
   */
  sensitiveProtection: z
    .object({
      enabled: z.boolean().default(true),
      patterns: z.array(z.string().min(1).max(500)).max(50).default([]),
    })
    .default({ enabled: true, patterns: [] }),
  /**
   * 内置运行时（WorkBuddy「内置运行时」）：允许执行的命令使用随包提供的运行时。
   *
   * 关掉后沙箱不再把随包 node/python/uv/java/git 的 bin 目录前置进 PATH、
   * 也不再授权它们的读根，命令只能用宿主自带的运行时（或都没有）。
   * 这是「缩小可用工具面」的保护，不是开关沙箱本身。
   */
  bundledRuntimes: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
  /**
   * AI 安全防护（WorkBuddy「AI 安全防护」）。
   *
   * 整组**默认关闭**（与 WorkBuddy 一致）。
   *
   * - `injectionGuard`：工具返回内容里出现「覆盖先前指令」「索取凭据」这类句式时，
   *   在结果末尾追加属主声明，提示模型那是外部内容而非用户要求。
   * - `approvalReview`：**模型行为智能审查 + AI 智能审批**。开启时，属主声明了
   *   `approvalReviewKind` 的高风险操作在进入人工审批之前，先交给「审批模型」审一次：
   *   判定为常规且有界 → 自动放行；可疑 / 越权 / 超出用户请求 → 交回人工（附风险说明）。
   *   未配置审批模型时一律回落到人工。
   *
   * 缺省 `false` 的后果是明确的：关掉后审批一律走人工，不经审批模型。
   * 想用自动审阅的用户在权限页打开这一项。
   */
  aiSafety: z
    .object({
      injectionGuard: z.boolean().default(false),
      approvalReview: z.boolean().default(false),
    })
    .default({ injectionGuard: false, approvalReview: false }),
  /**
   * 自动备份（WorkBuddy「自动备份」）：每轮对话修改文件之前先留一份影子快照。
   *
   * 本仓库的对应实现是**检查点**（`features/checkpoints`：每个轮次边界在私有目录
   * 里做一次 git 快照，可在检查点时间线上回看与恢复）。这里只控制「轮次前」那道
   * 快照要不要做；关掉后不产生新的 pre 快照，已有快照不受影响。
   */
  autoBackup: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
  /**
   * 沙箱安全总开关（WorkBuddy「沙箱安全」）。
   *
   * 打开（缺省）：命令在进程沙箱内执行，文件访问限 Task 授权目录，网络走域名白名单。
   * 关闭：任务不再能进入 `danger-full-access`（「完全访问」档的 yolo 被降级成
   * `workspace-write`）——文件访问仍限授权目录，网络仍走白名单。
   *
   * 为什么不是「关掉=不隔离」：真正的「不隔离」就是 `danger-full-access`，
   * 而它已经由权限档位（完全访问）控制。这里管控的是「档位能不能拿到那个模式」，
   * 因为有些用户希望档位拉到最高、但仍然不让命令跑出沙箱边界。
   */
  sandbox: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
});
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;

export const EMPTY_PERMISSION_POLICY: PermissionPolicy = {
  rules: [],
  disabledTools: [],
  pathRules: [],
  commandRules: [],
  domainRules: [],
  deleteProtection: {
    enabled: false,
    batchThreshold: 50,
    trashFirst: false,
  },
  sensitiveProtection: { enabled: true, patterns: [] },
  bundledRuntimes: { enabled: true },
  aiSafety: { injectionGuard: false, approvalReview: false },
  autoBackup: { enabled: true },
  sandbox: { enabled: true },
};
/**
 * 内置的敏感数据格式（与 WorkBuddy「敏感保护」同口径：票据、密码这类东西不该被 AI 发出去）。
 *
 * 只认**有明确前缀/结构**的令牌：宽松匹配会把普通文本里的长串也报出来，
 * 那种高误报的保护等于没有。`label` 直接进拒绝理由，让用户知道命中的是哪一类。
 */
export const SENSITIVE_DATA_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  { label: "OpenAI 密钥", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/u },
  { label: "GitHub 令牌", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { label: "AWS 访问密钥", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: "Google API 密钥", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { label: "Slack 令牌", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  { label: "私钥文件", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  {
    label: "Bearer 凭据",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/u,
  },
];

/**
 * 在一段文本里找敏感数据：返回命中的类型名（命中自定义规则时返回「自定义规则」）。
 *
 * 自定义正则由用户提供，编译失败视为不匹配（保存时会被拦下，这里只做兜底）。
 */
export function findSensitiveData(
  text: string,
  customPatterns: readonly string[] = [],
): string | null {
  if (!text) return null;
  for (const { label, pattern } of SENSITIVE_DATA_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  for (const source of customPatterns) {
    try {
      if (new RegExp(source, "u").test(text)) return "自定义规则";
    } catch {
      // 编译失败的自定义规则不参与匹配（保存期已拦下）
    }
  }
  return null;
}

/**
 * 这次工具调用在文件系统上「做的是什么」——路径规则据此挑读 / 写 / 删那一档。
 *
 * 判据优先级（高到低）：
 * 1. 工具名里能看出动作（`read_*` / `write_*` / `delete_*` / `rm` / `mv` / `cat` …）——
 *    这是属主给的语义，最可靠；
 * 2. 命令字符串里有删除指令 → delete；
 * 3. 带写入类参数（`content` / `new_string` / `old_string`）→ write；
 * 4. 只带路径、看不出写意图 → read。
 *
 * 返回 `undefined` 表示「这次调用不碰文件系统」，路径规则不参与判定。
 */
export function fileOperationFor(input: {
  toolName: string;
  /** 工具参数（可缺省：只按工具名判）。 */
  args?: Record<string, unknown> | undefined;
}): PermissionFileOperation | undefined {
  const name = input.toolName.toLowerCase();
  // 删除优先判：`delete_file` 也命中下面的 write 片段，但语义是删除。
  if (/delete|remove|unlink|rmdir|\brm\b|trash/.test(name)) return "delete";
  if (/^(read|get|list|ls|cat|view|inspect|search|grep|find|glob)/.test(name))
    return "read";
  if (/write|edit|create|append|patch|mkdir|move|rename|cp|copy/.test(name))
    return "write";
  const args = input.args;
  if (!args) return undefined;
  const command = ["command", "cmd"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string");
  if (command) {
    if (detectDeleteCommand(command)) return "delete";
    // 命令里的写入方向（`>`、`tee`、`cp`、`mv`、`mkdir`）按写处理，其余按读。
    if (/>|tee\b|\bcp\b|\bmv\b|\bmkdir\b|\btouch\b/.test(command))
      return "write";
    return "read";
  }
  if (
    typeof args.content === "string" ||
    typeof args.new_string === "string" ||
    typeof args.old_string === "string"
  ) {
    return "write";
  }
  // 只带路径参数的一律按读：宁可少拦一次写入，也不把普通查询按写规则拒掉。
  if (
    typeof args.file_path === "string" ||
    typeof args.path === "string" ||
    typeof args.target_path === "string"
  ) {
    return "read";
  }
  return undefined;
}

/**
 * 命令里的删除指令识别（删除保护与批量删除审批的判据）。
 *
 * 只认常见的删除命令与它们的目标数，**不做 shell 语法解析**——真正的解析要完整
 * shell 词法与变量展开，那是另一个量级的工作，而且删错一次就无法回滚。这里的口径是
 * 「保守识别：能看出是删除就按删除处理」：
 * - `rm` / `rmdir` / `del` / `erase` / `rd` / `Remove-Item` / `ri`；
 * - 目标数按空白分词后去掉选项（`-` / `--` / `/` 开头）计。
 *
 * 返回值只用于「是否要保护」与「一批删几个」，不用于执行任何东西。
 */
export interface DeleteCommandMatch {
  /** 命令里出现的删除指令名（`rm`、`del`…）。 */
  command: string;
  /** 识别到的目标数（`rm -rf a b c` = 3）。 */
  targets: number;
}

const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
]);

/** 分词时把管道/重定向拆开：`rm x | cat` 的目标只有 `x`。 */
const SHELL_SEPARATORS = /[|;&<>]+/u;

export function detectDeleteCommand(
  commandLine: string,
): DeleteCommandMatch | null {
  const normalized = commandLine.trim();
  if (!normalized) return null;
  for (const segment of normalized.split(SHELL_SEPARATORS)) {
    const words = segment
      .trim()
      .split(/\s+/u)
      .filter((word) => word.length > 0);
    if (words.length === 0) continue;
    // Windows 的 `del` / `rd` 常带前缀（`cmd /c del x`），逐个词找删除指令。
    // 引号形式（`grep "rm"`）同样识别：这里的口径是「保守拦截」，宁可多点一次审批。
    const normalizeWord = (word: string) =>
      word.toLowerCase().replace(/^["']|["']$/gu, "");
    const index = words.findIndex((word) =>
      DELETE_COMMANDS.has(normalizeWord(word)),
    );
    if (index === -1) continue;
    const targets = words
      .slice(index + 1)
      .filter((word) => !word.startsWith("-") && !word.startsWith("/")).length;
    return { command: normalizeWord(words[index] ?? ""), targets };
  }
  return null;
}

/** 域名规则是否命中：`*.example.com` 只吃子域，`example.com` 吃本身与全部子域。 */
export function matchesPermissionDomain(
  rule: string,
  hostname: string,
  port = "",
): boolean {
  const normalizedRule = rule.trim().toLowerCase();
  const host = hostname.trim().toLowerCase();
  if (!normalizedRule || !host) return false;
  // 带端口的规则：先比端口，再按域名口径比主机。
  const rulePort = normalizedRule.includes(":")
    ? normalizedRule.slice(normalizedRule.lastIndexOf(":") + 1)
    : "";
  const ruleHost = rulePort
    ? normalizedRule.slice(0, normalizedRule.lastIndexOf(":"))
    : normalizedRule;
  if (rulePort && rulePort !== port) return false;
  if (ruleHost.startsWith("*.")) {
    const base = ruleHost.slice(2);
    return host.endsWith(`.${base}`);
  }
  return host === ruleHost || host.endsWith(`.${ruleHost}`);
}

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
