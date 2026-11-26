import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import {
  classifyArchiveEntryPath,
  SkillImportSourceError,
  type SkillImportSourceLimits,
  SourceBudget,
} from "./import-source-support.js";

const UNREADABLE_ARCHIVE_MESSAGE =
  "压缩包无法解压，请确认文件是完整的 ZIP 包。";
/** 首条目必是本地文件头（PK\x03\x04），空包则是中央目录结束记录（PK\x05\x06）。 */
const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_ARCHIVE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

function withCause(
  message: string,
  statusCode: number,
  cause: unknown,
): SkillImportSourceError {
  return new SkillImportSourceError(message, statusCode, { cause });
}

function isPayloadTooLarge(error: unknown): boolean {
  return (error as { statusCode?: unknown }).statusCode === 413;
}

/**
 * 把上传的 zip 流解进 `destination`，边解边按预算计数。
 *
 * 每个条目都解压并计入字节预算：被跳过的条目同样消耗处理器时间，
 * 预算必须按真实解压量计算。来源标识取压缩包内容的 SHA-256，
 * 同一个包再次上传得到同一个标识，导入回执据此识别重复导入。
 */
export async function extractZipSource(input: {
  stream: Readable;
  destination: string;
  limits: SkillImportSourceLimits;
  signal: AbortSignal;
}): Promise<{ sourceKey: string; fileCount: number; skippedEntries: number }> {
  const budget = new SourceBudget(input.limits);
  const hash = createHash("sha256");
  let skippedEntries = 0;
  let fileCount = 0;
  let unfinishedEntries = 0;
  /** 从 ondata 里抛出的错误会被 fflate 的 start() 捕获掩盖，改走「销毁流」带回主循环。 */
  let failure: SkillImportSourceError | undefined;
  const unzip = new Unzip((file) => {
    budget.addEntry();
    const entry = classifyArchiveEntryPath(file.name, {
      backslashIsSeparator: true,
      destination: input.destination,
    });
    if (entry.kind === "skipped") {
      skippedEntries += 1;
    } else if (entry.kind === "directory") {
      mkdirSync(join(input.destination, ...entry.path.split("/")), {
        recursive: true,
      });
      return;
    }
    const target =
      entry.kind === "file"
        ? join(input.destination, ...entry.path.split("/"))
        : null;
    const parts: Buffer[] = [];
    unfinishedEntries += 1;
    file.ondata = (error, data, final) => {
      if (error) {
        throw withCause(UNREADABLE_ARCHIVE_MESSAGE, 400, error);
      }
      if (failure) return;
      try {
        budget.addBytes(data.byteLength);
      } catch (caught) {
        failure =
          caught instanceof SkillImportSourceError
            ? caught
            : withCause(UNREADABLE_ARCHIVE_MESSAGE, 400, caught);
        input.stream.destroy(failure);
        return;
      }
      if (target) parts.push(Buffer.from(data));
      if (final) {
        unfinishedEntries -= 1;
        if (target) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.concat(parts));
          fileCount += 1;
        }
      }
    };
    try {
      file.start();
    } catch (error) {
      throw withCause(UNREADABLE_ARCHIVE_MESSAGE, 400, error);
    }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  const stop = () => input.stream.destroy(input.signal.reason);
  input.signal.addEventListener("abort", stop, { once: true });
  if (input.signal.aborted) stop();
  const feed = (bytes: Buffer) =>
    unzip.push(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      false,
    );
  try {
    // 签名嗅探：fflate 对开头条目非法的字节流不报错、只当「没有条目」处理，
    // 必须自己验头，否则坏包会冒充空包（空包也会在暂存层被拒）。
    let header: Buffer | null = Buffer.alloc(0);
    for await (const chunk of input.stream) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      if (header) {
        header = Buffer.concat([header, bytes]);
        if (header.length < 4) continue;
        const signature = header.subarray(0, 4);
        if (
          !signature.equals(ZIP_LOCAL_FILE_SIGNATURE) &&
          !signature.equals(ZIP_EMPTY_ARCHIVE_SIGNATURE)
        ) {
          throw new SkillImportSourceError(UNREADABLE_ARCHIVE_MESSAGE);
        }
        feed(header);
        header = null;
        continue;
      }
      feed(bytes);
    }
    if (header) {
      // 不足 4 字节就结束了：连 zip 头都不完整
      throw new SkillImportSourceError(UNREADABLE_ARCHIVE_MESSAGE);
    }
    unzip.push(new Uint8Array(0), true);
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (error instanceof SkillImportSourceError) throw error;
    if (isPayloadTooLarge(error)) {
      throw new SkillImportSourceError(
        `压缩包超过 ${Math.round(input.limits.maxBytes / 1_048_576)} MB 上限。`,
        413,
        { cause: error },
      );
    }
    throw withCause(UNREADABLE_ARCHIVE_MESSAGE, 400, error);
  } finally {
    input.signal.removeEventListener("abort", stop);
  }
  if (failure) throw failure;
  if (unfinishedEntries > 0) {
    throw new SkillImportSourceError(UNREADABLE_ARCHIVE_MESSAGE);
  }
  return {
    sourceKey: `zip:sha256:${hash.digest("hex")}`,
    fileCount,
    skippedEntries,
  };
}
