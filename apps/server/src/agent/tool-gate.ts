import type { ToolGate } from "./deep-agent.js";

/**
 * 工具门组合器：把**多个维度**的判定合并成一个 `ToolGate`。
 *
 * 为什么需要它：执行模式（solo/plan）与权限档（default 危险工具需审批）是两套独立策略，
 * 但只有 `wrapToolCall` 这一个中间件能拦到 **deepagents 内置工具**（execute / write_file /
 * edit_file）——内置工具不经过 `ctx.tools.execute`，`tool-pre-execute` 事件缝对它们不触发。
 * 实测后果：默认「需审批」档下 agent 可以不经放行直接执行 shell 命令。
 *
 * 组合语义：任一维度拒绝即拒绝（模式优先给出理由），全放行才放行。
 */
export interface ToolGateSources {
  /** 执行模式硬约束（solo 全禁 / plan 只读）。 */
  modeVerdict: (
    toolName: string,
  ) => { allowed: true } | { allowed: false; reason: string };
  /** 权限档判定；未挂载权限缝时省略（该维度不设限）。 */
  permissionVerdict?: (
    toolName: string,
  ) => { allowed: true } | { allowed: false; reason: string } | undefined;
}

export function composeToolGate(sources: ToolGateSources): ToolGate {
  return (toolName) => {
    const mode = sources.modeVerdict(toolName);
    if (!mode.allowed) {
      return mode;
    }
    const permission = sources.permissionVerdict?.(toolName);
    if (permission && !permission.allowed) {
      return permission;
    }
    return { allowed: true };
  };
}
