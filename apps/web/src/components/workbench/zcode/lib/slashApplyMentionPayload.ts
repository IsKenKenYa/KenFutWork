/**
 * zcode 照搬：`@/lib/slashApplyMentionPayload.ts`（references/zcode/packages/ui/src/lib/slashApplyMentionPayload.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
import type { PromptInputSuggestionItem } from "@zui/lib/promptInputTriggers";
import {
  buildSkillMentionMarkdown,
  buildSubagentMentionMarkdown,
} from "@zui/mentions/mentionMarkdown";
import type { PromptMentionPayload } from "@zui/mentions/nodes/PromptMentionNode";
import { normalizeSlashCommandValue } from "@zui/slashCommandHelpers";

/** 将 `/` 面板选中的建议转成 PromptMention 载荷；skill/subagent 仍复用既有 $skill 与 @agent markdown 语义。 */
export function buildSlashApplyMentionPayload(
  suggestion: PromptInputSuggestionItem,
): PromptMentionPayload {
  if (suggestion.id.startsWith("skill:")) {
    return {
      id: suggestion.id,
      category: "skills",
      label: suggestion.value,
      value: suggestion.value,
      markdown: buildSkillMentionMarkdown(
        suggestion.value,
        suggestion.data?.path,
      ),
      description: suggestion.description,
      data: suggestion.data,
    };
  }

  if (suggestion.id.startsWith("subagent:")) {
    return {
      id: suggestion.id,
      category: "subagents",
      label: suggestion.value,
      value: suggestion.value,
      markdown: buildSubagentMentionMarkdown(suggestion.value),
      description: suggestion.description,
      data: suggestion.data,
    };
  }

  const commandValue = normalizeSlashCommandValue(suggestion.value);
  return {
    id: suggestion.id,
    category: "commands",
    label: commandValue,
    value: commandValue,
    markdown: `/${commandValue}`,
    description: suggestion.description,
  };
}
