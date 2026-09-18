"use client";

import { FileCode2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  fetchGitChanges,
  fetchGitFileDiff,
  fetchSandboxFile,
  setGitFileStaged,
  stageGitHunk,
} from "@/lib/code-git-api";
import { highlightCode } from "@/lib/code-highlight";
import {
  hunkPatch,
  markHunkStarts,
  splitHunks,
  toDiffLines,
} from "@/lib/git-hunks";
import { keyed } from "../list-keys";

/**
 * 「审查」（差异）与「打开」（文件内容）两个标签的正文。
 *
 * 差异视图的动作（参考图：暂存是逐块/逐文件做的）：
 * - 每个块的**左边**给 `＋`（暂存块）与 `⟲`（撤销块）——用户口径：暂存块和撤销块要做在左边；
 * - 头部给整文件的「暂存 / 取消暂存」与「打开」（转到只读预览）。
 */
export function DiffPane({
  accessToken,
  canvasId,
  path,
  version,
  onChanged,
  onOpenFile,
}: {
  accessToken: string | null;
  canvasId: string | null;
  path: string;
  version: number;
  onChanged: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [staged, setStaged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在处理第几块（null = 空闲）。 */
  const [hunkBusy, setHunkBusy] = useState<number | null>(null);
  /** 读差异的次数：块动作后 +1，重新拉正文。 */
  const [reload, setReload] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version/reload 是刷新信号（值不参与请求）；去掉后块动作或外部改动不再重拉
  useEffect(() => {
    if (!accessToken || !canvasId) return;
    let cancelled = false;
    setText(null);
    Promise.all([
      fetchGitFileDiff(accessToken, canvasId, path),
      fetchGitChanges(accessToken, canvasId).catch(() => null),
    ])
      .then(([diff, changes]) => {
        if (cancelled) return;
        setText(diff.text);
        setNote(
          diff.untracked
            ? "未跟踪文件（按新增展示）"
            : diff.truncated
              ? "已截断"
              : undefined,
        );
        setStaged(
          changes?.files.find((file) => file.path === path)?.staged ?? false,
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setText("");
          setError(err instanceof Error ? err.message : "读取差异失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, canvasId, path, version, reload]);

  /** 暂存 / 取消暂存整个文件（进索引，工作区内容不动）。 */
  const toggleStaged = useCallback(async () => {
    if (!accessToken || !canvasId) return;
    setBusy(true);
    setError(null);
    try {
      await setGitFileStaged(accessToken, canvasId, path, !staged);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂存失败。");
    } finally {
      setBusy(false);
    }
  }, [accessToken, canvasId, path, staged, onChanged]);

  /**
   * 块级动作：`stage` = 这一块进索引；`discard` = 丢掉这一块的工作区改动（**丢内容**，先确认）。
   * 两者都只发「文件头 + 这一块」的 patch。
   */
  const applyHunkAction = useCallback(
    async (hunkIndex: number, action: "stage" | "discard") => {
      if (!accessToken || !canvasId || text === null) return;
      const { fileHeader, hunks } = splitHunks(text);
      const hunk = hunks[hunkIndex];
      if (!hunk) return;
      if (
        action === "discard" &&
        !window.confirm(
          `撤销第 ${hunkIndex + 1} 块？这一块在 ${path} 里的改动会被丢掉，无法从这里恢复。`,
        )
      ) {
        return;
      }
      setHunkBusy(hunkIndex);
      setError(null);
      try {
        await stageGitHunk(
          accessToken,
          canvasId,
          path,
          hunkPatch(fileHeader, hunk),
          action === "discard" ? { reverse: true, target: "worktree" } : {},
        );
        onChanged();
        // 内容变了，重读这份 diff（否则界面上还留着已经不存在的改动）
        setReload((count) => count + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "这一块没处理成功。");
      } finally {
        setHunkBusy(null);
      }
    },
    [accessToken, canvasId, path, text, onChanged],
  );

  return (
    <div className="space-y-2">
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="border">
        <div className="flex items-center gap-2 border-b px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {path}
          </span>
          {note ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {note}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={`打开 ${path}`}
            title="打开：只看文件内容（不改动任何东西）"
            onClick={() => onOpenFile(path)}
            className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            打开
          </button>
          <button
            type="button"
            aria-label={staged ? "取消暂存此文件" : "暂存此文件"}
            disabled={busy}
            title={
              staged
                ? "从索引里撤下这个文件（工作区内容不动）"
                : "把这个文件加入索引（下次提交会带上它）"
            }
            onClick={() => void toggleStaged()}
            className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
          >
            {busy ? "处理中…" : staged ? "取消暂存" : "暂存此文件"}
          </button>
        </div>
        {text === null ? (
          <p className="p-2 text-xs text-muted-foreground">读取中…</p>
        ) : (
          <section
            aria-label="文件差异"
            className="max-h-[70vh] overflow-auto p-2 font-mono text-[11px] leading-5"
          >
            {keyed(
              markHunkStarts(toDiffLines(text)),
              (line) => `${line.kind}-${line.text}`,
            ).map(({ key, item: line }) => (
              <div
                key={key}
                className={`flex items-start gap-1 whitespace-pre ${
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
                {/* 块头左侧的 gutter：＋ 暂存块 / ⟲ 撤销块（参考图就在左边） */}
                <span className="flex w-10 shrink-0 items-center gap-0.5 pl-0.5">
                  {line.hunkIndex === undefined ? null : (
                    <>
                      <button
                        type="button"
                        aria-label={`暂存第 ${line.hunkIndex + 1} 块`}
                        disabled={hunkBusy !== null}
                        title="暂存块：只把这一块加进索引（其余块留在工作区）"
                        onClick={() => {
                          if (line.hunkIndex === undefined) return;
                          void applyHunkAction(line.hunkIndex, "stage");
                        }}
                        className="rounded border border-emerald-600/40 px-1 text-[10px] leading-4 text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-400"
                      >
                        ＋
                      </button>
                      <button
                        type="button"
                        aria-label={`撤销第 ${line.hunkIndex + 1} 块`}
                        disabled={hunkBusy !== null}
                        title="撤销块：丢掉这一块的工作区改动（会丢内容，需确认）"
                        onClick={() => {
                          if (line.hunkIndex === undefined) return;
                          void applyHunkAction(line.hunkIndex, "discard");
                        }}
                        className="rounded border border-rose-600/40 px-1 text-[10px] leading-4 text-rose-700 transition-colors hover:bg-rose-500/10 disabled:opacity-40 dark:text-rose-400"
                      >
                        ⟲
                      </button>
                    </>
                  )}
                </span>
                <span className="min-w-0 flex-1">{line.text}</span>
                {line.hunkIndex !== undefined && hunkBusy === line.hunkIndex ? (
                  <span className="shrink-0 pr-1 text-[10px] text-muted-foreground">
                    处理中…
                  </span>
                ) : null}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * 文件内容预览（「打开」与文件目录的落点）：能认语言就按 highlight.js 高亮渲染
 * （输出已转义），认不出来就纯文本——不猜语言，也不半渲染。
 */
export function FilePane({
  accessToken,
  canvasId,
  path,
}: {
  accessToken: string | null;
  canvasId: string | null;
  path: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken || !canvasId) return;
    let cancelled = false;
    setText(null);
    fetchSandboxFile(accessToken, canvasId, path)
      .then((file) => {
        if (cancelled) return;
        setText(file.binary ? "（二进制文件，无法按文本显示）" : file.content);
        setNote(file.truncated ? "已截断（只显示前 256 KB）" : undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setText("");
          setError(err instanceof Error ? err.message : "读取文件失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, canvasId, path]);

  const highlighted = text === null ? null : highlightCode(text, path);

  return (
    <div className="space-y-2">
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="border">
        <div className="flex items-center gap-2 border-b px-2 py-1.5">
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {path}
          </span>
          {note ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {note}
            </span>
          ) : null}
        </div>
        {text === null ? (
          <p className="p-2 text-xs text-muted-foreground">读取中…</p>
        ) : highlighted ? (
          // biome-ignore lint/a11y/useSemanticElements: 要 <pre> 的预格式语义（代码原文）；带 aria-label 的 section 会丢格式，role=region 只补地标
          <pre
            role="region"
            aria-label="文件内容"
            className="hljs max-h-[70vh] overflow-auto p-2 font-mono text-[11px] leading-5 whitespace-pre"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js 的输出自己转义（见 lib/code-highlight 的单测）
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: 同上：<pre> 的预格式语义优先
          <pre
            role="region"
            aria-label="文件内容"
            className="max-h-[70vh] overflow-auto p-2 font-mono text-[11px] leading-5 whitespace-pre"
          >
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}
