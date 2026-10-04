import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type { InstanceCredentials } from "../types.js";
import { mergeInvocationParameters, validateInstanceModelExtraBody } from "../request-options.js";

class InstanceGeminiModel extends ChatGoogleGenerativeAI {
  readonly requestBody: Record<string, unknown>;
  constructor(config: ConstructorParameters<typeof ChatGoogleGenerativeAI>[0], body: Record<string, unknown>) {
    super(config); this.requestBody = structuredClone(body);
  }
  override invocationParams(options?: this["ParsedCallOptions"]) {
    return mergeInvocationParameters(super.invocationParams(options), this.requestBody);
  }
}

/** gemini 线协议适配器：聊天（BYOK Google AI Studio Key）。 */

export function createInstanceChatModel(
  model: string,
  credentials: InstanceCredentials,
  extraBody?: Record<string, unknown>,
): BaseLanguageModel {
  validateInstanceModelExtraBody(extraBody);
  return new InstanceGeminiModel({
    model,
    apiKey: credentials.apiKey,
    ...(credentials.invocationMaxRetries !== undefined ? { maxRetries: credentials.invocationMaxRetries } : {}),
    ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
    // 自定义头（§4.8）：SDK 顶层 `customHeaders`；凭证头 x-goog-api-key 由 apiKey 生成
    ...(credentials.headers ? { customHeaders: credentials.headers } : {}),
    streaming: credentials.invocationStreaming ?? true,
  }, extraBody ?? {});
}
