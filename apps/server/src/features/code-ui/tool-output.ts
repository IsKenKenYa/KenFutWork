import type { StreamEvent } from "@kenfutwork/shared";

type ToolCompleted = Extract<StreamEvent, { type: "tool.completed" }>;

/**
 * 工具卡展示与原文分页共用的正文来源：TaskOutput 的 canonical 页已受字节预算
 * 约束，原 UI 不能把模型预览冒充完整分页。
 */
export function resolveToolOutputText(event: ToolCompleted): string {
  return event.toolName === "TaskOutput" && event.output
    ? JSON.stringify(event.output)
    : (event.outputText ??
        (event.output
          ? JSON.stringify(event.output)
          : (event.outputSummary ?? "")));
}

/** 按 UTF-8 字节裁切，按码点推进，避免切断代理对。 */
function clipUtf8(text: string, maxBytes: number, fromEnd: boolean): string {
  if (maxBytes <= 0) return "";
  const chars = Array.from(text);
  const keep: string[] = [];
  let bytes = 0;
  const step = fromEnd ? -1 : 1;
  let index = fromEnd ? chars.length - 1 : 0;
  while (index >= 0 && index < chars.length) {
    const char = chars[index]!;
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    keep.push(char);
    index += step;
  }
  return fromEnd ? keep.reverse().join("") : keep.join("");
}

/**
 * 终态工具输出超过预览预算时保留头尾，并登记 truncated.ref 指向原始事件；
 * 事件本身不截断，读取路由按 ref 分页取回全文。
 */
export function previewToolOutput(
  text: string,
  limitBytes: number,
  ref: string,
): { text: string; truncated?: { totalBytes: number; ref: string } } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limitBytes) return { text };
  const marker = "\n…\n";
  const budget = Math.max(0, limitBytes - Buffer.byteLength(marker, "utf8"));
  const head = clipUtf8(text, Math.ceil(budget / 2), false);
  const tail = clipUtf8(text, Math.floor(budget / 2), true);
  return {
    text: `${head}${marker}${tail}`,
    truncated: { totalBytes, ref },
  };
}

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** 原文引用固定为 runId/toolCallId；格式不符直接拒绝，不做猜测。 */
export function parseToolOutputRef(
  ref: string,
): { runId: string; toolCallId: string } | null {
  const parts = ref.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { runId: parts[0], toolCallId: parts[1] };
}

/**
 * 只读分页按字节窗口返回原文；起止都对齐到 UTF-8 码点边界，客户端由
 * nextOffset 续读。offset 越界时返回空窗口，不捏造前文。
 */
export function readUtf8Window(
  text: string,
  offset: number,
  limit: number,
): { text: string; totalBytes: number; nextOffset: number | null } {
  const bytes = Buffer.from(text, "utf8");
  const totalBytes = bytes.length;
  let start = Math.min(Math.max(0, offset), totalBytes);
  while (start > 0 && start < totalBytes && isContinuationByte(bytes[start]!))
    start += 1;
  let end = Math.min(start + limit, totalBytes);
  while (end > start && end < totalBytes && isContinuationByte(bytes[end]!))
    end -= 1;
  return {
    text: bytes.subarray(start, end).toString("utf8"),
    totalBytes,
    nextOffset: end < totalBytes ? end : null,
  };
}
