import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { ToolMessage } from "@langchain/core/messages";
import type { AgentMiddleware } from "langchain";

/**
 * 超大工具输出外置。
 *
 * 定位：只改**发给模型的那一份消息**，不改运行事件、界面展示与持久状态。
 * 超过字符阈值的结果写入执行作用域内的运行目录，模型收到一段说明（相对路径、
 * 总行数、字节数），再用现有读取工具按行区间分段取原文。
 *
 * 落点：工作目录下的 `.kenfutwork/tool-results/<taskId>/<runId>/<toolCallId>.txt`。
 * 该目录已被版本控制忽略，既在读取工具的授权范围内，又不碰用户源码文件。
 * 文件名按工具调用 id 固定，重复写入幂等覆盖，不产生重复文件。
 */

/** 单个路径片段里只保留可安全落盘、可被读取工具定位的字符。 */
const SAFE_SEGMENT = /[^A-Za-z0-9_-]/g;
const MAX_SEGMENT_CHARS = 120;
const OFFLOAD_ROOT = posix.join(".kenfutwork", "tool-results");

export interface ToolResultOffloadTarget {
  /** 相对工作目录的文件路径。 */
  relativePath: string;
  /** 完整原文的总字节数。 */
  totalBytes: number;
  /** 完整原文的总行数。 */
  totalLines: number;
  /** 实际写入的字节数；超过单文件上限时小于 totalBytes。 */
  storedBytes: number;
}

export interface ToolResultOffloadWriter {
  write(toolCallId: string, text: string): Promise<ToolResultOffloadTarget>;
}

export interface ToolResultOffloadWriterOptions {
  taskId: string;
  runId: string;
  /** 单文件写入字节上限；超出只保留前缀。 */
  maxBytes: number;
  /** 写盘前的资格复查；执行作用域撤销后抛错，迟到写入不复活目录。 */
  guard: () => Promise<void>;
  /** 由执行作用域把相对路径解析成真实路径（同时完成授权检查）。 */
  resolvePath: (relativePath: string) => Promise<string>;
}

export interface ToolResultOffloadMiddlewareOptions {
  writer: ToolResultOffloadWriter;
  maxChars: number;
}

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(SAFE_SEGMENT, "-").slice(0, MAX_SEGMENT_CHARS);
  return cleaned.length > 0 ? cleaned : fallback;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/** 取不超过字节上限的最长字符前缀；不在多字节字符中间切断。 */
export function prefixByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

export function createToolResultOffloadWriter(
  options: ToolResultOffloadWriterOptions,
): ToolResultOffloadWriter {
  const taskSegment = sanitizeSegment(options.taskId, "task");
  const runSegment = sanitizeSegment(options.runId, "run");
  return {
    async write(toolCallId, text) {
      const name = `${sanitizeSegment(toolCallId, "tool-call")}.txt`;
      const relativePath = posix.join(OFFLOAD_ROOT, taskSegment, runSegment, name);
      const totalBytes = Buffer.byteLength(text, "utf8");
      const stored = prefixByBytes(text, options.maxBytes);
      const storedBytes = Buffer.byteLength(stored, "utf8");

      await options.guard();
      const absolutePath = await options.resolvePath(relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, stored, "utf8");
      await rename(temporaryPath, absolutePath);

      return {
        relativePath,
        totalBytes,
        totalLines: countLines(text),
        storedBytes,
      };
    },
  };
}

/** 归档或删除时清掉该 Task 的外置输出目录；不保留文件名等元数据。 */
export async function removeTaskToolResultOffloads(
  rootDirectory: string,
  taskId: string,
): Promise<void> {
  await rm(join(rootDirectory, OFFLOAD_ROOT, sanitizeSegment(taskId, "task")), {
    recursive: true,
    force: true,
  });
}

export function buildToolResultOffloadNotice(
  target: ToolResultOffloadTarget,
): string {
  const truncation =
    target.storedBytes < target.totalBytes
      ? ` 写盘只保留前 ${target.storedBytes} 字节。`
      : " ";
  return `[工具输出已外置：共 ${target.totalLines} 行 ${target.totalBytes} 字节，原文见 ${target.relativePath}（相对工作目录）。${truncation}用读取工具按行区间分段查看。]`;
}

type UnknownMessage = Record<string, unknown>;

function isToolMessage(message: UnknownMessage): boolean {
  return (
    ToolMessage.isInstance(message) ||
    (typeof message.getType === "function" && message.getType() === "tool")
  );
}

function rebuildWithText(
  message: UnknownMessage,
  text: string,
): UnknownMessage {
  const rebuilt = new ToolMessage({
    content: text,
    tool_call_id: String(message.tool_call_id ?? ""),
    ...(typeof message.name === "string" ? { name: message.name } : {}),
    ...(message.additional_kwargs
      ? { additional_kwargs: message.additional_kwargs as never }
      : {}),
    ...(message.response_metadata
      ? { response_metadata: message.response_metadata as never }
      : {}),
    ...(typeof message.id === "string" ? { id: message.id } : {}),
    ...(message.status === "success" || message.status === "error"
      ? { status: message.status }
      : {}),
  });
  // artifact 是展示用的结构化副本，外置只作用于模型可见文本。
  if (message.artifact !== undefined) rebuilt.artifact = message.artifact;
  return rebuilt as unknown as UnknownMessage;
}

export function createToolResultOffloadMiddleware(
  options: ToolResultOffloadMiddlewareOptions,
): AgentMiddleware {
  const offloaded = new Set<string>();
  // 同一 run 内每次模型请求都会走一遍消息列表；已外置的调用 id 不重复写盘。
  return {
    name: "kenfutworkToolResultOffload",
    async wrapModelCall(
      request: unknown,
      handler: (req: unknown) => Promise<unknown>,
    ) {
      const messages = (request as { messages?: UnknownMessage[] }).messages;
      if (!Array.isArray(messages) || messages.length === 0)
        return handler(request);

      const next = [...messages];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || !isToolMessage(message)) continue;
        const content = message.content;
        if (typeof content !== "string") continue;
        if (content.length <= options.maxChars) continue;
        const toolCallId = String(message.tool_call_id ?? "");
        if (toolCallId.length === 0) continue;
        if (offloaded.has(toolCallId)) continue;

        const target = await options.writer.write(toolCallId, content);
        offloaded.add(toolCallId);
        next[index] = rebuildWithText(
          message,
          buildToolResultOffloadNotice(target),
        );
      }
      return handler({ ...(request as object), messages: next });
    },
  } as unknown as AgentMiddleware;
}
