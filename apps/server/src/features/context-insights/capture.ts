import {
  contextRequestHttpStatusSchema,
  contextRequestInputSchema,
  type ModelCallPurpose,
} from "@kenfutwork/shared";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { stampRetryable } from "@langchain/core/errors";
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type { ContextRequestOwner, ContextRequestWriter } from "./types.js";

async function writeCapture(write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    throw stampRetryable(error, false);
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const sdkUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  input_token_details: z
    .object({ cache_read: z.number().int().nonnegative().optional() })
    .optional(),
});

// 只保留供应商定义的停止原因，不保存任意理由文本或其他响应元数据。
const knownFinishReasons = new Set([
  "stop",
  "length",
  "tool_calls",
  "function_call",
  "content_filter",
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "safety",
  "recitation",
  "language",
  "blocklist",
  "prohibited_content",
  "spii",
  "malformed_function_call",
  "unexpected_tool_call",
  "other",
  "image_safety",
  "image_prohibited_content",
  "image_recitation",
  "no_image",
  "max_output_tokens",
  "model_context_window_exceeded",
]);

function readFinishReason(
  ...metadata: (Record<string, unknown> | undefined)[]
) {
  for (const entry of metadata) {
    const value =
      entry?.finish_reason ?? entry?.stop_reason ?? entry?.finishReason;
    if (
      typeof value === "string" &&
      knownFinishReasons.has(value.toLowerCase())
    )
      return value;
  }
  return undefined;
}

/** 排除仅供宿主使用的 artifact、响应头和计量元数据。 */
function serializeMessage(message: BaseMessage) {
  const serialized = message.toDict();
  const fields = [
    "id",
    "content",
    "name",
    "tool_call_id",
    "tool_calls",
    "invalid_tool_calls",
    "additional_kwargs",
  ];
  const data: Record<string, unknown> = Object.fromEntries(
    Object.entries(serialized.data).filter(
      ([key, value]) => fields.includes(key) && value !== undefined,
    ),
  );
  const status = ToolMessage.isInstance(message) ? message.status : undefined;
  if (status === "error" || status === "success") data.status = status;
  return { type: serialized.type, data };
}

/** 只选择实际模型输入；不读取模型序列化参数、网络头或连接配置。 */
export function createContextRequestCallbacks(
  writer: ContextRequestWriter,
  owner: ContextRequestOwner,
  purpose: ModelCallPurpose = "agent",
): BaseCallbackHandler {
  const handler = BaseCallbackHandler.fromMethods({
    async handleChatModelStart(
      _model,
      batches,
      id,
      _parent,
      extra,
      _tags,
      metadata,
    ) {
      const parameters = object(extra?.invocation_params);
      const model =
        parameters?.model ?? parameters?.model_name ?? metadata?.ls_model_name;
      const input = contextRequestInputSchema.parse(
        JSON.parse(
          JSON.stringify({
            messages: batches.map((messages) => messages.map(serializeMessage)),
            tools: Array.isArray(parameters?.tools) ? parameters.tools : null,
            model: typeof model === "string" ? model : null,
          }),
        ),
      );
      await writeCapture(() =>
        writer.start({
          purpose,
          id,
          owner,
          input,
          startedAt: new Date().toISOString(),
        }),
      );
    },
    async handleLLMEnd(result, id) {
      const generations = result.generations.flat();
      const replies = generations.flatMap((generation) =>
        "message" in generation && AIMessage.isInstance(generation.message)
          ? [
              {
                message: generation.message,
                finishReason: readFinishReason(
                  generation.generationInfo,
                  generation.message.response_metadata,
                ),
              },
            ]
          : [],
      );
      const observed = replies.flatMap(({ message }) => {
        const value = object(message)?.usage_metadata;
        return value == null ? [] : [sdkUsageSchema.parse(value)];
      });
      const usage =
        observed.length > 0 && observed.length === replies.length
          ? {
              inputTokens: observed.reduce(
                (sum, item) => sum + item.input_tokens,
                0,
              ),
              outputTokens: observed.reduce(
                (sum, item) => sum + item.output_tokens,
                0,
              ),
              ...(observed.every(
                (item) => item.input_token_details?.cache_read !== undefined,
              )
                ? {
                    cachedInputTokens: observed.reduce(
                      (sum, item) =>
                        sum + (item.input_token_details?.cache_read ?? 0),
                      0,
                    ),
                  }
                : {}),
            }
          : null;
      await writeCapture(() =>
        writer.finish({
          id,
          owner,
          endedAt: new Date().toISOString(),
          status: "completed",
          output: replies.map(({ message, finishReason }) => {
            const serialized = serializeMessage(message);
            if (finishReason !== undefined)
              serialized.data.finishReason = finishReason;
            return serialized;
          }),
          usage,
        }),
      );
    },
    async handleLLMError(error, id) {
      const status = error.name === "AbortError" ? "cancelled" : "failed";
      // 只读取 SDK 暴露的数字状态，不解析错误消息或响应正文。
      const sdkError = object(error);
      const httpStatus = contextRequestHttpStatusSchema.safeParse(
        sdkError?.status ?? sdkError?.statusCode,
      );
      await writeCapture(() =>
        writer.finish({
          id,
          owner,
          endedAt: new Date().toISOString(),
          status,
          ...(status === "failed" && httpStatus.success
            ? { httpStatus: httpStatus.data }
            : {}),
          // 错误原文可能包含服务商请求信息，不进入上下文正文记录。
          output: null,
          usage: null,
        }),
      );
    },
  });
  handler.raiseError = true;
  handler.awaitHandlers = true;
  return handler;
}
