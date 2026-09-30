/**
 * zcode 照搬：`@/v4/composer/WebElementContextAttachmentChip.tsx`（references/zcode/packages/ui/src/v4/composer/WebElementContextAttachmentChip.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */

import type { AttachmentHoverCardContentProps } from "@zui/components/ai-elements/attachments";
import { Button } from "@zui/components/ui/button";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { WebElementContextComposerAttachment } from "@zui/lib/webElementContext";
import { ContextAttachmentPill } from "@zui/v4/composer/ContextAttachmentPill";
import { Globe2Icon, MousePointer2Icon, Trash2Icon } from "lucide-react";

function getElementTitle(context: WebElementContextComposerAttachment) {
  return (
    context.accessibleName ||
    context.text ||
    context.selector ||
    context.tagName.toLowerCase()
  );
}

function getElementMeta(context: WebElementContextComposerAttachment) {
  const role = context.role ? `role=${context.role}` : null;
  const tagName = context.tagName.toLowerCase();
  return [tagName, role].filter(Boolean).join(" · ");
}

export function WebElementContextAttachmentChip({
  contexts,
  contentAlign = "start",
  onRemove,
  onRemoveAll,
}: {
  contexts: readonly WebElementContextComposerAttachment[];
  contentAlign?: AttachmentHoverCardContentProps["align"] | undefined;
  onRemove?: (id: string) => void | undefined;
  onRemoveAll?: () => void | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (contexts.length === 0) {
    return null;
  }

  const label = intl.formatMessage(
    {
      id:
        contexts.length === 1
          ? "chat.webElements.one"
          : "chat.webElements.many",
    },
    { count: String(contexts.length) },
  );
  const removeLabel = intl.formatMessage({ id: "chat.webElements.remove" });

  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={
        <MousePointer2Icon className="size-4 shrink-0 text-foreground-subtle" />
      }
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
    >
      {contexts.map((context) => (
        <div
          key={context.id}
          className="group/context flex min-h-7 cursor-default gap-2 rounded-lg px-2 py-1 text-ui-base/relaxed text-foreground hover:bg-menu-hover"
        >
          <Globe2Icon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">
              {getElementTitle(context)}
            </div>
            <div className="truncate font-mono text-ui-base text-foreground-subtle">
              {getElementMeta(context)}
            </div>
            <div className="truncate text-ui-base text-foreground-subtlest">
              {context.pageTitle || context.pageUrl}
            </div>
          </div>
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 size-5 shrink-0 rounded-sm text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/context:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(context.id);
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
