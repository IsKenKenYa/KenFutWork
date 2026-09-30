/**
 * zcode 照搬：`@/components/ai-elements/markdown-blockquote.tsx`（references/zcode/packages/ui/src/components/ai-elements/markdown-blockquote.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
"use client";

import { cn } from "@zui/components/lib/utils.js";
import type { ComponentProps } from "react";

export type MarkdownBlockquoteProps = ComponentProps<"blockquote"> & {
  node?: unknown;
};

export function MarkdownBlockquote({
  className,
  node: _node,
  ...props
}: MarkdownBlockquoteProps) {
  return (
    <blockquote
      className={cn(
        "my-4 border-border border-l-2 pl-3 text-foreground-subtle",
        "[&_p]:my-0 [&_p+p]:mt-2",
        className,
      )}
      data-markdown-blockquote=""
      {...props}
    />
  );
}
