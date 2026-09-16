"use client";

import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * composer 里的两个小下拉的选项表（落地页与会话内共用一份，免得标签漂移）。
 * 它们也负责「值 → 中文名」的查表：窄列下控件只剩图标，当前值要靠 `title` 交代。
 */
export const TIER_OPTIONS = [
  { value: "default", label: "默认" },
  { value: "auto-approve", label: "自动放行" },
  { value: "full-access", label: "完全访问" },
] as const;

export const THINKING_OPTIONS = [
  { value: "default", label: "默认" },
  { value: "低", label: "低" },
  { value: "中", label: "中" },
  { value: "高", label: "高" },
  { value: "最高", label: "最高" },
] as const;

export function optionLabel(
  options: readonly { value: string; label: string }[],
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * composer 里的图标下拉（权限档位 / 思考强度）：一对「值 + 文字」，窄列时只剩图标。
 *
 * **为什么要收成图标**：对话列被右栏面板挤窄之后，这一排里最先压扁的就是这两个带文字的下拉
 * （模式与模型是短词 / 关键信息，留着）。收起来后当前值改由 `title` 说清——不留「看不出放行到
 * 哪一档」的哑图标（用户口径：「面板里的东西塞不下了，思考强度和权限改成图标」）。
 */
export function ComposerCompactSelect({
  ariaLabel,
  icon,
  compact,
  options,
  value,
  onChange,
  contentClassName = "min-w-28",
}: {
  ariaLabel: string;
  icon: ReactNode;
  /** 由对话列实测宽度决定（见 lib/panel-layout 的紧凑阈值）。 */
  compact: boolean;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  contentClassName?: string;
}) {
  return (
    <Select
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string" && next !== value) onChange(next);
      }}
      items={options.map((option) => ({ ...option }))}
    >
      <SelectTrigger
        className="gap-1 border-transparent bg-muted/60 px-2 py-1 text-xs"
        aria-label={ariaLabel}
        title={compact ? `${ariaLabel}：${optionLabel(options, value)}` : undefined}
      >
        {icon}
        {compact ? null : <SelectValue />}
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
