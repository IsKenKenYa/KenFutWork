import { inflateRawSync } from "node:zlib";

/**
 * 最小 ZIP 读取器（技能 ZIP 导入用）。
 *
 * 为什么不引依赖：本仓对供应链敏感（改造计划 §4.12），而技能包只需要
 * 「中央目录 + store/deflate 解压」这一小块能力；`node:zlib` 已足够。
 * 覆盖范围有意收窄，遇到不支持的结构**明确报错**而不是猜测：
 * - 支持：method 0（store）/ 8（deflate）、UTF-8 文件名；
 * - 拒绝：加密（flag bit 0）、Zip64（EOCD 哨兵值）、多卷；
 * - 拒收：路径穿越（`..`/绝对路径）、目录项、超限体积（防 zip bomb）。
 */

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipArchiveError";
  }
}

export interface ZipArchiveEntry {
  /** 条目在压缩包内的相对路径（已做穿越校验，正斜杠分隔）。 */
  path: string;
  /** 文本内容（与 tarball 路径同口径：按 UTF-8 解码）。 */
  content: string;
}

export interface ReadZipOptions {
  /** 解压后总字节上限（默认 50MB，防 zip bomb）。 */
  maxTotalBytes?: number;
  /** 单条目字节上限（默认 20MB）。 */
  maxEntryBytes?: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 20 * 1024 * 1024;

/** 由尾部向前找 EOCD（注释最长 65535 字节）。 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - (0xffff + 22));
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw new ZipArchiveError("不是有效的 ZIP 文件（未找到中央目录记录 EOCD）。");
}

/** 校验条目路径：拒绝绝对路径与目录穿越。 */
function normalizeEntryPath(rawPath: string): string {
  const path = rawPath.replace(/\\/g, "/");
  if (
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.split("/").includes("..")
  ) {
    throw new ZipArchiveError(`ZIP 含非法路径（越界或绝对路径）：${rawPath}`);
  }
  return path;
}

/**
 * 读取 ZIP 内的文本条目。
 * @throws ZipArchiveError 结构不支持或校验失败（不静默跳过关键错误）
 */
export function readZipArchiveEntries(
  buffer: Buffer,
  options: ReadZipOptions = {},
): ZipArchiveEntry[] {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;

  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (
    entryCount === ZIP64_SENTINEL_16 ||
    centralSize === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32
  ) {
    throw new ZipArchiveError(
      "暂不支持 Zip64 格式的 ZIP（条目过多或体积过大）。",
    );
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipArchiveError("ZIP 中央目录越界，文件可能已损坏。");
  }

  const entries: ZipArchiveEntry[] = [];
  let totalBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) {
      throw new ZipArchiveError("ZIP 中央目录条目越界，文件可能已损坏。");
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipArchiveError("ZIP 中央目录条目签名不匹配，文件可能已损坏。");
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const rawName = buffer
      .subarray(nameStart, nameStart + nameLength)
      .toString("utf-8");

    cursor = nameStart + nameLength + extraLength + commentLength;

    if (flags & 0x1) {
      throw new ZipArchiveError(`ZIP 含加密条目（${rawName}），暂不支持。`);
    }
    // 目录项：以 / 结尾，无内容
    if (rawName.endsWith("/")) {
      continue;
    }
    if (
      compressedSize === ZIP64_SENTINEL_32 ||
      uncompressedSize === ZIP64_SENTINEL_32
    ) {
      throw new ZipArchiveError("暂不支持 Zip64 条目（条目体积过大）。");
    }
    if (uncompressedSize > maxEntryBytes) {
      throw new ZipArchiveError(
        `ZIP 条目过大（${rawName}，${uncompressedSize} 字节，上限 ${maxEntryBytes}）。`,
      );
    }
    totalBytes += uncompressedSize;
    if (totalBytes > maxTotalBytes) {
      throw new ZipArchiveError(
        `ZIP 解压后总体积超限（上限 ${maxTotalBytes} 字节），已中止。`,
      );
    }

    const path = normalizeEntryPath(rawName);
    const data = readEntryData({
      buffer,
      localHeaderOffset,
      compressedSize,
      method,
      path,
    });
    entries.push({ path, content: data.toString("utf-8") });
  }

  return entries;
}

function readEntryData(input: {
  buffer: Buffer;
  localHeaderOffset: number;
  compressedSize: number;
  method: number;
  path: string;
}): Buffer {
  const { buffer, localHeaderOffset, compressedSize, method, path } = input;
  if (localHeaderOffset + 30 > buffer.length) {
    throw new ZipArchiveError(`ZIP 本地头越界（${path}），文件可能已损坏。`);
  }
  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) {
    throw new ZipArchiveError(
      `ZIP 本地头签名不匹配（${path}），文件可能已损坏。`,
    );
  }
  // 本地头的 name/extra 长度可能与中央目录不同，必须以本地头为准
  const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.length) {
    throw new ZipArchiveError(`ZIP 条数据越界（${path}），文件可能已损坏。`);
  }
  const raw = buffer.subarray(dataStart, dataEnd);

  if (method === 0) {
    return Buffer.from(raw);
  }
  if (method === 8) {
    try {
      return inflateRawSync(raw);
    } catch (error) {
      throw new ZipArchiveError(
        `ZIP 条目解压失败（${path}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  throw new ZipArchiveError(
    `ZIP 使用了不支持的压缩方式（method=${method}，${path}）；请重新打包为 store 或 deflate。`,
  );
}
