/*
 * 按 shadcn 注册表模板（MIT，风格 base-nova）编写的组件封装，运行时依赖 Base UI（MIT，
 * @base-ui/react）与 lucide-react（ISC）。归属与义务见仓库根 THIRD-PARTY-NOTICES.md §A4。
 */
"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: generic shadcn primitive — control association is set by callers via htmlFor
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
