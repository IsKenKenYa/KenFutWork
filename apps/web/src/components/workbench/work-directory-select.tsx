"use client";

import type { ProjectSummary } from "@loomic/shared";
import {
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  MessageSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  busy = false,
  onSelect,
  onOpenFolder,
  onClear,
}: WorkDirectorySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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

  const selected = projects.find((project) => project.id === selectedProjectId);
  const keyword = query.trim().toLowerCase();
  const visible = keyword
    ? projects.filter((project) => project.name.toLowerCase().includes(keyword))
    : projects;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="工作目录"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
        className="flex max-w-[12rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
      >
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {selected ? selected.name : "选择工作目录"}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      {open ? (
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
    </div>
  );
}
