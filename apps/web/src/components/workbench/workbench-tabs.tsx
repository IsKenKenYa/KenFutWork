"use client";

import type { WorkbenchTab } from "@/lib/workbench-tabs";

const CloseIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className}>
    <path
      d="M4.5 4.5l7 7M11.5 4.5l-7 7"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * 画布标签栏（Design 模式）：打开过的画布各占一个标签，样式对齐编辑器里的文件标签
 * ——标签等宽排开、当前项高亮并与下方内容相接、每个标签带 × 关闭、放不下时横向滚动。
 */
export function WorkbenchTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
}: {
  tabs: WorkbenchTab[];
  activeId: string | null;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
}) {
  if (tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="打开的画布"
      className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-muted/40 px-2 pt-1.5"
    >
      {tabs.map((tab) => {
        const active = tab.projectId === activeId;
        return (
          <div
            key={tab.projectId}
            className={`group flex max-w-[220px] shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2.5 py-1.5 transition-colors ${
              active
                ? "border-border bg-card text-foreground"
                : "border-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground"
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(tab.projectId)}
              title={tab.name}
              className="min-w-0 flex-1 truncate text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {tab.name}
            </button>
            <button
              type="button"
              aria-label={`关闭 ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.projectId);
              }}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors ${
                active
                  ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                  : "text-transparent group-hover:text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
