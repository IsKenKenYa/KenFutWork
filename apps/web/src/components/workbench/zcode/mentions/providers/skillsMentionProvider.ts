/**
 * zcode 照搬：`@/mentions/providers/skillsMentionProvider.ts`（references/zcode/packages/ui/src/mentions/providers/skillsMentionProvider.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import { useSkills } from "@zui/hooks/useSkills";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import {
  resolveSkillDisplayDescription,
  resolveSkillSourceLabel,
} from "@zui/lib/builtinSkillI18n";
import { filterSkillsForProvider } from "@zui/lib/skillSourceFilter";
import type { Locale, SkillScope, ZCodeProvider } from "@zui/lib/zcode-shared";
import { buildSkillMentionMarkdown } from "@zui/mentions/mentionMarkdown";
import { filterMentionItemsWithOptions } from "@zui/mentions/mentionSearch";
import type {
  MentionCategoryResult,
  MentionItem,
} from "@zui/mentions/mentionTypes";
import { useMemo } from "react";

export function mapSkillsToMentionItemsForTest(
  skills: Array<{
    id: string;
    name: string;
    description: string;
    path: string;
    scope: SkillScope;
    pluginName?: string | undefined;
  }>,
  locale?: Locale,
): MentionItem[] {
  const uniqueSkillsByName = new Map<string, (typeof skills)[number]>();
  const scopePriority: Record<SkillScope, number> = {
    workspace: 0,
    plugin: 1,
    user: 2,
  };
  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase();
    const current = uniqueSkillsByName.get(key);
    // `$` 面板是执行入口，不是来源管理页。
    // 同名技能如果来自 workspace/user/plugin 多个路径，继续全部展示会让用户看到“同一个 skill”重复刷屏。
    // 这里按名称折叠，并优先选择 workspace，其次 plugin，最后 user；Settings 页仍保留完整来源列表用于管理。
    if (!current || scopePriority[skill.scope] < scopePriority[current.scope]) {
      uniqueSkillsByName.set(key, skill);
    }
  }
  const uniqueSkills = [...uniqueSkillsByName.values()];

  return uniqueSkills.map((skill) => {
    const sourceLabel = resolveSkillSourceLabel(skill.scope, locale);
    const description = resolveSkillDisplayDescription(skill, locale);
    return {
      id: `skill:${skill.id}`,
      category: "skills",
      label: skill.name,
      description: description
        ? `${sourceLabel} · ${description}`
        : sourceLabel,
      value: skill.name,
      markdown: buildSkillMentionMarkdown(skill.name, skill.path),
      keywords: [
        ...new Set([skill.name, skill.description, description, skill.scope]),
      ],
      data: {
        path: skill.path,
        scope: skill.scope,
      },
    };
  });
}

export function useSkillsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  provider: ZCodeProvider,
  query: string,
  enabled: boolean,
  requireQuery: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const { locale } = useZCodeIntl();
  const { skills, loading, error } = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId,
    enabled,
  });

  const allItems = useMemo(
    () =>
      mapSkillsToMentionItemsForTest(
        filterSkillsForProvider(skills, provider).filter(
          (skill) => skill.enabled,
        ),
        locale,
      ),
    [locale, provider, skills],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery,
      }),
    [allItems, query, requireQuery],
  );

  return {
    items: enabled ? items : [],
    loading,
    error: error ? new Error(error) : null,
    emptyText,
    title,
  };
}
