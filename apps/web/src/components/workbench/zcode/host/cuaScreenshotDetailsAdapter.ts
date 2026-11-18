import { readCuaResultState } from "@zui-original/ToolCallBlocks/renderers/cuaResultState.js";
import { buildCuaScreenshotDetails as original } from "@zui-original/ToolCallBlocks/renderers/cuaScreenshotDetails.js";
import { readToolResultDisplay } from "@zui-original/ToolCallBlocks/toolResultDisplay.js";

export type { CuaScreenshotDetails } from "@zui-original/ToolCallBlocks/renderers/cuaScreenshotDetails.js";

/** 保留原截图组件；尺寸由真实结果元数据提供，附件仍受原服务鉴权。 */
export function buildCuaScreenshotDetails(
  call: Parameters<typeof original>[0],
): ReturnType<typeof original> {
  const details = original(call);
  const result = readCuaResultState(call);
  const image =
    result?.image && typeof result.image === "object"
      ? (result.image as Record<string, unknown>)
      : undefined;
  const display = readToolResultDisplay(call.raw);
  const uri =
    display?.kind === "cua"
      ? display.media?.find(
          (item) => item.mimeType === "image/png" && item.artifactUri,
        )?.artifactUri
      : undefined;
  return {
    ...details,
    ...(Number.isSafeInteger(image?.width) && Number(image?.width) > 0
      ? { width: Number(image?.width) }
      : {}),
    ...(Number.isSafeInteger(image?.height) && Number(image?.height) > 0
      ? { height: Number(image?.height) }
      : {}),
    ...(!details.dataUrl &&
    uri &&
    /^\/api\/computer-use\/snapshots\?taskId=[0-9a-f-]{36}&digest=[0-9a-f]{64}$/u.test(
      uri,
    )
      ? { dataUrl: uri, mimeType: "image/png" }
      : {}),
  };
}
