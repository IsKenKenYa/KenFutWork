/**
 * zcode 照搬：`@/mentions/promptMentionLabel.ts`（references/zcode/packages/ui/src/mentions/promptMentionLabel.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import type { MentionCategory } from "@zui/mentions/mentionTypes";

function unescapePromptMentionMarkdownText(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }
    result += text[index];
  }
  return result;
}

function extractPromptMentionMarkdownLabel(text: string): string | null {
  const matched =
    /^\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)$/.exec(
      text.trim(),
    );
  const label = matched?.[1];
  return label ? unescapePromptMentionMarkdownText(label) : null;
}

export function normalizePromptMentionDisplayLabel(
  category: MentionCategory,
  label: string,
  value: string,
): string {
  const markdownLabel = extractPromptMentionMarkdownLabel(label);
  let displayLabel = markdownLabel ?? label;

  if (category === "skills" && displayLabel.startsWith("$")) {
    displayLabel = displayLabel.slice(1);
  } else if (category === "sessions" && displayLabel.startsWith("#")) {
    displayLabel = displayLabel.slice(1);
  } else if (
    (category === "files" ||
      category === "subagents" ||
      category === "whiteboards" ||
      category === "plugins") &&
    displayLabel.startsWith("@")
  ) {
    displayLabel = displayLabel.slice(1);
  }

  // 旧草稿快照里可能把完整 markdown 链接写进 mention node 的 text 字段。
  // 这会让恢复后的 tag 图标还在，但文本显示成 `[$skill](path)` 原文。显示层只取人类可读 label，
  // markdown 字段继续保留完整原文用于发送。
  return displayLabel.trim() || value;
}
