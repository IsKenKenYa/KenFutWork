/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/switch-mode.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：MessageResponseProps（禁改件 message.tsx）可选属性不接受 undefined，调用点按手册 §4 条件展开。
 */

import { MessageResponse } from "@zui/components/ai-elements/message";
import { ToolOutput } from "@zui/components/ai-elements/tool";
import { Button } from "@zui/components/ui/button";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import {
  extractPlanToolCallContent,
  getPlanFileLabel,
} from "@zui/lib/planToolCall";
import { getToolCallErrorText } from "@zui/lib/toolError";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared";
import { ToolSnapshotFieldNotice } from "@zui/ToolCallBlocks/ToolSnapshotFieldNotice";
import {
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  NotepadTextIcon,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useState } from "react";

function isInteractiveDescendant(
  target: EventTarget | null,
  card: HTMLElement,
): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(
    "button, a, input, textarea, select, [role='button']",
  );
  // 卡片自身带 role=button，旧 closest 会让卡片任意位置都命中自己，
  // 结果“点击卡片打开详情”从未执行。这里只拦截复制/展开/正文链接等真实子控件。
  return interactive !== null && interactive !== card;
}

export function SwitchModeToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const errorText = getToolCallErrorText(toolCall);
  const { markdown, planFilePath } = extractPlanToolCallContent(
    toolCall,
    context.workspacePath,
  );
  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );
  const hasMarkdown = typeof markdown === "string" && markdown.length > 0;
  const [copiedMarkdown, setCopiedMarkdown] = useState<string | null>(null);
  const copied = copiedMarkdown === markdown;

  const openDetail = () => {
    if (!markdown || !context.onOpenPlanDetail) return;
    context.onOpenPlanDetail({
      toolCallId: toolCall.toolId,
      markdown,
      ...(planFilePath ? { planFilePath } : {}),
    });
  };

  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!isInteractiveDescendant(event.target, event.currentTarget))
      openDetail();
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // 内部按钮的 keydown 会继续冒泡到整卡，导致一次键盘操作重复打开详情。
    // 与点击路径共用交互元素判定，只允许整卡自身接管 Enter / Space。
    if (isInteractiveDescendant(event.target, event.currentTarget)) return;
    event.preventDefault();
    openDetail();
  };

  const handleCopy = () => {
    if (
      !markdown ||
      typeof navigator === "undefined" ||
      !navigator.clipboard?.writeText
    )
      return;
    void navigator.clipboard.writeText(markdown).then(
      () => setCopiedMarkdown(markdown),
      () => setCopiedMarkdown(null),
    );
  };

  if (hasMarkdown) {
    return (
      <>
        <section
          role={context.onOpenPlanDetail ? "button" : undefined}
          tabIndex={context.onOpenPlanDetail ? 0 : undefined}
          aria-label={intl.formatMessage({ id: "planTool.panel.open" })}
          onClick={handleCardClick}
          onKeyDown={handleCardKeyDown}
          className="group w-full min-w-0 overflow-hidden rounded-xl border border-card-border bg-card text-foreground shadow-xs outline-none transition-colors hover:border-border-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <header className="flex h-10 min-w-0 items-start gap-2 px-4 pt-4">
            <div className="flex shrink-0 items-center gap-2">
              <NotepadTextIcon className="size-4 shrink-0 text-foreground-subtle" />
              <h3 className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "planTool.panel.planTab" })}
              </h3>
            </div>
            {planFilePath ? (
              <code
                className="min-w-0 truncate text-ui-sm text-foreground-subtlest"
                title={planFilePath}
              >
                {getPlanFileLabel(planFilePath)}
              </code>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({
                  id: copied ? "planTool.panel.copied" : "planTool.panel.copy",
                })}
                onClick={(event) => {
                  event.stopPropagation();
                  handleCopy();
                }}
              >
                {copied ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </Button>
            </div>
          </header>
          <div className="relative overflow-hidden">
            {/* max-height 与 mask 分层后，长正文会按完整内容高度计算渐变，
            导致实际可见区域没有底部渐隐；两者必须落在同一个裁切节点。 */}
            <div className="max-h-64 overflow-hidden px-4 pt-2 pb-12 [mask-image:linear-gradient(to_bottom,black_0%,black_30%,transparent_100%)]">
              <MessageResponse
                className="min-w-0 break-words text-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_li]:text-foreground-subtle [&_p]:text-foreground-subtle"
                {...(context.workspacePath === undefined
                  ? {}
                  : { workspacePath: context.workspacePath })}
                {...(context.theme === undefined
                  ? {}
                  : { theme: context.theme })}
                {...(context.codePreviewSettings === undefined
                  ? {}
                  : { codePreviewSettings: context.codePreviewSettings })}
                {...(context.onOpenCodeViewer === undefined
                  ? {}
                  : { onOpenCodeViewer: context.onOpenCodeViewer })}
                {...(context.onOpenFileLink === undefined
                  ? {}
                  : { onOpenFileLink: context.onOpenFileLink })}
                {...(context.onOpenBrowserUrl === undefined
                  ? {}
                  : { onOpenExternalUrl: context.onOpenBrowserUrl })}
              >
                {markdown}
              </MessageResponse>
            </div>
            <Button
              type="button"
              variant="default"
              size="lg"
              className="absolute bottom-6 left-1/2 h-10 -translate-x-1/2 rounded-full !pr-4.5 pl-6 shadow-xs"
              onClick={(event) => {
                event.stopPropagation();
                openDetail();
              }}
            >
              {intl.formatMessage({ id: "planTool.panel.viewFull" })}
              <ArrowRightIcon data-icon="inline-end" className="size-4" />
            </Button>
          </div>
        </section>
        {snapshotNotice}
      </>
    );
  }

  // switch_mode 的有效信息通常就是那段 markdown 结果，不应该再套一层通用工具卡片。
  // 只有当 provider 没给出 markdown、或者当前是失败态时，才回退到最小输出块，避免 UI 彻底空白。
  if (toolCall.output !== undefined || errorText) {
    return (
      <>
        <ToolOutput
          errorText={errorText}
          output={errorText ? undefined : toolCall.output}
        />
        {snapshotNotice}
      </>
    );
  }

  return snapshotNotice;
}
