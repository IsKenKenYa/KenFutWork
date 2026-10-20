import { useState } from "react";
import { Check, Trash2, X } from "lucide-react";
import type { DesignReviewComment } from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";

/**
 * 评论侧栏：这块画布当前文件上的评论清单。
 *
 * 计数只算未解决的（与画布上的图钉数一致）；已解决的留在列表里可重开，
 * 不做「一解决就消失」——那会让人以为评论被删了。
 */
export function OpenDesignCommentSidebar({
  comments,
  activeId,
  busy,
  onSelect,
  onToggleResolved,
  onDelete,
  onClose,
}: {
  comments: DesignReviewComment[];
  activeId: string | null;
  busy: boolean;
  onSelect: (commentId: string) => void;
  onToggleResolved: (comment: DesignReviewComment) => void;
  onDelete: (comment: DesignReviewComment) => void;
  onClose: () => void;
}) {
  return (
    <aside
      data-testid="open-design-comment-sidebar"
      className="absolute inset-y-0 right-0 z-20 flex w-72 max-w-full flex-col border-l border-border bg-background shadow-lg"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
          评论 {comments.filter((item) => item.status === "open").length}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="关闭评论侧栏"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {comments.length === 0 ? (
          <p className="px-1 py-6 text-center text-ui-caption text-foreground-subtle">
            还没有评论
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {comments.map((comment) => (
              <li key={comment.id}>
                <div
                  data-active={comment.id === activeId || undefined}
                  className={`rounded-lg border p-2 text-ui-caption ${
                    comment.id === activeId
                      ? "border-primary bg-primary/5"
                      : "border-border bg-surface"
                  } ${comment.status === "resolved" ? "opacity-60" : ""}`}
                >
                  <button
                    type="button"
                    className="block w-full text-left"
                    onClick={() => onSelect(comment.id)}
                  >
                    <span className="line-clamp-3 text-foreground">
                      {comment.body}
                    </span>
                    {comment.anchor.excerpt ? (
                      <span className="mt-1 block truncate border-l-2 border-border pl-1.5 text-foreground-subtle">
                        {comment.anchor.excerpt}
                      </span>
                    ) : null}
                  </button>
                  <div className="mt-1.5 flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => onToggleResolved(comment)}
                    >
                      <Check className="size-3" />
                      <span>{comment.status === "open" ? "解决" : "重开"}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      aria-label="删除评论"
                      onClick={() => onDelete(comment)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** 点选元素后的落笔卡片：一句话 + 提交。 */
export function OpenDesignCommentComposer({
  excerpt,
  busy,
  onCancel,
  onSubmit,
}: {
  excerpt: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  return (
    <div
      data-testid="open-design-comment-composer"
      className="absolute left-3 top-3 z-20 w-64 max-w-[calc(100%-1.5rem)] rounded-lg border border-border bg-background p-2 shadow-lg"
    >
      {excerpt ? (
        <p className="mb-1.5 truncate border-l-2 border-border pl-1.5 text-ui-caption text-foreground-subtle">
          {excerpt}
        </p>
      ) : null}
      <textarea
        autoFocus
        value={body}
        placeholder="评论"
        onChange={(event) => setBody(event.target.value)}
        className="h-16 w-full resize-none rounded-md border border-border bg-surface p-2 text-ui-caption"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || body.trim().length === 0}
          onClick={() => onSubmit(body.trim())}
        >
          提交
        </Button>
      </div>
    </div>
  );
}
