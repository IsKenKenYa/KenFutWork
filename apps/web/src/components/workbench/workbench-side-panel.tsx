"use client";

import {
  ArrowLeft,
  FileDiff as FileDiffIcon,
  FileText,
  Folder,
  GitBranch,
  Globe,
  SquareTerminal,
  MousePointerSquareDashed,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { SubagentDirectoryView } from "@/components/workbench/subagent-directory-view";
import { onBrowserOpen } from "@/lib/browser-panel";
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_WIDTH_KEY,
  type PanelWidthLimits,
} from "@/lib/panel-layout";
import {
  fetchCodeDocs,
  fetchCodeFiles,
  fetchGitChanges,
  runTerminalCommand,
  fetchGitFileDiff,
  fetchSandboxFile,
  type CodeFileListing,
  type GitChanges,
  type TerminalResult,
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
export type WorkbenchPanelTab =
  | "changes"
  | "files"
  | "terminal"
  | "browser"
  | "docs"
  | "subagents";

const TABS: Array<{ id: WorkbenchPanelTab; label: string }> = [
  { id: "changes", label: "变更" },
  { id: "files", label: "文件目录" },
  { id: "terminal", label: "终端" },
  { id: "browser", label: "浏览器" },
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
  widthLimits,
  onGrowBlocked,
  maxWidthExpression,
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
  /** 宽度上下限（工作台按视口与左栏现算，见 lib/panel-layout）。 */
  widthLimits?: PanelWidthLimits;
  /** 拖到上限还继续往里拖：工作台据此把左栏收起来腾地方。 */
  onGrowBlocked?: () => void;
  /**
   * 面板宽度的 CSS 上限表达式（如 `calc(100vw - var(--workbench-sidebar, 256px) - 420px)`）。
   * JS 的 `widthLimits` 依赖 resize 事件，宿主不派发时会陈旧；这条由浏览器排版保证
   * 中间的对话列不被挤没（两条同一口径，见 lib/panel-layout）。
   */
  maxWidthExpression?: string;
}) {
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [docs, setDocs] = useState<Array<{ path: string; bytes: number }> | null>(
    null,
  );
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 右栏浏览器（R3-1）：地址栏当前 URL（空 = 还没打开过）。 */
  const [browserUrl, setBrowserUrl] = useState("");
  /** 地址栏输入框（与已加载的 URL 分开，回车才加载）。 */
  const [urlDraft, setUrlDraft] = useState("");

  /** 转录里点链接 → 打开本标签并加载该 URL（见 lib/browser-panel）。 */
  useEffect(
    () =>
      onBrowserOpen((url) => {
        setBrowserUrl(url);
        setUrlDraft(url);
      }),
    [],
  );

  /** 文件目录：当前浏览的相对路径（根目录是空串）与列表。 */
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<CodeFileListing | null>(null);
  /** 面板宽度（可拖拽，持久化到 localStorage：宽度是用户偏好）。 */
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    const fallback =
      Number.isFinite(saved) && saved >= MIN_PANEL_WIDTH && saved <= MAX_PANEL_WIDTH
        ? saved
        : DEFAULT_PANEL_WIDTH;
    return widthLimits ? clampPanelWidth(fallback, widthLimits) : fallback;
  });

  /**
   * 视口变小或左栏重新展开时，把面板收回到当前上限内——中间对话列不被挤没
   * （用户口径：「保证右侧面板大小可以比较灵活调整」，但对话列要有下限）。
   */
  const limitsRef = useRef(widthLimits);
  limitsRef.current = widthLimits;
  useEffect(() => {
    if (!widthLimits) return;
    setWidth((current) => clampPanelWidth(current, widthLimits));
  }, [widthLimits]);

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
    if (tab === "files") {
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
  }, [open, tab, accessToken, canvasId, dir]);

  // 切标签/关面板时退出「正在看某个文件」的状态，免得下次进来还停在上次的文件上
  useEffect(() => {
    setReading(null);
    setError(null);
    setDir("");
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

  /**
   * 拖左边缘调宽（参考图：左右面板都能调）。面板在右侧，故向左拖 = 变宽；
   * 松手时落 localStorage——宽度是用户偏好，刷新后保持。
   *
   * **拖过上限 = 请求腾地方**：上限是「视口 − 左栏 − 对话列最小宽度」现算的，所以继续拖只会
   * 卡住不动。此时通知工作台把左栏收成图标栏（一次拖拽只请求一次，避免来回抖动），
   * 上限随之变大、面板接着变宽。
   */
  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      let askedForRoom = false;
      const onMove = (moveEvent: MouseEvent) => {
        const desired = startWidth + (startX - moveEvent.clientX);
        const limits = limitsRef.current;
        if (!askedForRoom && limits && desired > limits.max) {
          askedForRoom = true;
          onGrowBlocked?.();
        }
        setWidth(
          clampPanelWidth(
            desired,
            limits ?? { min: MIN_PANEL_WIDTH, max: MAX_PANEL_WIDTH },
          ),
        );
      };
      const onUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const limits = limitsRef.current;
        window.localStorage.setItem(
          PANEL_WIDTH_KEY,
          String(
            clampPanelWidth(
              startWidth + (startX - upEvent.clientX),
              limits ?? { min: MIN_PANEL_WIDTH, max: MAX_PANEL_WIDTH },
            ),
          ),
        );
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, onGrowBlocked],
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
      style={
        maxWidthExpression
          ? { width, minWidth: MIN_PANEL_WIDTH, maxWidth: maxWidthExpression }
          : { width }
      }
      className="relative flex shrink-0 flex-col border-l bg-card"
    >
      {/* 拖拽把手：贴面板左边缘（按住拖动改宽） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        onMouseDown={startResize}
        className="absolute top-0 -left-0.5 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-foreground/20"
      />
      {/* 标签条：与参考图一致——标签是视图，右侧是关闭。
          窄面板（拖到 280px）下标签会换行，而不是把关闭键挤出去 */}
      <div className="flex min-h-[44px] items-center gap-1 border-b px-2">
        <div
          role="tablist"
          aria-label="面板视图"
          className="flex min-w-0 flex-wrap items-center gap-1"
        >
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
        ) : tab === "terminal" ? (
          <TerminalView accessToken={accessToken} canvasId={canvasId} />
        ) : tab === "browser" ? (
          <BrowserView
            url={browserUrl}
            draft={urlDraft}
            onDraftChange={setUrlDraft}
            onNavigate={(next) => {
              setBrowserUrl(next);
              setUrlDraft(next);
            }}
          />
        ) : tab === "files" ? (
          <FilesView
            listing={listing}
            canvasId={canvasId}
            dir={dir}
            onNavigate={(next) => setDir(next)}
            onOpen={(path) => void openFile(path)}
          />
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

/**
 * 变更列表的统计列：**定宽 + 右对齐 + 等宽数字**——三个口径缺一个，逐行的 `+a −d`
 * 就会左右晃（`+0 −0` 与 `+1022 −396` 宽度差一倍），行与行之间看不出是一列。
 */
const CHANGE_STAT_CELL =
  "w-[4.75rem] shrink-0 text-right font-mono text-[11px] tabular-nums";

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
        {/* 合计与逐行统计对齐同一列：按两个行内按钮的实际占宽留白（同一套标签与内边距，
            写死像素会在字体/本地化变化时错位） */}
        <span aria-hidden className="invisible ml-auto flex shrink-0 items-center gap-2">
          <span className="rounded border px-1.5 py-0.5 text-[10px]">审查</span>
          <span className="rounded border px-1.5 py-0.5 text-[10px]">打开</span>
        </span>
        <span className={CHANGE_STAT_CELL}>
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
                <span className={`${CHANGE_STAT_CELL} text-[10px] text-muted-foreground`}>
                  二进制
                </span>
              ) : (
                <span className={CHANGE_STAT_CELL}>
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

/**
 * 文件目录（R3-1「文件目录」标签）：**只列一层**，子目录点进去、面包屑回退。
 *
 * 为什么不做整棵树：大型工作目录一次递归能出几千条，而这个面板是给「这一层有什么」
 * 用的；一层一层走既快又看得清（与参考图的文件浏览器一致）。
 */
function FilesView({
  listing,
  canvasId,
  dir,
  onNavigate,
  onOpen,
}: {
  listing: CodeFileListing | null;
  canvasId: string | null;
  dir: string;
  onNavigate: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  if (!canvasId) {
    return (
      <p className="text-xs text-muted-foreground">
        这个会话没有绑定工作目录。
      </p>
    );
  }
  if (listing === null) {
    return <p className="text-xs text-muted-foreground">读取中…</p>;
  }

  const segments = dir ? dir.split("/") : [];

  return (
    <div className="space-y-2">
      {/* 面包屑：工作目录 → … → 当前目录 */}
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={() => onNavigate("")}
          className="rounded px-1 hover:bg-muted hover:text-foreground"
        >
          工作目录
        </button>
        {segments.map((segment, index) => (
          <span key={segment} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <button
              type="button"
              onClick={() => onNavigate(segments.slice(0, index + 1).join("/"))}
              className="rounded px-1 hover:bg-muted hover:text-foreground"
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {listing.entries.length === 0 ? (
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
                    ? onNavigate(entry.path)
                    : onOpen(entry.path)
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
      {listing.truncated ? (
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

/**
 * 右栏浏览器（参考图 `待办插件、浏览器参考、工具调用可展开.png` 的浏览器视口）。
 *
 * 边界如实写在界面上：这是**内嵌 iframe**，能否渲染取决于目标站点是否允许被嵌入
 * （X-Frame-Options / CSP frame-ancestors）——允许的（本机 dev server 等）能看能用，
 * 不允许的会是一片空白，此时右侧给「在系统浏览器打开」的出口。
 * 「选择网页元素加入聊天」（R3-4）需要跨源 DOM 访问，内嵌 iframe 拿不到，故按钮置灰
 * 并说明原因，不做假开关。
 */
function BrowserView({
  url,
  draft,
  onDraftChange,
  onNavigate,
}: {
  url: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onNavigate: (url: string) => void;
}) {
  const normalized = normalizeUrl(draft);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (normalized) onNavigate(normalized);
        }}
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label="地址"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="输入网址，回车打开"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={normalized === null}
          className="shrink-0 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
        >
          打开
        </button>
      </form>

      <div className="flex items-center gap-2">
        {/* R3-4：拾取网页元素需要跨源 DOM 访问，内嵌 iframe 做不到——不给假按钮 */}
        <button
          type="button"
          disabled
          title="选择网页元素加入聊天需要浏览器的调试接口（CDP/扩展），内嵌 iframe 拿不到跨源 DOM——属未实现能力"
          className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground opacity-50"
        >
          <MousePointerSquareDashed className="h-3 w-3" />
          选择网页元素加入聊天
        </button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted-foreground underline hover:text-foreground"
          >
            在系统浏览器打开
          </a>
        ) : null}
      </div>

      {url ? (
        <iframe
          key={url}
          src={url}
          title={`右栏浏览器：${url}`}
          className="min-h-0 flex-1 rounded-xl border bg-background"
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          还没有打开页面。对话里点链接会自动在这里打开，也可以在地址栏输入。
        </p>
      )}
      <p className="text-[10px] text-muted-foreground">
        内嵌页面能否显示取决于目标站点是否允许被嵌入；被拒绝时会是一片空白，用上面的
        「在系统浏览器打开」兜底。
      </p>
    </div>
  );
}

/** 补全协议：裸地址（如 localhost:3000）按 http 处理；空串返回 null。 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/**
 * 终端（R3-1「终端」标签）：在**该画布的工作目录**里跑用户自己敲的命令。
 *
 * 口径写在界面上：cwd = 工作目录、每次执行有超时（服务端 20s）与输出上限；
 * 这是「用户操作自己的机器」（不套 agent 的工具门），但没有 stdin——交互式命令会被超时掐掉。
 */
function TerminalView({
  accessToken,
  canvasId,
}: {
  accessToken: string | null;
  canvasId: string | null;
}) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<TerminalResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const trimmed = command.trim();
    if (!trimmed || !accessToken || !canvasId || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await runTerminalCommand(accessToken, canvasId, trimmed);
      setHistory((prev) => [...prev, result]);
      setCommand("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行失败。");
    } finally {
      setRunning(false);
    }
  }, [accessToken, canvasId, command, running]);

  if (!canvasId) {
    return (
      <p className="text-xs text-muted-foreground">
        这个会话没有绑定工作目录——终端要在工作目录里执行。
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label="终端命令"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="输入命令，回车执行"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={running || command.trim().length === 0}
          className="shrink-0 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
        >
          {running ? "执行中…" : "执行"}
        </button>
      </form>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}

      <div
        aria-label="终端输出"
        className="min-h-0 flex-1 overflow-y-auto rounded-xl border bg-muted/30 p-2 font-mono text-[11px] leading-5"
      >
        {history.length === 0 ? (
          <p className="text-muted-foreground">
            还没有执行过命令。命令在**工作目录**里运行，有超时与输出上限。
          </p>
        ) : (
          history.map((entry, index) => (
            <div key={`${entry.command}-${index}`} className="mb-2 last:mb-0">
              <div className="text-muted-foreground">$ {entry.command}</div>
              {entry.stdout ? <pre className="m-0 whitespace-pre-wrap">{entry.stdout}</pre> : null}
              {entry.stderr ? (
                <pre className="m-0 whitespace-pre-wrap text-destructive">{entry.stderr}</pre>
              ) : null}
              <div className="text-muted-foreground">
                {entry.timedOut
                  ? `超时终止（${entry.durationMs}ms）`
                  : `退出码 ${entry.exitCode ?? "未知"} · ${entry.durationMs}ms`}
                {entry.truncated ? " · 输出已截断" : ""}
              </div>
            </div>
          ))
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        工作目录内执行；单次上限 20 秒、输出各 64 KB；不支持交互式命令（没有 stdin）。
      </p>
    </div>
  );
}
