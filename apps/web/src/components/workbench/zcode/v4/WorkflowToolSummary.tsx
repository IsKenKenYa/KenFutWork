/**
 * zcode 照搬：`@/v4/WorkflowToolSummary.tsx`（references/zcode/packages/ui/src/v4/WorkflowToolSummary.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import { WORKFLOW_CARD_ICON } from "@zui/components/workflow-timeline/WorkflowCardChrome";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { WorkflowRunCardSummary } from "@zui/ToolCallBlocks/shared";
import { ToolLayout } from "@zui/ToolCallBlocks/ToolLayout";
import { ArrowUpRightIcon } from "lucide-react";
import { useMemo } from "react";

export function WorkflowToolSummary({
  toolCallId,
  summary,
  onOpen,
  amend = false,
}: {
  toolCallId: string;
  summary: WorkflowRunCardSummary;
  onOpen?: (() => void) | undefined;
  /** AmendWorkflow 发起行：种类词换成「工作流已调整」。 */
  amend?: boolean | undefined;
}) {
  const { intl } = useZCodeIntl();
  // ToolLayout 是 memo 组件：primaryText 若是内联 JSX，每次渲染都会打破 memo（reactStableReferences 测试会拦下）。
  // 计数只说子代理；宿主没给子代理数时那一段留空，只剩 ↗。
  const agents = summary.agents;
  const primaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden={true}>·</span>
        <span
          data-testid="workflow-summary-agents"
          className={
            onOpen
              ? "inline-flex items-center gap-2 group-hover/tool-summary:text-foreground group-focus-visible/tool-summary:text-foreground"
              : "inline-flex items-center gap-2"
          }
        >
          {agents === undefined
            ? null
            : intl.formatMessage(
                {
                  id:
                    agents === 1
                      ? "chat.toolCall.workflow.card.agent"
                      : "chat.toolCall.workflow.card.agents",
                },
                { count: agents },
              )}
          {onOpen ? (
            <ArrowUpRightIcon aria-hidden={true} className="size-4 shrink-0" />
          ) : null}
        </span>
      </span>
    ),
    [agents, intl, onOpen],
  );
  return (
    <div
      data-testid="workflow-tool-summary"
      data-tool-call-id={toolCallId}
      data-workflow-run-id={summary.runId}
    >
      <ToolLayout
        toolId={toolCallId}
        icon={WORKFLOW_CARD_ICON}
        kindLabel={intl.formatMessage({
          id: amend
            ? "chat.toolCall.workflow.amend.amended"
            : "chat.toolCall.workflow.ran",
        })}
        canToggle={false}
        primaryText={primaryText}
        summaryAction={
          onOpen
            ? {
                ariaLabel: intl.formatMessage({
                  id: "chat.toolCall.workflow.openRunDetails",
                }),
                onActivate: onOpen,
              }
            : undefined
        }
      />
    </div>
  );
}
