import type {
  PermissionRules,
  PermissionScenario,
  PermissionTier,
} from "@kenfutwork/shared";
import { anyPermissionRuleMatches } from "@kenfutwork/shared";

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
}

export interface PermissionService {
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
  }): PermissionDecision;
  /** 审批（只能由人审 UI 触发，agent 无路径自我授权）。 */
  approve(toolName: string, approval: ToolApproval): void;
  listApprovedForever(): string[];
}

export function createPermissionService(): PermissionService {
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

  const service: PermissionService = {
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
      for (const toolName of next.approvedForever) foreverApproved.add(toolName);
    },
    evaluate({ toolName, threadId, scenario = "interactive" }) {
      const tier = tierFor(threadId, scenario);
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
      if (!isDangerousTool(toolName)) {
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
      if (approval.scope === "forever") {
        foreverApproved.add(toolName);
      } else if (approval.scope === "thread" && approval.threadId) {
        threadApproved.add(`${approval.threadId}:${toolName}`);
      }
      // "once"：不记忆，本次放行由调用方直接执行
    },
    listApprovedForever() {
      return [...foreverApproved];
    },
  };
  return service;
}
