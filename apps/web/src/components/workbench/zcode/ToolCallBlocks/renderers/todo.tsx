/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/todo.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/todo.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */

import { cn } from "@zui/components/lib/utils";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { ZCodePlanStep } from "@zui/lib/zcode-shared";
import {
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
} from "@zui/lib/zcode-shared";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared";
import { ToolCallBody } from "@zui/ToolCallBlocks/ToolCallBody";
import { ToolLayout } from "@zui/ToolCallBlocks/ToolLayout";
import { ToolSnapshotFieldNotice } from "@zui/ToolCallBlocks/ToolSnapshotFieldNotice";
import {
  ArrowRightIcon,
  CircleCheckIcon,
  CircleIcon,
  ListTodoIcon,
} from "lucide-react";
import { useCallback, useMemo } from "react";

const TODO_TOOL_ICON = (
  <ListTodoIcon className="size-4 shrink-0 text-foreground-subtle" />
);

const todoTextClasses: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "text-foreground",
  completed: "text-foreground-subtlest line-through",
};

function readTodoPlan(
  context: ToolCallBlockRenderContext,
): ZCodePlanStep[] | null {
  const { toolCall } = context.toolCallNode;
  return (
    extractPlanStepsFromToolOutput({
      title: toolCall.title,
      kind: toolCall.kind,
      output: toolCall.output,
    }) ??
    extractPlanStepsFromToolInput({
      title: toolCall.title,
      kind: toolCall.kind,
      input: toolCall.input,
    })
  );
}

function TodoStatusIcon({ status }: { status: ZCodePlanStep["status"] }) {
  if (status === "completed") {
    return <CircleCheckIcon className="size-3.5 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    // 工具输出里的 todo running 状态会长时间留在页面上；
    // 用静态箭头表达当前项，避免和加载动画语义混在一起。
    return <ArrowRightIcon className="size-3.5 shrink-0 text-foreground" />;
  }
  return <CircleIcon className="size-3.5 shrink-0 text-foreground-subtlest" />;
}

export function TodoToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const plan = readTodoPlan(context);
  const completedCount =
    plan?.filter((step) => step.status === "completed").length ?? 0;
  const activeStep =
    plan?.find((step) => step.status === "in_progress") ??
    plan?.find((step) => step.status !== "completed") ??
    plan?.at(-1);
  const kindLabel = intl.formatMessage({ id: "todo.panel.title" });
  const primaryText =
    activeStep?.title ??
    toolCall.title ??
    intl.formatMessage({ id: "todo.panel.currentTask" });
  const secondaryText = plan
    ? `${completedCount}/${plan.length}`
    : context.statusLabel;
  const primaryTextNode = useMemo(
    () => (
      <span className="min-w-0 truncate text-foreground-subtlest">
        {primaryText}
      </span>
    ),
    [primaryText],
  );
  const secondaryTextNode = useMemo(
    () => (
      <span className="shrink-0 font-mono text-ui-base text-foreground-subtlest">
        {secondaryText}
      </span>
    ),
    [secondaryText],
  );
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () =>
      plan ? (
        <div className="space-y-1 rounded-xl bg-surface px-3 py-2">
          {plan.map((step) => (
            <div key={step.id} className="flex min-w-0 items-center gap-2 py-1">
              <TodoStatusIcon status={step.status} />
              <span
                className={cn(
                  "min-w-0 break-words text-ui-base",
                  todoTextClasses[step.status],
                )}
              >
                {step.title}
              </span>
            </div>
          ))}
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              handleLoadFullToolCallFields
                ? () => handleLoadFullToolCallFields(toolCall.toolId)
                : undefined
            }
          />
        </div>
      ) : (
        <>
          <ToolCallBody
            childToolList={context.childToolList}
            displayModel={context.displayModel}
            toolCall={toolCall}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              handleLoadFullToolCallFields
                ? () => handleLoadFullToolCallFields(toolCall.toolId)
                : undefined
            }
          />
        </>
      ),
    [
      context.childToolList,
      context.codePreviewSettings,
      context.displayModel,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      handleLoadFullToolCallFields,
      plan,
      toolCall,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={TODO_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={kindLabel}
      sourceLabel={context.sourceLabel}
      primaryText={primaryTextNode}
      secondaryText={secondaryTextNode}
      statusLabel={
        toolCall.status === "failed" ? context.statusLabel : undefined
      }
      statusTooltip={
        toolCall.status === "failed" ? context.errorText : undefined
      }
      showFailureStatus={toolCall.status === "failed"}
      isRunning={context.isRunning}
      title={toolCall.title}
      renderContent={renderContent}
    />
  );
}
