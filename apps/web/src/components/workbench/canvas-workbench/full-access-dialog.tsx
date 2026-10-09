"use client";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { useDesignComposer } from "./use-design-composer";
export function FullAccessDialog({
  composer,
  active = true,
}: {
  composer: ReturnType<typeof useDesignComposer>;
  active?: boolean;
}) {
  const { pendingFullAccess, setPendingFullAccess, applyTier } = composer;
  return (
    <Dialog
      open={active && pendingFullAccess}
      onOpenChange={setPendingFullAccess}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            开启「完全访问」？
          </DialogTitle>
          <DialogDescription>
            无需逐项审批
            <br />文件修改 · 命令执行 · 外部工具
            <br />执行结果无法回滚
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPendingFullAccess(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              setPendingFullAccess(false);
              void applyTier("full-access");
            }}
          >
            仍要开启
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
