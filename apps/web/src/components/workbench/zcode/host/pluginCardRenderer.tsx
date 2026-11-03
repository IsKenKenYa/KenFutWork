import type {
  PluginCardDeclaration,
  PluginCardStatus,
} from "@kenfutwork/shared";
import type { ToolCallRendererContribution } from "@zui/ToolCallBlocks/contributedRenderers.js";
import { FallbackToolCallBlock } from "@zui/ToolCallBlocks/renderers/fallback.js";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared.js";
import { ToolLayout } from "@zui/ToolCallBlocks/ToolLayout.js";
import { List } from "lucide-react";
import { findPluginCard } from "./pluginCards.js";

const STATUS_LABELS: Record<PluginCardStatus, string> = {
  success: "成功",
  failure: "失败",
  in_progress: "进行中",
};

export interface PluginCardView {
  kindLabel: string;
  title: string;
  rows: Array<{ key: string; label: string; value: string }>;
}

/** 卡片声明的视图数据：只做标签映射与字符串化，正文一律按纯文本显示。 */
export function pluginCardView(card: PluginCardDeclaration): PluginCardView {
  return {
    kindLabel: card.status ? STATUS_LABELS[card.status] : "插件卡片",
    title: card.title,
    rows: card.fields.map((field, index) => ({
      key: `${field.label}:${index}`,
      label: field.label,
      value: String(field.value),
    })),
  };
}

export function PluginCardToolCallBlock(context: ToolCallBlockRenderContext) {
  const tool = context.toolCallNode.toolCall;
  const card = findPluginCard(tool.toolName);
  if (!card) return <FallbackToolCallBlock {...context} />;
  const view = pluginCardView(card);
  return (
    <ToolLayout
      toolId={tool.toolId}
      icon={<List className="size-4" />}
      showIcon={context.showIcon !== false}
      kindLabel={view.kindLabel}
      primaryText={view.title}
      secondaryText={context.statusLabel}
      autoOpen
      canToggle
      renderContent={() => (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-xs">
            {view.rows.map((row) => (
              <div key={row.key} className="contents">
                <dt className="text-foreground-subtle">{row.label}</dt>
                <dd className="break-all">{row.value}</dd>
              </div>
            ))}
          </dl>
          {context.childToolList}
        </>
      )}
    />
  );
}

export const pluginCardRenderer: ToolCallRendererContribution = {
  id: "host.plugin-card",
  matches: (context) =>
    findPluginCard(context.toolCallNode.toolCall.toolName) !== null,
  component: PluginCardToolCallBlock,
};
