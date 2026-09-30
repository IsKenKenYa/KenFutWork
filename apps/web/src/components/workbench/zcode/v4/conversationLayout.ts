/**
 * zcode 照搬：`@/v4/conversationLayout.ts`（references/zcode/packages/ui/src/v4/conversationLayout.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀。
 */
import type { ChatViewSummaryPanelVariant } from "@zui/v4/legacyChatViewTypes";

const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-2xl";
const CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
const CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
const CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME =
  "@min-[1280px]/conversation:-translate-x-42";

type ConversationStatusPanelResolvedVariant =
  | ChatViewSummaryPanelVariant
  | "auto";

export function getConversationContentWidthClassName(params: {
  centeredEmptyLayout: boolean;
  statusPanelLayout: "none" | "auto" | "inline";
}): string {
  if (params.centeredEmptyLayout)
    return CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME;

  // 宽布局统一使用 1280px，避免面板状态变化时触发不同断点造成内容列跳变。
  return params.statusPanelLayout === "none"
    ? CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME
    : CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME;
}

export function resolveConversationStatusPanelVariant(params: {
  variantOverride: ConversationStatusPanelResolvedVariant | null;
}): ConversationStatusPanelResolvedVariant {
  // 自动模式必须保留到 DOM，由 conversation container query 裁决实际形态；
  // React 不再通过 ResizeObserver 把容器宽度翻译成业务状态。
  return params.variantOverride ?? "auto";
}

export function shouldUseConversationStatusPanelInlineLayout(params: {
  hasContent: boolean;
  variant: ConversationStatusPanelResolvedVariant;
}): boolean {
  return params.hasContent && params.variant !== "mini";
}

export function getConversationStatusPanelOffsetClassName(
  layout: "none" | "auto" | "inline",
): string | undefined {
  // 状态面板和会话宽布局统一在 1280px 启用，保证面板状态切换不改变响应分水岭。
  return layout === "none"
    ? undefined
    : CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME;
}
