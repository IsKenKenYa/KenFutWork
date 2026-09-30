/**
 * zcode 照搬：`@/components/ai-elements/markdown-list.tsx`（references/zcode/packages/ui/src/components/ai-elements/markdown-list.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
"use client";

import { cn } from "@zui/components/lib/utils.js";
import type { ComponentProps } from "react";

type MarkdownListNodeProp = {
  node?: unknown;
};

export type MarkdownUnorderedListProps = ComponentProps<"ul"> &
  MarkdownListNodeProp;

export function MarkdownUnorderedList({
  className,
  node: _node,
  ...props
}: MarkdownUnorderedListProps) {
  return (
    <ul
      className={cn(
        "my-3 list-outside list-disc space-y-1.5 pl-5 marker:text-foreground-subtlest",
        "[&_ul]:my-1.5 [&_ol]:my-1.5",
        className,
      )}
      data-markdown-list="unordered"
      data-streamdown="unordered-list"
      {...props}
    />
  );
}

export type MarkdownOrderedListProps = ComponentProps<"ol"> &
  MarkdownListNodeProp;

export function MarkdownOrderedList({
  className,
  node: _node,
  ...props
}: MarkdownOrderedListProps) {
  return (
    <ol
      className={cn(
        // 有序列表编号到两位/三位时，list-outside 会把 marker 向父容器外侧扩展；
        // 消息气泡外层有 overflow-hidden，固定 pl 缩进不足就会把编号左侧截断。
        "my-3 list-inside list-decimal space-y-1.5 pl-0 marker:text-foreground-subtlest",
        "[&_ul]:my-1.5 [&_ol]:my-1.5",
        className,
      )}
      data-markdown-list="ordered"
      data-streamdown="ordered-list"
      {...props}
    />
  );
}

export type MarkdownListItemProps = ComponentProps<"li"> & MarkdownListNodeProp;

export function MarkdownListItem({
  className,
  node: _node,
  ...props
}: MarkdownListItemProps) {
  return (
    <li
      className={cn("pl-1 [&>p]:my-0 [&>p]:inline", className)}
      data-streamdown="list-item"
      {...props}
    />
  );
}
