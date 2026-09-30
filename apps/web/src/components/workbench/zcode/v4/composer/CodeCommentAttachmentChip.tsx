/**
 * zcode 照搬：`@/v4/composer/CodeCommentAttachmentChip.tsx`（references/zcode/packages/ui/src/v4/composer/CodeCommentAttachmentChip.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 * 适配注记：本文件类型可选成员放宽 `| undefined`（exactOptionalPropertyTypes 下等价 zcode tsconfig 行为）。
 */

import type { AttachmentHoverCardContentProps } from "@zui/components/ai-elements/attachments";
import { Button } from "@zui/components/ui/button";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import type { CodeCommentComposerAttachment } from "@zui/lib/codeCommentContext";
import { ContextAttachmentPill } from "@zui/v4/composer/ContextAttachmentPill";
import { Code2Icon, MessageSquareTextIcon, Trash2Icon } from "lucide-react";

function getContextKey(comment: CodeCommentComposerAttachment) {
  return `${comment.workspaceIdentity?.trim() || comment.workspacePath}\0${comment.id}`;
}

export function CodeCommentAttachmentChip({
  comments,
  contentAlign = "start",
  onRemove,
  onRemoveAll,
}: {
  comments: readonly CodeCommentComposerAttachment[];
  contentAlign?: AttachmentHoverCardContentProps["align"] | undefined;
  onRemove?: (comment: CodeCommentComposerAttachment) => void | undefined;
  onRemoveAll?: () => void | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (comments.length === 0) return null;

  const label = intl.formatMessage(
    {
      id:
        comments.length === 1
          ? "chat.codeComments.one"
          : "chat.codeComments.many",
    },
    { count: String(comments.length) },
  );
  const removeLabel = intl.formatMessage({ id: "chat.codeComments.remove" });

  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={
        <MessageSquareTextIcon className="size-4 shrink-0 text-foreground-subtle" />
      }
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
    >
      {comments.map((comment) => {
        const lineLabel =
          comment.startLine === comment.endLine
            ? `L${comment.startLine}`
            : `L${comment.startLine}-L${comment.endLine}`;
        return (
          <div
            key={getContextKey(comment)}
            className="group/comment flex min-h-7 cursor-default gap-2 rounded-lg px-2 py-1 text-ui-base/relaxed text-foreground hover:bg-menu-hover"
          >
            <Code2Icon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">
                  {comment.sourceTitle}
                </span>
                <span className="shrink-0 font-mono text-ui-base text-foreground-subtle">
                  {lineLabel}
                </span>
              </div>
              <div className="truncate font-mono text-ui-base text-foreground-subtlest">
                {comment.sourcePath ?? comment.sourceTitle}
              </div>
              {comment.comment.trim() ? (
                <div className="line-clamp-2 text-ui-base/relaxed text-foreground-subtle">
                  {comment.comment}
                </div>
              ) : null}
            </div>
            {onRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="mt-0.5 size-5 shrink-0 rounded-sm text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/comment:opacity-100"
                aria-label={removeLabel}
                title={removeLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(comment);
                }}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        );
      })}
    </ContextAttachmentPill>
  );
}
