import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { TaskWorkRecord } from "../task-work/types.js";
import type { CapturedOutputSource } from "./output-history-types.js";
import { CodeUiRepositoryError } from "./repository.js";

type Locator = Pick<
  CapturedOutputSource,
  "instanceId" | "taskId" | "kind" | "outputRef" | "childSessionId"
>;
const denied = (message: string) =>
  new CodeUiRepositoryError("not_found", message);

/** locator只能来自当前Task的可信捕获事实；用户只提供资源ID。 */
export async function resolveCapturedOutputPath(
  executionRoot: string,
  source: Locator,
) {
  if (!isAbsolute(source.outputRef)) throw denied("输出捕获路径无效。");
  const root = await realpath(resolve(executionRoot));
  const path = await realpath(source.outputRef);
  const expected =
    source.kind === "subagent"
      ? join(root, source.instanceId, source.taskId, "children")
      : join(
          root,
          createHash("sha256").update(source.taskId).digest("hex"),
          "output",
        );
  if (
    dirname(path) !== expected ||
    (source.kind === "subagent" &&
      (!source.childSessionId ||
        path !== join(expected, `${source.childSessionId}.log`)))
  )
    throw denied("输出不在当前Task的私有捕获目录。");
  return path;
}

/** 运行日志允许追加；一次查询冻结尾窗，完成日志须保持同一字节事实。 */
export async function readCapturedOutputView(
  executionRoot: string,
  record: TaskWorkRecord,
  input: {
    offset: number;
    maxBytes: number;
    tail: boolean;
    maxRetainedBytes: number;
  },
) {
  if (!record.outputRef) throw denied("工作尚未提供捕获日志。");
  const locator = {
    instanceId: record.scope.instanceId,
    taskId: record.scope.taskId,
    kind: record.kind,
    outputRef: record.outputRef,
    ...(record.childSessionId ? { childSessionId: record.childSessionId } : {}),
  };
  const path = await resolveCapturedOutputPath(executionRoot, locator);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > input.maxRetainedBytes)
      throw denied("输出不是常规日志或超过当前保留预算。");
    if (
      record.status !== "running" &&
      record.status !== "interrupted" &&
      (!record.outputStats || before.size !== record.outputStats.retainedBytes)
    )
      throw denied("终态日志不符合已持久化的保留字节事实。");
    const offset = input.tail
      ? Math.max(0, before.size - input.maxBytes)
      : input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > before.size)
      throw denied("输出分页游标无效。");
    const length = Math.min(input.maxBytes, before.size - offset);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const part = await file.read(bytes, read, length - read, offset + read);
      if (!part.bytesRead) throw denied("日志在读取期间被截断。");
      read += part.bytesRead;
    }
    const after = await file.stat();
    const current = await stat(path);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      after.size < before.size ||
      (record.status !== "running" &&
        (before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs)) ||
      (await resolveCapturedOutputPath(executionRoot, locator)) !== path
    )
      throw denied("日志捕获事实在读取期间改变。");
    // 尾窗不能从UTF-8 continuation字节开始；该位掩码是编码结构常量。
    let start = 0;
    if (input.tail && offset > 0)
      while (start < bytes.length && (bytes.readUInt8(start) & 0xc0) === 0x80)
        start++;
    const totalBytes = Math.max(
      before.size,
      record.outputStats?.totalBytes ?? before.size,
    );
    return {
      bytes: bytes.subarray(start),
      offset: offset + start,
      retainedBytes: before.size,
      totalBytes,
      discardedBytes: totalBytes - before.size,
      done: record.status !== "running",
    };
  } finally {
    await file.close();
  }
}
