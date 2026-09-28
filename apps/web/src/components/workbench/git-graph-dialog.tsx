"use client";

import { GitGraph as GitGraphIcon, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fetchGitGraph, type GitGraphEntry } from "@/lib/code-git-api";
import { keyed } from "../list-keys";

/**
 * Git 图谱（参考图 `git图谱.png`）：**独立窗口**里的提交表格。
 *
 * 形态要点（照参考图）：表头 `图 | 描述 | 日期 | 作者 | 提交`；「图」列是等宽的图形字符
 * （连接线行也画，否则分支会缺笔画）；「描述」列前面挂 ref 小徽标（HEAD / main /
 * origin/main…）；选中某行时下方给出该提交的详情（主题 / 提交 / 作者 / 日期 / 父提交）。
 * 右上角有刷新。
 *
 * 为什么改成弹窗：此前的实现是弹层里塞一段 ASCII —— 放不下列，也读不出「谁在什么时候提交的」。
 */
export function GitGraphDialog({
  open,
  onClose,
  accessToken,
  canvasId,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
  canvasId: string | null;
}) {
  const [entries, setEntries] = useState<GitGraphEntry[] | null>(null);
  const [isRepo, setIsRepo] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !canvasId) return;
    setError(null);
    try {
      const graph = await fetchGitGraph(accessToken, canvasId);
      setEntries(graph.entries);
      setIsRepo(graph.isRepo);
      setTruncated(graph.truncated);
      setSelected((current) =>
        current && graph.entries.some((e) => e.sha === current)
          ? current
          : null,
      );
    } catch (err) {
      setEntries([]);
      setError(err instanceof Error ? err.message : "读取 git 图谱失败。");
    }
  }, [accessToken, canvasId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const selectedEntry =
    entries?.find((entry) => entry.sha && entry.sha === selected) ?? null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex max-h-[82vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        <div className="flex items-center gap-2 border-b px-5 py-3 pr-20">
          <GitGraphIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <DialogTitle className="text-sm font-medium">Git 图谱</DialogTitle>
          <button
            type="button"
            aria-label="刷新"
            title="刷新"
            onClick={() => void load()}
            className="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        {error ? (
          <p className="border-b border-destructive/40 bg-destructive/5 px-5 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {!isRepo ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            还不是 git 仓库
          </p>
        ) : entries === null ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">读取中…</p>
        ) : entries.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">还没有提交</p>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-card">
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="w-10 px-3 py-2 font-normal">图</th>
                    <th className="px-2 py-2 font-normal">描述</th>
                    <th className="w-28 px-2 py-2 font-normal">日期</th>
                    <th className="w-28 px-2 py-2 font-normal">作者</th>
                    <th className="w-24 px-2 py-2 font-normal">提交</th>
                  </tr>
                </thead>
                <tbody>
                  {keyed(
                    entries,
                    (entry) => `${entry.sha ?? "rail"}-${entry.rail}`,
                  ).map(({ key, item: entry }) => {
                    const isSelected =
                      entry.sha !== null && entry.sha === selected;
                    return (
                      <tr
                        key={key}
                        // 连接线行不可选：它没有提交可看
                        onClick={() =>
                          entry.sha ? setSelected(entry.sha) : undefined
                        }
                        data-selected={isSelected || undefined}
                        className={`border-b last:border-b-0 data-[selected]:bg-muted ${
                          entry.sha ? "cursor-pointer hover:bg-muted/60" : ""
                        }`}
                      >
                        <td className="px-3 py-1.5 align-top">
                          {/* 图形字符原样渲染：`*`、`|`、`|\` 就是 git 自己画的那套 */}
                          <pre className="m-0 font-mono text-[11px] leading-4 whitespace-pre text-muted-foreground">
                            {entry.rail}
                          </pre>
                        </td>
                        <td className="min-w-0 px-2 py-1.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            {entry.refs.map((ref) => (
                              <span
                                key={ref}
                                className="shrink-0 rounded border bg-muted/60 px-1 py-px font-mono text-[10px] text-muted-foreground"
                              >
                                {ref}
                              </span>
                            ))}
                            <span className="min-w-0 flex-1 truncate">
                              {entry.subject}
                            </span>
                          </span>
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                          {entry.date ? formatCommitDate(entry.date) : ""}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                          {entry.author}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-muted-foreground">
                          {entry.shortSha ?? ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {truncated ? (
                <p className="px-5 py-2 text-[11px] text-muted-foreground">
                  只显示最近 30 条
                </p>
              ) : null}
            </div>

            {/* 选中提交的详情（参考图底部那块） */}
            {selectedEntry ? (
              <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-2 border-t px-5 py-3 text-xs sm:grid-cols-3">
                <div className="col-span-2 sm:col-span-3">
                  <dt className="text-muted-foreground">主题</dt>
                  <dd className="mt-0.5">{selectedEntry.subject}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">提交</dt>
                  <dd className="mt-0.5 font-mono break-all">
                    {selectedEntry.sha}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">作者</dt>
                  <dd className="mt-0.5">{selectedEntry.author}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">日期</dt>
                  <dd className="mt-0.5">
                    {formatCommitDate(selectedEntry.date)}
                  </dd>
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <dt className="text-muted-foreground">父提交</dt>
                  <dd className="mt-0.5 font-mono">
                    {selectedEntry.parents
                      .map((sha) => sha.slice(0, 7))
                      .join(" ") || "（根提交）"}
                  </dd>
                </div>
              </dl>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * `2026-09-16T17:08:00+08:00` → `09/16 17:08`（参考图口径）。
 * 解析失败时原样返回——宁可显示原始串，也不要 `Invalid Date`。
 */
export function formatCommitDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(parsed.getMonth() + 1)}/${pad(parsed.getDate())} ${pad(
    parsed.getHours(),
  )}:${pad(parsed.getMinutes())}`;
}
