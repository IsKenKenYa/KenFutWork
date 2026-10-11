/*
 * 按 shadcn 注册表模板（MIT，风格 base-nova）编写的组件封装，运行时依赖 Base UI（MIT，
 * @base-ui/react）与 lucide-react（ISC）。归属与义务见仓库根 THIRD-PARTY-NOTICES.md §A4。
 */
"use client";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
