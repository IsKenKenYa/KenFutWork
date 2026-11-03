"use client";

import type { ThemePreference } from "@kenfutwork/shared";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { useLocalInstance } from "./local-instance-context";
import { fetchInstanceSettings, updateInstanceSettings } from "./server-api";

export function toThemePreference(theme: string | undefined): ThemePreference {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return "system";
}

export function toNextTheme(
  theme: ThemePreference,
): "light" | "dark" | "system" {
  if (theme === "zai-dark") return "dark";
  if (theme === "zai-light") return "light";
  return "system";
}

/** 实例主题为权威来源；localStorage 只保留首屏缓存。 */
export function InstanceThemeSync() {
  const { instance } = useLocalInstance();
  const { theme, setTheme } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const hydrated = useRef(false);
  const currentTheme = useRef(theme);
  const setThemeRef = useRef(setTheme);
  const persisted = useRef<ThemePreference | null>(null);
  const writeVersion = useRef(0);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    currentTheme.current = theme;
    setThemeRef.current = setTheme;
  }, [theme, setTheme]);

  useEffect(() => {
    if (!instance) return;
    let cancelled = false;
    const requestedTheme = currentTheme.current;
    void fetchInstanceSettings(null)
      .then(({ settings }) => {
        if (cancelled) return;
        hydrated.current = true;
        setHydrationVersion((version) => version + 1);
        persisted.current = settings.theme;
        const next = toNextTheme(settings.theme);
        // 读取期间用户已换档时，旧响应不能覆盖新选择；随后按新选择串行写回。
        if (
          currentTheme.current === requestedTheme &&
          next !== currentTheme.current
        ) {
          currentTheme.current = next;
          setThemeRef.current(next);
        }
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        hydrated.current = true;
        setHydrationVersion((version) => version + 1);
        // 读不到权威值时保留本机外观，但不在用户未操作时覆盖库里的未知值。
        persisted.current = toThemePreference(currentTheme.current);
        setError("主题读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [instance]);

  useEffect(() => {
    // 水合完成本身也要触发一次后续 effect（同值恢复与慢读取都不遗漏）。
    void hydrationVersion;
    if (!instance || !hydrated.current || !theme) return;
    const preference = toThemePreference(currentTheme.current ?? theme);
    localStorage.setItem("zcode-theme", preference);
    if (persisted.current === preference) return;
    const version = ++writeVersion.current;
    writeQueue.current = writeQueue.current
      .catch(() => undefined)
      .then(async () => {
        await updateInstanceSettings(null, {
          theme: preference,
        });
        if (version === writeVersion.current) {
          persisted.current = preference;
          setError(null);
        }
      })
      .catch(() => {
        if (version === writeVersion.current) {
          persisted.current = null;
          setError("主题保存失败");
        }
      });
  }, [instance, theme, hydrationVersion]);

  return error ? (
    <p
      role="alert"
      className="fixed right-3 bottom-3 z-100 rounded-md border bg-background px-3 py-2 text-sm text-destructive shadow-md"
    >
      {error}
    </p>
  ) : null;
}
