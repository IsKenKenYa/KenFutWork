/**
 * zcode 照搬：`@/v4/legacyChatViewTypes.ts`（references/zcode/packages/ui/src/v4/legacyChatViewTypes.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀；源文件自带头注保留于下。
 */
/** 竖切后 ChatView 已删；保留 shell / command-center 仍引用的最小类型。 */
export interface ChatSearchResultHighlightRequest {
  requestId: number;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  query: string;
  snippet?: string;
  snippetIndex?: number;
}

export interface ConversationFindMatchState {
  matchCount: number;
  activeIndex?: number;
}

export type ChatViewSummaryPanelVariant = "panel" | "mini";
