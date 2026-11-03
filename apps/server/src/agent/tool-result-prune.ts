import { ToolMessage } from "@langchain/core/messages";
import type { AgentMiddleware } from "langchain";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";

/**
 * 工具结果内联修剪：模型请求前的最后一道文本预算。
 *
 * 定位：只改**发给模型的那一份消息**，不改运行事件、不改界面展示、不改持久状态。
 * 大段命令输出、整文件读取与第三方 MCP 结果在长会话里会一直占住上下文，
 * 这里按字符预算保留头尾、写入省略标记，压缩触发线因此看到更小的请求。
 *
 * 边界：JSON 形状的结果不做修剪（截断会破坏可解析性）；预算来自治理设置
 * `processPreviewMaxChars`（与进程输出模型预览同一预算，不另立字面量）。
 */

const NOTICE_RESERVE_CHARS = 160;
const HEAD_RATIO = 0.6;
const MIN_BUDGET_CHARS = 200;

export interface PruneTextResult {
  text: string;
  pruned: boolean;
  removedChars: number;
}

function isJsonPayload(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function sliceHead(text: string, size: number): string {
  if (size <= 0) return "";
  const sliced = text.slice(0, size);
  const last = sliced.charCodeAt(sliced.length - 1);
  // 高位代理单独出现会拆坏 emoji 与其它星形平面字符，向回收一位。
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function sliceTail(text: string, size: number): string {
  if (size <= 0) return "";
  const sliced = text.slice(text.length - size);
  const first = sliced.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? sliced.slice(1) : sliced;
}

export function pruneToolResultText(
  text: string,
  maxChars: number,
): PruneTextResult {
  if (!Number.isFinite(maxChars) || maxChars < MIN_BUDGET_CHARS)
    return { text, pruned: false, removedChars: 0 };
  if (text.length <= maxChars) return { text, pruned: false, removedChars: 0 };
  if (isJsonPayload(text)) return { text, pruned: false, removedChars: 0 };

  const budget = Math.max(0, maxChars - NOTICE_RESERVE_CHARS);
  const headSize = Math.floor(budget * HEAD_RATIO);
  const tailSize = budget - headSize;
  const head = sliceHead(text, headSize);
  const tail = sliceTail(text, tailSize);
  const removedChars = text.length - head.length - tail.length;
  const notice = `\n\n[工具输出中间部分已省略 ${removedChars} 字符，原文共 ${text.length} 字符；需要完整内容时请缩小查询范围或分页读取]\n\n`;
  return { text: `${head}${notice}${tail}`, pruned: true, removedChars };
}

type UnknownMessage = Record<string, unknown>;

function isToolMessage(message: UnknownMessage): boolean {
  return (
    ToolMessage.isInstance(message) ||
    (typeof message.getType === "function" && message.getType() === "tool")
  );
}

function pruneMessage(message: UnknownMessage, maxChars: number): UnknownMessage {
  if (!isToolMessage(message)) return message;
  const content = message.content;
  if (typeof content !== "string") return message;
  const result = pruneToolResultText(content, maxChars);
  if (!result.pruned) return message;
  const rebuilt = new ToolMessage({
    content: result.text,
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
  // artifact 是展示用的结构化副本，修剪只作用于模型可见文本。
  if (message.artifact !== undefined) rebuilt.artifact = message.artifact;
  return rebuilt as unknown as UnknownMessage;
}

const IMAGE_PART_TYPES = new Set(["image_url", "image", "input_image"]);
const IMAGE_OMITTED_NOTICE =
  "[较早的图片已省略：只向模型发送最近几张图片；需要重新查看时请再次打开或读取该图片]";

function isImagePart(part: unknown): boolean {
  return (
    typeof part === "object" &&
    part !== null &&
    IMAGE_PART_TYPES.has(String((part as { type?: unknown }).type))
  );
}

function replaceContent(
  message: UnknownMessage,
  content: unknown[],
): UnknownMessage {
  const rebuilt = Object.assign(
    Object.create(Object.getPrototypeOf(message)) as UnknownMessage,
    message,
  );
  rebuilt.content = content;
  return rebuilt;
}

/**
 * 旧图片卸载：从最新消息往回数，只保留最近 `keepRecentImages` 张图片；
 * 更早的图片换成文字占位。只改发给模型的副本，界面与持久事件保留原图。
 * 图片可能落在人类、模型或工具消息里，故对所有消息的结构化内容生效。
 */
export function unloadRecentImages(
  messages: UnknownMessage[],
  keepRecentImages: number,
): UnknownMessage[] {
  if (!Number.isFinite(keepRecentImages) || keepRecentImages < 0)
    return messages;
  let remaining = Math.max(0, Math.floor(keepRecentImages));
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !Array.isArray(message.content)) continue;
    const parts = message.content as unknown[];
    const next: unknown[] = [];
    let changed = false;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (!isImagePart(part)) {
        next.unshift(part);
        continue;
      }
      if (remaining > 0) {
        remaining -= 1;
        next.unshift(part);
      } else {
        next.unshift({ type: "text", text: IMAGE_OMITTED_NOTICE });
        changed = true;
      }
    }
    if (changed) result[index] = replaceContent(message, next);
  }
  return result;
}

export function createToolResultPruneMiddleware(
  maxChars: number,
  keepRecentImages: number = AGENT_GOVERNANCE_DEFAULTS.contextKeepRecentImages,
): AgentMiddleware {
  return {
    name: "kenfutworkToolResultPrune",
    wrapModelCall(
      request: unknown,
      handler: (req: unknown) => Promise<unknown>,
    ) {
      const messages = (request as { messages?: UnknownMessage[] }).messages;
      if (!Array.isArray(messages) || messages.length === 0)
        return handler(request);
      const imagesUnloaded = unloadRecentImages(messages, keepRecentImages);
      const prunedMessages = imagesUnloaded.map((message) =>
        pruneMessage(message, maxChars),
      );
      return handler({ ...(request as object), messages: prunedMessages });
    },
  } as unknown as AgentMiddleware;
}
