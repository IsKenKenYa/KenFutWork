"use client";

import type {
  CheckpointFileChange,
  CheckpointSummary,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import {
  fetchCheckpointFiles,
  fetchCheckpoints,
  restoreCheckpointFile,
} from "@/lib/code-checkpoints-api";
import { getPathLeaf } from "@/lib/ui-format";

/**
 * 右栏「检查点」页签（借鉴 ZCode 的变更面板）：列出**最近一轮**影子快照的逐文件
 * 变更（文件名 + 增删行数），每个文件一行「撤销」——把该文件恢复到这一轮开始前的
 * 状态（该轮新建的文件则删除）。整目录回滚仍走消息卡检查点条（带时间线选择）。
 *
 * 数据口径与消息卡一致：最近的 kind=turn 检查点（restore 行是回滚痕迹，不作为
 * 面板主体）；git 缺席（503）与空状态都给可读文案，不出死按钮。
 */
export function PanelCheckpointView({
  accessToken,
  canvasId,
  running,
}: {
  accessToken: string | null;
  canvasId: string | null;
  /** 任务运行中：撤销被禁用（服务端也拦在途 run）。 */
  running: boolean;
}) {
  const [checkpoint, setCheckpoint] = useState<CheckpointSummary | null>(null);
  const [files, setFiles] = useState<CheckpointFileChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 撤销中的 path（行级 pending）；null = 无进行中的撤销。 */
  const [undoingPath, setUndoingPath] = useState<string | null>(null);
  /** 确认弹窗的目标文件；null = 关着。 */
  const [pendingUndo, setPendingUndo] = useState<CheckpointFileChange | null>(
    null,
  );
  const [_reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!accessToken || !canvasId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const checkpoints = await fetchCheckpoints(accessToken, canvasId);
        const latestTurn = [...checkpoints]
          .reverse()
          .find((c) => c.kind === "turn");
        if (!latestTurn) {
          if (!cancelled) {
            setCheckpoint(null);
            setFiles([]);
            setLoading(false);
          }
          return;
        }
        const list = await fetchCheckpointFiles(accessToken, latestTurn.id);
        if (!cancelled) {
          setCheckpoint(latestTurn);
          setFiles(list);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "读取检查点变更失败。");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, canvasId]);

  const undo = useCallback(async () => {
    if (!accessToken || !canvasId || !checkpoint || !pendingUndo) return;
    setUndoingPath(pendingUndo.path);
    setError(null);
    try {
      await restoreCheckpointFile(
        accessToken,
        canvasId,
        checkpoint.id,
        pendingUndo.path,
      );
      // 撤销后重拉清单与检查点行（恢复本身也是一条 restore 快照，面板仍锚在最近的 turn 行）
      const list = await fetchCheckpointFiles(accessToken, checkpoint.id);
      setFiles(list);
      setPendingUndo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤销失败，请重试。");
    } finally {
      setUndoingPath(null);
    }
  }, [accessToken, canvasId, checkpoint, pendingUndo]);

  if (!accessToken || !canvasId) {
    return (
      <p className="px-4 py-6 text-xs text-muted-foreground">未绑定工作目录</p>
    );
  }
  if (loading) {
    return <p className="px-4 py-6 text-xs text-muted-foreground">读取中…</p>;
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {checkpoint
            ? `${checkpoint.label} · ${new Date(checkpoint.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}`
            : "还没有检查点"}
        </p>
        <button
          type="button"
          onClick={() => setReloadToken((t) => t + 1)}
          className="shrink-0 rounded border border-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          刷新
        </button>
      </div>
      {error ? (
        <p className="mx-4 mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      {checkpoint === null ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">
          跑一轮对话后出现
        </p>
      ) : files.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">没有改动</p>
      ) : (
        <ul
          aria-label="本轮改动的文件"
          className="min-h-0 flex-1 divide-y overflow-y-auto px-4 pb-4"
        >
          {files.map((file) => (
            <li
              key={file.path}
              className="flex items-center gap-2 py-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate" title={file.path}>
                <span className="font-medium">{getPathLeaf(file.path)}</span>
                {file.path.includes("/") ? (
                  <span className="ml-1.5 text-muted-foreground/50">
                    {file.path.slice(0, file.path.lastIndexOf("/"))}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{file.added ?? 0}
                </span>{" "}
                <span className="text-rose-600 dark:text-rose-400">
                  −{file.deleted ?? 0}
                </span>
              </span>
              <button
                type="button"
                disabled={running || undoingPath !== null}
                onClick={() => setPendingUndo(file)}
                title={
                  running
                    ? "任务运行中"
                    : `恢复到本轮开始前（${getPathLeaf(file.path)}）`
                }
                className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
              >
                {undoingPath === file.path ? "撤销中…" : "撤销"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {pendingUndo ? (
        <div
          role="dialog"
          aria-label="确认撤销这个文件"
          className="border-t bg-muted/30 px-4 py-3"
        >
          <p className="text-xs text-foreground">
            <span className="font-mono">{pendingUndo.path}</span>{" "}
            恢复到本轮开始前？
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            覆盖该轮修改（+{pendingUndo.added ?? 0} −{pendingUndo.deleted ?? 0}
            ） · 恢复会记成新检查点
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingUndo(null)}
              className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              取消
            </button>
            <button
              type="button"
              disabled={undoingPath !== null}
              onClick={() => void undo()}
              className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
            >
              {undoingPath ? "撤销中…" : "确认撤销"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
