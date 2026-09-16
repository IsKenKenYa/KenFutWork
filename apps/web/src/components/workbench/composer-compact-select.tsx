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
  { value: "default", label: "默认", hint: "危险 / 不可逆操作需人工审批" },
  {
    value: "auto-approve",
    label: "自动放行",
    hint: "命中已批准策略的调用自动通过",
  },
  {
    value: "full-access",
    label: "完全访问",
    hint: "不限制（明示开启，风险自担）",
  },
] as const;

export const THINKING_OPTIONS = [
  { value: "default", label: "默认", hint: "不额外要求，用模型自己的默认" },
  { value: "低", label: "低", hint: "想得少、回得快" },
  { value: "中", label: "中", hint: "常规推理" },
  { value: "高", label: "高", hint: "多想一步再答" },
  { value: "最高", label: "最高", hint: "尽量深想（更慢、更费 token）" },
] as const;

/** 思考强度的档位 → 进度条比例（满格 = 最高）。 */
export const THINKING_PROGRESS: Record<string, number> = {
  default: 0,
  "低": 0.25,
  "中": 0.5,
  "高": 0.75,
  "最高": 1,
};

export function optionLabel(
  options: readonly { value: string; label: string }[],
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * composer 里的图标下拉（权限档位 / 思考强度）：一对「图标 + 当前值」，窄列时只剩图标。
 *
 * **为什么要收成图标**：对话列被右栏面板挤窄之后，这一排里最先压扁的就是这两个带文字的下拉
 * （模式与模型是短词 / 关键信息，留着）。收起来后当前值改由 `title` 说清——不留「看不出放行到
 * 哪一档」的哑图标（用户口径：「面板里的东西塞不下了，思考强度和权限改成图标」）。
 *
 * **判据为什么走 CSS 容器查询而不是 JS 量宽度**：容器查询由浏览器在排版时算，不依赖任何 JS
 * 事件——窗口被宿主拖窄（某些内嵌环境不派发 resize / ResizeObserver 回调）时照样生效；
 * 卡片自己就是容器（`@container/composer`，见两个 composer 的卡片），
 * 阈值 `@max-xl` = 容器窄于 36rem（576px）时收起文字。
 */
export function ComposerCompactSelect({
  ariaLabel,
  icon,
  options,
  value,
  onChange,
  contentClassName = "min-w-28",
  progress,
}: {
  ariaLabel: string;
  icon: ReactNode;
  options: readonly { value: string; label: string; hint?: string }[];
  value: string;
  onChange: (next: string) => void;
  contentClassName?: string;
  /**
   * 进度条档位（0..1）：值是一组有顺序的档时用（思考强度：低/中/高/最高）。
   * 传了就按它画一条小进度条——参考图里思考强度就是一个「图标 + 条」而不是文字。
   */
  progress?: number | undefined;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <span className="group relative inline-flex">
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
          title={`${ariaLabel}：${optionLabel(options, value)}`}
          /* 缩小时只剩图标：除模型外别的控件都不要那个下拉箭头（用户口径） */
          chevronClassName="@max-xl/composer:hidden"
        >
          {icon}
          {progress === undefined ? (
            <SelectValue className="@max-xl/composer:hidden" />
          ) : (
            <>
              {/* 思考强度：一条小进度条表示档位（满格 = 最高）；文字只在宽时显示 */}
              <span
                aria-hidden
                className="flex h-1 w-6 items-center overflow-hidden rounded-full bg-foreground/15"
              >
                <span
                  className="h-full rounded-full bg-foreground/70"
                  style={{
                    width: `${Math.round(
                      Math.min(1, Math.max(0, progress)) * 100,
                    )}%`,
                  }}
                />
              </span>
              <SelectValue className="@max-xl/composer:hidden" />
            </>
          )}
        </SelectTrigger>
        <SelectContent className={contentClassName}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/*
        鼠标悬停时的说明面板（用户口径：「鼠标放上去显示面板」）：收起文字后只剩图标，
        光有 title 说不清每一档是什么意思——这里把选项与各自的含义一并列出，当前档位高亮。
        纯 CSS（group-hover），不依赖 JS 事件；`pointer-events-none` 免得抢走下拉的点击。
      */}
      <span
        role="tooltip"
        aria-label={`${ariaLabel}说明`}
        className="pointer-events-none absolute top-full left-0 z-50 mt-1 hidden w-56 rounded-lg border bg-popover p-2 text-xs shadow-md @max-xl/composer:group-hover:block"
      >
        <span className="mb-1 block font-medium">
          {ariaLabel}
          {current ? ` · 当前：${current.label}` : ""}
        </span>
        <span className="block space-y-1">
          {options.map((option) => (
            <span key={option.value} className="block">
              <span
                className={
                  option.value === value
                    ? "text-foreground"
                    : "text-muted-foreground"
                }
              >
                {option.label}
              </span>
              {option.hint ? (
                <span className="block text-[10px] text-muted-foreground">
                  {option.hint}
                </span>
              ) : null}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
