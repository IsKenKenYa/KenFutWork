import {
  anyPermissionRuleMatches,
  EMPTY_PERMISSION_POLICY,
  matchesPermissionRule,
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
 */
function triStateDecision<T extends { action: PermissionRuleAction }>(
  table: readonly T[],
  subject: string,
  matches: (rule: T) => boolean,
): PermissionDecision | undefined {
  for (const rule of table) {
    if (!matches(rule)) continue;
    if (rule.action === "allow") return { decision: "allow" };
    if (rule.action === "deny") {
      return {
        decision: "deny",
        blocked: true,
        reason: `${subject} 命中「拒绝」规则`,
      };
    }
    // ask：交给审批，不给记忆（每次都要人点）
    return {
      decision: "deny",
      reason: `${subject} 命中「询问」规则，需你确认`,
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
        reason: `工具 ${toolName} 已在「设置 → 权限 → 工具管控」里被禁用`,
      };
    }
    const toolDecision = triStateDecision(policy.rules, toolName, (rule) =>
      matchesPermissionRule(rule.pattern, toolName),
    );
    if (toolDecision) return toolDecision;

    // 路径与命令规则只在参数里真的带了对应字段时才判：没带就不该命中。
    const targetPath = pathArgument(args);
    if (targetPath) {
      const pathDecision = triStateDecision(
        policy.pathRules,
        targetPath,
        (rule) => withinPathPrefix(targetPath, rule.path),
      );
      if (pathDecision) return pathDecision;
    }
    const command = commandArgument(args);
    if (command) {
      const commandDecision = triStateDecision(
        policy.commandRules,
        command,
        (rule) => command.startsWith(rule.prefix),
      );
      if (commandDecision) return commandDecision;
    }
    return undefined;
  };

  const service: PermissionService = {
    ...createCodeApprovalService(options),
    checkToolPolicy(toolName, args) {
      return policyDecisionFor(toolName, args);
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
    evaluate({ toolName, threadId, scenario = "interactive", access, args }) {
      const tier = tierFor(threadId, scenario);
      // 工具策略优先于档位：禁用清单是硬拒绝（完全访问档也拦），
      // 三态规则按表内顺序取第一条命中。这两项是 WorkBuddy 安全中心的口径，
      // 与档位正交——「完全访问」放开的是审批，不该放开用户明确禁用的工具。
      const policyDecision = policyDecisionFor(toolName, args);
      if (policyDecision) return policyDecision;
      if (tier === "full-access") {
        return { decision: "allow" };
      }
      // 第 4 档：自定义规则优先，且**拒绝优先**（放行表写宽了也不至于把危险工具带出去）
      if (tier === "custom") {
        const rules: PermissionRules = settings.rules;
        if (anyPermissionRuleMatches(rules.deny, toolName)) {
          return {
            decision: "deny",
            reason: `工具 ${toolName} 命中自定义规则里的拒绝项（设置 → 权限 → 自定义）`,
          };
        }
        if (anyPermissionRuleMatches(rules.allow, toolName)) {
          return { decision: "allow" };
        }
        // 都没命中 → 回落 default 档的判定
      }
      if (!isDangerousCall({ toolName, ...(access ? { access } : {}) })) {
        return { decision: "allow" };
      }
      if (tier === "auto-approve") {
        return { decision: "allow" };
      }
      // default（或 custom 未命中规则）：危险工具需要审批记忆
      if (foreverApproved.has(toolName)) {
        return { decision: "allow" };
      }
      if (threadId && threadApproved.has(`${threadId}:${toolName}`)) {
        return { decision: "allow" };
      }
      return {
        decision: "deny",
        reason: `工具 ${toolName} 属危险操作，需在「设置 → 权限 → 工具审批」批准（${TIER_LABELS[tier]}）`,
      };
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
