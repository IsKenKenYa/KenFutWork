import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { Input } from "@zui/components/ui/input.js";
import { useEffect, useState } from "react";

/** 项目改名：只改显示名，不碰目录、身份与启用方式。 */
export function ProjectRenameDialog({
  open,
  initialName,
  onOpenChange,
  onRename,
}: {
  open: boolean;
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initialName);
    setError(null);
    setBusy(false);
  }, [initialName, open]);

  const submit = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(name);
      onOpenChange(false);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "项目改名失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名项目</DialogTitle>
        </DialogHeader>
        <Input
          aria-label="项目名称"
          value={draft}
          maxLength={100}
          autoFocus
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => void submit()}
          >
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
