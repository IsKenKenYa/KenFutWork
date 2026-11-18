"use client";

import {
  Hand,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
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
/** 档位图标的统一尺寸（触发器与下拉项共用一份，免得两处漂移）。 */
const TIER_ICON_CLASS = "h-3.5 w-3.5 shrink-0";

/**
 * 权限四档：**档名与图标都不许重样**（用户口径「图标可以参考一下，不要全部都一样」，
 * 参考图里就是每档一个图标 + 一句说明）。
 *
 * 档名用产品口径的四个词：**默认 / 自动审批 / 完全访问 / 自定义**——其中「默认」的语义
 * 就是「改文件前先问我」：写类与命令类工具（`write_file` / `edit_file` / `execute` / `shell*`
 * / `mcp__*` / `diff_patch`，见服务端 `DANGEROUS_TOOL_PATTERNS`）在默认档下都要审批，
 * 所以说明可以照实这么写，不是承诺更多。
 */
export const TIER_OPTIONS = [
  {
    value: "default",
    label: "默认",
    hint: "改文件 / 跑命令前先问我",
    icon: <Hand className={TIER_ICON_CLASS} />,
  },
  {
    value: "auto-approve",
    label: "自动审批",
    hint: "已批准的调用自动通过",
    icon: <ShieldCheck className={TIER_ICON_CLASS} />,
  },
  {
    value: "full-access",
    label: "完全访问",
    // 括号里那半句（「明示开启，风险自担」）挪成了**选中时的风险确认弹窗**（用户口径）
    hint: "不限制",
    icon: <ShieldAlert className={TIER_ICON_CLASS} />,
  },
  /**
   * 第四档（自定义）：**少了这一条**时编排器只能显示原始值 `custom`，
   * 而且在下拉里根本选不到它——四档已经在权限页落地了，这里必须跟着齐（实测发现）。
   */
  {
    value: "custom",
    label: "自定义",
    hint: "按设置里的规则逐条判断",
    icon: <SlidersHorizontal className={TIER_ICON_CLASS} />,
  },
] as const;

/** 档位 → 图标：触发器显示的是**当前档位**的图标（四档各不相同，别退回一个通用盾牌）。 */
export function tierIcon(value: string): ReactNode {
  return (
    TIER_OPTIONS.find((option) => option.value === value)?.icon ??
    TIER_OPTIONS[0].icon
  );
}

export const THINKING_OPTIONS = [
  { value: "default", label: "默认", hint: "用模型自己的默认" },
  {
    value: "关闭",
    label: "关闭",
    hint: "直接给结论 · 更快更省",
  },
  { value: "低", label: "低", hint: "想得少、回得快" },
  { value: "中", label: "中", hint: "常规推理" },
  { value: "高", label: "高", hint: "多想一步再答" },
  { value: "最高", label: "最高", hint: "尽量深想（更慢）" },
] as const;

/**
 * 思考强度的档位 → 竖条比例（满格 = 最高）。
 * `关闭` 是**明确的 0%**（用户口径：「关闭才是进度条 0%」）；`默认` 在界面上**不画条**。
 */
export const THINKING_PROGRESS: Record<string, number> = {
  default: 0,
  关闭: 0,
  低: 0.25,
  中: 0.5,
  高: 0.75,
  最高: 1,
};

/** 界面上该不该画那根竖条：`默认` 不画（用户口径），其余档位都画（含「关闭」= 0%）。 */
export function showsThinkingProgress(value: string): boolean {
  return value !== "default";
}

/**
 * 思考强度 → 拼进用户消息的提示词片段（**这是它唯一的执行面**：模型收到的一句要求）。
 *
 * 与界面文案分开写：「关闭」在提示词里必须说清是「不要展开推理」，否则模型只会看到一个
 * 不知道什么意思的「关闭」。
 */
export function thinkingPromptHint(value: string): string {
  if (!value || value === "default") return "";
  if (value === "关闭") {
    return "【思考强度：关闭——不要展开推理过程，直接给结论】\n";
  }
  return `【思考强度：${value}】\n`;
}

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
  options: readonly {
    value: string;
    label: string;
    hint?: string;
    icon?: ReactNode;
  }[];
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
        items={options.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      >
        <SelectTrigger
          className="h-7 gap-1 border-transparent bg-muted/60 px-2 text-xs"
          aria-label={ariaLabel}
          title={`${ariaLabel}：${optionLabel(options, value)}`}
          /* 除模型外一律不要下拉箭头（用户口径；缩小时更只剩图标）——触发器本身仍可点开 */
          hideChevron
        >
          {icon}
          {progress === undefined || !showsThinkingProgress(value) ? (
            <SelectValue className="@max-xl/composer:hidden" />
          ) : (
            <>
              {/*
                思考强度：一根**竖条**（参考图口径：图标 + 竖条，满格 = 最高）。
                **默认态不显示进度**（用户口径）——只留一根空的浅灰轨道；
                选了具体档位（低/中/高/最高）才填，填充用绿色（参考图里就是绿的）。
              */}
              <span
                aria-hidden
                className="flex h-3.5 w-1 flex-col justify-end overflow-hidden rounded-full bg-foreground/15"
              >
                {progress > 0 ? (
                  <span
                    className="w-full rounded-full bg-emerald-600"
                    style={{
                      height: `${Math.round(
                        Math.min(1, Math.max(0, progress)) * 100,
                      )}%`,
                    }}
                  />
                ) : null}
              </span>
              <SelectValue className="@max-xl/composer:hidden" />
            </>
          )}
        </SelectTrigger>
        <SelectContent className={contentClassName}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {/*
                带图标的档位（权限四档）拉成两行：图标 + 档名 + 一句说明（参考图口径）；
                没图标的（思考强度）保持单行——那里六档都是「哪一个更想得多」，加说明只是噪声。
              */}
              {option.icon ? (
                <span className="flex items-center gap-2 py-0.5">
                  <span className="text-muted-foreground">{option.icon}</span>
                  <span className="flex min-w-0 flex-col">
                    <span>{option.label}</span>
                    {option.hint ? (
                      <span className="text-[10px] text-muted-foreground">
                        {option.hint}
                      </span>
                    ) : null}
                  </span>
                </span>
              ) : (
                option.label
              )}
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

/**
 * 思考档位过滤：模型声明了 reasoningEfforts（供应商模型行）时只显示这些
 * 档位（「默认」恒在）；未声明 = 全档位。声明值与档位 value 精确匹配。
 */
export function thinkingOptionsFor(
  model: { reasoningEfforts?: string[] | undefined } | undefined,
  allOptions: readonly { value: string; label: string; hint?: string }[],
): { value: string; label: string; hint?: string }[] {
  const declared = model?.reasoningEfforts;
  if (!declared || declared.length === 0) {
    return [...allOptions];
  }
  const declaredSet = new Set(declared);
  return allOptions.filter(
    (option) => option.value === "default" || declaredSet.has(option.value),
  );
}
