import {
  type GeneratedMediaDisplay,
  generatedMediaDisplaySchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { ToolCallRendererContribution } from "@zui/ToolCallBlocks/contributedRenderers.js";
import { FallbackToolCallBlock } from "@zui/ToolCallBlocks/renderers/fallback.js";
import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared.js";
import { ToolLayout } from "@zui/ToolCallBlocks/ToolLayout.js";
import { FilmIcon, ImageIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getSurfaceApiBase, surfaceJson } from "./surfaceApi.js";

const pendingUrls = new Map<string, Promise<string>>();
const mediaPreviewErrorMessage = "预览无法加载，请重试";
export function readGeneratedMediaUrl(assetId: string): Promise<string> {
  const key = `${getSurfaceApiBase()}\0${assetId}`;
  const existing = pendingUrls.get(key);
  if (existing) return existing;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const request = surfaceJson<{ url: string }>(
    `/api/uploads/${encodeURIComponent(assetId)}/url`,
    { signal: controller.signal },
  )
    .then((response) => {
      if (!response || typeof response.url !== "string" || !response.url)
        throw new Error("预览地址不可用");
      const url = new URL(response.url, getSurfaceApiBase());
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("预览地址不可用");
      return url.href;
    })
    .finally(() => {
      clearTimeout(timer);
      pendingUrls.delete(key);
    });
  pendingUrls.set(key, request);
  return request;
}

function GeneratedMediaPreview({
  display,
  onOpen,
}: {
  display: GeneratedMediaDisplay;
  onOpen?: ((url: string) => void) | undefined;
}) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    assetId: string;
    url?: string;
    failed?: boolean;
  }>({ assetId: display.assetId });
  useEffect(() => {
    let active = true;
    setState({ assetId: display.assetId });
    void readGeneratedMediaUrl(display.assetId)
      .then((url) => {
        if (active) setState({ assetId: display.assetId, url });
      })
      .catch(() => {
        if (active) setState({ assetId: display.assetId, failed: true });
      });
    return () => {
      active = false;
    };
  }, [display.assetId, version]);
  const fail = useCallback(
    () => setState({ assetId: display.assetId, failed: true }),
    [display.assetId],
  );
  if (state.assetId !== display.assetId || (!state.url && !state.failed))
    return <p role="status">读取预览</p>;
  if (state.failed)
    return (
      <div role="alert">
        {mediaPreviewErrorMessage}{" "}
        <button type="button" onClick={() => setVersion((value) => value + 1)}>
          重试
        </button>
      </div>
    );
  const title =
    display.title?.trim() || (display.mediaType === "image" ? "图片" : "视频");
  return (
    <figure
      data-generated-media-job={display.jobId}
      data-generated-media-asset={display.assetId}
      className="overflow-hidden rounded-lg border border-border"
    >
      {display.mediaType === "video" ? (
        // biome-ignore lint/a11y/useMediaCaption: 生成成果未提供字幕文件，保留原生播放器操作。
        <video
          aria-label={title}
          controls
          preload="metadata"
          src={state.url}
          onError={fail}
          className="max-h-96 w-full"
        />
      ) : onOpen ? (
        <button
          type="button"
          aria-label="打开图片"
          onClick={() => {
            if (state.url) onOpen(state.url);
          }}
          className="block w-full"
        >
          {/* biome-ignore lint/performance/noImgElement: 授权预览地址由本机服务动态解析。 */}
          <img
            src={state.url}
            alt={title}
            onError={fail}
            className="max-h-96 w-full object-contain"
          />
        </button>
      ) : (
        // biome-ignore lint/performance/noImgElement: 授权预览地址由本机服务动态解析。
        <img
          src={state.url}
          alt={title}
          onError={fail}
          className="max-h-96 w-full object-contain"
        />
      )}
      <figcaption className="flex gap-2 px-3 py-2 text-xs">
        {title}
        {display.width && display.height ? (
          <span>
            {display.width} × {display.height}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function GeneratedMediaToolCallBlock(
  context: ToolCallBlockRenderContext,
) {
  const tool = context.toolCallNode.toolCall;
  const parsed = generatedMediaDisplaySchema.safeParse(
    context.displayModel.contributedDisplay,
  );
  if (tool.status !== "completed")
    return <FallbackToolCallBlock {...context} hideRawFallback />;
  if (
    !parsed.success ||
    !parsed.data.mimeType.startsWith(`${parsed.data.mediaType}/`)
  )
    return <div role="alert">生成结果无法显示，请重试</div>;
  const display = parsed.data;
  return (
    <ToolLayout
      toolId={tool.toolId}
      icon={
        display.mediaType === "image" ? (
          <ImageIcon className="size-4" />
        ) : (
          <FilmIcon className="size-4" />
        )
      }
      showIcon={context.showIcon !== false}
      kindLabel={display.mediaType === "image" ? "图片" : "视频"}
      primaryText={display.title?.trim() || tool.title || "生成成果"}
      secondaryText={context.statusLabel}
      autoOpen
      canToggle
      renderContent={() => (
        <>
          <GeneratedMediaPreview
            key={`${display.jobId}:${display.assetId}`}
            display={display}
            onOpen={context.onOpenBrowserUrl}
          />
          {context.childToolList}
        </>
      )}
    />
  );
}
export const generatedMediaRenderer: ToolCallRendererContribution = {
  id: "canvas.generated-media",
  matches: (context) => {
    const display = context.displayModel.contributedDisplay;
    return Boolean(
      display &&
        typeof display === "object" &&
        "kind" in display &&
        display.kind === "generated_media",
    );
  },
  component: GeneratedMediaToolCallBlock,
};
