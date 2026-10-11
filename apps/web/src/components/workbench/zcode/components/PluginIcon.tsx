import { useEffect, useState, type ReactNode } from "react";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { isPluginIconResourceReference } from "@kenfutwork/shared";
import { Blocks } from "lucide-react";
import { cn } from "@zui/components/lib/utils.js";
import { resolvePluginIconSource } from "@zui/lib/pluginIconSource.js";

/** Plugin 原始图标；支持官方内置图标与 HTTPS，缺失或失败时使用调用方兜底，默认回退 Blocks。 */
export function PluginIcon({
  src,
  pluginId,
  className,
  iconClassName,
  fallbackIcon,
  monochrome = false,
}: {
  src?: string;
  pluginId?: string;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
  monochrome?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedSrc = resolvePluginIconSource(pluginId, src);
  const platform = useOptionalPlatform();
  const [resourceImage, setResourceImage] = useState<{ resource: string; image: string } | null>(null);
  const resource = isPluginIconResourceReference(resolvedSrc);
  useEffect(() => {
    let current = true;
    setImageFailed(false);
    if (resource && resolvedSrc && platform?.resolvePluginIcon) {
      void platform.resolvePluginIcon(resolvedSrc).then((image) => {
        if (current && image) setResourceImage({ resource: resolvedSrc, image });
      }).catch(() => { if (current) setImageFailed(true); });
    }
    return () => { current = false; };
  }, [resolvedSrc, resource, platform]);
  const imageSrc = resource ? (resourceImage?.resource === resolvedSrc ? resourceImage.image : undefined) : resolvedSrc;
  const showImage = Boolean(imageSrc) && !imageFailed;
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
        <>
        {monochrome ? <span
          className={cn("size-full", iconClassName)}
          style={{
            backgroundColor: "currentColor",
            maskImage: `url(${imageSrc})`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskImage: `url(${imageSrc})`,
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
          }}
        /> : null}
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          className={monochrome ? "absolute size-0 opacity-0" : "h-2/3 w-2/3 object-contain"}
          onError={() => setImageFailed(true)}
        />
        </>
      ) : fallbackIcon ? (
        fallbackIcon
      ) : (
        <Blocks className={cn("size-4", iconClassName)} />
      )}
    </span>
  );
}
