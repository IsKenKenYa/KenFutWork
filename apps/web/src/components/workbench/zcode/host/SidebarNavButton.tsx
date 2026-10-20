import { cn } from "@zui/components/lib/utils.js";
import { Button } from "@zui/components/ui/button.js";
import type { ReactNode } from "react";

/**
 * 侧栏的一条导航项：展开态是「图标 + 标签」整行按钮，收起态（rail）只剩图标。
 *
 * 两种形态共用同一份 label／onClick／disabled／active——收起态曾经只留 logo、展开与模式
 * 三个图标，把插件市场·技能·MCP·插件面板·新建任务·搜索整个藏掉（用户 2026-10-19 口径），
 * 所以「收起后还剩什么」必须能从这一处回答，而不是各写一份按钮。
 */
export function SidebarNavButton({
  collapsed = false,
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  testId,
  trailing,
  hint,
}: {
  collapsed?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
  /** 展开态右侧的次要读数（如快捷键）；收起态不占位。 */
  trailing?: ReactNode;
  /** 悬停说明；缺省用 label。报错原因这类「不进标签」的文字走这里。 */
  hint?: string;
}) {
  const title = hint ?? label;
  /** 只有选中态才声明为切换按钮：未选中的「技能 / MCP」是打开设置页的动作，不是开关。 */
  const pressed = active ? { "aria-pressed": true } : {};
  if (collapsed)
    return (
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label={label}
        title={title}
        disabled={disabled}
        data-testid={testId}
        onClick={onClick}
        className={cn(
          "shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
          active && "bg-selected text-foreground",
        )}
        {...pressed}
      >
        {icon}
      </Button>
    );
  return (
    <Button
      variant="ghost"
      size="lg"
      data-icon="inline-start"
      title={hint}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
        active && "bg-selected text-foreground",
      )}
      {...pressed}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ? (
        <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
          {trailing}
        </span>
      ) : null}
    </Button>
  );
}
