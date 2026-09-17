import type { StreamEvent, ToolArtifact } from "@kenfutwork/shared";
import { imageArtifactSchema, videoArtifactSchema } from "@kenfutwork/shared";
import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import {
  AIMessageChunk as AIMessageChunkClass,
  AIMessage as AIMessageClass,
  ToolMessage as ToolMessageClass,
} from "@langchain/core/messages";

import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { CompactionPlan } from "./auto-compact.js";
import {
  type CompositionPart,
  measureMessages,
  mergeComposition,
} from "./prompt-composition.js";
import {
  StreamIdleTimeoutError,
  withStreamIdleGuard,
} from "./stream-idle-guard.js";

/**
 * Shape of a LangChain v2 stream event from `streamEvents()`.
 */
type LangChainStreamEvent = {
  event: string;
  name?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  run_id?: string;
  tags?: string[];
};

type AdaptDeepAgentStreamOptions = {
  conversationId: string;
  now?: () => string;
  /** 用量采集点（§4.5）：chunk 携带 usage_metadata（cumulative）时回调最新累计值。 */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    /** 上游上报的「命中缓存的输入 token」；上游不报时为 undefined。 */
    cachedInputTokens?: number | undefined;
  }) => void;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
  /**
   * 工具 schema 的分段量（runtime 在装配后量好传入）：MCP 工具 / 系统工具。
   * 消息侧分段由本适配器在 `on_chat_model_start` 时量，两边合并成一条 composition。
   */
  toolComposition?: readonly CompositionPart[] | undefined;
  stream: AsyncIterable<LangChainStreamEvent | unknown>;
  /**
   * 空闲看门狗阈值（毫秒，见 `stream-idle-guard.ts`）：上游停滞超过该时长即
   * 有界失败。缺省用库内默认值。
   */
  idleTimeoutMs?: number;
  /** 空闲超时触发时调用（中止底层请求、释放上游连接）。 */
  abortRun?: () => void;
  /**
   * 自动压缩口径（传了才检测压缩、才可能发 `run.compacted`）：
   * 与 agent 装配用的是同一份（见 agent/auto-compact.ts）。
   */
  autoCompact?: CompactionPlan | undefined;
};

/**
 * Sub-agent parent tool names whose inner tools should have their
 * artifacts suppressed (the parent re-emits them with placement).
 */
const SUB_AGENT_PARENT_TOOLS = new Set(["video_generate"]);
/** Inner tools that may be suppressed when running inside a sub-agent. */
const INNER_SUB_AGENT_TOOLS = new Set(["generate_video"]);

export async function* adaptDeepAgentStream(
  options: AdaptDeepAgentStreamOptions,
): AsyncGenerator<StreamEvent> {
  const now = options.now ?? (() => new Date().toISOString());
  const seenCompletedToolCalls = new Set<string>();
  const seenStreamedMessageIds = new Set<string>();
  const seenStartedToolCalls = new Set<string>();
  /** Tracks active sub-agent parent runs so we can detect nested inner tools. */
  const activeSubAgentRuns = new Set<string>();
  /** 上一次下发 run.usage 时的 input token 数（同一提示词大小不重复发）。 */
  let lastUsageInputTokens = -1;
  /** 本轮是否已报过「上下文已压缩」（每轮最多一条）。 */
  let compactionReported = false;
  /**
   * 本轮 run 的累计用量（跨模型调用求和），用于「平均缓存命中率」。
   *
   * 口径：命中率 = 累计命中缓存输入 ÷ 累计输入（**按 token 加权**），而不是各次百分比的
   * 算术平均——一轮里短调用多时后者会虚高。每次模型调用的用量在 chunk 上会反复出现同一
   * 份（调用内累计值），故只在「输入侧变化 = 新调用开始」时把上一轮调用结算进累计。
   */
  /**
   * 分类占比（R4-1）：在 on_chat_model_start 时按模型**实际输入**量一次，
   * 与 runtime 传来的工具分段合并，随 run.usage 下发。**字符数口径**（不是 token 拆分）。
   */
  let composition: CompositionPart[] | undefined;

  let completedCallsInput = 0;
  let completedCallsCached = 0;
  let sawCachedFromUpstream = false;
  let lastCallInput: number | null = null;
  let lastCallCached: number | undefined;

  /** 当前累计（含正在进行的那次调用），供 run.usage 下发。 */
  const runTotals = (currentInput: number, currentCached?: number) => {
    const runInputTokens = completedCallsInput + currentInput;
    const cachedKnown = sawCachedFromUpstream || currentCached !== undefined;
    if (!cachedKnown) {
      return { runInputTokens };
    }
    return {
      runInputTokens,
      runCachedInputTokens: completedCallsCached + (currentCached ?? 0),
    };
  };

  yield {
    conversationId: options.conversationId,
    runId: options.runId,
    sessionId: options.sessionId,
    timestamp: now(),
    type: "run.started",
  };

  if (options.signal?.aborted) {
    yield canceledEvent(options.runId, now);
    return;
  }

  try {
    // 空闲看门狗：上游停滞不再是无限挂起，且中止信号在等待期即可生效
    for await (const rawEvent of withStreamIdleGuard(options.stream, {
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idleMs: options.idleTimeoutMs }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.abortRun ? { onIdle: options.abortRun } : {}),
    })) {
      if (options.signal?.aborted) {
        yield canceledEvent(options.runId, now);
        return;
      }

      if (!isStreamEvent(rawEvent)) {
        continue;
      }

      const evt = rawEvent;

      // 模型输入就绪：量一次分类占比（系统提示词 / 消息 / 技能 …）
      if (evt.event === "on_chat_model_start") {
        const data = (evt as { data?: unknown }).data as
          | { input?: { messages?: unknown } }
          | undefined;
        const raw = data?.input?.messages;
        const groups = Array.isArray(raw) ? raw : [];
        // 有的版本给 [[messages]]（批量），有的给 [messages]——两种都摊平
        const flat = groups.flatMap((group) =>
          Array.isArray(group) ? group : [group],
        );
        composition = mergeComposition([
          ...measureMessages(flat),
          ...(options.toolComposition ?? []),
        ]);

        /**
         * 自动压缩发生了？中间件把被压掉的旧消息换成一条摘要消息
         * （HumanMessage + `additional_kwargs.lc_source === "summarization"`），
         * 它一定出现在**下一次模型调用的输入里**——这是唯一可靠、又不依赖私有 state 通道的观测点。
         * 每轮最多报一次（用户知道「刚才压过一次」就够了）。
         */
        if (!compactionReported && options.autoCompact) {
          const compacted = flat.some((message) => {
            const kwargs = (message as { additional_kwargs?: unknown })
              ?.additional_kwargs;
            return (
              typeof kwargs === "object" &&
              kwargs !== null &&
              (kwargs as { lc_source?: unknown }).lc_source === "summarization"
            );
          });
          if (compacted) {
            compactionReported = true;
            yield {
              type: "run.compacted" as const,
              runId: options.runId,
              triggerTokens: options.autoCompact.trigger.value,
              triggerSource: options.autoCompact.source,
              keepMessages: options.autoCompact.keep.value,
              timestamp: now(),
            };
          }
        }
        continue;
      }

      // Per-token streaming from the chat model
      if (evt.event === "on_chat_model_stream") {
        const chunk = evt.data?.chunk;
        if (!chunk) continue;

        // Skip chunks that are tool calls (no text to emit)
        if (
          AIMessageChunkClass.isInstance(chunk) ||
          AIMessageClass.isInstance(chunk)
        ) {
          const msg = chunk as AIMessageChunk | AIMessage;
          if ((msg.tool_calls?.length ?? 0) > 0) continue;
          const usageMeta = (
            msg as unknown as {
              usage_metadata?: {
                input_tokens?: number;
                output_tokens?: number;
                input_token_details?: { cache_read?: number };
              };
            }
          ).usage_metadata;
          if (usageMeta) {
            const inputTokens = usageMeta.input_tokens ?? 0;
            const outputTokens = usageMeta.output_tokens ?? 0;
            const cachedRaw = usageMeta.input_token_details?.cache_read;
            const cachedInputTokens =
              typeof cachedRaw === "number" && cachedRaw >= 0
                ? cachedRaw
                : undefined;
            options.onUsage?.({
              inputTokens,
              outputTokens,
              ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
            });
            // 用量快照发给前端（上下文容量/缓存命中浮层）。**只在输入侧变化时发**：
            // input_tokens 是每次模型调用的提示词大小（一轮里随工具结果增长），
            // output_tokens 则每个 chunk 都在涨——逐 chunk 下发会把 WS 灌满。
            if (inputTokens !== lastUsageInputTokens) {
              // 输入侧变了 = 这是一次新的模型调用：把上一次调用结算进累计
              if (lastCallInput !== null) {
                completedCallsInput += lastCallInput;
                if (lastCallCached !== undefined) {
                  completedCallsCached += lastCallCached;
                  sawCachedFromUpstream = true;
                }
              }
              lastCallInput = inputTokens;
              lastCallCached = cachedInputTokens;
              lastUsageInputTokens = inputTokens;
              yield {
                type: "run.usage" as const,
                runId: options.runId,
                inputTokens,
                outputTokens,
                ...(cachedInputTokens === undefined
                  ? {}
                  : { cachedInputTokens }),
                ...runTotals(inputTokens, cachedInputTokens),
                ...(composition && composition.length > 0
                  ? { composition }
                  : {}),
                timestamp: now(),
              };
            }
          }
        }

        const messageId =
          (chunk as { id?: string }).id ?? `message_${options.runId}`;

        const content = (chunk as { content: unknown }).content;

        // Handle array content (e.g. Gemini thinking + text blocks)
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "thinking" &&
              "thinking" in part &&
              typeof part.thinking === "string" &&
              part.thinking
            ) {
              yield {
                type: "thinking.delta" as const,
                runId: options.runId,
                messageId,
                delta: part.thinking,
                timestamp: now(),
              };
            } else {
              const text =
                typeof part === "string"
                  ? part
                  : part &&
                      typeof part === "object" &&
                      "text" in part &&
                      typeof (part as { text: unknown }).text === "string"
                    ? (part as { text: string }).text
                    : "";
              if (text) {
                seenStreamedMessageIds.add(messageId);
                yield {
                  type: "message.delta" as const,
                  runId: options.runId,
                  messageId,
                  delta: text,
                  timestamp: now(),
                };
              }
            }
          }
          continue;
        }

        // String content (normal text)
        const delta = extractChunkText(chunk);
        if (!delta) continue;

        seenStreamedMessageIds.add(messageId);
        yield {
          delta,
          messageId,
          runId: options.runId,
          timestamp: now(),
          type: "message.delta",
        };
        continue;
      }

      // Fallback: complete message from non-streaming model (on_chat_model_end)
      if (evt.event === "on_chat_model_end") {
        const output = evt.data?.output;
        if (!output) continue;

        if (
          AIMessageClass.isInstance(output) ||
          AIMessageChunkClass.isInstance(output)
        ) {
          const msg = output as AIMessage | AIMessageChunk;
          const messageId = msg.id ?? `message_${options.runId}`;

          // Skip if this was a tool call message (tool lifecycle via on_tool_*)
          if ((msg.tool_calls?.length ?? 0) > 0) continue;
          if (seenStreamedMessageIds.has(messageId)) continue;

          const delta = extractChunkText(msg);
          if (!delta) continue;

          yield {
            delta,
            messageId,
            runId: options.runId,
            timestamp: now(),
            type: "message.delta",
          };
        }
        continue;
      }

      // Tool execution started
      if (evt.event === "on_tool_start") {
        const toolName = evt.name ?? "unknown_tool";
        // Use run_id as the tool call identifier for consistent start/end pairing
        const toolCallId = readString(evt.run_id) ?? `tool_${Date.now()}`;

        if (seenStartedToolCalls.has(toolCallId)) continue;
        seenStartedToolCalls.add(toolCallId);

        // Extract tool input arguments for frontend display
        const rawInput = evt.data?.input;
        const toolInput =
          rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
            ? (rawInput as Record<string, unknown>)
            : undefined;

        // Track sub-agent parent tools so we can detect nested inner calls.
        if (SUB_AGENT_PARENT_TOOLS.has(toolName)) {
          activeSubAgentRuns.add(toolCallId);
        }

        yield {
          runId: options.runId,
          timestamp: now(),
          toolCallId,
          toolName,
          ...(toolInput ? { input: toolInput } : {}),
          type: "tool.started",
        };
        continue;
      }

      // Tool execution completed
      if (evt.event === "on_tool_end") {
        const toolName = evt.name ?? "unknown_tool";
        // Use run_id for consistent pairing with on_tool_start
        const toolCallId = readString(evt.run_id) ?? `tool_${Date.now()}`;

        if (seenCompletedToolCalls.has(toolCallId)) continue;
        seenCompletedToolCalls.add(toolCallId);

        const output = evt.data?.output;

        // When an inner tool runs inside an active sub-agent parent,
        // suppress its artifacts because the parent will re-emit them.
        const isNestedInSubAgent =
          INNER_SUB_AGENT_TOOLS.has(toolName) && activeSubAgentRuns.size > 0;
        const extractedArtifacts = isNestedInSubAgent
          ? undefined
          : extractArtifacts(output);
        const extractedOutput = extractOutput(
          output,
          (extractedArtifacts?.length ?? 0) > 0,
        );
        yield {
          output: extractedOutput,
          outputSummary: summarizeOutput(output),
          artifacts: extractedArtifacts,
          runId: options.runId,
          timestamp: now(),
          toolCallId,
          toolName,
          type: "tool.completed",
        };

        // Clean up sub-agent parent tracking after its tool.completed is emitted.
        if (SUB_AGENT_PARENT_TOOLS.has(toolName)) {
          activeSubAgentRuns.delete(toolCallId);
        }

        if (toolName === "manipulate_canvas") {
          yield {
            type: "canvas.sync" as const,
            runId: options.runId,
            timestamp: now(),
          } satisfies StreamEvent;
        }
      }

      /**
       * 工具抛错（LangChain 发 on_tool_error，不发 on_tool_end）。
       *
       * 没有这一支时，工具块在客户端永远停在 `status: "running"`——用户看到
       * 一个转圈的工具调用，既不知道它失败了、也不知道为什么失败（GUI 实测：
       * web_search 打真实秘塔端点、Key 无效，块停在 running，run 只报通用文案）。
       * 用 `tool.completed` 收尾（契约里工具块只有 running/completed 两态），
       * 把可读原因放进 outputSummary，失败的块因此变成「有结论」而不是「卡住」。
       */
      if (evt.event === "on_tool_error") {
        const toolName = evt.name ?? "unknown_tool";
        const toolCallId = readString(evt.run_id) ?? `tool_${Date.now()}`;
        if (seenCompletedToolCalls.has(toolCallId)) continue;
        seenCompletedToolCalls.add(toolCallId);

        const reason = describeToolError(evt.data?.error);
        yield {
          output: { error: reason },
          outputSummary: `失败：${reason}`,
          runId: options.runId,
          timestamp: now(),
          toolCallId,
          toolName,
          type: "tool.completed",
        };

        if (SUB_AGENT_PARENT_TOOLS.has(toolName)) {
          activeSubAgentRuns.delete(toolCallId);
        }
      }
    }
  } catch (error) {
    /**
     * 停滞优先于取消：看门狗触发时会中止同一信号（释放上游连接），故
     * `signal.aborted` 此时也为真——若先判取消，上游故障会被误报成
     * 「用户取消」（E2E 实测踩中：run.canceled 而非 run.failed）。
     */
    const idleTimedOut = error instanceof StreamIdleTimeoutError;
    if (!idleTimedOut && (isAbortError(error) || options.signal?.aborted)) {
      yield canceledEvent(options.runId, now);
      return;
    }

    // Log full error detail server-side
    console.error(
      `[stream-adapter] Stream error for run ${options.runId}:`,
      error,
    );

    yield {
      error: {
        code: "run_failed",
        message: sanitizeErrorForClient(error),
      },
      runId: options.runId,
      timestamp: now(),
      type: "run.failed",
    };
    return;
  }

  // 看门狗因中止信号收场（而非上游正常结束）：仍按「取消」上报
  if (options.signal?.aborted) {
    yield canceledEvent(options.runId, now);
    return;
  }

  yield {
    runId: options.runId,
    timestamp: now(),
    type: "run.completed",
  };
}

function canceledEvent(runId: string, now: () => string): StreamEvent {
  return {
    runId,
    timestamp: now(),
    type: "run.canceled",
  };
}

/**
 * LangChain sub-agent tools return a Command object whose real payload
 * lives inside update.messages[0].kwargs.content (a JSON string).
 * Unwrap it so extractArtifacts can find url/placement at the top level.
 */
function unwrapCommandOutput(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (record.lg_name !== "Command") return record;
  try {
    const messages = (record.update as { messages?: unknown })?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return record;
    const content = messages[0]?.kwargs?.content ?? messages[0]?.content;
    if (typeof content !== "string") return record;
    const inner = JSON.parse(content);
    if (inner && typeof inner === "object")
      return inner as Record<string, unknown>;
  } catch {
    // fall through
  }
  return record;
}

const ARTIFACT_KEYS = new Set([
  "url",
  "imageUrl",
  "screenshotUrl",
  "videoUrl",
  "durationSeconds",
  "mimeType",
  "width",
  "height",
  "placement",
]);
const OUTPUT_SIZE_LIMIT = 10240; // 10KB

function extractOutput(
  output: unknown,
  hasArtifacts: boolean,
): Record<string, unknown> | undefined {
  let text = "";
  if (ToolMessageClass.isInstance(output)) {
    text = extractChunkText(output);
  } else if (typeof output === "string") {
    text = output;
  } else if (output && typeof output === "object") {
    text = JSON.stringify(output);
  }

  const parsed = tryParseJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;

  const unwrapped = unwrapCommandOutput(parsed as Record<string, unknown>);

  // Strip artifact keys if artifacts were extracted
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(unwrapped)) {
    if (hasArtifacts && ARTIFACT_KEYS.has(key)) continue;
    result[key] = value;
  }

  // Skip if empty after stripping
  if (Object.keys(result).length === 0) return undefined;

  // Size limit check
  const serialized = JSON.stringify(result);
  if (serialized.length > OUTPUT_SIZE_LIMIT) return undefined;

  return result;
}

function extractArtifacts(output: unknown): ToolArtifact[] | undefined {
  let text = "";
  if (ToolMessageClass.isInstance(output)) {
    text = extractChunkText(output);
  } else if (typeof output === "string") {
    text = output;
  } else if (output && typeof output === "object") {
    text = JSON.stringify(output);
  }

  const parsed = tryParseJson(text);
  if (!parsed || typeof parsed !== "object") return undefined;

  // If this is a LangChain Command object (from sub-agent), dig into
  // update.messages[0].kwargs.content to find the real structured response.
  const unwrapped = unwrapCommandOutput(parsed as Record<string, unknown>);

  const artifacts: ToolArtifact[] = [];
  const record = unwrapped;

  // New format: sub-agent structured response with url + placement
  if (typeof record.url === "string" && record.url.length > 0) {
    const candidate: Record<string, unknown> = {
      type: "image" as const,
      url: record.url,
      mimeType: (record.mimeType as string) ?? "image/png",
      width: (record.placement as { width?: number } | undefined)?.width ?? 512,
      height:
        (record.placement as { height?: number } | undefined)?.height ?? 512,
    };
    if (typeof record.title === "string" && record.title.length > 0) {
      candidate.title = record.title;
    }
    if (record.placement && typeof record.placement === "object") {
      candidate.placement = record.placement;
    }
    const result = imageArtifactSchema.safeParse(candidate);
    if (result.success) {
      artifacts.push(result.data);
    }
  }

  // Legacy format: direct tool response with imageUrl
  if (artifacts.length === 0 && typeof record.imageUrl === "string") {
    const candidate: Record<string, unknown> = {
      type: "image" as const,
      url: record.imageUrl,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
    };
    if (typeof record.title === "string" && record.title.length > 0) {
      candidate.title = record.title;
    }
    if (record.placement && typeof record.placement === "object") {
      candidate.placement = record.placement;
    }
    const result = imageArtifactSchema.safeParse(candidate);
    if (result.success) {
      artifacts.push(result.data);
    }
  }

  // Screenshot format: tool response with screenshotUrl
  if (artifacts.length === 0 && typeof record.screenshotUrl === "string") {
    const candidate: Record<string, unknown> = {
      type: "image" as const,
      url: record.screenshotUrl,
      mimeType: "image/png",
      width: typeof record.width === "number" ? record.width : 1024,
      height: typeof record.height === "number" ? record.height : 1024,
    };
    const result = imageArtifactSchema.safeParse(candidate);
    if (result.success) {
      artifacts.push(result.data);
    }
  }

  // Video format: tool response with videoUrl from generate_video
  if (typeof record.videoUrl === "string" && record.videoUrl.length > 0) {
    const candidate: Record<string, unknown> = {
      type: "video" as const,
      url: record.videoUrl,
      mimeType: (record.mimeType as string) ?? "video/mp4",
      width: typeof record.width === "number" ? record.width : 1280,
      height: typeof record.height === "number" ? record.height : 720,
    };
    if (typeof record.durationSeconds === "number") {
      candidate.durationSeconds = record.durationSeconds;
    }
    // Prefer LLM-authored title, then original prompt, then technical summary
    if (typeof record.title === "string" && record.title.length > 0) {
      candidate.title = record.title.slice(0, 120);
    } else if (typeof record.prompt === "string") {
      candidate.title = record.prompt.slice(0, 200);
    } else if (typeof record.summary === "string") {
      candidate.title = record.summary.slice(0, 100);
    }
    if (record.placement && typeof record.placement === "object") {
      candidate.placement = record.placement;
    }
    const result = videoArtifactSchema.safeParse(candidate);
    if (result.success) {
      artifacts.push(result.data);
    }
  }

  return artifacts.length > 0 ? artifacts : undefined;
}

/**
 * Extract text from a chat model stream chunk.
 */
function extractChunkText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";

  // AIMessageChunk / AIMessage with string content
  if ("content" in chunk) {
    const content = (chunk as { content: unknown }).content;
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof part.text === "string"
          ) {
            return part.text;
          }
          return "";
        })
        .join("");
    }
  }

  return "";
}

function summarizeOutput(output: unknown): string | undefined {
  if (ToolMessageClass.isInstance(output)) {
    const textContent = extractChunkText(output);
    const parsed = tryParseJson(textContent);
    if (
      parsed &&
      typeof parsed === "object" &&
      "summary" in parsed &&
      typeof parsed.summary === "string"
    ) {
      return parsed.summary;
    }
    return textContent || undefined;
  }

  if (output && typeof output === "object") {
    const serialized = JSON.stringify(output);
    const parsed = tryParseJson(serialized);
    if (
      parsed &&
      typeof parsed === "object" &&
      "summary" in parsed &&
      typeof parsed.summary === "string"
    ) {
      return parsed.summary;
    }
    return serialized.length > 200
      ? `${serialized.slice(0, 197)}...`
      : serialized;
  }

  if (typeof output === "string") return output || undefined;
  return undefined;
}

function tryParseJson(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "This operation was aborted")
  );
}

/**
 * 从工具错误里取一句可读原因（面向用户）。
 *
 * LangChain 会把工具抛的错包一层（`ToolNode` 的包装错误 + `cause` 链），直接取
 * `error.message` 有时只剩包装文案；故沿 `cause` 链找**最深**的一条消息。
 *
 * 另外 LangChain 的 `message` 常把堆栈一起带上（`Error.message + "\n at …"`），
 * 直接透出会把内部路径摊给用户看——只取首行，并按长度收敛（工具报错都短；
 * 超过 200 字的当噪声，退回顶层消息）。
 */
function describeToolError(error: unknown): string {
  const firstLine = (value: unknown): string => {
    const raw = value instanceof Error ? value.message : String(value ?? "");
    return (raw.split("\n")[0] ?? "").trim();
  };

  const messages: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 5) {
    const line = firstLine(current);
    if (line) messages.push(line);
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  const deepest = messages[messages.length - 1];
  const readable =
    deepest && deepest.length <= 200
      ? deepest
      : (messages[0] ?? "工具执行失败");
  return readable.length > 200 ? `${readable.slice(0, 200)}…` : readable;
}

function isStreamEvent(value: unknown): value is LangChainStreamEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    "event" in value &&
    typeof (value as { event: unknown }).event === "string"
  );
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
