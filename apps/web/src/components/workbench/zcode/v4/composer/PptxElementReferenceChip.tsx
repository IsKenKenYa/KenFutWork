/**
 * zcode 照搬：`@/v4/composer/PptxElementReferenceChip.tsx`（references/zcode/packages/ui/src/v4/composer/PptxElementReferenceChip.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */

import type { AttachmentHoverCardContentProps } from "@zui/components/ai-elements/attachments";
import { Button } from "@zui/components/ui/button";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { PptxElementReference } from "@zui/lib/pptxElementReference";
import { ContextAttachmentPill } from "@zui/v4/composer/ContextAttachmentPill";
import { PresentationIcon, Trash2Icon } from "lucide-react";

function getReferenceText(reference: PptxElementReference) {
  return (
    reference.selectedText ||
    reference.text ||
    reference.nodeName ||
    reference.nodeType
  );
}

export function PptxElementReferenceChip({
  references,
  contentAlign = "start",
  onOpen,
  onRemove,
  onRemoveAll,
}: {
  references: readonly PptxElementReference[];
  contentAlign?: AttachmentHoverCardContentProps["align"] | undefined;
  onOpen?: ((reference: PptxElementReference) => void | undefined) | undefined;
  onRemove?: (id: string) => void | undefined;
  onRemoveAll?: () => void | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (references.length === 0) {
    return null;
  }
  const label = intl.formatMessage(
    {
      id:
        references.length === 1
          ? "chat.pptxElements.one"
          : "chat.pptxElements.many",
    },
    { count: String(references.length) },
  );
  const removeLabel = intl.formatMessage({ id: "chat.pptxElements.remove" });
  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={
        <PresentationIcon className="size-4 shrink-0 text-foreground-subtle" />
      }
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
    >
      {references.map((reference) => (
        <div
          key={reference.id}
          className="group/context flex min-h-7 items-start gap-1 rounded-lg px-1 py-0.5 text-ui-base/relaxed hover:bg-menu-hover"
        >
          {onOpen ? (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              onClick={() => onOpen(reference)}
            >
              <PresentationIcon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {getReferenceText(reference)}
                </span>
                <span className="block truncate font-mono text-ui-sm text-foreground-subtle">
                  {reference.sourceTitle} · {reference.slideIndex + 1} ·{" "}
                  {reference.nodeId}
                </span>
                {reference.comment?.trim() ? (
                  <span className="line-clamp-2 text-ui-base/relaxed text-foreground-subtle">
                    {reference.comment}
                  </span>
                ) : null}
              </span>
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-start gap-2 px-1 py-0.5">
              <PresentationIcon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {getReferenceText(reference)}
                </div>
                <div className="truncate font-mono text-ui-sm text-foreground-subtle">
                  {reference.sourceTitle} · {reference.slideIndex + 1} ·{" "}
                  {reference.nodeId}
                </div>
                {reference.comment?.trim() ? (
                  <div className="line-clamp-2 text-ui-base/relaxed text-foreground-subtle">
                    {reference.comment}
                  </div>
                ) : null}
              </div>
            </div>
          )}
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 size-5 shrink-0 rounded-sm text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/context:opacity-100 focus-visible:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(reference.id);
              }}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
    </ContextAttachmentPill>
  );
}
