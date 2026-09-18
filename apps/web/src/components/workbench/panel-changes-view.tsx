"use client";

import { FileDiff as FileDiffIcon, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import {
  discardGitChanges,
  fetchGitChanges,
  type GitChanges,
} from "@/lib/code-git-api";

/**
 * 变更列表（参考图：N 个文件已更改 +a −d，逐行 图标/名称/路径/统计/审查/打开/撤销）。
 *
 * 三种动作的分工（用户口径）：
 * - **审查** = 看差异，并在差异里逐块/整文件暂存（「是否应用」的入口）；
 * - **打开** = 只看文件内容（改不了东西）；
 * - 点文件名 = 打开预览（与「打开」同一条路，参考图里文件名本身就是入口）。
 */
export function ChangesPane({
  accessToken,
  canvasId,
  /** 变化计数：暂存/撤销之后由外壳 +1，让清单重新拉取。 */
  version,
  onOpenDiff,
  onOpenFile,
  onChanged,
}: {
  accessToken: string | null;
  canvasId: string | null;
  version: number;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onChanged: () => void;
}) {
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是刷新信号（值不参与请求）；去掉后外部改动不再触发重拉
  useEffect(() => {
    if (!accessToken || !canvasId) return;
    let cancelled = false;
    setChanges(null);
    fetchGitChanges(accessToken, canvasId)
      .then((next) => {
        if (!cancelled) setChanges(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setChanges({ isRepo: false, files: [], truncated: false });
          setError(err instanceof Error ? err.message : "读取变更失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, canvasId, version]);

  /** 撤销单个文件的改动（未跟踪 = 删除该文件）；**丢内容**，先确认。 */
  const discardFile = async (path: string, untracked: boolean) => {
    if (!accessToken || !canvasId) return;
    const what = untracked
      ? `删除未跟踪文件 ${path}`
      : `把 ${path} 恢复成仓库里的样子`;
    if (!window.confirm(`确定撤销？将${what}，这些改动无法从这里恢复。`)) {
      return;
    }
    setDiscarding(true);
    setError(null);
    try {
      await discardGitChanges(accessToken, canvasId, { path, untracked });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤销失败。");
    } finally {
      setDiscarding(false);
    }
  };

  /** 撤销全部未提交改动；**丢内容**，先确认（确认框里带文件数）。 */
  const discardEverything = async () => {
    if (!accessToken || !canvasId) return;
    const count = changes?.files.length ?? 0;
    if (
      !window.confirm(
        `确定撤销全部 ${count} 个文件的改动？未跟踪的新文件会被删除，且无法从这里恢复。`,
      )
    ) {
      return;
    }
    setDiscarding(true);
    setError(null);
    try {
      await discardGitChanges(accessToken, canvasId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤销失败。");
    } finally {
      setDiscarding(false);
    }
  };

  if (!canvasId) {
    return <p className="text-xs text-muted-foreground">未绑定工作目录</p>;
  }

  const totals = (changes?.files ?? []).reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="space-y-2">
      {error ? (
        <p className="border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      {changes === null ? (
        <p className="text-xs text-muted-foreground">读取中…</p>
      ) : !changes.isRepo ? (
        <p className="text-xs text-muted-foreground">还不是 git 仓库</p>
      ) : changes.files.length === 0 ? (
        <p className="text-xs text-muted-foreground">没有未提交的更改。</p>
      ) : (
        <div className="border">
          <div className="flex items-center gap-2 border-b px-2.5 py-2 text-xs">
            <FileDiffIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">{changes.files.length}</span>{" "}
              个文件已更改
            </span>
            {/* 合计与逐行统计对齐同一列：按两个行内按钮的实际占宽留白（同一套标签与内边距，
                写死像素会在字体/本地化变化时错位） */}
            <span
              aria-hidden
              className="invisible ml-auto flex shrink-0 items-center gap-2"
            >
              <span className="border px-1.5 py-0.5 text-[10px]">审查</span>
              <span className="border px-1.5 py-0.5 text-[10px]">打开</span>
            </span>
            <span className={CHANGE_STAT_CELL}>
              <span className="text-emerald-600">+{totals.additions}</span>{" "}
              <span className="text-rose-500">−{totals.deletions}</span>
            </span>
            <button
              type="button"
              aria-label="撤销全部更改"
              disabled={discarding || changes.files.length === 0}
              title="撤销全部更改"
              onClick={() => void discardEverything()}
              className="shrink-0 border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
            >
              撤销
            </button>
          </div>
          <ul aria-label="变更文件" className="divide-y">
            {changes.files.map((file) => {
              const { name, dir } = splitPath(file.path);
              return (
                <li
                  key={file.path}
                  className="flex items-center gap-2 px-2.5 py-1.5"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {/* 文件名本身就是「打开预览」的入口（用户口径：点文件名可以打开预览文件） */}
                  <button
                    type="button"
                    aria-label={`打开 ${file.path} 的预览`}
                    onClick={() => onOpenFile(file.path)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-xs hover:underline">
                      {name}
                    </span>
                    {dir ? (
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {dir}
                      </span>
                    ) : null}
                  </button>
                  {file.staged ? (
                    <span className="shrink-0 bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      已暂存
                    </span>
                  ) : null}
                  {file.binary ? (
                    <span
                      className={`${CHANGE_STAT_CELL} text-[10px] text-muted-foreground`}
                    >
                      二进制
                    </span>
                  ) : (
                    <span className={CHANGE_STAT_CELL}>
                      <span className="text-emerald-600">
                        +{file.additions}
                      </span>{" "}
                      <span className="text-rose-500">−{file.deletions}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`审查 ${file.path}`}
                    title="审查"
                    onClick={() => onOpenDiff(file.path)}
                    className="shrink-0 border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    审查
                  </button>
                  <button
                    type="button"
                    aria-label={`打开 ${file.path}`}
                    title="打开"
                    onClick={() => onOpenFile(file.path)}
                    className="shrink-0 border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    aria-label={`撤销 ${file.path}`}
                    disabled={discarding}
                    onClick={() =>
                      void discardFile(file.path, file.status === "untracked")
                    }
                    title="撤销"
                    className="shrink-0 border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
                  >
                    撤销
                  </button>
                </li>
              );
            })}
          </ul>
          {changes.truncated ? (
            <p className="border-t px-2.5 py-1.5 text-[10px] text-muted-foreground">
              只显示前 200 个文件。
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * 变更列表的统计列：**定宽 + 右对齐 + 等宽数字**——三个口径缺一个，逐行的 `+a −d`
 * 就会左右晃（`+0 −0` 与 `+1022 −396` 宽度差一倍），行与行之间看不出是一列。
 */
const CHANGE_STAT_CELL =
  "w-[4.75rem] shrink-0 text-right font-mono text-[11px] tabular-nums";

/** 路径拆成「文件名 + 所在目录」（列表两行显示）。 */
export function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return { name, dir: parts.join("/") };
}
