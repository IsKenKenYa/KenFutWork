"use client";

import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";

/**
 * OpenDesign 资源操作弹窗（资源页三点菜单 / 文档顶部重命名共用）。
 * 只做展示与录入，请求由面板发起（busy 由调用方持有）。
 */
export function OpenDesignRenameDialog({
  target,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  target: { name: string; draft: string } | null;
  busy: boolean;
  onChange: (draft: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>重命名</DialogTitle>
        </DialogHeader>
        <input
          aria-label="文件名称"
          autoFocus
          value={target?.draft ?? ""}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              !busy
            ) {
              event.preventDefault();
              onSubmit();
            } else if (event.key === "Escape") {
              onCancel();
            }
          }}
          className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-ui-base outline-none focus:border-foreground/30"
        />
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !target?.draft.trim()}
            onClick={onSubmit}
          >
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OpenDesignDeleteDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  /** 待删除文件名；null = 关闭。 */
  target: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>删除文件</DialogTitle>
        </DialogHeader>
        <p className="break-all text-ui-base text-foreground-subtle">
          {target}（不可恢复）
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "删除中…" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
