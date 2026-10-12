import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { toast } from "@zui/components/ui/toast.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { HistoryIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 检查点多轮时间线回滚（G8/Q15，KenFutWork 宿主件）：恢复旧版
 * checkpoint-restore-dialog 的三件套——时间线下拉（轮次快照倒序）+ 恢复预览
 * （工作目录相对目标时点的未提交差异）+ 确认回滚。
 *
 * 数据面（cookie 会话，Task 作用域）：GET /api/code/checkpoints?taskId=…
 * POST /api/code/checkpoints/:id/preview、/restore（服务端缝健在）。
 * 入口挂 ConversationStatusPanel 顶部（G8 建议落点）；无检查点/拉取失败时
 * 入口隐藏（不摆空壳）。
 */
interface CheckpointSummary {
  id: string;
  runId: string;
  createdAt: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface RestorePreview {
  targetSha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function optionLabel(row: CheckpointSummary): string {
  return `${formatTimestamp(row.createdAt)} · ${row.filesChanged} 个文件 +${row.insertions} −${row.deletions}`;
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "操作失败";
}

export function CheckpointTimeline({
  workspacePath,
  workspaceIdentity,
  onRestored,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  onRestored?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[] | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const taskId = useZCodeSessionStore
    .getState()
    .getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId;

  const reload = useCallback(async () => {
    if (!taskId) {
      setCheckpoints(null);
      return;
    }
    try {
      const payload = await surfaceJson<{ checkpoints: CheckpointSummary[] }>(
        `/api/code/checkpoints?taskId=${encodeURIComponent(taskId)}`,
      );
      // 服务端按 createdAt 升序；时间线倒序（最新在前）
      setCheckpoints([...payload.checkpoints].reverse());
    } catch {
      setCheckpoints(null);
    }
  }, [taskId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!open || !selectedId) return;
    let cancelled = false;
    setPreview(null);
    void surfaceJson<RestorePreview>(
      `/api/code/checkpoints/${encodeURIComponent(selectedId)}/preview?taskId=${encodeURIComponent(taskId ?? "")}`,
      { method: "POST" },
    )
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) toast(readableError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId, taskId]);

  const restore = useCallback(async () => {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await surfaceJson(
        `/api/code/checkpoints/${encodeURIComponent(selectedId)}/restore?taskId=${encodeURIComponent(taskId ?? "")}`,
        { method: "POST" },
      );
      setOpen(false);
      onRestored?.();
      await reload();
    } catch (error) {
      toast(readableError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, onRestored, reload, selectedId, taskId]);

  // 无 Task（草稿态）或无检查点时不摆入口（空壳禁则）
  if (!taskId || !checkpoints || checkpoints.length === 0) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        aria-label="检查点"
        data-testid="checkpoint-timeline-trigger"
        onClick={() => {
          setSelectedId((current) => current ?? checkpoints[0]?.id ?? null);
          setOpen(true);
        }}
      >
        <HistoryIcon className="size-3.5" />
        检查点
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>回滚到检查点</DialogTitle>
            <DialogDescription />
          </DialogHeader>
          <div className="space-y-3">
            <Select
              value={selectedId ?? ""}
              onValueChange={(next) => {
                if (typeof next === "string") setSelectedId(next);
              }}
            >
              <SelectTrigger aria-label="回滚目标" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {checkpoints.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {optionLabel(row)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="rounded-md border p-2.5 text-ui-sm">
              {preview === null ? (
                <span className="text-foreground-subtle">读取预览…</span>
              ) : (
                <div>
                  <p className="text-foreground-subtle">
                    将覆盖 {preview.filesChanged} 个文件的未提交改动（+
                    {preview.insertions} −{preview.deletions}）
                  </p>
                  <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-auto text-foreground-subtle">
                    {preview.files.map((file) => (
                      <li key={file.path} className="truncate">
                        {file.path}（+{file.additions} −{file.deletions}）
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <p className="text-ui-sm text-foreground-subtle">
              丢弃所选时点后的未提交改动
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || preview === null}
              onClick={() => void restore()}
            >
              {busy ? "回滚中…" : "回滚"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
