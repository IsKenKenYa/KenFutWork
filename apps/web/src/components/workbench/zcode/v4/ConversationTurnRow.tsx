/**
 * zcode 照搬：`@/v4/ConversationTurnRow.tsx`（references/zcode/packages/ui/src/v4/ConversationTurnRow.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */

import type { AssistantCodeCommentCard } from "@zui/lib/assistantCodeComment";
import type { AssistantPreviewCard } from "@zui/lib/assistantPreviewCards";
import { extractPlanToolCallContent } from "@zui/lib/planToolCall";
import type {
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
} from "@zui/lib/zcode-shared/zcode-protocol-v4";
import type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
} from "@zui/v4/ConversationRowView";
import { ConversationRowView } from "@zui/v4/ConversationRowView";
import type { ConversationRowRenderContext } from "@zui/v4/conversationRowContext";
import type { ConversationTurnRenderUnit } from "@zui/v4/conversationTurnRenderUnits";
import { toolCallRowToLegacyNode } from "@zui/v4/toolCallRowAdapter";

interface ConversationTurnRowProps {
  row: ConversationRow;
  context: ConversationRowRenderContext;
  onFork?: ((target: ConversationRowTarget) => void | undefined) | undefined;
  onRetry?: ((target: ConversationRowTarget) => void | undefined) | undefined;
  onFeedbackChange?: AssistantFeedbackHandler | undefined;
  onEdit?:
    | ((
        target: ConversationRowTarget,
        newText: string,
        attachments?: readonly AttachmentRef[] | undefined,
        workspaceMode?: "preserve" | "rewind" | undefined,
      ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void)
    | undefined;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability | undefined;
  hideAssistantActions?: boolean | undefined;
  deferAssistantActions?: boolean | undefined;
  assistantCopyText?: string | undefined;
  assistantPreviewCards?: AssistantPreviewCard[] | undefined;
  assistantPreviewCardsAutoOpenKey?: string | undefined;
  assistantCodeCommentCards?: AssistantCodeCommentCard[] | undefined;
  assistantCodeCommentProjectionEnabled?: boolean | undefined;
  reasoningContentVariant?: "default" | "nested" | undefined;
  userInputStatus?: string | undefined;
}

export function ConversationTurnRow({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationTurnRowProps) {
  return (
    <ConversationRowView
      row={row}
      context={context}
      onFork={onFork}
      onRetry={onRetry}
      onFeedbackChange={onFeedbackChange}
      onEdit={onEdit}
      editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
      hideAssistantActions={hideAssistantActions}
      deferAssistantActions={deferAssistantActions}
      assistantCopyText={assistantCopyText}
      assistantPreviewCards={assistantPreviewCards}
      assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
      assistantCodeCommentCards={assistantCodeCommentCards}
      assistantCodeCommentProjectionEnabled={
        assistantCodeCommentProjectionEnabled
      }
      reasoningContentVariant={reasoningContentVariant}
      userInputStatus={userInputStatus}
    />
  );
}

export function resolveAssistantCopyText(
  unit: ConversationTurnRenderUnit,
): string | undefined {
  if (!unit.latestAssistantTextRow) {
    return undefined;
  }

  const segments =
    unit.assistantTextRows.length > 0
      ? unit.assistantTextRows.map((segment) => segment.text)
      : [unit.latestAssistantTextRow.text];
  const includedSegments = new Set(segments);
  for (const row of unit.assistantWorkRows) {
    if (row.kind !== "toolCall" || row.toolName !== "ExitPlanMode") continue;
    const markdown = extractPlanToolCallContent(
      toolCallRowToLegacyNode(row).toolCall,
      "",
    ).markdown;
    if (!markdown || includedSegments.has(markdown)) continue;
    // 产品边界：assistant 复制代表本轮完整可见回答。计划正文来自原位结构化 tool row，
    // 不能读取被 max-height/mask 裁切的卡片 DOM，也不能顺手混入普通工具输出。
    segments.push(markdown);
    includedSegments.add(markdown);
  }
  return segments.join("\n\n");
}
