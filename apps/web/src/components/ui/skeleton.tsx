/*
 * 按 shadcn 注册表模板（MIT，风格 base-nova）编写的组件封装，运行时依赖 Base UI（MIT，
 * @base-ui/react）与 lucide-react（ISC）。归属与义务见仓库根 THIRD-PARTY-NOTICES.md §A4。
 */
import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.5s_ease-in-out_infinite] before:bg-gradient-to-r before:from-transparent before:via-white/60 before:to-transparent",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
