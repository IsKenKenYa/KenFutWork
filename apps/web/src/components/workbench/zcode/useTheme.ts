/**
 * zcode 移植层宿主适配：theme（references/zcode packages/ui/src/useTheme.ts 的最小等价）。
 * 主题事实来源是 next-themes；zcode 的 zai-light/zai-dark 变体我们不搬，统一折叠到 light/dark。
 */
"use client";

import { useTheme as useNextTheme } from "next-themes";

export type Theme = "light" | "dark" | "zai-light" | "zai-dark" | "system";
export type ResolvedTheme = "light" | "dark";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }
  return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
}

export function normalizeThemePreference(theme: Theme): Theme {
  return theme;
}

export function useTheme() {
  const { theme, resolvedTheme, setTheme } = useNextTheme();
  const current = (theme ?? "system") as Theme;
  return {
    theme: current,
    resolvedTheme: (resolvedTheme ?? "light") as ResolvedTheme,
    setTheme: (next: Theme) => setTheme(resolveTheme(next)),
  };
}
