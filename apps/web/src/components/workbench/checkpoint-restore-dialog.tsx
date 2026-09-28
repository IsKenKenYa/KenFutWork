"use client";

import type {
  CheckpointFileChange,
  CheckpointSummary,
} from "@kenfutwork/shared";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatCheckpointOption,
  toCheckpointOptions,
} from "@/lib/checkpoint-select";
import {
  type CheckpointRestorePreview,
  fetchCheckpoints,
  previewCheckpointRestore,
  restoreCheckpoint,
} from "@/lib/code-checkpoints-api";

/**
 * 检查点回滚确认弹窗：打开先取**恢复预览**（工作目录相对目标时点的未提交差异），
 * 让用户在确认前看到会覆盖掉什么；确认才真正回滚。
 *
 * 顶部有**回滚目标选择器**（该画布的完整检查点时间线，最新在前）：任务卡上的
 * chip 只带来最新一轮的检查点，要回到更早的轮次（第 7 轮写坏、第 10 轮才发现）
 * 就在这里换目标——预览清单跟随所选目标实时切换。
 *
 * 回滚是**丢内容**操作，但可从更早的检查点再恢复——警示文案按这个口径写，
 * 不吓唬也不轻描淡写。恢复动作本身的服务端守卫（在途 run 拒绝）在 HTTP 层。
 */
export function CheckpointRestoreDialog({
  open,
  onOpenChange,
  accessToken,
  canvasId,
  checkpoint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accessToken: string | null;
  /** 回滚目标所在画布（=项目主画布）；服务端靠它校验归属并拦截在途 run。 */
  canvasId: string | null;
  checkpoint: CheckpointSummary;
}) {
  const [preview, setPreview] = useState<CheckpointRestorePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  /** 完整时间线（最新在前）；拉取失败退化为只可选 chip 带来的这个检查点。 */
  const [options, setOptions] = useState<CheckpointSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>(checkpoint.id);

  useEffect(() => {
    if (!open || !accessToken || !canvasId) return;
    let cancelled = false;
    setOptions([]);
    setSelectedId(checkpoint.id);
    fetchCheckpoints(accessToken, canvasId)
      .then((rows) => {
        if (!cancelled) setOptions(toCheckpointOptions(rows));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, accessToken, canvasId, checkpoint.id]);

  useEffect(() => {
    if (!open || !accessToken) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    previewCheckpointRestore(accessToken, selectedId)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "读取恢复预览失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, accessToken, selectedId]);

  const restore = async () => {
    if (!accessToken || !canvasId || restoring) return;
    setRestoring(true);
    setError(null);
    try {
      await restoreCheckpoint(accessToken, canvasId, selectedId);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "回滚失败，请重试。");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        aria-describedby={undefined}
      >
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle className="text-sm font-medium">
            回滚工作目录
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            改动会被覆盖 · 可再从历史恢复
          </DialogDescription>
        </DialogHeader>

        <div className="border-b px-5 py-2.5">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">回滚目标</span>
            <Select
              value={selectedId}
              onValueChange={(next) => {
                if (typeof next === "string") setSelectedId(next);
              }}
              items={(options.length > 0 ? options : [checkpoint]).map(
                (option) => ({
                  value: option.id,
                  label: formatCheckpointOption(option),
                }),
              )}
            >
              <SelectTrigger
                aria-label="回滚目标"
                className="min-w-0 flex-1 py-1 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(options.length > 0 ? options : [checkpoint]).map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {formatCheckpointOption(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {error ? (
            <p className="border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
          {preview === null ? (
            <p className="text-xs text-muted-foreground">
              {error ? null : "读取受影响的文件中…"}
            </p>
          ) : preview.files.length === 0 ? (
            <p className="text-xs text-muted-foreground">没有改动</p>
          ) : (
            <ul aria-label="受影响的文件" className="divide-y">
              {preview.files.map((file) => (
                <FileRow key={file.path} file={file} />
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            取消
          </button>
          <button
            type="button"
            disabled={
              !accessToken || !canvasId || preview === null || restoring
            }
            onClick={() => void restore()}
            title={canvasId ? undefined : "没有绑定工作目录"}
            className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
          >
            {restoring ? "回滚中…" : "确认回滚"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 受影响文件一行：路径 + 逐文件增删（二进制文件没有行数，如实标「二进制」）。 */
function FileRow({ file }: { file: CheckpointFileChange }) {
  return (
    <li className="flex items-center gap-2 py-1.5">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {file.path}
      </span>
      {file.added === null && file.deleted === null ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          二进制
        </span>
      ) : (
        <span className="w-20 shrink-0 text-right font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{file.added ?? 0}
          </span>{" "}
          <span className="text-rose-600 dark:text-rose-400">
            −{file.deleted ?? 0}
          </span>
        </span>
      )}
    </li>
  );
}
