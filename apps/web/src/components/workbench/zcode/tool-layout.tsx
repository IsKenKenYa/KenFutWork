"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";

/**
 * zcode 工具块布局（references/zcode packages/ui ToolLayout.tsx + ToolSummaryRow.tsx
 * 照搬，剥离 i18n/tooltip 系统）：摘要行 + 可折叠详情。
 *
 * 关键交互全部照搬：
 * - 展开状态按 key 模块级持久化（切会话/虚拟重挂不丢）；
 * - kindLabel 运行态走 animated-gradient-text 流光，完成态 quiet（text-foreground-subtlest）；
 * - 失败才显示状态词（dotted 下划线 + title 提示）；成功不占文字（zcode 口径）；
 * - chevron size-4 hover 显现，展开 rotate-90；
 * - 收起详情延迟 300ms 卸载（高度动画测量保护，同 zcode）。
 */

/** 展开状态持久化表：key = persistOpenKey ?? toolId。 */
const toolLayoutOpenState = new Map<string, boolean>();
const CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;

export type ToolSummaryAction = {
  ariaLabel: string;
  onActivate: () => void;
};

export interface ToolSummaryRowProps {
  action?: ToolSummaryAction | undefined;
  canToggle: boolean;
  forceOpen: boolean;
  icon: ReactNode;
  showIcon: boolean;
  isExpanded: boolean;
  kindLabel?: ReactNode | undefined;
  kindLabelClassName: string;
  kindDetail?: ReactNode | undefined;
  sourceLabel?: ReactNode | undefined;
  primaryText?: ReactNode | undefined;
  secondaryText?: ReactNode | undefined;
  separator?: ReactNode | undefined;
  diffCount?: ReactNode | undefined;
  statusNode?: ReactNode;
  title?: string | undefined;
  toggleAriaLabel: string;
  toolId: string;
}

function SummaryLeadingContent({
  icon,
  showIcon,
  kindLabel,
  kindLabelClassName,
  kindDetail,
  sourceLabel,
}: Pick<
  ToolSummaryRowProps,
  | "icon"
  | "showIcon"
  | "kindLabel"
  | "kindLabelClassName"
  | "kindDetail"
  | "sourceLabel"
>) {
  return (
    <>
      {showIcon ? (
        <span className="shrink-0 text-foreground-subtlest [&_svg]:text-foreground-subtlest">
          {icon}
        </span>
      ) : null}
      {kindLabel != null && kindLabel !== false && kindLabel !== "" ? (
        <span
          className={`tool-summary-kind-label whitespace-nowrap ${kindLabelClassName}`}
        >
          {kindLabel}
        </span>
      ) : null}
      {kindDetail ? (
        <span className="min-w-0 shrink-0">{kindDetail}</span>
      ) : null}
      {sourceLabel ? (
        <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] leading-none text-foreground-subtlest">
          {sourceLabel}
        </span>
      ) : null}
    </>
  );
}

function SummaryContent({
  primaryText,
  secondaryText,
  separator,
  diffCount,
  statusNode,
}: Pick<
  ToolSummaryRowProps,
  "primaryText" | "secondaryText" | "separator" | "diffCount" | "statusNode"
>) {
  const hasSummaryContent = [
    primaryText,
    secondaryText,
    diffCount,
    statusNode,
  ].some((node) => node != null && node !== false && node !== "");
  if (!hasSummaryContent) return null;
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2 text-foreground-subtlest">
      {separator != null ? (
        <span className="shrink-0 text-foreground-subtlest">{separator}</span>
      ) : null}
      {primaryText}
      {secondaryText}
      {diffCount}
      {statusNode}
    </div>
  );
}

export function ToolSummaryRow(props: ToolSummaryRowProps) {
  const {
    action,
    canToggle,
    forceOpen,
    isExpanded,
    title,
    toggleAriaLabel,
    toolId: _toolId,
  } = props;
  const sharedContent = (
    <>
      <SummaryLeadingContent {...props} />
      <SummaryContent {...props} />
    </>
  );

  if (action) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: 摘要行内含可点子元素，button 嵌套非法
      <div
        role="button"
        tabIndex={0}
        aria-label={action.ariaLabel}
        onClick={action.onActivate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          action.onActivate();
        }}
        className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border"
        title={title}
      >
        {sharedContent}
      </div>
    );
  }

  if (canToggle) {
    return (
      <Collapsible.Trigger
        aria-label={toggleAriaLabel}
        className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border"
        title={title}
      >
        {sharedContent}
        <ChevronRight
          aria-hidden
          className={`size-4 shrink-0 text-foreground-subtlest opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover/tool-summary:opacity-100 ${
            isExpanded ? "rotate-90 opacity-100" : "rotate-0"
          } ${forceOpen ? "opacity-100" : ""}`}
        />
      </Collapsible.Trigger>
    );
  }

  return (
    <div
      className="group/tool-summary flex w-full cursor-default items-center gap-2 text-left text-ui-base transition-colors"
      title={title}
    >
      {sharedContent}
    </div>
  );
}

export interface ToolLayoutProps {
  toolId: string;
  persistOpenKey?: string | undefined;
  icon: ReactNode;
  showIcon?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  autoOpen?: boolean;
  autoCollapseOnComplete?: boolean;
  kindLabel?: ReactNode | undefined;
  kindDetail?: ReactNode | undefined;
  sourceLabel?: ReactNode | undefined;
  primaryText?: ReactNode | undefined;
  secondaryText?: ReactNode | undefined;
  separator?: ReactNode | undefined;
  hideSecondaryTextWhenOpen?: boolean;
  diffCount?: ReactNode | undefined;
  hideDiffCountWhenOpen?: boolean;
  statusLabel?: ReactNode | undefined;
  statusTooltip?: string | undefined;
  showFailureStatus?: boolean;
  isRunning?: boolean;
  title?: string | undefined;
  content?: ReactNode | undefined;
  renderContent?: (() => ReactNode) | undefined;
  summaryAction?: ToolSummaryAction | undefined;
}

function ToolLayoutComponent({
  toolId,
  persistOpenKey,
  icon,
  showIcon = true,
  canToggle = true,
  forceOpen = false,
  autoOpen = false,
  autoCollapseOnComplete = false,
  kindLabel,
  kindDetail,
  sourceLabel,
  primaryText,
  secondaryText,
  separator,
  hideSecondaryTextWhenOpen = false,
  diffCount,
  hideDiffCountWhenOpen = false,
  statusLabel,
  statusTooltip,
  showFailureStatus = false,
  isRunning = false,
  title,
  content,
  renderContent,
  summaryAction,
}: ToolLayoutProps) {
  const resolvedPersistOpenKey = persistOpenKey ?? toolId;
  const [isOpen, setIsOpen] = useState(
    () => toolLayoutOpenState.get(resolvedPersistOpenKey) ?? false,
  );
  const hasSummaryAction = summaryAction !== undefined;
  const isExpanded = !hasSummaryAction && (forceOpen || (canToggle && isOpen));
  const [shouldRenderContent, setShouldRenderContent] = useState(isExpanded);
  const contentUnmountDelayRef = useRef<number | null>(null);
  const hasAutoOpenedRef = useRef(false);
  const previousIsRunningRef = useRef(isRunning);

  const shouldShowStatusLabel =
    (showFailureStatus || Boolean(statusLabel)) && statusLabel != null;
  const resolvedContent =
    !hasSummaryAction && (isExpanded || shouldRenderContent)
      ? (renderContent?.() ?? content ?? null)
      : null;
  const summarySecondaryText =
    isExpanded && hideSecondaryTextWhenOpen ? null : secondaryText;
  const shouldShowDiffCount =
    diffCount != null && !(isExpanded && hideDiffCountWhenOpen);
  // 运行态保留 kind 文案扫光表达「仍在进行」；非运行态最浅文本色（zcode 口径）
  const kindLabelClassName = `font-medium whitespace-nowrap shrink-0 ${
    isRunning ? "animated-gradient-text" : "text-foreground-subtlest"
  }`;

  useEffect(() => {
    setIsOpen(toolLayoutOpenState.get(resolvedPersistOpenKey) ?? false);
  }, [resolvedPersistOpenKey]);

  useEffect(() => {
    // read/edit 这类工具「完成后自动展开一次」的需求：一次性 autoOpen，之后仍可手动收
    if (!autoOpen || hasAutoOpenedRef.current) return;
    toolLayoutOpenState.set(resolvedPersistOpenKey, true);
    setShouldRenderContent(true);
    setIsOpen(true);
    hasAutoOpenedRef.current = true;
  }, [autoOpen, resolvedPersistOpenKey]);

  useEffect(() => {
    const wasRunning = previousIsRunningRef.current;
    previousIsRunningRef.current = isRunning;
    // 子代理完成后自动收起一次（running→completed 边沿），不干扰后续手动展开
    if (autoCollapseOnComplete && !isRunning && wasRunning) {
      toolLayoutOpenState.set(resolvedPersistOpenKey, false);
      setIsOpen(false);
    }
  }, [autoCollapseOnComplete, isRunning, resolvedPersistOpenKey]);

  useEffect(() => {
    if (isExpanded) {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
      setShouldRenderContent(true);
      return;
    }
    if (!shouldRenderContent) return;
    // 收起时不能立刻卸载 children（高度动画测量保护，同 zcode 300ms）
    contentUnmountDelayRef.current = window.setTimeout(() => {
      setShouldRenderContent(false);
      contentUnmountDelayRef.current = null;
    }, CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);
    return () => {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
    };
  }, [isExpanded, shouldRenderContent]);

  const statusNode =
    shouldShowStatusLabel && statusLabel != null ? (
      statusTooltip ? (
        <span
          className="shrink-0 cursor-help whitespace-nowrap text-red-600 underline decoration-dotted underline-offset-2 dark:text-red-400"
          title={statusTooltip}
        >
          {statusLabel}
        </span>
      ) : (
        <span className="whitespace-nowrap">{statusLabel}</span>
      )
    ) : null;

  return (
    <Collapsible.Root
      open={!hasSummaryAction && (forceOpen || (canToggle && isOpen))}
      onOpenChange={(open) => {
        if (hasSummaryAction || forceOpen) return;
        toolLayoutOpenState.set(resolvedPersistOpenKey, open);
        if (open) setShouldRenderContent(true);
        setIsOpen(open);
      }}
      className="flex w-full flex-col"
    >
      <ToolSummaryRow
        action={summaryAction}
        canToggle={canToggle}
        diffCount={shouldShowDiffCount ? diffCount : undefined}
        forceOpen={forceOpen}
        icon={icon}
        isExpanded={isExpanded}
        kindDetail={kindDetail}
        kindLabel={kindLabel}
        kindLabelClassName={kindLabelClassName}
        primaryText={primaryText}
        secondaryText={summarySecondaryText}
        separator={separator}
        showIcon={showIcon}
        sourceLabel={sourceLabel}
        statusNode={statusNode}
        title={title}
        toggleAriaLabel={isExpanded ? "收起详情" : "展开详情"}
        toolId={toolId}
      />
      {!hasSummaryAction && canToggle ? (
        <Collapsible.Panel className="outline-none">
          {/* padding 挂内部（高度动画节点上 padding 会残留在最终帧，zcode 同款处理） */}
          <div className="pt-2">{resolvedContent}</div>
        </Collapsible.Panel>
      ) : !hasSummaryAction && forceOpen ? (
        <div className="pt-2">{resolvedContent}</div>
      ) : null}
    </Collapsible.Root>
  );
}

export const ToolLayout = memo(ToolLayoutComponent);
ToolLayout.displayName = "ToolLayout";
