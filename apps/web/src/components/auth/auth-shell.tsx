"use client";

import type { ReactNode } from "react";

import { LoomicLogo } from "@/components/icons/loomic-logo";

/** 登录/注册壳：与工作台同风格的居中卡片（无分屏、无营销区）。 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <div className="mb-6 flex items-center gap-2.5">
        <LoomicLogo className="size-9" />
        <span className="text-lg font-semibold tracking-tight">KenFutWork</span>
      </div>
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        {children}
      </div>
    </div>
  );
}
