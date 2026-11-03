import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import { useEffect, useState } from "react";

/** 新建项目只收名称：目录由服务端按项目创建，路径不在这里猜测。 */
export function ProjectCreateDialog({
  open,
  onOpenChange,
  createProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  createProject: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName("");
    setError(null);
    setSubmitting(false);
  }, [open]);
  const trimmed = name.trim();
  const submit = async () => {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createProject(trimmed);
      onOpenChange(false);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "创建项目失败，请重试。",
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center gap-3 text-sm">
            <label htmlFor="kenfutwork-project-name">名称</label>
            <input
              id="kenfutwork-project-name"
              // biome-ignore lint/a11y/noAutofocus: 弹窗唯一输入项，打开即待输入。
              autoFocus
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={!trimmed || submitting}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
