import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type { InstanceCredentials } from "../types.js";

/** gemini 线协议适配器：聊天（BYOK Google AI Studio Key）。 */

export function createInstanceChatModel(
  model: string,
  credentials: InstanceCredentials,
): BaseLanguageModel {
  return new ChatGoogleGenerativeAI({
    model,
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
    // 自定义头（§4.8）：SDK 顶层 `customHeaders`；凭证头 x-goog-api-key 由 apiKey 生成
    ...(credentials.headers ? { customHeaders: credentials.headers } : {}),
    streaming: true,
  });
}
