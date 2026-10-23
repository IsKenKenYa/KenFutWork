"use client";

import { MessageResponse } from "@zui/components/ai-elements/message.js";
import { Button } from "@zui/components/ui/button.js";
import { Pencil } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseMarkdownIntoBlocks } from "streamdown";

/**
 * Markdown 预览 + 块级就地编辑。
 *
 * 用 Streamdown 的块切分保留原始空行（`blocks.join("") === source`），每块独立渲染；
 * 鼠标悬停块左侧的笔进入该块源码编辑，保存后只替换这一块，其余块原样保留。
 * 流程图（mermaid）等围栏块仍交给 MessageResponse/Streamdown 渲染。
 */
export function OpenDesignMarkdownPreview({
  source,
  saving,
  onSave,
}: {
  source: string;
  saving: boolean;
  onSave: (nextSource: string) => Promise<void>;
}) {
  const blocks = useMemo(() => parseMarkdownIntoBlocks(source), [source]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editingIndex !== null && editingIndex >= blocks.length) {
      setEditingIndex(null);
    }
  }, [blocks.length, editingIndex]);

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setDraft(blocks[index] ?? "");
    setError(null);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setDraft("");
    setError(null);
  };

  const saveBlock = async () => {
    if (editingIndex === null) return;
    setError(null);
    const nextBlocks = [...blocks];
    nextBlocks[editingIndex] = draft;
    try {
      await onSave(nextBlocks.join(""));
      setEditingIndex(null);
      setDraft("");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存这个块失败。",
      );
    }
  };

  return (
    <div
      data-testid="open-design-markdown"
      className="h-full min-h-0 overflow-y-auto bg-background px-6 py-4"
    >
      <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col">
        {blocks.map((block, index) =>
          block.trim() ? (
            <div
              key={`${index}-${block.length}`}
              className="group/block relative"
            >
              {editingIndex === index ? (
                <div className="my-2 rounded-lg border border-border bg-surface p-2">
                  <textarea
                    aria-label="Markdown 块源码"
                    value={draft}
                    spellCheck={false}
                    rows={Math.min(16, Math.max(3, draft.split("\n").length))}
                    onChange={(event) => setDraft(event.target.value)}
                    className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground outline-none"
                  />
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={saving}
                      onClick={cancelEdit}
                    >
                      取消
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={saving || draft.trim().length === 0}
                      onClick={() => void saveBlock()}
                    >
                      {saving ? "保存中…" : "保存"}
                    </Button>
                  </div>
                  {error ? (
                    <p role="alert" className="mt-2 text-xs text-destructive">
                      {error}
                    </p>
                  ) : null}
                </div>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="编辑此块"
                    title="编辑此块"
                    className="absolute -left-6 top-1 text-foreground-subtle opacity-0 transition-opacity group-hover/block:opacity-100 focus-visible:opacity-100"
                    onClick={() => startEdit(index)}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <MessageResponse theme="system">{block}</MessageResponse>
                </>
              )}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
