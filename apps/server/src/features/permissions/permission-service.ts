import type { PermissionTier } from "@kenfutwork/shared";

/**
 * permissions 策略缝（DEC-4，P6）：
 * - 三档：default（危险操作 ask）/ auto-approve（命中已批准策略自动放行）/ full-access；
 * - 审批记忆粒度：本次（单次放行）/ 会话（thread 级）/ 永久（工具级）；
 * - agent 无「自我授权为永久」路径：approve 只能由外部（审批 UI）调用。
 * 拦截挂在 kernel 的 tool-pre-execute 事件上（permissions 插件订阅）。
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
  /** 单次决策：default 档危险工具在无审批记忆时要求 ask（返回 deny，等待人审后 approve）。 */
  evaluate(input: { toolName: string; threadId?: string }): PermissionDecision;
  /** 审批（只能由人审 UI 触发，agent 无路径自我授权）。 */
  approve(toolName: string, approval: ToolApproval): void;
  listApprovedForever(): string[];
}

export function createPermissionService(): PermissionService {
  let globalTier: PermissionTier = "default";
  const threadTiers = new Map<string, PermissionTier>();
  const foreverApproved = new Set<string>();
  const threadApproved = new Set<string>();

  return {
    getTier(threadId) {
      return (threadId && threadTiers.get(threadId)) || globalTier;
    },
    setTier(threadId, tier) {
      if (threadId) {
        threadTiers.set(threadId, tier);
      } else {
        globalTier = tier;
      }
    },
    evaluate({ toolName, threadId }) {
      const tier = this.getTier(threadId);
      if (tier === "full-access") {
        return { decision: "allow" };
      }
      if (!isDangerousTool(toolName)) {
        return { decision: "allow" };
      }
      if (tier === "auto-approve") {
        return { decision: "allow" };
      }
      // default 档：危险工具需要审批记忆
      if (foreverApproved.has(toolName)) {
        return { decision: "allow" };
      }
      if (threadId && threadApproved.has(`${threadId}:${toolName}`)) {
        return { decision: "allow" };
      }
      return {
        decision: "deny",
        reason: `工具 ${toolName} 属危险操作，等待用户审批（default 档）`,
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
}
