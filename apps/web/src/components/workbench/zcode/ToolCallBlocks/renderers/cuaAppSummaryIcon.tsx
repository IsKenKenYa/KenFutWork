/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/cuaAppSummaryIcon.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/cuaAppSummaryIcon.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 * 适配注记：接口可选属性放宽 | undefined 以等价 zcode tsconfig 行为（exactOptionalPropertyTypes）。
 */

import { cn } from "@zui/components/lib/utils";
import { useOptionalPlatform } from "@zui/hooks/usePlatform";
import type { ApplicationIconRequest } from "@zui/lib/zcode-shared";
import { CUA_TOOL_ICON } from "@zui/ToolCallBlocks/renderers/cuaIcon";
import { type ReactNode, useEffect, useState } from "react";

export function CuaAppSummaryIcon({
  bundleId,
  fallback,
  iconRequest,
  name,
  className,
}: {
  bundleId?: string | undefined;
  /**
   * 图标取不到时显示什么（平台无 resolver、Linux 无 locator、读取失败）。
   * 默认沿用 CUA 图标；node_repl 工具卡传入自己的图标，避免同一张卡在解析失败时
   * 跳成另一个指针图形。
   */
  fallback?: ReactNode | undefined;
  iconRequest?: ApplicationIconRequest | string | null | undefined;
  name: string;
  className?: "size-4" | "size-5" | undefined;
}) {
  const platform = useOptionalPlatform();
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIconDataUrl(null);
    const request = iconRequest ?? bundleId;
    if (!request || !platform?.getApplicationIcon) return () => undefined;
    void platform
      .getApplicationIcon(request)
      .then((result) => {
        if (active) setIconDataUrl(result?.iconDataUrl ?? null);
      })
      .catch(() => {
        if (active) setIconDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [bundleId, iconRequest, platform]);

  return iconDataUrl ? (
    <img
      src={iconDataUrl}
      alt={name}
      className={cn(
        className ?? "size-4",
        "shrink-0 rounded-sm object-contain",
      )}
    />
  ) : (
    (fallback ?? CUA_TOOL_ICON)
  );
}
