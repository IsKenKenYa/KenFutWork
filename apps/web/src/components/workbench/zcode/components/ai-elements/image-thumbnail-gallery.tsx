/**
 * zcode 照搬：`@/components/ai-elements/image-thumbnail-gallery.tsx`（references/zcode/packages/ui/src/components/ai-elements/image-thumbnail-gallery.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
"use client";

import { cn } from "@zui/components/lib/utils.js";
import type { ComponentProps } from "react";

export const imageThumbnailTriggerClassName =
  "my-4 block w-fit max-w-1/2 cursor-zoom-in overflow-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export const imageThumbnailClassName =
  "h-auto max-h-90 max-w-full rounded-xl border border-border bg-background object-cover";

export function ImageThumbnailGallery({
  children,
  className,
  grouped = true,
  ...props
}: ComponentProps<"div"> & { grouped?: boolean }) {
  return (
    <div
      className={cn(
        grouped
          ? "my-4 grid grid-cols-1 gap-2 [&>[data-image-thumbnail-trigger]]:my-0 [&>[data-image-thumbnail-trigger]]:h-32 [&>[data-image-thumbnail-trigger]]:w-full [&>[data-image-thumbnail-trigger]]:max-w-none [&>[data-image-thumbnail-trigger]>img]:size-full [&>[data-image-thumbnail-trigger]>img]:max-h-none sm:grid-cols-2 md:flex md:flex-wrap md:[&>[data-image-thumbnail-trigger]]:h-44 md:[&>[data-image-thumbnail-trigger]]:w-auto md:[&>[data-image-thumbnail-trigger]]:shrink-0 md:[&>[data-image-thumbnail-trigger]>img]:h-44 md:[&>[data-image-thumbnail-trigger]>img]:w-auto md:[&>[data-image-thumbnail-trigger]>img]:max-w-none"
          : "contents",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
