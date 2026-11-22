import { cn } from "@zui/components/lib/utils.js";

/**
 * 渐隐分割线：中间实、两端淡出（用户口径：菜单里的分割线统一用这一条）。
 *
 * 实线 `border` 在圆角菜单里两端会撞边框，渐隐线在视觉上与圆角衔接；
 * 横竖两个方向共用同一套渐变，只是方向不同。
 */
export function MenuGradientDivider({
  className,
  vertical = false,
}: {
  className?: string;
  vertical?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      role="none"
      data-slot="menu-gradient-divider"
      className={cn(
        vertical
          ? "w-px self-stretch bg-gradient-to-b from-transparent via-foreground/30 to-transparent"
          : "h-px w-full bg-gradient-to-r from-transparent via-foreground/30 to-transparent",
        className,
      )}
    />
  );
}
