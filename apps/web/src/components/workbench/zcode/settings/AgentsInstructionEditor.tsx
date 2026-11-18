"use client";

import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { Textarea } from "@zui/components/ui/textarea.js";
import { useEffect, useState } from "react";

/**
 * 设置 → 智能体：实例级默认 AGENTS.md 的页内编辑器。
 *
 * 桌面端有「用外部软件打开」；Web 端没有该能力，页内编辑器保证默认指令
 * 在任何形态下都能改。保存走宿主 RPC，写入数据目录的同一份文件。
 */
export function AgentsInstructionEditor({
  open,
  filePath,
  load,
  save,
  onClose,
}: {
  open: boolean;
  filePath: string;
  load: () => Promise<{ content: string }>;
  save: (content: string) => Promise<void>;
  onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPending(true);
    setError(null);
    void load()
      .then((result) => {
        if (!active) return;
        setContent(result.content);
        setPending(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPending(false);
      });
    return () => {
      active = false;
    };
  }, [load, open]);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await save(content);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>编辑 AGENTS.md</DialogTitle>
        </DialogHeader>
        <p
          className="truncate font-mono text-ui-sm text-foreground-subtle"
          title={filePath}
        >
          {filePath}
        </p>
        <Textarea
          aria-label="AGENTS.md"
          className="min-h-[40vh] font-mono text-ui-sm"
          spellCheck={false}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        {error ? (
          <p className="text-ui-base text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={pending}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
