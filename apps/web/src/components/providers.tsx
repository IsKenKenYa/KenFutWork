"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

import { InstanceThemeSync } from "../lib/instance-theme";
import {
  LocalInstanceBoundary,
  LocalInstanceProvider,
} from "../lib/local-instance-context";
import { ToastProvider } from "./toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      // 显式固定 storageKey：首屏引导脚本、InstanceThemeSync 与 zcode iframe 都读
      // 同一个 "theme" 键，避免 next-themes 默认值变动后刷新丢失选择。
      storageKey="theme"
      // 切档瞬间禁用全局 transition，避免半套浅色/深色 token 交错闪一下。
      disableTransitionOnChange
    >
      <LocalInstanceProvider>
        <InstanceThemeSync />
        <ToastProvider>
          <LocalInstanceBoundary>{children}</LocalInstanceBoundary>
        </ToastProvider>
      </LocalInstanceProvider>
    </ThemeProvider>
  );
}
