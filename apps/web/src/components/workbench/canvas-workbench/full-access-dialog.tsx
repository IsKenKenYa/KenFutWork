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
}: {
  composer: ReturnType<typeof useDesignComposer>;
}) {
  const { pendingFullAccess, setPendingFullAccess, applyTier } = composer;
  return (
    <Dialog open={pendingFullAccess} onOpenChange={setPendingFullAccess}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            开启「完全访问」？
          </DialogTitle>
          <DialogDescription>
            这一档不再逐条询问：改文件、跑命令、调用外部工具都会直接执行，出问题无法回滚。
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
