"use client";

import { useEffect } from "react";

/**
 * 品牌套件管理浮窗：90% 宽、85% 高，覆盖在画布之上。
 *
 * 里面直接嵌 `/brand-kit` 这条既有路由（同源 iframe）——那套界面有自己的侧栏与编辑器、
 * 十几个文件，做成弹窗组件要拆一遍且容易漏；iframe 方案一行不动就复用了同一份实现，
 * 路由也仍然可以直接访问。用户此前的不满在于「点管理会把整页换掉（跳走）」与
 * 「页里有返回工作台按钮」——前者由本浮窗解决，后者已从侧栏移除。
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
            <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
              <path
                d="M4.5 4.5l7 7M11.5 4.5l-7 7"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <iframe
          src="/brand-kit"
          title="品牌套件管理"
          className="min-h-0 w-full flex-1 border-0"
        />
      </div>
    </div>
  );
}
