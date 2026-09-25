"use client";

import type { CheckpointSummary } from "@kenfutwork/shared";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CheckpointRestoreDialog } from "@/components/workbench/checkpoint-restore-dialog";
import { formatCheckpointStats } from "@/lib/checkpoint-select";
import {
  type CheckpointDiff,
  fetchCheckpointDiff,
} from "@/lib/code-checkpoints-api";
import { toDiffLines } from "@/lib/git-hunks";
import { keyed } from "../list-keys";

/**
 * 检查点条（Code 模式）：一轮 run 结束后影子快照的细条，挂在对话消息卡下方——
 * 「检查点 · N 个文件 +a −d」+「查看改动」+「回滚」。
 *
 * 样式对齐 WorkbenchToolRow 的容器与 panel-changes-view 的小按钮：都是消息流里的
 * 弱化条，不抢对话正文。本轮还在跑时禁用回滚（工作目录正被写入，服务端也会拦）。
 */
export function CheckpointChip({
  checkpoint,
  accessToken,
  canvasId,
  restoreDisabled,
}: {
  checkpoint: CheckpointSummary;
  accessToken: string | null;
  /** 回滚目标所在画布（=项目主画布），确认弹窗的 restore 要用。 */
  canvasId: string | null;
  restoreDisabled: boolean;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  return (
    <>
      <div className="flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
        />
        <span>检查点 · {formatCheckpointStats(checkpoint)}</span>
        <button
          type="button"
          aria-label="查看这个检查点的改动"
          onClick={() => setDiffOpen(true)}
          className="shrink-0 border px-1.5 py-0.5 text-[10px] transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          查看改动
        </button>
        <button
          type="button"
          aria-label="回滚到这个检查点"
          disabled={restoreDisabled}
          title={
            restoreDisabled
              ? "本轮还在运行，结束或停止后再回滚。"
              : "把工作目录整体回到这个时点（会先给你看受影响的文件）。"
          }
          onClick={() => setRestoreOpen(true)}
          className="shrink-0 border px-1.5 py-0.5 text-[10px] transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground"
        >
          回滚
        </button>
      </div>

      <CheckpointDiffDialog
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        accessToken={accessToken}
        checkpoint={checkpoint}
      />
      <CheckpointRestoreDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        accessToken={accessToken}
        canvasId={canvasId}
        checkpoint={checkpoint}
      />
    </>
  );
}

/**
 * 检查点改动弹窗：该检查点相对上一检查点的统一 diff（轻量只读视图——
 * 复用 `toDiffLines` 按行着色，配色与右栏审查视图同一套）。
 */
function CheckpointDiffDialog({
  open,
  onClose,
  accessToken,
  checkpoint,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
  checkpoint: CheckpointSummary;
}) {
  const [diff, setDiff] = useState<CheckpointDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !accessToken) return;
    let cancelled = false;
    setDiff(null);
    setError(null);
    fetchCheckpointDiff(accessToken, checkpoint.id)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "读取差异失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, accessToken, checkpoint.id]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex max-h-[82vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        aria-describedby={undefined}
      >
        <div className="flex items-center gap-2 border-b px-5 py-3 pr-20">
          <DialogTitle className="text-sm font-medium">
            检查点改动 · {formatCheckpointStats(checkpoint)}
          </DialogTitle>
        </div>
        {error ? (
          <p className="border-b border-destructive/40 bg-destructive/5 px-5 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {diff === null ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {error ? null : "读取中…"}
          </p>
        ) : diff.diff === "" ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            这个检查点没有相对上一检查点的改动。
          </p>
        ) : (
          <section
            aria-label="检查点差异"
            className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-5"
          >
            {keyed(
              toDiffLines(diff.diff),
              (line) => `${line.kind}-${line.text}`,
            ).map(({ key, item: line }) => (
              <div
                key={key}
                className={`whitespace-pre ${
                  line.kind === "add"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : line.kind === "del"
                      ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
                      : line.kind === "hunk"
                        ? "bg-muted/60 text-muted-foreground"
                        : line.kind === "meta"
                          ? "text-muted-foreground"
                          : ""
                }`}
              >
                {line.text}
              </div>
            ))}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
