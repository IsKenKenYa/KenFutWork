"use client";

import {
  Bot,
  FileCode2,
  FileDiff as FileDiffIcon,
  Folder,
  Globe,
  Plus,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  filterPanelTabs,
  type PanelTab,
  type PanelView,
  type PanelViewKind,
  relativeOpenedLabel,
} from "@/lib/panel-tabs";

/**
 * 右栏面板的标签条（参考图的编辑器式多标签）：**左侧加号（打开的标签页 + 新建视图）→ 各标签（可关）**。
 *
 * 用户口径：左边的箭头改加号、右边的叉去掉（收起面板走会话头部那个「面板」开关）。
 *
 * 标签是**视图实例**（每个文件/每个视图一个），关掉时右邻接替（顺序判定在 lib/panel-tabs，
 * 有单测）。标签溢出时横向滚动，而不是换行堆成两层。
 */
export function PanelTabStrip({
  tabs,
  activeId,
  onActivate,
  onCloseTab,
  onOpenView,
}: {
  tabs: PanelTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenView: (view: PanelView) => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  // 下拉里的相对时刻（参考图的「1小时」）：开着的时候每分钟刷新一次就够
  useEffect(() => {
    if (!listOpen) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [listOpen]);

  useEffect(() => {
    if (!listOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(event.target as Node)) {
        setListOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setListOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [listOpen]);

  const visible = filterPanelTabs(tabs, query);

  return (
    <div className="flex min-h-[40px] items-center gap-1 border-b px-1">
      {/* 标签列表：搜索 + 打开的标签页（参考图的下拉形态） */}
      <div ref={listRef} className="relative shrink-0">
        <button
          type="button"
          aria-label="标签列表"
          aria-expanded={listOpen}
          title="新建视图 / 标签页（可搜索）"
          onClick={() => setListOpen((current) => !current)}
          className="p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {/* 左侧是**加号**（用户口径「左边的箭头改成加号」）：点开就是「打开的标签页 +
              新建视图」这一个菜单，不再是一个看不出用途的下拉箭头 */}
          <Plus className="h-3.5 w-3.5" />
        </button>
        {listOpen ? (
          <div
            role="dialog"
            aria-label="打开的标签页"
            className="absolute top-full left-0 z-50 mt-1 w-64 border bg-popover p-1.5 text-popover-foreground shadow-md"
          >
            <div className="flex items-center gap-1.5 border px-2 py-1">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                aria-label="搜索标签页"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标签页…"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
              />
            </div>
            <p className="px-1.5 py-1 text-[10px] text-muted-foreground">
              打开的标签页
            </p>
            {visible.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">
                没有匹配的标签页。
              </p>
            ) : (
              <ul aria-label="打开的标签页" className="space-y-0.5">
                {visible.map((tab) => (
                  <li key={tab.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        onActivate(tab.id);
                        setListOpen(false);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-xs hover:bg-muted"
                    >
                      <span className="shrink-0 text-muted-foreground">
                        {tabIcon(tab.view.kind)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {tab.label}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {relativeOpenedLabel(tab.openedAt, now)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${tab.label}`}
                      onClick={() => onCloseTab(tab.id)}
                      className="shrink-0 p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/*
              「新建视图」并进**同一个菜单**（用户口径：不要单独一个菜单）：
              原来是「标签列表」与「＋」两个下拉并排，看着就是两套菜单做同一件事。
            */}
            <div className="mt-1 border-t pt-1">
              <p className="px-1.5 py-1 text-[10px] text-muted-foreground">
                新建视图
              </p>
              <ul aria-label="新建视图" className="space-y-0.5">
                {NEW_TAB_VIEWS.map((view) => (
                  <li key={view.kind}>
                    <button
                      type="button"
                      aria-label={`新建视图：${view.label}`}
                      onClick={() => {
                        onOpenView({ kind: view.kind });
                        setListOpen(false);
                      }}
                      className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-xs hover:bg-muted"
                    >
                      <span className="shrink-0 text-muted-foreground">
                        {tabIcon(view.kind)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {view.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </div>

      {/* 标签本体：横向滚动（不换行——换行会把正文挤没） */}
      <div
        role="tablist"
        aria-label="面板视图"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <span
              key={tab.id}
              className={`group flex shrink-0 items-center gap-1 border px-2 py-1 text-xs transition-colors ${
                active
                  ? "border-border bg-muted font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onActivate(tab.id)}
                className="flex max-w-40 min-w-0 items-center gap-1.5"
              >
                <span className="shrink-0">{tabIcon(tab.view.kind)}</span>
                <span className="truncate">{tab.label}</span>
              </button>
              <button
                type="button"
                aria-label={`关闭 ${tab.label}`}
                onClick={() => onCloseTab(tab.id)}
                className={`shrink-0 p-0.5 transition-opacity hover:bg-background ${
                  active ? "" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

const NEW_TAB_VIEWS: Array<{ kind: PanelViewKind; label: string }> = [
  { kind: "changes", label: "变更" },
  { kind: "files", label: "文件目录" },
  { kind: "terminal", label: "终端" },
  { kind: "browser", label: "浏览器" },
  { kind: "subagents", label: "子智能体" },
];

/** 标签左侧的小图标（视图种类一眼可辨）。 */
function tabIcon(kind: PanelViewKind) {
  const className = "h-3.5 w-3.5";
  switch (kind) {
    case "changes":
      return <FileDiffIcon className={className} />;
    case "files":
      return <Folder className={className} />;
    case "terminal":
      return <SquareTerminal className={className} />;
    case "browser":
      return <Globe className={className} />;
    case "subagents":
      return <Bot className={className} />;
    case "diff":
      return <FileDiffIcon className={className} />;
    case "file":
      return <FileCode2 className={className} />;
  }
}
