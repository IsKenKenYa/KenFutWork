/**
 * zcode 照搬：`@/components/ai-elements/chat-loading.tsx`（references/zcode/packages/ui/src/components/ai-elements/chat-loading.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
"use client";

import { cn } from "@zui/components/lib/utils";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import { LoaderIcon } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

export interface ChatLoadingProps extends ComponentPropsWithoutRef<"div"> {
  loading: boolean;
  size?: "default" | "sm";
  className?: string;
}

export function ChatLoading({
  loading,
  size = "default",
  className,
  ...props
}: ChatLoadingProps) {
  const { intl } = useZCodeIntl();

  if (!loading) {
    return null;
  }

  const sizeClasses = size === "sm" ? "size-4 text-ui-base" : "size-6";

  return (
    <div
      aria-label={intl.formatMessage({ id: "common.loading" })}
      {...props}
      data-zcode-chat-loading-animate="true"
      role="status"
      className={cn("flex items-center", className)}
    >
      <div className="flex size-4 items-center justify-center">
        <LoaderIcon
          aria-hidden="true"
          className={cn("animate-spin text-foreground-subtle", sizeClasses)}
        />
      </div>
    </div>
  );
}
