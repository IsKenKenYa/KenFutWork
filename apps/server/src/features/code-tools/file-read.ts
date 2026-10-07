import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { TextPager } from "./file-read-page.js";
import type { ReadPageInput, TextPage } from "./file-types.js";

export interface FileSnapshot {
  text: string;
  version: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  bom: boolean;
  mode: number;
  createdAt: string;
  modifiedAt: string;
}

export interface PageRead {
  page: TextPage;
  range: { start: number; end: number };
  full: boolean;
  totalCharacters: number;
}

function stamp(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

export async function scanText(
  path: string,
  input: ReadPageInput,
  maxCharacters: number,
  maxBytes?: number,
): Promise<PageRead & { snapshot: FileSnapshot }> {
  input.signal?.throwIfAborted();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`不是常规文件：${path}`);
    if (maxBytes !== undefined && before.size > maxBytes)
      throw new Error(`文件超过可编辑字节上限 ${maxBytes}：${path}`);
    const pager = new TextPager(
      path,
      input,
      maxCharacters,
      maxBytes !== undefined,
    );
    const hash = createHash("sha256");
    let decoder: TextDecoder | undefined;
    let encoding: FileSnapshot["encoding"] = "utf-8";
    let bom = false;
    for await (const value of file.createReadStream({
      autoClose: false,
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(bytes);
      if (!decoder) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
        bom =
          encoding !== "utf-8" ||
          (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
        decoder = new TextDecoder(encoding, { fatal: true });
      }
      pager.consume(decoder.decode(bytes, { stream: true }));
    }
    if (decoder) pager.consume(decoder.decode());
    const after = await file.stat();
    input.signal?.throwIfAborted();
    if (stamp(before) !== stamp(after))
      throw new Error("文件在读取期间变化，请重新读取");
    const version = createHash("sha256")
      .update(stamp(after))
      .update(hash.digest())
      .digest("hex");
    if (input.continuation && input.continuation.version !== version)
      throw new Error("文件版本已变化，请重新读取后继续");
    return {
      ...pager.finish(version, after.size),
      snapshot: {
        text: pager.text,
        version,
        encoding,
        bom,
        mode: after.mode,
        createdAt: after.birthtime.toISOString(),
        modifiedAt: after.mtime.toISOString(),
      },
    };
  } finally {
    await file.close();
  }
}

export function encodeText(content: string, snapshot?: FileSnapshot): Buffer {
  if (!snapshot || snapshot.encoding === "utf-8")
    return Buffer.from(`${snapshot?.bom ? "\ufeff" : ""}${content}`, "utf8");
  const buffer = Buffer.from(content, "utf16le");
  if (snapshot.encoding === "utf-16be") buffer.swap16();
  return Buffer.concat([
    Buffer.from(snapshot.encoding === "utf-16be" ? [0xfe, 0xff] : [0xff, 0xfe]),
    buffer,
  ]);
}

export function isTextDecodeFailure(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") ||
    (error instanceof Error &&
      error.message.startsWith("二进制文件不能作为文本读取"))
  );
}
