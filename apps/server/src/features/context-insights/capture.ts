import { contextRequestInputSchema } from "@kenfutwork/shared";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ContextRequestOwner, ContextRequestWriter } from "./types.js";

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
  return {
    type: serialized.type,
    data: Object.fromEntries(
      Object.entries(serialized.data).filter(
        ([key, value]) => fields.includes(key) && value !== undefined,
      ),
    ),
  };
}

/** 只选择实际模型输入；不读取模型序列化参数、网络头或连接配置。 */
export function createContextRequestCallbacks(
  writer: ContextRequestWriter,
  owner: ContextRequestOwner,
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
      await writer.start({
        id,
        owner,
        input,
        startedAt: new Date().toISOString(),
      });
    },
    async handleLLMEnd(result, id) {
      const generations = result.generations.flat();
      const messages: AIMessage[] = generations.flatMap((generation) =>
        "message" in generation && AIMessage.isInstance(generation.message)
          ? [generation.message]
          : [],
      );
      const observed = messages.flatMap((message) => {
        const value = object(message)?.usage_metadata;
        return value == null ? [] : [sdkUsageSchema.parse(value)];
      });
      const usage =
        observed.length > 0 && observed.length === messages.length
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
      await writer.finish({
        id,
        owner,
        endedAt: new Date().toISOString(),
        status: "completed",
        output: messages.map(serializeMessage),
        usage,
      });
    },
    async handleLLMError(error, id) {
      await writer.finish({
        id,
        owner,
        endedAt: new Date().toISOString(),
        status: error.name === "AbortError" ? "cancelled" : "failed",
        // 错误原文可能包含服务商请求信息，不进入上下文正文记录。
        output: null,
        usage: null,
      });
    },
  });
  handler.raiseError = true;
  handler.awaitHandlers = true;
  return handler;
}
