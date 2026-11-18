"use client";

import { SETTINGS_ROW_MIN_HEIGHT } from "@/lib/settings-layout";

/**
 * 设置里的**单个开关行**：标签在左、开关在右。
 *
 * **没有副标题**——复述标签的副标题按 2026-09-27 口径一律不写；时机这类一句话事实
 * 走操作回执（调用方自己显示），不常驻在行里。
 *
 * 提取动机：浏览器页与本机偏好页都要它，第二处使用就该共用一份（行高与开关样式
 * 各写一遍必然漂移）。
 */
export function SettingsToggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between gap-4 px-3 py-2 ${SETTINGS_ROW_MIN_HEIGHT}`}
    >
      <span className="text-sm">
        {label}
        {disabled ? (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            暂不可用
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted-foreground/30"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-background transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </button>
    </label>
  );
}
