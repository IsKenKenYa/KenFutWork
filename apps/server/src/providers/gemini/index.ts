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
    streaming: true,
  });
}
