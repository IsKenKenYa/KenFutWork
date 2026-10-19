import { cn } from "@zui/components/lib/utils.js";

/**
 * 工具条标签：静态一行，装不下就截断成省略号。
 * 用户口径（2026-10-19）：原先的滚动换字（AnimatePresence + popLayout）在标签频繁变化时
 * 表现为持续抽搐，且 popLayout 会让容器宽度在动画期间跳动、连带整条工具条抖——
 * 一律去掉动画，只保留截断。组件名沿用（植码文件按来源清单锁定，改名会破坏保真核对）。
 */
export function RollingToolbarLabel({
  label,
  className,
  prefix,
  prefixClassName,
  value,
}: {
  label: string;
  className?: string;
  prefix?: string;
  prefixClassName?: string;
  value?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex h-[1.3em] min-w-0 items-center overflow-hidden leading-[1.25]",
        className,
      )}
      title={label}
    >
      <span className="min-w-0 truncate whitespace-nowrap leading-[1.25]">
        {prefix !== undefined && value !== undefined ? (
          <>
            <span className={prefixClassName}>{prefix}</span>
            <span>{value}</span>
          </>
        ) : (
          label
        )}
      </span>
    </span>
  );
}
