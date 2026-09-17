"use client";

import { Folder, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type CodeFileListing, fetchCodeFiles } from "@/lib/code-git-api";
import { type CodeIndexSearchHit, searchCodeIndex } from "@/lib/server-api";

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
  /**
   * 索引库搜索（R4-3 的消费方）：按文件名 / 路径 / 内容摘要找文件，不必一层层翻目录。
   * 索引库没开时服务端回 409 并指路，这里把原话显示出来。
   */
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<CodeIndexSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = useCallback(
    async (query: string) => {
      if (!accessToken || !canvasId || !query.trim()) {
        setHits(null);
        setSearchError(null);
        return;
      }
      setSearching(true);
      setSearchError(null);
      try {
        const result = await searchCodeIndex(accessToken, canvasId, query);
        setHits(result.hits);
      } catch (err) {
        setHits(null);
        setSearchError(err instanceof Error ? err.message : "搜索失败。");
      } finally {
        setSearching(false);
      }
    },
    [accessToken, canvasId],
  );

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
      <p className="text-xs text-muted-foreground">
        这个会话没有绑定工作目录。
      </p>
    );
  }

  const segments = dir ? dir.split("/") : [];

  return (
    <div className="space-y-2">
      <form
        className="flex items-center gap-1.5 rounded-md border px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(searchQuery);
        }}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label="搜索文件"
          value={searchQuery}
          onChange={(event) => {
            setSearchQuery(event.target.value);
            if (!event.target.value.trim()) {
              setHits(null);
              setSearchError(null);
            }
          }}
          placeholder="按文件名 / 路径 / 内容摘要搜索（索引库）"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
        <button
          type="submit"
          disabled={searching}
          className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
        >
          {searching ? "搜索中…" : "搜索"}
        </button>
      </form>

      {searchError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {searchError}
        </p>
      ) : null}

      {hits ? (
        <div className="rounded-xl border">
          <p className="border-b px-2.5 py-1.5 text-[10px] text-muted-foreground">
            {hits.length === 0
              ? "没有匹配的文件"
              : `命中 ${hits.length} 个文件`}
            {hits.length > 0 ? "（点了打开预览）" : ""}
          </p>
          <ul aria-label="搜索命中" className="divide-y">
            {hits.map((hit) => (
              <li key={hit.path} className="px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={() => onOpenFile(hit.path)}
                  className="min-w-0 w-full text-left"
                >
                  <span className="flex items-center gap-1.5">
                    {hit.language ? (
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {hit.language}
                      </span>
                    ) : null}
                    <span className="truncate font-mono text-xs hover:underline">
                      {hit.path}
                    </span>
                  </span>
                  {hit.summary ? (
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                      {hit.summary}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
            <li
              key={entry.path}
              className="flex items-center gap-2 px-2.5 py-1.5"
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() =>
                  entry.type === "dir"
                    ? setDir(entry.path)
                    : onOpenFile(entry.path)
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
