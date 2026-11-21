import {
  anyPermissionRuleMatches,
  detectDeleteCommand,
  EMPTY_PERMISSION_POLICY,
  fileOperationFor,
  findSensitiveData,
  matchesPermissionDomain,
  matchesPermissionRule,
  type PermissionDecisionSource,
  type PermissionDomainRule,
  type PermissionFileOperation,
  type PermissionPolicy,
  type PermissionRuleAction,
  type PermissionRules,
  type PermissionScenario,
  type PermissionTier,
} from "@kenfutwork/shared";
import type { CodeApprovalService } from "./approval-types.js";
import { createCodeApprovalService } from "./code-approval.js";

import {
  DEFAULT_PERMISSION_SETTINGS,
  type PermissionSettings,
} from "./tier-store.js";

/**
 * permissions 策略缝（DEC-4，P6；R5-3 扩展）：
 * - 四档：default（危险操作 ask）/ auto-approve（命中已批准策略自动放行）/
 *   full-access / **custom**（按 `permissionRules` 逐条判）；
 * - **分场景**：常规任务与自动化任务（目标/循环）各设一档；
 * - 审批记忆粒度：本次（单次放行）/ 会话（thread 级）/ 永久（工具级）；
 * - agent 无「自我授权为永久」路径：approve 只能由外部（审批 UI）调用。
 * 拦截挂在 kernel 的 tool-pre-execute 事件上（permissions 插件订阅），
 * 以及 agent-runs 的工具门（内置工具不经过 ctx.tools，见 features/agent-runs/plugin.ts）。
 */

/**
 * 危险/不可逆工具名模式：default 档下必须审批。
 *
 * 名称必须与**真实注册名**一致，否则该工具根本不进审批链（默认档下静默放行）。
 * 曾经的错拼 `/^file_write$/` 就与 deepagents 内置工具的真实名 `write_file` 不匹配，
 * 导致「写文件需审批」的政策实际从未生效——改动此表请以 `isDangerousTool` 的回归测试为准。
 */
export const DANGEROUS_TOOL_PATTERNS = [
  /^(Write|Edit|ApplyPatch|Bash|TaskInput|TaskStop)$/,
  /^mcp__/,
  /^diff_patch$/,
  // deepagents FilesystemMiddleware 内置写工具
  /^write_file$/,
  /^edit_file$/,
  // 命令执行
  /^execute$/,
  /shell/i,
] as const;

export function isDangerousTool(toolName: string): boolean {
  return DANGEROUS_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

/** 从工具参数里取被操作的路径（不同工具用 `file_path` 或 `path`）。 */
export function pathArgument(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  for (const key of ["file_path", "path", "target_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** 从工具参数里取要执行的命令（命令类工具用 `command` 或 `cmd`）。 */
export function commandArgument(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  for (const key of ["command", "cmd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** 从工具参数里取要访问的网址（`browser_open` 等用 `url`）。 */
export function urlArgument(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  for (const key of ["url", "href"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * 把工具参数的字符串值拼成一段文本供敏感数据检测。
 *
 * 只取字符串（含嵌套对象/数组里的），数值与布尔没有意义；对象键也拼进来，
 * 因为 `{"apiKey":"sk-…"}` 这种键名本身也可能带出判断线索（前缀匹配已足够，键名只是补充）。
 */
function collectTextArguments(
  args: Record<string, unknown>,
  depth = 0,
): string {
  if (depth > 4) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      parts.push(value);
    } else if (value && typeof value === "object") {
      parts.push(
        collectTextArguments(value as Record<string, unknown>, depth + 1),
      );
    }
    // 键名单独计入：`Authorization` 这类键配 `Bearer …` 值是常见组合
    if (typeof value === "string" && value.length > 0) parts.push(key);
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

/**
 * 路径前缀判定：规则路径是「该目录/文件及其下层」。
 *
 * 分隔符两种都认（Windows 与 POSIX），且必须落在分隔符边界上——
 * 否则 `/data/app-old` 会被 `/data/app` 误伤。比较前统一转小写：
 * Windows 路径大小写不敏感，规则写 `C:\Users` 而工具传 `c:\users` 必须命中。
 */
export function withinPathPrefix(
  targetPath: string,
  rulePath: string,
): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  const target = normalize(targetPath);
  const rule = normalize(rulePath);
  if (!rule) return false;
  if (target === rule) return true;
  return target.startsWith(`${rule}/`);
}

/**
 * 三态表判定：按表内顺序取第一条命中。
 *
 * 抽成泛型是为了工具规则、路径规则、命令规则共用同一套「首个命中生效」语义，
 * 避免三处各写一遍循环而判定顺序漂移。
 *
 * 理由里写**命中的规则**（不放被操作的内容）：命令原文可能带 `curl -H "Authorization: …"`，
 * 路径也可能是私密文件名。审计流水会落库，理由因此只描述规则本身。
 */
function triStateDecision<T extends { action: PermissionRuleAction }>(
  table: readonly T[],
  label: (rule: T) => string,
  matches: (rule: T) => boolean,
  source: PermissionDecisionSource,
): PermissionDecision | undefined {
  for (const rule of table) {
    if (!matches(rule)) continue;
    if (rule.action === "allow") return { decision: "allow", source };
    if (rule.action === "deny") {
      return {
        decision: "deny",
        blocked: true,
        source,
        reason: `命中「拦截」规则 ${label(rule)}`,
      };
    }
    // ask：交给审批，不给记忆（每次都要人点）
    return {
      decision: "deny",
      source,
      reason: `命中「每次询问」规则 ${label(rule)}，需你确认`,
    };
  }
  return undefined;
}

/**
 * 危险调用的完整判据 = 名称命中危险模式 **或** 属主声明的执行效果不是只读。
 *
 * 为什么要看声明：插件 bundle 的工具名（`mihome_control`/`ha_control`…）不进名表，
 * 只按名字判会**静默放行设备写入**（《HA 插件规划》§3.3，见 `docs/插件/HA插件规划.md`）。工具注册时由
 * 属主声明 `access`（内建工具在各自定义处、插件在 `ctx.tools.register`），内核随
 * `tool-pre-execute` 事件把它带到这里：`read` = 只读放行，`write`/`execute` = 默认档
 * 需审批。`undefined`（未声明的旧工具）维持按名字判，行为不变。
 */
export function isDangerousCall(input: {
  toolName: string;
  access?: "read" | "write" | "execute" | undefined;
}): boolean {
  if (isDangerousTool(input.toolName)) return true;
  return input.access !== undefined && input.access !== "read";
}

/**
 * 档位 → 用户可见名（与界面同一套词：默认 / 自动审批 / 完全访问 / 自定义）。
 *
 * 审批原因会直接展示给用户，**别把原始枚举值写进去**（此前非自定义档渲染成
 * 「auto-approve 档」这种半中半英的串）。
 */
const TIER_LABELS: Record<PermissionTier, string> = {
  default: "默认档",
  "auto-approve": "自动审批档",
  "full-access": "完全访问档",
  custom: "自定义档",
};

/** 文件操作 → 用户可见名（路径规则的理由里要能读出「管的是读还是写」）。 */
const FILE_OPERATION_LABELS: Record<PermissionFileOperation, string> = {
  read: "读",
  write: "写",
  delete: "删",
};

export interface ToolApproval {
  scope: "once" | "thread" | "forever";
  threadId?: string;
}

export interface PermissionDecision {
  decision: "allow" | "deny";
  reason?: string;
  /**
   * `true` = 命中「拒绝」规则或禁用清单：**硬拒绝**，不给审批机会。
   *
   * 缺省（undefined）表示 `deny` 是「需要审批」——这是改造前唯一的行为，
   * 保持默认值不变才不会让既有调用方误把「需审批」当成永久拒绝。
   */
  blocked?: boolean;
  /** 这次结论来自哪条规则（审计中心按它分类显示；未命中规则时缺省）。 */
  source?: PermissionDecisionSource;
}

/**
 * 审计记录的一条输入（服务端落库用；不含工具参数，理由见
 * `permissionAuditEntrySchema`）。
 */
export interface PermissionAuditRecord {
  toolName: string;
  decision: "allow" | "deny";
  source: PermissionDecisionSource | undefined;
  blocked: boolean;
  reason: string | undefined;
}

export interface PermissionService extends CodeApprovalService {
  getTier(threadId?: string): PermissionTier;
  setTier(threadId: string | undefined, tier: PermissionTier): void;
  /** 当前完整设置（档位 / 自动化档位 / 自定义规则 / 浏览器控制）。 */
  getSettings(): PermissionSettings;
  /** 读回持久化设置后覆盖内存（启动期用；不写库）。 */
  applySettings(settings: PermissionSettings): void;
  /**
   * 单次决策。`scenario` 决定用哪一档（缺省 interactive）：
   * 自动化任务（目标/循环）走 `automationTier`。
   */
  evaluate(input: {
    toolName: string;
    threadId?: string;
    scenario?: PermissionScenario;
    /** 属主声明的执行效果（内核随 tool-pre-execute 事件带来）；缺省按名字判。 */
    access?: "read" | "write" | "execute" | undefined;
    /** 工具参数：路径/命令规则据此取被操作的路径与命令。 */
    args?: Record<string, unknown> | undefined;
  }): PermissionDecision;
  /**
   * 只检查工具策略（禁用清单 + 三态规则），不看档位。
   *
   * 审批入口（`admit`）用它做前置拦截：命中禁用或「拒绝」规则时直接返回 `blocked`，
   * 不进入人工审批；命中「询问」返回 `deny`（无 `blocked`），照常弹审批。
   * 返回 `undefined` 表示策略未命中，调用方继续走 Task 策略。
   */
  checkToolPolicy(
    toolName: string,
    args?: Record<string, unknown>,
  ): PermissionDecision | undefined;
  /**
   * 只检查网络访问规则（网络安全：域名三态表），不看档位。
   *
   * 服务端替用户访问任意地址的出口（`fetchPageSnapshot`）在抓取前调用它：
   * 命中「拒绝」直接抛可读原因，命中「允许」放行，未命中返回 `undefined`
   * 让调用方按原行为继续。与工具策略同理，完全访问档也拦不住用户显式拒绝的域名。
   */
  checkUrlPolicy(url: string): PermissionDecision | undefined;
  /**
   * 挂一个审计记录器（审计中心）。
   *
   * 工具门判定（`evaluate`）与审批入口（`checkToolPolicy`）各记一条；
   * 记录器由插件在挂载时接上（落库），缺席时判定照常、不记流水。
   * 只记结论与命中的规则来源，**不记工具参数**。
   */
  setAuditSink(sink: ((record: PermissionAuditRecord) => void) | null): void;
  /** 审批（只能由人审 UI 触发，agent 无路径自我授权）。 */
  approve(toolName: string, approval: ToolApproval): void;
  listApprovedForever(): string[];
}

export function createPermissionService(
  options: Parameters<typeof createCodeApprovalService>[0] = {},
): PermissionService {
  let settings: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS };
  const threadTiers = new Map<string, PermissionTier>();
  // 「永久」批准的快速判定集：与 settings.approvedForever 同步（applySettings 覆盖，
  // approve(forever) 增补后由调用方经 tier-store 写穿持久化）。
  const foreverApproved = new Set<string>(settings.approvedForever);
  const threadApproved = new Set<string>();
  let auditSink: ((record: PermissionAuditRecord) => void) | null = null;

  /** 记一条审计流水：记录器抛错不能影响判定（审计是旁路，不是判定的一环）。 */
  const audit = (
    toolName: string,
    decision: PermissionDecision,
  ): PermissionDecision => {
    if (!auditSink) return decision;
    try {
      auditSink({
        toolName,
        decision: decision.decision,
        source: decision.source,
        blocked: decision.blocked === true,
        reason: decision.reason,
      });
    } catch {
      // 审计失败静默：判定的正确性优先于记账
    }
    return decision;
  };

  /** 场景对应的档位：自动化任务用 automationTier（线程显式设过档的优先）。 */
  const tierFor = (
    threadId: string | undefined,
    scenario: PermissionScenario,
  ): PermissionTier => {
    if (threadId && threadTiers.get(threadId)) {
      return threadTiers.get(threadId) as PermissionTier;
    }
    return scenario === "automation" ? settings.automationTier : settings.tier;
  };

  /**
   * 工具策略判定（禁用清单 → 工具三态规则 → 路径/命令规则）。
   * 命中即返回，未命中返回 undefined。
   *
   * `evaluate`（工具门）与 `checkToolPolicy`（审批入口）共用这一份，
   * 保证「禁用/拒绝」在两条路径上语义一致：都是硬拒绝，不给审批机会。
   */
  const policyDecisionFor = (
    toolName: string,
    args?: Record<string, unknown>,
  ): PermissionDecision | undefined => {
    const policy = settings.policy ?? EMPTY_PERMISSION_POLICY;
    if (anyPermissionRuleMatches(policy.disabledTools, toolName)) {
      return {
        decision: "deny",
        blocked: true,
        source: "disabled",
        reason: `工具 ${toolName} 已在「设置 → 权限 → 工具管控」里被禁用`,
      };
    }
    const toolDecision = triStateDecision(
      policy.rules,
      (rule) => rule.pattern,
      (rule) => matchesPermissionRule(rule.pattern, toolName),
      "tool-rule",
    );
    if (toolDecision) return toolDecision;

    // 路径规则只在参数里真的带了路径时才判；操作类型决定命中哪一档规则。
    const targetPath = pathArgument(args);
    if (targetPath) {
      const operation = fileOperationFor({ toolName, args });
      const pathDecision = triStateDecision(
        policy.pathRules,
        (rule) => `${rule.path}（${FILE_OPERATION_LABELS[rule.operation]}）`,
        (rule) =>
          rule.operation === operation &&
          withinPathPrefix(targetPath, rule.path),
        "path-rule",
      );
      if (pathDecision) return pathDecision;
    }
    const command = commandArgument(args);
    if (command) {
      const commandDecision = triStateDecision(
        policy.commandRules,
        (rule) => rule.prefix,
        (rule) => command.startsWith(rule.prefix),
        "command-rule",
      );
      if (commandDecision) return commandDecision;
    }
    const target = urlArgument(args);
    if (target) {
      const domainDecision = domainDecisionFor(target, policy.domainRules);
      if (domainDecision) return domainDecision;
    }
    // 删除保护（数据安全）：本仓库的删除发生在命令里，因此判在命令参数上。
    const deleteDecision = deleteProtectionFor(args, policy);
    if (deleteDecision) return deleteDecision;
    // 敏感保护（数据安全）：参数里出现令牌格式即拒绝——审批也救不回已泄漏的凭据。
    const sensitiveDecision = sensitiveProtectionFor(toolName, args, policy);
    if (sensitiveDecision) return sensitiveDecision;
    return undefined;
  };

  /**
   * 敏感保护：工具参数里出现令牌/凭据格式时**硬拒绝**（不给审批机会）。
   *
   * 为什么不是「问一下」：凭据一旦进了模型输出或远端请求就已经泄漏，人工点「允许」
   * 不解决任何问题；正确做法是让模型换个做法（用环境变量、读配置而不是贴令牌）。
   * 理由里只说**命中的类型**，不回显令牌本身。
   */
  const sensitiveProtectionFor = (
    toolName: string,
    args: Record<string, unknown> | undefined,
    policy: PermissionPolicy,
  ): PermissionDecision | undefined => {
    if (!policy.sensitiveProtection.enabled || !args) return undefined;
    const text = collectTextArguments(args);
    if (!text) return undefined;
    const hit = findSensitiveData(text, policy.sensitiveProtection.patterns);
    if (!hit) return undefined;
    return {
      decision: "deny",
      blocked: true,
      source: "sensitive-data",
      reason: `工具 ${toolName} 的参数里含${hit}，已按敏感保护拦下。请改用环境变量或配置文件，不要把凭据写进调用参数。`,
    };
  };

  /**
   * 删除保护：开启后，删除命令要么需要审批（单目标），要么因批量而需要审批；
   * 打开 `trashFirst` 时，删除命令一律硬拦并给出「先移到回收站目录」的改写建议。
   *
   * 单目标也拦的理由：删除不可撤销，而「完全访问」档把它放开了；
   * 用户在数据安全里显式打开保护，就是表达「删除前让我看一眼」。
   *
   * `trashFirst` 为什么是拦下而不是替用户移：删除发生在沙箱内的 shell 命令里，
   * 服务端拿不到那些文件句柄，也无法在命令执行后恢复。如实拦下 + 给改写建议，
   * 用户能看见到底发生了什么，也不会以为「已经进了回收站」。
   */
  /**
   * 删除模式判定（ask / auto-approve / trash / permanent）。
   *
   * 四种模式的差别只有「要不要先过问」与「删掉后能不能找回」：
   * - `auto-approve`：用户已经明确表达「不问」，直接放过去（批量阈值也不拦）；
   * - `trash`：删除命令**没有**可移动的文件句柄，喊「已进回收站」是骗人——
   *   如实拦下并给出 mv 改写建议；文件工具（`delete_path`）走真实移入回收站，
   *   那条路径不经过这里；
   * - `ask` / `permanent`：单目标也要过问（`permanent` 只是不留回收站，
   *   不代表可以无声删掉）；达到批量阈值时理由里写明数量。
   */
  const deleteProtectionFor = (
    args: Record<string, unknown> | undefined,
    policy: PermissionPolicy,
  ): PermissionDecision | undefined => {
    const mode = policy.deleteMode ?? "ask";
    if (mode === "auto-approve") return undefined;
    const command = commandArgument(args);
    if (!command) return undefined;
    const match = detectDeleteCommand(command);
    if (!match) return undefined;
    if (mode === "trash") {
      return {
        decision: "deny",
        blocked: true,
        source: "delete-protection",
        reason: `删除命令 ${match.command} 被拦下：删除模式是「先移到回收站」。请改用 mv 把目标移到项目里的备份目录，确认后再删。`,
      };
    }
    if (
      policy.deleteProtection.enabled &&
      match.targets >= policy.deleteProtection.batchThreshold
    ) {
      return {
        decision: "deny",
        source: "delete-protection",
        reason: `这次 ${match.command} 要删 ${match.targets} 个目标，达到批量删除阈值 ${policy.deleteProtection.batchThreshold}，需你确认`,
      };
    }
    if (mode === "permanent") {
      return {
        decision: "deny",
        source: "delete-protection",
        reason: `删除模式是「完全删除」（不进回收站），${match.command} 删 ${match.targets} 个目标需你确认`,
      };
    }
    return {
      decision: "deny",
      source: "delete-protection",
      reason: `删除模式是「删除前询问」，${match.command} 删 ${match.targets} 个目标需你确认`,
    };
  };

  /**
   * 域名规则判定（网络安全）。
   *
   * 与工具/路径/命令规则同一套三态语义，只是主体换成了 URL 的主机名：
   * 工具参数里带 `url`（`browser_open`）时按它判，命中即返回。
   * 非 http/https（含解析不出的地址）不参与：域名规则管的是网络访问。
   */
  const domainDecisionFor = (
    url: string,
    rules: readonly PermissionDomainRule[],
  ): PermissionDecision | undefined => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port;
    return triStateDecision(
      rules,
      (rule) => rule.domain,
      (rule) => matchesPermissionDomain(rule.domain, host, port),
      "domain-rule",
    );
  };

  /** 工具门的判定本体（`evaluate` 包一层审计后再暴露）。 */
  const evaluateDecision = ({
    toolName,
    threadId,
    scenario = "interactive",
    access,
    args,
  }: Parameters<PermissionService["evaluate"]>[0]): PermissionDecision => {
    const tier = tierFor(threadId, scenario);
    // 工具策略优先于档位：禁用清单是硬拒绝（完全访问档也拦），
    // 三态规则按表内顺序取第一条命中。这两项是 WorkBuddy 安全中心的口径，
    // 与档位正交——「完全访问」放开的是审批，不该放开用户明确禁用的工具。
    const policyDecision = policyDecisionFor(toolName, args);
    if (policyDecision) return policyDecision;
    if (tier === "full-access") {
      return { decision: "allow", source: "tier" };
    }
    // 第 4 档：自定义规则优先，且**拒绝优先**（放行表写宽了也不至于把危险工具带出去）
    if (tier === "custom") {
      const rules: PermissionRules = settings.rules;
      if (anyPermissionRuleMatches(rules.deny, toolName)) {
        return {
          decision: "deny",
          source: "custom-rules",
          reason: `工具 ${toolName} 命中自定义规则里的拒绝项（设置 → 权限 → 自定义）`,
        };
      }
      if (anyPermissionRuleMatches(rules.allow, toolName)) {
        return { decision: "allow", source: "custom-rules" };
      }
      // 都没命中 → 回落 default 档的判定
    }
    if (!isDangerousCall({ toolName, ...(access ? { access } : {}) })) {
      return { decision: "allow", source: "tier" };
    }
    if (tier === "auto-approve") {
      return { decision: "allow", source: "tier" };
    }
    // default（或 custom 未命中规则）：危险工具需要审批记忆
    if (foreverApproved.has(toolName)) {
      return { decision: "allow", source: "approval-memory" };
    }
    if (threadId && threadApproved.has(`${threadId}:${toolName}`)) {
      return { decision: "allow", source: "approval-memory" };
    }
    return {
      decision: "deny",
      source: "tier",
      reason: `工具 ${toolName} 属危险操作，需在「设置 → 权限 → 工具审批」批准（${TIER_LABELS[tier]}）`,
    };
  };

  const service: PermissionService = {
    ...createCodeApprovalService(options),
    checkToolPolicy(toolName, args) {
      const decision = policyDecisionFor(toolName, args);
      // 只在真的命中规则时记一条：未命中说明还要走档位判定，不在这一层下结论。
      return decision ? audit(toolName, decision) : undefined;
    },
    checkUrlPolicy(url) {
      const policy = settings.policy ?? EMPTY_PERMISSION_POLICY;
      return domainDecisionFor(url, policy.domainRules);
    },
    setAuditSink(sink) {
      auditSink = sink;
    },
    getTier(threadId) {
      return (threadId && threadTiers.get(threadId)) || settings.tier;
    },
    setTier(threadId, tier) {
      if (threadId) {
        threadTiers.set(threadId, tier);
      } else {
        settings = { ...settings, tier };
      }
    },
    getSettings() {
      // approvedForever 以运行集为准（approve 增补后、applySettings 覆盖前也要读得到）
      return { ...settings, approvedForever: [...foreverApproved] };
    },
    applySettings(next) {
      settings = next;
      foreverApproved.clear();
      for (const toolName of next.approvedForever)
        foreverApproved.add(toolName);
    },
    evaluate(input) {
      // 工具门是「最终结论」，每条都进审计（含放行）——用户可以看见 AI 都跑了什么。
      return audit(input.toolName, evaluateDecision(input));
    },
    approve(toolName, approval) {
      if (approval.scope === "once") {
        throw new Error(
          "本次审批必须绑定真实工具调用，请通过当前 V4 审批请求回应。",
        );
      }
      if (approval.scope === "forever") {
        foreverApproved.add(toolName);
      } else if (approval.scope === "thread" && approval.threadId) {
        threadApproved.add(`${approval.threadId}:${toolName}`);
      }
    },
    listApprovedForever() {
      return [...foreverApproved];
    },
  };
  return service;
}
