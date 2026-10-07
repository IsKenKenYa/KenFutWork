import { buildPluginMentionMarkdown } from "@zui/mentions/mentionMarkdown.js";
import type { ComposerMentionPrefill } from "@zui/store/zcodeSessionStoreTypes.js";

interface DraftSuggestedPromptPluginReference {
  stableId: string;
  label: string;
}

export function buildDraftSuggestedPluginMention(
  plugin: DraftSuggestedPromptPluginReference,
  icon?: string,
): ComposerMentionPrefill {
  const markdown = buildPluginMentionMarkdown(plugin.label, plugin.stableId);
  return {
    id: `plugin:${plugin.stableId}`,
    category: "plugins",
    label: plugin.label,
    value: plugin.stableId,
    markdown,
    data: {
      pluginId: plugin.stableId,
      ...(icon ? { icon } : {}),
    },
  };
}
