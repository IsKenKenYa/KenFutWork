/**
 * zcode 照搬：`@/components/PluginIcon.tsx`（references/zcode/packages/ui/src/components/PluginIcon.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）。
 */

import { cn } from "@zui/components/lib/utils";
import { resolvePluginIconSource } from "@zui/lib/pluginIconSource";
import { Blocks } from "lucide-react";
import { type ReactNode, useState } from "react";

/** Plugin 原始图标；支持官方内置图标与 HTTPS，缺失或失败时使用调用方兜底，默认回退 Blocks。 */
export function PluginIcon({
  src,
  pluginId,
  className,
  iconClassName,
  fallbackIcon,
}: {
  src?: string | undefined;
  pluginId?: string | undefined;
  className?: string | undefined;
  iconClassName?: string | undefined;
  fallbackIcon?: ReactNode | undefined;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedSrc = resolvePluginIconSource(pluginId, src);
  const showImage = Boolean(resolvedSrc) && !imageFailed;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-xl bg-surface",
        !showImage && "text-foreground-subtle",
        className,
      )}
    >
      {showImage ? (
        <img
          src={resolvedSrc}
          alt=""
          draggable={false}
          className="h-2/3 w-2/3 object-contain"
          onError={() => setImageFailed(true)}
        />
      ) : fallbackIcon ? (
        fallbackIcon
      ) : (
        <Blocks className={cn("size-4", iconClassName)} />
      )}
    </span>
  );
}
