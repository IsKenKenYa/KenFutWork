"use client";

import type { ProjectSummary } from "@kenfutwork/shared";
import {
  Check,
  ChevronDown,
  FileText as FileTextIcon,
  Folder,
  FolderOpen,
  MessageSquare,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fetchCodeDocs, fetchSandboxFile } from "@/lib/code-git-api";

/**
 * 工作目录选择器（Code 模式 composer 底部）。
 *
 * 「工作目录 = 项目」：列表里的每一项就是一个工作目录项目（服务端 kind='code'），
 * 选中即把后续对话挂到它下面、run 以它的主画布为作用域。
 *
 * 交互按设计稿：顶部搜索框 + 目录列表（选中项打勾）+ 分隔线 + 「打开文件夹」
 * 「不在项目中工作」。**远程连接暂不做**（需要远程环境接入，未定方案）。
 */
export interface WorkDirectorySelectProps {
  /** 工作目录项目（kind='code'），已按 updated_at 倒序。 */
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  /** 文档入口（R3-3）用：作用域画布 = 当前选中项目的主画布，与 run 同一口径。 */
  accessToken?: string | null;
  canvasId?: string | null;
  /**
   * 只读展示：已有对话绑定工作目录时传入提示文案。
   *
   * 转录里的追问沿用对话自己的项目（换目录会让上一轮写的文件留在旧沙箱里
   * 「消失」），所以这里把 chip 锁成展示态，而不是给一个按了不生效的下拉。
   */
  lockedHint?: string | undefined;
  /** 正在创建项目（新建/自动补建）时为 true，禁用以避免并发重复建。 */
  busy?: boolean;
  onSelect: (projectId: string) => void;
  /** 打开文件夹：调浏览器目录选择器，按目录名复用/新建工作目录。 */
  onOpenFolder: () => void;
  /** 不在项目中工作：清空工作目录，run 退回会话自身作用域。 */
  onClear: () => void;
}

export function WorkDirectorySelect({
  projects,
  selectedProjectId,
  accessToken = null,
  canvasId = null,
  lockedHint,
  busy = false,
  onSelect,
  onOpenFolder,
  onClear,
}: WorkDirectorySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** 项目文档（R3-3）：`null` = 还没读过；打开下拉时才拉一次。 */
  const [docs, setDocs] = useState<
    Array<{ path: string; bytes: number }> | null
  >(null);
  const [openedDoc, setOpenedDoc] = useState<{
    path: string;
    text: string;
    note?: string;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 点外面 / Esc 关闭（与 brand-kit-selector 同一套交互）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  /**
   * 打开下拉时读一次项目文档清单（R3-3）。挂在 `open` 上而不是挂载时：
   * 工作目录会在会话里切换，清单跟着当前选中的项目走，且关着的时候不发请求。
   */
  useEffect(() => {
    // 没绑画布（还没选工作目录）：清单无从谈起，直接给空——此前留 null 会让文案
    // 永远停在「读取中…」（GUI 实测），把「没得读」说成「在读」是撒谎。
    if (!accessToken || !canvasId) {
      setDocs([]);
      return;
    }
    if (!open) return;
    let cancelled = false;
    setDocs(null);
    void fetchCodeDocs(accessToken, canvasId)
      .then((next) => {
        if (!cancelled) setDocs(next);
      })
      .catch(() => {
        // 列不出来就当没有（例如目录还没建）：不打断选目录这件事
        if (!cancelled) setDocs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, accessToken, canvasId]);

  const openDoc = useCallback(
    async (path: string) => {
      if (!accessToken || !canvasId) return;
      try {
        const file = await fetchSandboxFile(accessToken, canvasId, path);
        setOpenedDoc({
          path: file.path,
          text: file.binary ? "（二进制文件，无法按文本显示）" : file.content,
          ...(file.truncated ? { note: "已截断（只显示前 256 KB）" } : {}),
        });
        setOpen(false);
      } catch {
        // 读不到通常是「文件刚被删/改名」：关掉下拉即可，不弹错
        setOpen(false);
      }
    },
    [accessToken, canvasId],
  );

  const selected = projects.find((project) => project.id === selectedProjectId);
  const keyword = query.trim().toLowerCase();
  const visible = keyword
    ? projects.filter((project) => project.name.toLowerCase().includes(keyword))
    : projects;
  /** 只读（已绑定对话）：chip 仍然显示目录名，但不给下拉——按了不生效才是坑。 */
  const locked = lockedHint !== undefined;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="工作目录"
        aria-haspopup={locked ? undefined : "listbox"}
        aria-expanded={locked ? undefined : open}
        title={lockedHint}
        disabled={busy || locked}
        onClick={() => setOpen((current) => !current)}
        className="flex max-w-[12rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-60"
      >
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {selected
            ? selected.name
            : locked
              ? "未绑定工作目录"
              : "选择工作目录"}
        </span>
        {locked ? null : <ChevronDown className="h-3 w-3 shrink-0" />}
      </button>

      {open && !locked ? (
        <div
          role="listbox"
          aria-label="工作目录列表"
          className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md"
        >
          <div className="border-b p-2">
            <input
              aria-label="搜索工作区"
              placeholder="搜索工作区"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full rounded-md bg-transparent px-2 py-1 text-sm outline-none"
            />
          </div>

          <div className="max-h-64 overflow-y-auto p-1">
            {visible.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {projects.length === 0
                  ? "还没有工作目录——用下方「打开文件夹」选择"
                  : "没有匹配的工作目录"}
              </p>
            ) : (
              visible.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="option"
                  aria-selected={project.id === selectedProjectId}
                  onClick={() => {
                    onSelect(project.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {project.name}
                  </span>
                  {project.id === selectedProjectId ? (
                    <Check className="h-4 w-4 shrink-0" />
                  ) : null}
                </button>
              ))
            )}
          </div>

          {/* 项目文档（R3-3）：工作目录里的 AGENTS.md / README.md 等，「打开」看内容 */}
          <div className="border-t p-1">
            <p className="px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground/70">
              项目文档
            </p>
            {!canvasId ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                先选一个工作目录
              </p>
            ) : docs === null ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">读取中…</p>
            ) : docs.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                这个目录里没有 AGENTS.md / README.md 等文档
              </p>
            ) : (
              docs.map((doc) => (
                <div
                  key={doc.path}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                >
                  <FileTextIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{doc.path}</span>
                  <button
                    type="button"
                    aria-label={`打开 ${doc.path}`}
                    onClick={() => void openDoc(doc.path)}
                    className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    打开
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenFolder();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              打开文件夹
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onClear();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MessageSquare className="h-4 w-4 shrink-0" />
              不在项目中工作
            </button>
          </div>
        </div>
      ) : null}

      {/* 文档内容（R3-3）：浮窗而不是下拉里再套一层滚动区——内容可能很长 */}
      <Dialog
        open={openedDoc !== null}
        onOpenChange={(next) => !next && setOpenedDoc(null)}
      >
        <DialogContent
          className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-2 border-b px-5 py-3 pr-12">
            <DialogTitle className="min-w-0 flex-1 truncate font-mono text-sm">
              {openedDoc?.path ?? ""}
            </DialogTitle>
            {openedDoc?.note ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {openedDoc.note}
              </span>
            ) : null}
          </div>
          <pre
            aria-label="文档内容"
            className="m-0 max-h-[64vh] overflow-auto p-4 font-mono text-xs leading-5 whitespace-pre"
          >
            {openedDoc?.text ?? ""}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
