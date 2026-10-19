import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { ScopedFileController } from "../code-tools/file-controller.js";
import { runFileOperation } from "../code-tools/file-operations.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { CadToolResult } from "./service.js";
import type { CadResult } from "./tool-contracts.js";

const PREVIEW_WIDTH = 1024;
const PREVIEW_HEIGHT = 768;
type CanvasModule = typeof import("@napi-rs/canvas");

function projectionDecodeSize(svg: string): { width: number; height: number } {
  const viewBox = /<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/iu
    .exec(svg)?.[1]
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (
    viewBox?.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    (viewBox[2] ?? 0) <= 0 ||
    (viewBox[3] ?? 0) <= 0
  ) {
    throw new Error("CAD 预览为空或缺少有效投影范围。");
  }
  const width = viewBox[2] ?? 0;
  const height = viewBox[3] ?? 0;
  const scale = Math.min(PREVIEW_WIDTH / width, PREVIEW_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 栅格化官方 TechDraw 真实几何投影；不自行重建 CAD 线条。 */
export async function rasterizeCadSvg(svg: string): Promise<Buffer> {
  // Native SVG 解码器只接收官方投影的自包含路径，不能借图像引用读取宿主资源。
  if (
    /<!|<\s*(?:script|image|foreignObject|iframe|object|embed|use|style)\b|\b(?:href|on\w+)\s*=|url\s*\(/iu.test(
      svg,
    )
  ) {
    throw new Error("CAD 投影包含外部资源或非几何内容，不能生成预览。");
  }
  const { createCanvas, Image } = createRequire(import.meta.url)(
    "@napi-rs/canvas",
  ) as CanvasModule;
  // 用真实几何范围等比确定解码尺寸，避免覆盖为固定4:3导致拉伸，
  // 也避免毫米尺寸先按自然DPI解成巨大位图或小图后再放大。
  const size = projectionDecodeSize(svg);
  // 直接设置 Image(width,height) 会使当前原生解码器裁掉非零原点投影；
  // 只在内存副本中改根 SVG 的像素视口，交换文件继续保留物理毫米。
  const rasterSource = svg.replace(
    /<svg\b([^>]*)>/iu,
    (_tag, attributes: string) =>
      `<svg${attributes.replace(/\s+(?:width|height)\s*=\s*(["'])[^"']*\1/giu, "")} width="${size.width}" height="${size.height}">`,
  );
  const image = new Image();
  image.src = Buffer.from(rasterSource, "utf8");
  await image.decode();
  const canvas = createCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  const scale = Math.min(
    PREVIEW_WIDTH / image.width,
    PREVIEW_HEIGHT / image.height,
  );
  const width = image.width * scale;
  const height = image.height * scale;
  context.drawImage(
    image,
    (PREVIEW_WIDTH - width) / 2,
    (PREVIEW_HEIGHT - height) / 2,
    width,
    height,
  );
  const pixels = context.getImageData(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT).data;
  let drawn = false;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (
      (pixels[offset] ?? 255) < 240 ||
      (pixels[offset + 1] ?? 255) < 240 ||
      (pixels[offset + 2] ?? 255) < 240
    ) {
      drawn = true;
      break;
    }
  }
  if (!drawn) throw new Error("FreeCAD 线框预览为空，不能用空白图片确认几何。");
  return canvas.toBuffer("image/png");
}

export async function createCadPreviewResult(input: {
  handle: ExecutionScopeHandle;
  svgPath: string;
  outputPath: string;
  nativeResult: CadResult;
  signal: AbortSignal;
  maxSvgBytes: number;
}): Promise<CadToolResult> {
  input.signal.throwIfAborted();
  if (!input.nativeResult.preview)
    throw new Error("FreeCAD 回执缺少线框投影事实。");
  const svgPath = await input.handle.resolvePath(input.svgPath, "read");
  const metadata = await stat(svgPath);
  if (metadata.size > input.maxSvgBytes)
    throw new Error(
      "CAD 预览矢量数据超过当前进程输出设置，请选择更少对象或调整设置。",
    );
  const png = await rasterizeCadSvg(await readFile(svgPath, "utf8"));
  input.signal.throwIfAborted();
  const outputPath = await input.handle.resolvePath(input.outputPath, "write");
  const controller = new ScopedFileController(
    input.handle,
    input.handle.backend.limits,
  );
  await runFileOperation(
    input.handle,
    input.signal,
    (signal) =>
      controller.publishBytes(outputPath, png, null, undefined, signal),
    "write",
  );
  await input.handle.resolvePath(outputPath, "read");
  input.signal.throwIfAborted();
  const canonicalOutput = {
    type: "cad-preview",
    outputPath,
    filePath: outputPath,
    svgPath,
    mimeType: "image/png",
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    sizeBytes: png.length,
    preview: input.nativeResult.preview,
    document: input.nativeResult.document,
    version: input.nativeResult.version,
  };
  const text = `FreeCAD 线框预览：${outputPath}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: canonicalOutput,
    canonicalOutput,
    modelContent: [
      { type: "text", text: JSON.stringify(canonicalOutput) },
      {
        type: "image",
        source_type: "base64",
        mime_type: "image/png",
        data: png.toString("base64"),
      },
    ],
  };
}
