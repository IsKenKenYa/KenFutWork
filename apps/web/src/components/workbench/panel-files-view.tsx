"use client";

import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { type CodeFileListing, fetchCodeFiles } from "@/lib/code-git-api";

/**
 * 文件目录（R3-1「文件目录」标签）：**只列一层**，子目录点进去、面包屑回退。
 *
 * 为什么不做整棵树：大型工作目录一次递归能出几千条，而这个面板是给「这一层有什么」
 * 用的；一层一层走既快又看得清（与参考图的文件浏览器一致）。
 *
 * 点文件名 = 打开预览（高亮渲染在「文件」标签里，见 panel-reading-view）。
 */
export function FilesPane({
  accessToken,
  canvasId,
  onOpenFile,
}: {
  accessToken: string | null;
  canvasId: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<CodeFileListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken || !canvasId) return;
    let cancelled = false;
    setListing(null);
    fetchCodeFiles(accessToken, canvasId, dir)
      .then((next) => {
        if (!cancelled) setListing(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setListing({ path: dir, entries: [], truncated: false });
          setError(err instanceof Error ? err.message : "读取目录失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, canvasId, dir]);

  if (!canvasId) {
    return (
      <p className="text-xs text-muted-foreground">这个会话没有绑定工作目录。</p>
    );
  }

  const segments = dir ? dir.split("/") : [];

  return (
    <div className="space-y-2">
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      {/* 面包屑：工作目录 → … → 当前目录 */}
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={() => setDir("")}
          className="rounded px-1 hover:bg-muted hover:text-foreground"
        >
          工作目录
        </button>
        {segments.map((segment, index) => (
          <span key={segment} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <button
              type="button"
              onClick={() => setDir(segments.slice(0, index + 1).join("/"))}
              className="rounded px-1 hover:bg-muted hover:text-foreground"
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {listing === null ? (
        <p className="text-xs text-muted-foreground">读取中…</p>
      ) : listing.entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">这个目录是空的。</p>
      ) : (
        <ul aria-label="目录内容" className="divide-y rounded-xl border">
          {listing.entries.map((entry) => (
            <li key={entry.path} className="flex items-center gap-2 px-2.5 py-1.5">
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() =>
                  entry.type === "dir" ? setDir(entry.path) : onOpenFile(entry.path)
                }
                aria-label={
                  entry.type === "dir"
                    ? `进入 ${entry.path}`
                    : `打开 ${entry.path}`
                }
                className="min-w-0 flex-1 truncate text-left text-xs hover:underline"
              >
                {entry.name}
              </button>
              {entry.type === "dir" ? null : (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {entry.bytes === null ? "" : formatBytes(entry.bytes)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {listing?.truncated ? (
        <p className="text-[10px] text-muted-foreground">只列出前 500 项。</p>
      ) : null}
    </div>
  );
}

/** 字节数的人类可读形态（列表里只表示量级）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
