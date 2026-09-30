/**
 * zcode 照搬：`@/slashCommandPanelSections.tsx`（references/zcode/packages/ui/src/slashCommandPanelSections.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import type { IntlInstance } from "@zui/i18n/IntlProvider";
import type { PromptInputSuggestionItem } from "@zui/lib/promptInputTriggers";
import type {
  MentionPanelOption,
  MentionPanelSection,
} from "@zui/mentions/components/MentionPanel";
import { useMemo } from "react";

export function useSlashCommandMentionPanelSections(
  intl: IntlInstance,
  commandsLength: number,
  filteredCommandSuggestions: PromptInputSuggestionItem[],
  filteredSkillSuggestions: PromptInputSuggestionItem[],
  skillsLoading: boolean,
  skillsError: string | null,
  filteredSubagentSuggestions: PromptInputSuggestionItem[],
  subagentsLoading: boolean,
  subagentsError: string | null,
): MentionPanelSection[] {
  return useMemo(
    () => [
      {
        id: "commands",
        title: intl.formatMessage({ id: "chat.slash.commands.title" }),
        options: filteredCommandSuggestions.map<MentionPanelOption>(
          (suggestion) => ({
            id: suggestion.id,
            label: `/${suggestion.value}`,
            description: suggestion.description,
            content: (
              <span className="min-w-0 flex-1 flex items-center gap-2">
                <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                  {`/${suggestion.value}`}
                </span>
                <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                  {suggestion.description}
                </span>
              </span>
            ),
          }),
        ),
        loading: false,
        emptyText:
          commandsLength === 0
            ? intl.formatMessage({ id: "chat.slash.emptyUnavailable" })
            : intl.formatMessage({ id: "chat.slash.emptyResults" }),
      },
      {
        id: "skills",
        title: intl.formatMessage({ id: "chat.slash.skills.title" }),
        options: filteredSkillSuggestions.map<MentionPanelOption>(
          (suggestion) => ({
            id: suggestion.id,
            label: `$${suggestion.value}`,
            description: suggestion.description,
            content: (
              <span className="min-w-0 flex-1 flex items-center gap-2">
                <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                  {`$${suggestion.value}`}
                </span>
                <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                  {suggestion.description}
                </span>
              </span>
            ),
          }),
        ),
        loading: skillsLoading,
        loadingText: intl.formatMessage({
          id: "chat.mention.category.loading",
        }),
        emptyText: intl.formatMessage({ id: "chat.slash.skills.empty" }),
        errorText: skillsError,
      },
      {
        id: "subagents",
        title: intl.formatMessage({ id: "chat.slash.subagents.title" }),
        options: filteredSubagentSuggestions.map<MentionPanelOption>(
          (suggestion) => ({
            id: suggestion.id,
            label: suggestion.value,
            description: suggestion.description,
            content: (
              <span className="min-w-0 flex-1 flex items-center gap-2">
                <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                  {suggestion.value}
                </span>
                <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                  {suggestion.description}
                </span>
              </span>
            ),
          }),
        ),
        loading: subagentsLoading,
        emptyText: intl.formatMessage({ id: "chat.slash.subagents.empty" }),
        errorText: subagentsError,
      },
    ],
    [
      commandsLength,
      filteredCommandSuggestions,
      filteredSkillSuggestions,
      filteredSubagentSuggestions,
      intl,
      skillsError,
      skillsLoading,
      subagentsError,
      subagentsLoading,
    ],
  );
}
