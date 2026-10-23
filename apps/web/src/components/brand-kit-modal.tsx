"use client";

import { useEffect } from "react";
import { BrandKitPage } from "./brand-kit/brand-kit-page";

/**
 * 品牌套件管理浮窗：90% 宽、85% 高，覆盖在画布之上。
 *
 * 直接渲染 `/brand-kit` 那条路由背后的同一套页面（`embedded` 模式），不再套一层
 * iframe：iframe 会把页头、`100dvh` 与整页留白一起搬进窄浮窗，出现「品牌套件」
 * 标题重复、内容挤成一列的事故；路由本身仍可独立访问。
 */
export function BrandKitModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
      {/* 点遮罩关闭 */}
      <button
        type="button"
        aria-label="关闭品牌套件"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div className="relative flex h-[85%] w-[90%] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="text-sm font-medium text-foreground">品牌套件</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path
                d="M4.5 4.5l7 7M11.5 4.5l-7 7"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <BrandKitPage embedded />
      </div>
    </div>
  );
}
