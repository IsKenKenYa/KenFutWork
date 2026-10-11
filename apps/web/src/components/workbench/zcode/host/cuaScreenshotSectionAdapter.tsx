import { CuaScreenshotSection as Original } from "@zui-original/ToolCallBlocks/renderers/CuaScreenshotSection.js";
import type { ComponentProps } from "react";
import { createContext, useContext, useEffect, useState } from "react";

type Reader = (uri: string, signal: AbortSignal) => Promise<Blob>;
export const CuaSnapshotReader = createContext<Reader | null>(null);

/** 图片请求沿当前宿主认证，凭据不进入DOM/图片地址；换图/卸载释放对象URL。 */
export function CuaScreenshotSection({
  screenshot,
}: ComponentProps<typeof Original>) {
  const reader = useContext(CuaSnapshotReader);
  const uri = screenshot.dataUrl;
  const archived = uri?.startsWith("/api/computer-use/snapshots?");
  const [loaded, setLoaded] = useState<{ uri: string; url: string } | null>(
    null,
  );
  useEffect(() => {
    if (!archived || !uri || !reader) return;
    const controller = new AbortController();
    let url: string | undefined;
    void reader(uri, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setLoaded({ uri, url });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded(null);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [archived, uri, reader]);
  return (
    <Original
      screenshot={
        archived
          ? { ...screenshot, dataUrl: loaded?.uri === uri ? loaded.url : null }
          : screenshot
      }
    />
  );
}
