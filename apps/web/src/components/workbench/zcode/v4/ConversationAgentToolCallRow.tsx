/**
 * zcode 照搬：`@/v4/ConversationAgentToolCallRow.tsx`（references/zcode/packages/ui/src/v4/ConversationAgentToolCallRow.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件接口可选属性放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */

import { runUserAction } from "@zui/lib/userActionTelemetry";
import {
  TID_V4_ROW,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  testId,
} from "@zui/lib/zcode-shared";
import { ToolCallBlock } from "@zui/ToolCallBlocks";
import { getAgentPrimaryText } from "@zui/ToolCallBlocks/renderers/agentHelpers";
import type { ConversationAssistantWorkRenderItem } from "@zui/v4/conversationAssistantWorkItems";
import type { ConversationRowRenderContext } from "@zui/v4/conversationRowContext";
import { toolCallRowToLegacyNode } from "@zui/v4/toolCallRowAdapter";
import { useCallback, useMemo } from "react";

function openSubagentSessionFromSummary({
  backgrounded: _backgrounded = false,
  childSessionId,
  context,
  subagentType,
  title,
}: {
  backgrounded?: boolean | undefined;
  childSessionId?: string | undefined;
  context: ConversationRowRenderContext;
  subagentType: string;
  title: string;
}): boolean {
  const parentSessionId = context.sessionId;
  const onOpenSubagentSession = context.onOpenSubagentSession;
  if (!childSessionId || !parentSessionId || !onOpenSubagentSession) {
    return false;
  }

  onOpenSubagentSession({
    rootSessionId: context.rootSessionId ?? parentSessionId,
    parentSessionId,
    childSessionId,
    subagentType,
    title,
  });
  return true;
}

export function ConversationAgentToolCallRow({
  item,
  context,
}: {
  item: Extract<ConversationAssistantWorkRenderItem, { kind: "agentToolCall" }>;
  context: ConversationRowRenderContext;
}) {
  const toolCallNode = useMemo(
    () => toolCallRowToLegacyNode(item.row),
    [item.row],
  );
  const childSessionId = item.subagentRow.childSessionId;
  const subagentType = item.subagentRow.subagentType;
  // 与 Agent 摘要行复用同一 title resolver，保证右侧 tab 和用户点击的可见标题逐字一致。
  const title = getAgentPrimaryText(toolCallNode.toolCall, "");
  const canOpenChildSession = Boolean(
    childSessionId && context.sessionId && context.onOpenSubagentSession,
  );
  const handleOpenChildSession = useCallback(() => {
    runUserAction({
      input: {
        featureId: "conversation.subagent",
        action: "open_side_pane",
        trigger: "button",
      },
      operation: () =>
        openSubagentSessionFromSummary({
          childSessionId,
          context,
          subagentType,
          title,
        }),
      completed: { resultSource: "local_commit" },
      failureStage: "subagent_open",
    });
  }, [childSessionId, context, subagentType, title]);
  const agentSummaryAction = useMemo(
    () =>
      canOpenChildSession && childSessionId
        ? {
            onActivate: handleOpenChildSession,
            testId: testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, childSessionId),
          }
        : undefined,
    [canOpenChildSession, childSessionId, handleOpenChildSession],
  );

  // Agent 工具行和普通工具行同属工作流，不能在配对壳上额外加 px-4，
  // 否则会和未配对 toolCall 行产生左右缩进差异。
  return (
    <div
      data-row-id={item.row.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.row.rowId))}
    >
      <ToolCallBlock
        toolCallNode={toolCallNode}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        agentSummaryAction={agentSummaryAction}
        authoritativeAgentType={subagentType}
      />
    </div>
  );
}
