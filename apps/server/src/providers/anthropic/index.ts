import { ChatAnthropic } from "@langchain/anthropic";

import type { BaseLanguageModel } from "@langchain/core/language_models/base";

import type { InstanceCredentials } from "../types.js";

/** anthropic 线协议适配器：聊天（BYOK Claude API Key）。 */

export function createInstanceChatModel(
  model: string,
  credentials: InstanceCredentials,
): BaseLanguageModel {
  return new ChatAnthropic({
    model,
    anthropicApiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { anthropicApiUrl: credentials.baseUrl } : {}),
    streaming: true,
    streamUsage: true,
  });
}
