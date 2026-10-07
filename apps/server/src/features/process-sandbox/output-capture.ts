import { closeSync, openSync, readSync, writeSync } from "node:fs";
import type { ProcessOutput, ProcessOutputStream } from "./types.js";
import { ProcessSandboxError } from "./types.js";

export interface CapturedOutputStats {
  retainedBytes: number;
  totalBytes: number;
  discardedBytes: number;
}

function readDescriptor(
  descriptor: number,
  stats: CapturedOutputStats,
  input: { offset: number; maxBytes: number },
  done: boolean,
): ProcessOutput {
  const { offset, maxBytes } = input;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > stats.retainedBytes ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  )
    throw new ProcessSandboxError(
      "invalid_process_request",
      "输出游标或分页大小无效。",
    );
  // UTF-8 最长 4 字节是编码结构常量，不是运行时限额。
  const bytes = Buffer.alloc(
    Math.min(stats.retainedBytes - offset, maxBytes + 4),
  );
  const read = readSync(descriptor, bytes, 0, bytes.length, offset);
  let end = Math.min(maxBytes, read);
  while (end < read && (bytes.readUInt8(end) & 0xc0) === 0x80) end++;
  if (!done && stats.discardedBytes === 0 && end === read && end > 0) {
    let start = end - 1;
    while (start > 0 && (bytes.readUInt8(start) & 0xc0) === 0x80) start--;
    const lead = bytes.readUInt8(start);
    const length =
      lead >= 0xc2 && lead <= 0xdf
        ? 2
        : lead >= 0xe0 && lead <= 0xef
          ? 3
          : lead >= 0xf0 && lead <= 0xf4
            ? 4
            : 1;
    if (end - start < length) end = start;
  }
  return {
    data: bytes.subarray(0, end).toString("utf8"),
    offset,
    nextOffset: offset + end,
    retainedBytes: stats.retainedBytes,
    totalBytes: stats.totalBytes,
    discardedBytes: stats.discardedBytes,
    truncated: stats.discardedBytes > 0,
    done,
  };
}

/** 只读保留日志；调用方先验证 Task owner，path 必须来自持久 outputRef。 */
export function readCapturedOutput(
  path: string,
  stats: CapturedOutputStats,
  input: { offset: number; maxBytes: number },
  done: boolean,
): ProcessOutput {
  const descriptor = openSync(path, "r");
  try {
    return readDescriptor(descriptor, stats, input, done);
  } finally {
    closeSync(descriptor);
  }
}

/** 原始 stdout/stderr 到达顺序的有界磁盘采集；模型展示另由 consumer 投影。 */
export class OutputCapture {
  readonly path: string;
  retainedBytes = 0;
  totalBytes = 0;
  private descriptor: number;
  private closed = false;

  constructor(
    path: string,
    private readonly maxBytes: number,
  ) {
    this.path = path;
    this.descriptor = openSync(path, "wx+", 0o600);
  }

  append(chunk: Buffer, totalBytes = chunk.byteLength): void {
    if (this.closed)
      throw new ProcessSandboxError("output_failed", "命令输出文件已关闭。");
    this.totalBytes += totalBytes;
    const retained = chunk.subarray(
      0,
      Math.max(0, this.maxBytes - this.retainedBytes),
    );
    let written = 0;
    while (written < retained.byteLength) {
      written += writeSync(
        this.descriptor,
        retained,
        written,
        retained.byteLength - written,
        this.retainedBytes + written,
      );
    }
    this.retainedBytes += retained.byteLength;
  }

  read(offset: number, maxBytes: number, done: boolean): ProcessOutput {
    const stats = {
      retainedBytes: this.retainedBytes,
      totalBytes: this.totalBytes,
      discardedBytes: this.totalBytes - this.retainedBytes,
    };
    const descriptor = this.closed ? openSync(this.path, "r") : this.descriptor;
    try {
      return readDescriptor(descriptor, stats, { offset, maxBytes }, done);
    } finally {
      if (this.closed) closeSync(descriptor);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.descriptor);
  }
}

/** 分流日志是同一批保留字节的磁盘副本，不给每条 stream 再授予采集 cap。 */
export class ProcessOutputCapture {
  private readonly merged: OutputCapture;
  private readonly streams: Record<ProcessOutputStream, OutputCapture>;

  constructor(path: string, maxBytes: number) {
    this.merged = new OutputCapture(path, maxBytes);
    this.streams = {
      stdout: new OutputCapture(`${path}.stdout`, maxBytes),
      stderr: new OutputCapture(`${path}.stderr`, maxBytes),
    };
  }

  get path() {
    return this.merged.path;
  }
  get retainedBytes() {
    return this.merged.retainedBytes;
  }
  get totalBytes() {
    return this.merged.totalBytes;
  }

  append(chunk: Buffer, stream: ProcessOutputStream): void {
    const before = this.merged.retainedBytes;
    this.merged.append(chunk);
    const retained = this.merged.retainedBytes - before;
    this.streams[stream].append(chunk.subarray(0, retained), chunk.byteLength);
  }

  read(
    offset: number,
    maxBytes: number,
    done: boolean,
    stream?: ProcessOutputStream,
  ) {
    return (stream ? this.streams[stream] : this.merged).read(
      offset,
      maxBytes,
      done,
    );
  }

  close(): void {
    this.merged.close();
    this.streams.stdout.close();
    this.streams.stderr.close();
  }
}
