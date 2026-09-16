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
    // 自定义头（§4.8）走 Anthropic 客户端的 defaultHeaders：SDK 顶层的 `headers`
    // 只作为**每次调用**的 run options 透传（实测不会自动带上），故不能用它。
    // 凭证头 x-api-key 由 apiKey 生成，契约与渲染两层都拒绝覆盖。
    ...(credentials.headers
      ? { clientOptions: { defaultHeaders: credentials.headers } }
      : {}),
    streaming: true,
    streamUsage: true,
  });
}
