"use client";

import type { TerminalShellId } from "@kenfutwork/shared";
import {
  ArrowLeft,
  ArrowRight,
  Ellipsis,
  FileDiff as FileDiffIcon,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Monitor,
  MousePointerSquareDashed,
  RotateCw,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SubagentDirectoryView } from "@/components/workbench/subagent-directory-view";
import {
  canGoBack,
  canGoForward,
  createHistory,
  currentUrl,
  goBack,
  goForward,
  openUrl,
} from "@/lib/browser-history";
import { onBrowserOpen } from "@/lib/browser-panel";
import { highlightCode } from "@/lib/code-highlight";
import {
  type CodeFileListing,
  discardGitChanges,
  fetchCodeFiles,
  fetchGitChanges,
  fetchGitFileDiff,
  fetchSandboxFile,
  fetchTerminalShells,
  type GitChanges,
  runTerminalCommand,
  type SandboxFileView,
  setGitFileStaged,
  stageGitHunk,
  type TerminalResult,
  type TerminalShellOption,
} from "@/lib/code-git-api";
import {
  hunkPatch,
  markHunkStarts,
  splitHunks,
  toDiffLines,
} from "@/lib/git-hunks";
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_WIDTH_KEY,
  type PanelWidthLimits,
} from "@/lib/panel-layout";
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
  | "subagents";

const TABS: Array<{ id: WorkbenchPanelTab; label: string }> = [
  { id: "changes", label: "变更" },
  { id: "files", label: "文件目录" },
  { id: "terminal", label: "终端" },
  { id: "browser", label: "浏览器" },
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
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 右栏浏览器（R3-1）：**面板内历史栈**（后退/前进/刷新按参考图补齐）。
   * 不用 `iframe.contentWindow.history`——内嵌页面基本跨源，读不到它的历史（见 lib/browser-history）。
   */
  const [browserHistory, setBrowserHistory] = useState(createHistory);
  const browserUrl = currentUrl(browserHistory);
  /** 地址栏输入框（与已加载的 URL 分开，回车才加载）。 */
  const [urlDraft, setUrlDraft] = useState("");
  /** 刷新用的计数：改 key 让 iframe 真的重新加载（同 src 不会重载）。 */
  const [reloadToken, setReloadToken] = useState(0);

  /** 转录里点链接 → 打开本标签并加载该 URL（见 lib/browser-panel）。 */
  useEffect(
    () =>
      onBrowserOpen((url) => {
        setBrowserHistory((current) => openUrl(current, url));
        setUrlDraft(url);
      }),
    [],
  );

  /** 暂存动作的进行态（按钮禁用 + 文案切换）。 */
  const [staging, setStaging] = useState(false);

  /** 暂存 / 取消暂存当前审查的文件，成功后刷新变更清单（列表与按钮跟着变）。 */
  const toggleStaged = useCallback(async () => {
    if (!accessToken || !canvasId || !reading || reading.kind !== "diff")
      return;
    const staged = !(
      changes?.files.find((f) => f.path === reading.path)?.staged ?? false
    );
    setStaging(true);
    setError(null);
    try {
      await setGitFileStaged(accessToken, canvasId, reading.path, staged);
      setChanges(await fetchGitChanges(accessToken, canvasId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂存失败。");
    } finally {
      setStaging(false);
    }
  }, [accessToken, canvasId, reading, changes]);

  /** 正在处理第几块（null = 空闲）；撤销动作与它互斥。 */
  const [hunkBusy, setHunkBusy] = useState<number | null>(null);

  /**
   * 块级动作：`stage` = 这一块进索引；`discard` = 丢掉这一块的工作区改动（**丢内容**，先确认）。
   * 两者都只发「文件头 + 这一块」的 patch。
   */
  const applyHunkAction = useCallback(
    async (hunkIndex: number, action: "stage" | "discard") => {
      if (!accessToken || !canvasId || !reading || reading.kind !== "diff") {
        return;
      }
      const { fileHeader, hunks } = splitHunks(reading.text);
      const hunk = hunks[hunkIndex];
      if (!hunk) return;
      if (
        action === "discard" &&
        !window.confirm(
          `撤销第 ${hunkIndex + 1} 块？这一块在 ${reading.path} 里的改动会被丢掉，无法从这里恢复。`,
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
          reading.path,
          hunkPatch(fileHeader, hunk),
          action === "discard" ? { reverse: true, target: "worktree" } : {},
        );
        setChanges(await fetchGitChanges(accessToken, canvasId));
        if (action === "discard") {
          // 内容变了，重读这份 diff（否则界面上还留着已经不存在的改动）
          const diff = await fetchGitFileDiff(
            accessToken,
            canvasId,
            reading.path,
          );
          setReading({ kind: "diff", path: reading.path, text: diff.text });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "这一块没处理成功。");
      } finally {
        setHunkBusy(null);
      }
    },
    [accessToken, canvasId, reading],
  );

  /** 正在撤销（单文件或全部）时禁用按钮。 */
  const [discarding, setDiscarding] = useState(false);

  /** 撤销单个文件的改动（未跟踪 = 删除该文件）；**丢内容**，先确认。 */
  const discardFileChanges = useCallback(
    async (path: string, untracked: boolean) => {
      if (!accessToken || !canvasId) return;
      const what = untracked
        ? `删除未跟踪文件 ${path}`
        : `把 ${path} 恢复成仓库里的样子`;
      if (!window.confirm(`确定撤销？将${what}，这些改动无法从这里恢复。`))
        return;
      setDiscarding(true);
      setError(null);
      try {
        await discardGitChanges(accessToken, canvasId, { path, untracked });
        setChanges(await fetchGitChanges(accessToken, canvasId));
        setReading(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "撤销失败。");
      } finally {
        setDiscarding(false);
      }
    },
    [accessToken, canvasId],
  );

  /** 撤销全部未提交改动；**丢内容**，先确认（确认框里带文件数）。 */
  const discardEverything = useCallback(async () => {
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
      setChanges(await fetchGitChanges(accessToken, canvasId));
      setReading(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤销失败。");
    } finally {
      setDiscarding(false);
    }
  }, [accessToken, canvasId, changes]);

  /** 文件目录：当前浏览的相对路径（根目录是空串）与列表。 */
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<CodeFileListing | null>(null);
  /** 面板宽度（可拖拽，持久化到 localStorage：宽度是用户偏好）。 */
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    const fallback =
      Number.isFinite(saved) &&
      saved >= MIN_PANEL_WIDTH &&
      saved <= MAX_PANEL_WIDTH
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

  /** 文件预览的高亮 HTML（认不出语言或高亮失败是 null → 纯文本）。 */
  const highlighted =
    reading?.kind === "file" ? highlightCode(reading.text, reading.path) : null;

  /** 当前审查的文件是否已在索引里（决定按钮文案）。 */
  const stagedNow =
    reading?.kind === "diff"
      ? (changes?.files.find((file) => file.path === reading.path)?.staged ??
        false)
      : false;

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
              {/* 暂存 / 取消暂存（参考图审查视图的「暂存」）：只有差异视图有这个东西 */}
              {reading.kind === "diff" ? (
                <button
                  type="button"
                  aria-label={stagedNow ? "取消暂存此文件" : "暂存此文件"}
                  disabled={staging}
                  title={
                    stagedNow
                      ? "从索引里撤下这个文件（工作区内容不动）"
                      : "把这个文件加入索引（下次提交会带上它）"
                  }
                  onClick={() => void toggleStaged()}
                  className="ml-auto rounded-md border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
                >
                  {staging ? "处理中…" : stagedNow ? "取消暂存" : "暂存此文件"}
                </button>
              ) : null}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {reading.path}
              </span>
              {reading.note ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {reading.note}
                </span>
              ) : null}
            </div>
            {reading.kind === "diff" ? (
              /* 差异视图逐行渲染：每个块（hunk）的第一行右侧给「暂存块」——
                 参考图的审查视图就是这么把改动一块一块收进索引的 */
              <div
                aria-label="文件差异"
                className="max-h-[60vh] overflow-auto p-2 font-mono text-[11px] leading-5"
              >
                {markHunkStarts(toDiffLines(reading.text)).map(
                  (line, index) => (
                    <div
                      key={`${index}-${line.text.slice(0, 12)}`}
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
                              onClick={() =>
                                void applyHunkAction(line.hunkIndex!, "stage")
                              }
                              className="rounded border border-emerald-600/40 px-1 text-[10px] leading-4 text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-400"
                            >
                              ＋
                            </button>
                            <button
                              type="button"
                              aria-label={`撤销第 ${line.hunkIndex + 1} 块`}
                              disabled={hunkBusy !== null}
                              title="撤销块：丢掉这一块的工作区改动（会丢内容，需确认）"
                              onClick={() =>
                                void applyHunkAction(line.hunkIndex!, "discard")
                              }
                              className="rounded border border-rose-600/40 px-1 text-[10px] leading-4 text-rose-700 transition-colors hover:bg-rose-500/10 disabled:opacity-40 dark:text-rose-400"
                            >
                              ⟲
                            </button>
                          </>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">{line.text}</span>
                      {line.hunkIndex !== undefined &&
                      hunkBusy === line.hunkIndex ? (
                        <span className="shrink-0 pr-1 text-[10px] text-muted-foreground">
                          处理中…
                        </span>
                      ) : null}
                    </div>
                  ),
                )}
              </div>
            ) : (
              /* 文件预览：能认语言就按高亮渲染（highlight.js 的输出已转义），
                 认不出来就纯文本——不猜语言，也不半渲染 */
              highlighted ? (
                <pre
                  aria-label="文件内容"
                  className="hljs max-h-[60vh] overflow-auto p-2 font-mono text-[11px] leading-5 whitespace-pre"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js 的输出自己转义（见 lib/code-highlight 的单测）
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              ) : (
                <pre
                  aria-label="文件内容"
                  className="max-h-[60vh] overflow-auto p-2 font-mono text-[11px] leading-5 whitespace-pre"
                >
                  {reading.text}
                </pre>
              )
            )}
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
            reloadToken={reloadToken}
            canBack={canGoBack(browserHistory)}
            canForward={canGoForward(browserHistory)}
            onDraftChange={setUrlDraft}
            onNavigate={(next) => {
              setBrowserHistory((current) => openUrl(current, next));
              setUrlDraft(next);
            }}
            onBack={() => {
              setBrowserHistory((current) => {
                const next = goBack(current);
                setUrlDraft(currentUrl(next));
                return next;
              });
            }}
            onForward={() => {
              setBrowserHistory((current) => {
                const next = goForward(current);
                setUrlDraft(currentUrl(next));
                return next;
              });
            }}
            onReload={() => setReloadToken((token) => token + 1)}
          />
        ) : tab === "files" ? (
          <FilesView
            listing={listing}
            canvasId={canvasId}
            dir={dir}
            onNavigate={(next) => setDir(next)}
            onOpen={(path) => void openFile(path)}
          />
        ) : (
          <ChangesView
            changes={changes}
            canvasId={canvasId}
            totals={totals}
            discarding={discarding}
            onReview={(path) => void openDiff(path)}
            onOpen={(path) => void openFile(path)}
            onDiscard={discardFileChanges}
            onDiscardAll={discardEverything}
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
  onDiscard,
  onDiscardAll,
  discarding,
}: {
  changes: GitChanges | null;
  canvasId: string | null;
  totals: { additions: number; deletions: number };
  onReview: (path: string) => void;
  onOpen: (path: string) => void;
  /** 撤销单个文件（未跟踪的会被删除）。二次确认在调用方。 */
  onDiscard: (path: string, untracked: boolean) => Promise<void>;
  /** 撤销全部未提交改动。二次确认在调用方。 */
  onDiscardAll: () => Promise<void>;
  discarding: boolean;
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
        该工作目录还不是 git
        仓库；初始化后每轮对话会自动提交，改动也会列在这里。
      </p>
    );
  }
  if (changes.files.length === 0) {
    return <p className="text-xs text-muted-foreground">没有未提交的更改。</p>;
  }

  return (
    <div className="rounded-xl border">
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
          <span className="rounded border px-1.5 py-0.5 text-[10px]">审查</span>
          <span className="rounded border px-1.5 py-0.5 text-[10px]">打开</span>
        </span>
        <span className={CHANGE_STAT_CELL}>
          <span className="text-emerald-600">+{totals.additions}</span>{" "}
          <span className="text-rose-500">−{totals.deletions}</span>
        </span>
        <button
          type="button"
          aria-label="撤销全部更改"
          disabled={discarding || changes.files.length === 0}
          title="撤销全部未提交改动（未跟踪的新文件会被删除）"
          onClick={() => void onDiscardAll()}
          className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
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
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{name}</span>
                {dir ? (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {dir}
                  </span>
                ) : null}
              </span>
              {file.staged ? (
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
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
              <button
                type="button"
                aria-label={`撤销 ${file.path}`}
                disabled={discarding}
                onClick={() =>
                  void onDiscard(file.path, file.status === "untracked")
                }
                title={
                  file.status === "untracked"
                    ? "撤销：删除这个未跟踪文件"
                    : "撤销：把这个文件恢复成仓库里的样子"
                }
                className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
              >
                撤销
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
 * 右栏浏览器（R3-1 / R3-4 的可用形态）。工具栏按参考图的浏览器面板排：
 * **后退 / 前进 / 刷新在左，地址栏居中，右侧是视图宽度与 ⋯ 菜单**（「在系统浏览器打开」等）。
 *
 * 三条如实写明的边界：
 * - 后退/前进走**面板内历史栈**（跨源 iframe 读不到页面自己的 history）；
 * - 预览缩放是**真的缩放**（iframe transform），只影响这个面板里的显示；
 * - 「选择网页元素加入聊天」需要浏览器调试接口（CDP / 扩展），内嵌 iframe 拿不到跨源 DOM，
 *   所以按钮**禁用**并写明原因——不做假开关。
 */
function BrowserView({
  url,
  draft,
  reloadToken,
  canBack,
  canForward,
  onDraftChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
}: {
  url: string;
  draft: string;
  reloadToken: number;
  canBack: boolean;
  canForward: boolean;
  onDraftChange: (value: string) => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}) {
  const normalized = normalizeUrl(draft);
  const [zoom, setZoom] = useState<ZoomPreset>("fit");
  const zoomScale = ZOOM_PRESETS.find((p) => p.id === zoom)?.scale ?? 1;
  /** 面板里这块预览区有多大（参考图那行「1280 × 720」）。 */
  const frameRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [paneHeight, setPaneHeight] = useState(0);
  useEffect(() => {
    const measure = () => {
      const el = frameRef.current;
      if (!el) return;
      setPaneWidth(el.clientWidth);
      setPaneHeight(el.clientHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [url]);

  const navButtonClass =
    "shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (normalized) onNavigate(normalized);
        }}
      >
        <button
          type="button"
          aria-label="后退"
          disabled={!canBack}
          title="后退（本面板打开过的上一个地址）"
          onClick={onBack}
          className={navButtonClass}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          disabled={!canForward}
          title="前进（本面板打开过的下一个地址）"
          onClick={onForward}
          className={navButtonClass}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="刷新"
          disabled={!url}
          title="重新加载当前页面"
          onClick={onReload}
          className={navButtonClass}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <Globe className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label="地址"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            // 工具栏里没有「打开」按钮（与参考图一致）：回车即打开。
            // 不依赖表单的隐式提交——那要求表单里只有一个输入框，加个控件就会失效。
            if (event.key === "Enter") {
              event.preventDefault();
              if (normalized) onNavigate(normalized);
            }
          }}
          placeholder="输入网址，回车打开"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="button"
          aria-label="选择网页元素加入聊天"
          disabled
          title="需要浏览器调试接口（CDP / 扩展）才能读到跨源页面的 DOM，内嵌 iframe 做不到——未实现能力，不做假开关"
          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-40"
        >
          <MousePointerSquareDashed className="h-3.5 w-3.5" />
        </button>
        <Select
          aria-label="浏览器菜单"
          value=""
          onValueChange={(next) => {
            if (next === "open-system" && url) {
              window.open(url, "_blank", "noopener");
            }
            if (next === "copy" && url) {
              void navigator.clipboard?.writeText(url);
            }
          }}
          items={[
            { value: "open-system", label: "在系统浏览器打开" },
            { value: "copy", label: "复制地址" },
          ]}
        >
          <SelectTrigger
            className="shrink-0 gap-0 border-transparent px-1.5 py-1"
            aria-label="浏览器菜单"
            hideChevron
            title="更多（在系统浏览器打开 / 复制地址）"
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </SelectTrigger>
          <SelectContent className="min-w-40">
            <SelectItem value="open-system">在系统浏览器打开</SelectItem>
            <SelectItem value="copy">复制地址</SelectItem>
          </SelectContent>
        </Select>
      </form>

      {/* 预览控制行（参考图：地址栏下面一行显示尺寸 + 预设）。**缩放是真的缩放**——
          iframe 用 transform 放大/缩小，指针坐标照样对得上，不是拿宽度假装缩放 */}
      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1 text-[11px]">
        <span className="font-mono text-muted-foreground">
          {paneWidth > 0 ? `${paneWidth} × ${paneHeight}` : "—"}
        </span>
        <Select
          aria-label="预览缩放"
          value={zoom}
          onValueChange={(next) => {
            if (typeof next === "string") setZoom(next as ZoomPreset);
          }}
          items={ZOOM_PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.label,
          }))}
        >
          <SelectTrigger
            className="ml-auto shrink-0 gap-1 border-transparent bg-transparent px-1.5 py-0.5 text-[11px]"
            aria-label="预览缩放"
            title="预览缩放（只影响这个面板里的显示）"
          >
            <Monitor className="h-3.5 w-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-32">
            {ZOOM_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {url ? (
        <div
          ref={frameRef}
          className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-background"
        >
          <iframe
            key={`${url}#${reloadToken}`}
            src={url}
            title={`右栏浏览器：${url}`}
            style={{
              transform: `scale(${zoomScale})`,
              transformOrigin: "top left",
              width: `${100 / zoomScale}%`,
              height: `${100 / zoomScale}%`,
            }}
            className="absolute top-0 left-0"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          还没有打开页面。对话里点链接会自动在这里打开，也可以在地址栏输入。
        </p>
      )}
      <p className="text-[10px] text-muted-foreground">
        内嵌页面能否显示取决于目标站点是否允许被嵌入；被拒绝时会是一片空白，用「在系统浏览器
        打开」兜底。后退 /
        前进记的是**本面板打开过的地址**（跨源页面自己的历史读不到）。
      </p>
    </div>
  );
}

/** 预览缩放预设（参考图：适应窗口 / 50% / 75% / 100%）。 */
const ZOOM_PRESETS = [
  { id: "fit", label: "适应窗口", scale: 1 },
  { id: "half", label: "50%", scale: 0.5 },
  { id: "three-quarter", label: "75%", scale: 0.75 },
  { id: "full", label: "100%", scale: 1 },
  { id: "one-quarter", label: "125%", scale: 1.25 },
] as const;

type ZoomPreset = (typeof ZOOM_PRESETS)[number]["id"];

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
/**
 * 终端下拉的选项：`auto（→ 本机实际用的那个）` 在前，其后是探测到的 shell。
 * `auto` 单列出来是因为它**不是某个具体 shell**——不写清解析成谁，用户看不出实际用的是什么。
 */
function SHELL_CHOICES(
  shells: TerminalShellOption[],
  autoShell: TerminalShellId | null,
): Array<{ value: TerminalShellId; label: string; title: string }> {
  const resolved = shells.find((option) => option.id === autoShell);
  return [
    {
      value: "auto",
      label: autoShell ? `auto（→ ${autoShell}）` : "auto（按平台默认）",
      title: resolved
        ? `跟随设置：${resolved.executable}`
        : "跟随平台默认 shell",
    },
    ...shells.map((option) => ({
      value: option.id,
      label: option.label,
      title: option.executable,
    })),
  ];
}

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
  /**
   * shell 选择（用户口径：「终端应该是直连 cmd 或者 powershell、git-bash 等等」）。
   * 清单由服务端探测本机有什么；初值取**工作区设置的默认**（设置页里配的那个）。
   */
  const [shells, setShells] = useState<TerminalShellOption[]>([]);
  const [shell, setShell] = useState<TerminalShellId | null>(null);
  /** `auto` 在本机解析成谁（下拉里写「auto（→ cmd）」，免得看不出实际用的是哪个）。 */
  const [autoShell, setAutoShell] = useState<TerminalShellId | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchTerminalShells(accessToken)
      .then((next) => {
        if (cancelled) return;
        setShells(next.shells);
        setAutoShell(next.resolvedShell);
        setShell((current) => current ?? next.defaultShell);
      })
      .catch(() => {
        // 拿不到清单就不摆下拉：命令仍可执行（服务端按工作区默认解析）
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const run = useCallback(async () => {
    const trimmed = command.trim();
    if (!trimmed || !accessToken || !canvasId || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await runTerminalCommand(
        accessToken,
        canvasId,
        trimmed,
        shell ?? undefined,
      );
      setHistory((prev) => [...prev, result]);
      setCommand("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行失败。");
    } finally {
      setRunning(false);
    }
  }, [accessToken, canvasId, command, running, shell]);

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
        {shells.length > 0 ? (
          <Select
            aria-label="终端 shell"
            value={shell ?? shells[0]!.id}
            onValueChange={(next) => {
              if (typeof next === "string") setShell(next as TerminalShellId);
            }}
            items={SHELL_CHOICES(shells, autoShell).map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          >
            <SelectTrigger
              className="shrink-0 gap-1 border-transparent bg-muted/60 px-2 py-1 font-mono text-[11px]"
              aria-label="终端 shell"
              title={
                SHELL_CHOICES(shells, autoShell).find(
                  (option) => option.value === shell,
                )?.title ?? ""
              }
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="min-w-44">
              {SHELL_CHOICES(shells, autoShell).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
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
              {entry.stdout ? (
                <pre className="m-0 whitespace-pre-wrap">{entry.stdout}</pre>
              ) : null}
              {entry.stderr ? (
                <pre className="m-0 whitespace-pre-wrap text-destructive">
                  {entry.stderr}
                </pre>
              ) : null}
              <div className="text-muted-foreground">
                {entry.timedOut
                  ? `超时终止（${entry.durationMs}ms）`
                  : `${entry.shell} · 退出码 ${entry.exitCode ?? "未知"} · ${entry.durationMs}ms`}
                {entry.truncated ? " · 输出已截断" : ""}
              </div>
            </div>
          ))
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        命令交给上面选中的 shell 本体执行（默认值在「设置 → 通用 →
        终端」里配）； 工作目录内执行，单次上限 20 秒、输出各 64
        KB；不支持交互式命令（没有 stdin）。
      </p>
    </div>
  );
}
