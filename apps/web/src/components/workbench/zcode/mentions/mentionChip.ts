/**
 * zcode 照搬：`@/mentions/mentionChip.ts`（references/zcode/packages/ui/src/mentions/mentionChip.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import type { MentionCategory } from "@zui/mentions/mentionTypes";

export const PROMPT_MENTION_BASE_CLASS_NAME =
  // inline-flex token 用 align-middle 会按父文本基线 + x-height 对齐，不是和行盒视觉中心对齐。
  // 在输入框里 token 后继续输入正文时会低约 1px；align-top 让同 line-height 的 token 和正文共用行盒顶部基准。
  "inline-flex cursor-default items-center gap-1 align-top text-ui-base leading-5 font-medium";

export function getPromptMentionVariantClassName(
  category: MentionCategory,
): string {
  if (category === "skills") {
    return "text-skill-node-foreground";
  }
  if (category === "subagents") {
    return "text-subagent-node-foreground";
  }
  if (category === "commands") {
    return "text-command-node-foreground capitalize";
  }
  if (category === "sessions") {
    return "text-session-node-foreground";
  }
  if (category === "plugins") {
    return "text-plugin-node-foreground";
  }
  if (category === "whiteboards") {
    return "text-file-node-foreground";
  }
  return "text-file-node-foreground";
}
