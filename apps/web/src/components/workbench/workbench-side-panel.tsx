"use client";

import {
  ArrowLeft,
  FileDiff as FileDiffIcon,
  FileText,
  GitBranch,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { SubagentDirectoryView } from "@/components/workbench/subagent-directory-view";
import {
  fetchCodeDocs,
  fetchGitChanges,
  fetchGitFileDiff,
  fetchSandboxFile,
  type GitChanges,
  type SandboxFileView,
} from "@/lib/code-git-api";
import type { SubagentEntry } from "@/lib/subagent-directory";

/**
 * Code 工作台的右栏停靠面板（参考图 R3-1「扩展插件-添加终端、浏览器、变更等功能」）。
 *
 * **为什么是面板而不是下拉**：参考图里「变更列表 / 文档入口 / 子智能体目录」都是**右侧面板的
 * 标签页**——它们是「边看边改」的长驻视图（24 个文件要逐行审查、文档要读、子代理要看进展），
 * 塞进分支下拉那种一次性弹层里既放不下也留不住。此前把变更/文档放进下拉正是形态做错。
 *
 * 标签是**视图**，不是会话内容：切标签只换正文。终端/浏览器两个标签要各自的执行缝与浏览器能力
 * （R3-1 的另两项、R3-4），另一个批次做；这里先把已有能力装进正确的容器。
 */
export type WorkbenchPanelTab = "changes" | "docs" | "subagents";

const TABS: Array<{ id: WorkbenchPanelTab; label: string }> = [
  { id: "changes", label: "变更" },
  { id: "docs", label: "文档" },
  { id: "subagents", label: "子智能体" },
];

/** 面板里正在看的东西：null = 看列表；否则看这个文件的差异/内容。 */
type Reading =
  | { kind: "diff"; path: string; text: string; note?: string }
  | { kind: "file"; path: string; text: string; note?: string };

function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return { name, dir: parts.join("/") };
}

export function WorkbenchSidePanel({
  open,
  onClose,
  tab,
  onTabChange,
  accessToken,
  canvasId,
  subagents,
  running,
}: {
  open: boolean;
  onClose: () => void;
  tab: WorkbenchPanelTab;
  onTabChange: (tab: WorkbenchPanelTab) => void;
  accessToken: string | null;
  /** 作用域画布 = 会话自己绑定的项目主画布（与 run 同一口径）。 */
  canvasId: string | null;
  subagents: SubagentEntry[];
  running: boolean;
}) {
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [docs, setDocs] = useState<Array<{ path: string; bytes: number }> | null>(
    null,
  );
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 拉取当前标签需要的数据（变更/文档各一个端点；子智能体走已有事件流）。 */
  useEffect(() => {
    if (!open || !accessToken || !canvasId) return;
    let cancelled = false;
    if (tab === "changes") {
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
    }
    if (tab === "docs") {
      setDocs(null);
      fetchCodeDocs(accessToken, canvasId)
        .then((next) => {
          if (!cancelled) setDocs(next);
        })
        .catch(() => {
          if (!cancelled) setDocs([]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, tab, accessToken, canvasId]);

  // 切标签/关面板时退出「正在看某个文件」的状态，免得下次进来还停在上次的文件上
  useEffect(() => {
    setReading(null);
    setError(null);
  }, [tab, open]);

  const openDiff = useCallback(
    async (path: string) => {
      if (!accessToken || !canvasId) return;
      try {
        const diff = await fetchGitFileDiff(accessToken, canvasId, path);
        setReading({
          kind: "diff",
          path,
          text: diff.text,
          ...(diff.untracked
            ? { note: "未跟踪文件（按新增展示）" }
            : diff.truncated
              ? { note: "已截断" }
              : {}),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "读取差异失败。");
      }
    },
    [accessToken, canvasId],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!accessToken || !canvasId) return;
      try {
        const file: SandboxFileView = await fetchSandboxFile(
          accessToken,
          canvasId,
          path,
        );
        setReading({
          kind: "file",
          path,
          text: file.binary ? "（二进制文件，无法按文本显示）" : file.content,
          ...(file.truncated ? { note: "已截断（只显示前 256 KB）" } : {}),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "读取文件失败。");
      }
    },
    [accessToken, canvasId],
  );

  if (!open) return null;

  const totals = (changes?.files ?? []).reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return (
    <aside
      aria-label="工作台面板"
      className="flex w-[360px] shrink-0 flex-col border-l bg-card"
    >
      {/* 标签条：与参考图一致——标签是视图，右侧是关闭 */}
      <div className="flex min-h-[44px] items-center gap-1 border-b px-2">
        <div role="tablist" aria-label="面板视图" className="flex items-center gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => onTabChange(item.id)}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:bg-muted data-[active=true]:font-medium data-[active=true]:text-foreground"
              data-active={tab === item.id}
            >
              {item.label}
              {item.id === "subagents" && subagents.length > 0
                ? ` · ${subagents.length}`
                : ""}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="收起面板"
          onClick={onClose}
          className="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
            {error}
          </p>
        ) : null}

        {reading ? (
          <div className="rounded-xl border">
            <div className="flex items-center gap-2 border-b px-2 py-1.5">
              <button
                type="button"
                aria-label="返回列表"
                onClick={() => setReading(null)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {reading.path}
              </span>
              {reading.note ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {reading.note}
                </span>
              ) : null}
            </div>
            <pre
              aria-label={reading.kind === "diff" ? "文件差异" : "文件内容"}
              className="max-h-[60vh] overflow-auto p-2 font-mono text-[11px] leading-5 whitespace-pre"
            >
              {reading.text}
            </pre>
          </div>
        ) : tab === "subagents" ? (
          subagents.length > 0 ? (
            <SubagentDirectoryView entries={subagents} running={running} />
          ) : (
            <p className="text-xs text-muted-foreground">
              这个会话还没有派过子智能体。
            </p>
          )
        ) : tab === "docs" ? (
          <DocsView
            docs={docs}
            canvasId={canvasId}
            onOpen={(path) => void openFile(path)}
          />
        ) : (
          <ChangesView
            changes={changes}
            canvasId={canvasId}
            totals={totals}
            onReview={(path) => void openDiff(path)}
            onOpen={(path) => void openFile(path)}
          />
        )}
      </div>
    </aside>
  );
}

/** 变更列表（参考图：N 个文件已更改 +a −d，逐行 图标/名称/路径/统计/审查/打开）。 */
function ChangesView({
  changes,
  canvasId,
  totals,
  onReview,
  onOpen,
}: {
  changes: GitChanges | null;
  canvasId: string | null;
  totals: { additions: number; deletions: number };
  onReview: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  if (!canvasId) {
    return (
      <p className="text-xs text-muted-foreground">
        这个会话没有绑定工作目录——绑定后这里会列出它的改动。
      </p>
    );
  }
  if (changes === null) {
    return <p className="text-xs text-muted-foreground">读取中…</p>;
  }
  if (!changes.isRepo) {
    return (
      <p className="text-xs text-muted-foreground">
        该工作目录还不是 git 仓库；初始化后每轮对话会自动提交，改动也会列在这里。
      </p>
    );
  }
  if (changes.files.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">没有未提交的更改。</p>
    );
  }

  return (
    <div className="rounded-xl border">
      <div className="flex items-center gap-2 border-b px-2.5 py-2 text-xs">
        <FileDiffIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>
          <span className="font-medium">{changes.files.length}</span> 个文件已更改
        </span>
        <span className="ml-auto font-mono">
          <span className="text-emerald-600">+{totals.additions}</span>{" "}
          <span className="text-rose-500">−{totals.deletions}</span>
        </span>
      </div>
      <ul aria-label="变更文件" className="divide-y">
        {changes.files.map((file) => {
          const { name, dir } = splitPath(file.path);
          return (
            <li key={file.path} className="flex items-center gap-2 px-2.5 py-1.5">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{name}</span>
                {dir ? (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {dir}
                  </span>
                ) : null}
              </span>
              {file.binary ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  二进制
                </span>
              ) : (
                <span className="shrink-0 font-mono text-[11px]">
                  <span className="text-emerald-600">+{file.additions}</span>{" "}
                  <span className="text-rose-500">−{file.deletions}</span>
                </span>
              )}
              <button
                type="button"
                aria-label={`审查 ${file.path}`}
                onClick={() => onReview(file.path)}
                className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                审查
              </button>
              <button
                type="button"
                aria-label={`打开 ${file.path}`}
                onClick={() => onOpen(file.path)}
                className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                打开
              </button>
            </li>
          );
        })}
      </ul>
      {changes.truncated ? (
        <p className="border-t px-2.5 py-1.5 text-[10px] text-muted-foreground">
          只列出前 200 个文件。
        </p>
      ) : null}
    </div>
  );
}

/**
 * 文档列表（参考图：`AGENTS.md` / `文档 · MD` / 「打开」）。
 * 打不开时如实说原因（例如目录里没有文档），不留空白。
 */
function DocsView({
  docs,
  canvasId,
  onOpen,
}: {
  docs: Array<{ path: string; bytes: number }> | null;
  canvasId: string | null;
  onOpen: (path: string) => void;
}) {
  if (!canvasId) {
    return (
      <p className="text-xs text-muted-foreground">
        这个会话没有绑定工作目录。
      </p>
    );
  }
  if (docs === null) {
    return <p className="text-xs text-muted-foreground">读取中…</p>;
  }
  if (docs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        这个目录里没有 AGENTS.md / README.md 等文档。
      </p>
    );
  }

  return (
    <ul aria-label="项目文档" className="space-y-2">
      {docs.map((doc) => {
        const { name } = splitPath(doc.path);
        const ext = name.includes(".") ? name.split(".").pop() : "";
        return (
          <li
            key={doc.path}
            className="flex items-center gap-2 rounded-xl border px-3 py-2.5"
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{name}</span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <GitBranch className="h-3 w-3" />
                文档{ext ? ` · ${ext.toUpperCase()}` : ""}
              </span>
            </span>
            <button
              type="button"
              aria-label={`打开 ${doc.path}`}
              onClick={() => onOpen(doc.path)}
              className="shrink-0 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              打开
            </button>
          </li>
        );
      })}
    </ul>
  );
}
