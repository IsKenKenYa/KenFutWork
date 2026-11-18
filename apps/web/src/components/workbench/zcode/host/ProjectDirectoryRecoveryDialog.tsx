"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import type { ReactNode } from "react";

export function ProjectDirectoryRecoveryDialog({
  open,
  onOpenChange,
  title = "重新关联项目",
  busy,
  busyLabel = "关联中",
  error,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  busy: boolean;
  busyLabel?: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {busy ? <p role="status">{busyLabel}</p> : children}
      </DialogContent>
    </Dialog>
  );
}
