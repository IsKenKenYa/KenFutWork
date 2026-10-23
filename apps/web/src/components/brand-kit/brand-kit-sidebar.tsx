"use client";

import type { BrandKitSummary } from "@kenfutwork/shared";
import { Plus, Trash2 } from "lucide-react";

import { cn } from "../../lib/utils";

interface BrandKitSidebarProps {
  kits: BrandKitSummary[];
  selectedKitId: string | null;
  /** 浮窗内嵌时标题与关闭由外层浮窗负责，侧栏不再重复一份页头。 */
  embedded?: boolean;
  onSelectKit: (kitId: string) => void;
  onCreateKit: () => void;
  onDeleteKit: (kitId: string) => void;
}

export function BrandKitSidebar({
  kits,
  selectedKitId,
  embedded = false,
  onSelectKit,
  onCreateKit,
  onDeleteKit,
}: BrandKitSidebarProps) {
  return (
    <aside
      className={cn(
        "flex w-full shrink-0 flex-col border-b bg-secondary",
        embedded
          ? "min-h-0 w-[180px] border-r border-b-0"
          : "md:w-[260px] md:border-r md:border-b-0",
      )}
    >
      {embedded ? null : (
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <h1 className="text-sm font-semibold text-foreground">品牌套件</h1>
          {/* 管理界面已改为画布内的浮窗（见 canvas/page.tsx 的 BrandKitModal），
              不再需要「返回工作台」入口——浮窗里点它只会把浮窗自己换掉。 */}
        </div>
      )}

      {/* Create button */}
      <div className={cn("px-3", embedded ? "pt-3 pb-3" : "pb-3")}>
        <button
          type="button"
          onClick={onCreateKit}
          className="flex w-full items-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/30 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-muted-foreground/50 cursor-pointer min-h-[44px] sm:min-h-0"
        >
          <Plus className="h-4 w-4" />
          新建套件
        </button>
      </div>

      {/* Kit list -- 浮窗内始终竖排并内部滚动；独立页窄屏才横排。 */}
      <div
        className={cn(
          "flex gap-1",
          embedded
            ? "min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-2 pb-4"
            : "overflow-x-auto px-2 pb-3 md:flex-col md:flex-1 md:overflow-x-hidden md:overflow-y-auto md:pb-4",
        )}
      >
        {kits.map((kit) => {
          const isSelected = kit.id === selectedKitId;
          return (
            // biome-ignore lint/a11y/useSemanticElements: 行内有嵌套的删除按钮，<button> 套 <button> 非法；role + Enter/Space 已补键盘等价
            <div
              role="button"
              tabIndex={0}
              key={kit.id}
              onClick={() => onSelectKit(kit.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectKit(kit.id);
                }
              }}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors cursor-pointer",
                embedded
                  ? "w-full min-h-0 shrink-0"
                  : "min-h-[44px] w-auto shrink-0 md:w-full md:min-h-0 md:shrink",
                isSelected ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              {/* Thumbnail placeholder */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                <span className="text-xs font-medium text-muted-foreground">
                  {kit.name.charAt(0).toUpperCase()}
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">
                    {kit.name}
                  </span>
                  {kit.is_default && (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      默认
                    </span>
                  )}
                </div>
              </div>

              {/* 浮窗内始终保留删除入口；独立页窄屏才隐藏。 */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteKit(kit.id);
                }}
                className={cn(
                  "shrink-0 rounded p-1 transition-all cursor-pointer hover:bg-destructive/10 hover:text-destructive",
                  embedded
                    ? "opacity-60 hover:opacity-100"
                    : "hidden opacity-0 group-hover:opacity-100 md:block",
                )}
                aria-label={`删除 ${kit.name}`}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
