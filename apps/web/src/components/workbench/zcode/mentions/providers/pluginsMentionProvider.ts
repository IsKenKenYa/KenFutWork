/**
 * zcode 照搬：`@/mentions/providers/pluginsMentionProvider.ts`（references/zcode/packages/ui/src/mentions/providers/pluginsMentionProvider.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import { useIsOfficeMode } from "@zui/hooks/useInterfaceMode";
import { usePluginReferenceCatalog } from "@zui/hooks/usePluginReferenceCatalog";
import { usePluginStoreOrder } from "@zui/hooks/usePluginStoreOrder";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import {
  isPublicStoreMarketplaceId,
  type PluginStoreModeOrder,
  resolveLocalizedText,
  resolvePluginDisplayName,
  sortPluginStoreEntries,
  type ZCodePluginReferenceCatalogEntry,
} from "@zui/lib/zcode-shared";
import { buildPluginMentionMarkdown } from "@zui/mentions/mentionMarkdown";
import { filterMentionItemsWithOptions } from "@zui/mentions/mentionSearch";
import type {
  MentionCategoryResult,
  MentionItem,
} from "@zui/mentions/mentionTypes";
import { useMemo } from "react";

interface PluginMentionLabels {
  conflictReason: string;
}

// - 只展示 catalog 中 enabled 的 Plugin；disabled 条目不可被引用，不进入候选。
// - 同名 manifest 冲突（conflictingPluginIds 非空）保持可见但禁选，展示冲突原因（V1 fail closed）。
// - markdown 载体固定 `[@Label](plugin://stable-id)`；label 仅展示，身份在 destination。
//   面板展示名 displayLabel 按当前 locale 走全 app 统一的 resolvePluginDisplayName；label 与
//   载体 label 固定 entry.name，chip/canonical text/reminder 不随 locale 变化（chip 节点复用
//   item.label，若本地化 label 会与按 markdown 重建的消息气泡文案分裂）。
// - keywords 并入 listing 的全部语言显示名（无论当前 locale）：英文界面下打中文
//   也能搜到官方插件（插件 @ 引用中文搜索）。
function mapPluginCatalogToMentionItemsForTest(
  entries: ZCodePluginReferenceCatalogEntry[],
  labels: PluginMentionLabels,
  locale: string,
  order?: PluginStoreModeOrder,
): MentionItem[] {
  const sorted =
    order && entries.some((entry) => entry.category !== undefined)
      ? [
          ...sortPluginStoreEntries(
            entries.filter((entry) =>
              isPublicStoreMarketplaceId(entry.marketplace),
            ),
            (entry) => ({
              id: entry.pluginId,
              category: entry.category,
              displayName: resolvePluginDisplayName(
                {
                  name: entry.name,
                  listing: {
                    displayName: entry.displayName,
                    displayNameI18n: entry.displayNameI18n,
                  },
                },
                locale,
              ),
            }),
            locale,
            order,
          ),
          ...entries.filter(
            (entry) => !isPublicStoreMarketplaceId(entry.marketplace),
          ),
        ]
      : entries;
  return sorted
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const conflicted = entry.conflictingPluginIds.length > 0;
      return {
        id: `plugin:${entry.pluginId}`,
        category: "plugins" as const,
        label: entry.name,
        displayLabel: resolvePluginDisplayName(
          {
            name: entry.name,
            listing: {
              displayName: entry.displayName,
              displayNameI18n: entry.displayNameI18n,
            },
          },
          locale,
        ),
        description:
          resolveLocalizedText(
            locale,
            entry.description,
            entry.descriptionI18n,
          ) ?? "",
        value: entry.pluginId,
        markdown: buildPluginMentionMarkdown(entry.name, entry.pluginId),
        keywords: [
          entry.name,
          entry.pluginId,
          entry.marketplace,
          ...(entry.displayName ? [entry.displayName] : []),
          ...Object.values(entry.displayNameI18n ?? {}),
        ],
        data: {
          pluginId: entry.pluginId,
          ...(entry.icon ? { icon: entry.icon } : {}),
        },
        ...(conflicted
          ? {
              disabled: true,
              disabledReason: labels.conflictReason,
            }
          : {}),
      };
    });
}

export function usePluginsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const { intl, locale } = useZCodeIntl();
  const { order } = usePluginStoreOrder(enabled);
  const isOfficeMode = useIsOfficeMode();
  const modeOrder = isOfficeMode ? order?.work : order?.code;
  const catalog = usePluginReferenceCatalog(
    workspacePath,
    workspaceIdentity,
    sessionId,
    enabled,
  );

  const allItems = useMemo(
    () =>
      mapPluginCatalogToMentionItemsForTest(
        catalog.entries,
        {
          conflictReason: intl.formatMessage({
            id: "chat.mention.plugins.conflict",
          }),
        },
        locale,
        modeOrder,
      ),
    [catalog.entries, intl, locale, modeOrder],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery: false,
      }),
    [allItems, query],
  );

  return {
    items: enabled ? items : [],
    loading: catalog.loading,
    error: catalog.error ? new Error(catalog.error) : null,
    emptyText,
    title,
  };
}
