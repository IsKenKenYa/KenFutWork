import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import sharp from "sharp";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import { readPdf } from "./file-pdf.js";
import type { FileLimits, MediaFile, MediaReadInput } from "./file-types.js";

/** The same guarded file descriptor supplies bytes, metadata and the observed version. */
export async function readBinary(
  scope: ScopedFilesystemScope,
  input: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const path = await scope.resolvePath(input, "read");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("媒体路径不是常规文件");
    if (before.size > maxBytes)
      throw new Error(
        `媒体文件超过读取预算 ${maxBytes} 字节，请调整工作区治理设置`,
      );
    signal?.throwIfAborted();
    const bytes = await handle.readFile(signal ? { signal } : undefined);
    const after = await handle.stat();
    signal?.throwIfAborted();
    const stamp = (info: typeof before) =>
      `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (
      stamp(before) !== stamp(after) ||
      (await scope.resolvePath(input, "read")) !== path
    )
      throw new Error("媒体文件在读取期间变化，请重新读取");
    const version = createHash("sha256")
      .update(stamp(after))
      .update(createHash("sha256").update(bytes).digest())
      .digest("hex");
    return {
      path,
      bytes,
      version,
      mimeType: binaryMimeType(bytes),
      createdAt: after.birthtime.toISOString(),
      modifiedAt: after.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

export function binaryMimeType(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG")
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    return "application/pdf";
  return "application/octet-stream";
}

export async function readMedia(
  scope: ScopedFilesystemScope,
  limits: FileLimits,
  input: MediaReadInput,
): Promise<MediaFile> {
  const binary = await readBinary(scope, input.path, limits.codeReadMaxBytes);
  if (binary.bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    const pdf = await readPdf(binary, limits, input);
    await scope.resolvePath(input.path, "read");
    input.signal?.throwIfAborted();
    input.signal?.throwIfAborted();
    return pdf;
  }
  if (!input.capabilities.image)
    throw new Error("当前模型不支持图片读取；用户可通过文件预览查看图片");
  input.signal?.throwIfAborted();
  const metadata = await sharp(binary.bytes).metadata();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  const originalMime = metadata.format ? mimeTypes[metadata.format] : undefined;
  const bytes = originalMime
    ? binary.bytes
    : await sharp(binary.bytes).png().toBuffer();
  const mimeType = originalMime ?? "image/png";
  const dimensions = {
    ...(metadata.width !== undefined
      ? { originalWidth: metadata.width, displayWidth: metadata.width }
      : {}),
    ...(metadata.height !== undefined
      ? { originalHeight: metadata.height, displayHeight: metadata.height }
      : {}),
  };
  const base64 = bytes.toString("base64");
  const canonicalOutput = {
    type: "image",
    base64,
    mimeType,
    originalSize: binary.bytes.length,
    dimensions,
    ...(!originalMime
      ? {
          transformedSize: bytes.length,
          compressed: false,
          resized: false,
          compressionStrategy: "format-conversion",
        }
      : {}),
  };
  await scope.resolvePath(input.path, "read");
  input.signal?.throwIfAborted();
  return {
    ...canonicalOutput,
    type: "image",
    filePath: binary.path,
    version: binary.version,
    preview: {
      path: binary.path,
      mimeType,
      sizeBytes: binary.bytes.length,
      version: binary.version,
    },
    canonicalOutput,
    modelContent: [
      {
        type: "image",
        source_type: "base64",
        mime_type: mimeType,
        data: base64,
      },
    ],
  };
}
