import { AsyncLocalStorage } from "node:async_hooks";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  mergeInvocationParameters,
  validateInstanceModelExtraBody,
} from "../request-options.js";
import type { InstanceCredentials } from "../types.js";

class InstanceGeminiModel extends ChatGoogleGenerativeAI {
  private readonly invocationSignal = new AsyncLocalStorage<
    AbortSignal | undefined
  >();
  readonly requestBody: Record<string, unknown>;
  constructor(
    config: ConstructorParameters<typeof ChatGoogleGenerativeAI>[0],
    body: Record<string, unknown>,
  ) {
    super(config);
    this.requestBody = structuredClone(body);
  }
  override _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ) {
    // 当前 SDK 的非流式路径未继续传递 signal；每次调用独立保存，含未提供信号的调用。
    return this.invocationSignal.run(options.signal, () =>
      super._generate(messages, options, runManager),
    );
  }
  override completionWithRetry(
    request: Parameters<ChatGoogleGenerativeAI["completionWithRetry"]>[0],
    options?: this["ParsedCallOptions"],
  ) {
    const signal = options?.signal ?? this.invocationSignal.getStore();
    return super.completionWithRetry(
      request,
      signal ? { ...options, signal } : options,
    );
  }
  override invocationParams(options?: this["ParsedCallOptions"]) {
    return mergeInvocationParameters(
      super.invocationParams(options),
      this.requestBody,
    );
  }
}

/** gemini 线协议适配器：聊天（BYOK Google AI Studio Key）。 */

export function createInstanceChatModel(
  model: string,
  credentials: InstanceCredentials,
  extraBody?: Record<string, unknown>,
): BaseLanguageModel {
  validateInstanceModelExtraBody(extraBody);
  return new InstanceGeminiModel(
    {
      model,
      apiKey: credentials.apiKey,
      ...(credentials.invocationMaxRetries !== undefined
        ? { maxRetries: credentials.invocationMaxRetries }
        : {}),
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      // 自定义头（§4.8）：SDK 顶层 `customHeaders`；凭证头 x-goog-api-key 由 apiKey 生成
      ...(credentials.headers ? { customHeaders: credentials.headers } : {}),
      streaming: credentials.invocationStreaming ?? true,
    },
    extraBody ?? {},
  );
}
