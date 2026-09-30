/**
 * zcode 照搬：`@/mentions/mentionPanelRouting.ts`（references/zcode/packages/ui/src/mentions/mentionPanelRouting.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import type { PromptInputTrigger } from "@zui/lib/promptInputTriggers";

export type MentionPanelGroupId =
  | "plugins"
  | "files"
  | "sessions"
  | "whiteboards"
  | "skills";
export type SessionMentionWorkspaceScope =
  | "current-workspace"
  | "same-authority-workspaces";

const CONTEXT_GROUP_ORDER: readonly MentionPanelGroupId[] = [
  "plugins",
  "files",
  "sessions",
  "whiteboards",
];
const SESSION_GROUP_ORDER: readonly MentionPanelGroupId[] = ["sessions"];
const SKILL_GROUP_ORDER: readonly MentionPanelGroupId[] = ["skills"];

/**
 * 输入触发器只负责发现入口，不改变候选选中后的 canonical mention。
 * `#` 与 `$`（含输入层归一后的 `¥` / `￥`）继续保留旧单分组面板。
 */
export function getMentionPanelGroupOrder(
  trigger: PromptInputTrigger | null | undefined,
): readonly MentionPanelGroupId[] {
  if (trigger === "@") {
    return CONTEXT_GROUP_ORDER;
  }
  if (trigger === "#") {
    return SESSION_GROUP_ORDER;
  }
  if (trigger === "$") {
    return SKILL_GROUP_ORDER;
  }
  return [];
}

/**
 * `@` 与 `#` 虽然复用会话 provider，但产品范围不同。
 * 若在共享 provider 内无条件扩展 workspace，`@` 会被连带扩容；范围必须由触发器路由显式决定。
 */
export function getSessionMentionWorkspaceScope(
  trigger: PromptInputTrigger | null | undefined,
): SessionMentionWorkspaceScope {
  return trigger === "#" ? "same-authority-workspaces" : "current-workspace";
}
