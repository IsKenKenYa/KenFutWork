import { ChatAnthropic } from "@langchain/anthropic";

import type { BaseLanguageModel } from "@langchain/core/language_models/base";

import type { InstanceCredentials } from "../types.js";
import { mergeInvocationParameters, validateInstanceModelExtraBody } from "../request-options.js";

class InstanceAnthropicModel extends ChatAnthropic {
  readonly requestBody: Record<string, unknown>;
  constructor(config: ConstructorParameters<typeof ChatAnthropic>[0], body: Record<string, unknown>) {
    super(config); this.requestBody = structuredClone(body);
  }
  override invocationParams(options?: this["ParsedCallOptions"]) {
    return mergeInvocationParameters(super.invocationParams(options), this.requestBody);
  }
}

/** anthropic 线协议适配器：聊天（BYOK Claude API Key）。 */

export function createInstanceChatModel(
  model: string,
  credentials: InstanceCredentials,
  extraBody?: Record<string, unknown>,
): BaseLanguageModel {
  validateInstanceModelExtraBody(extraBody);
  return new InstanceAnthropicModel({
    model,
    anthropicApiKey: credentials.apiKey,
    ...(credentials.invocationMaxRetries !== undefined ? { maxRetries: credentials.invocationMaxRetries } : {}),
    ...(credentials.baseUrl ? { anthropicApiUrl: credentials.baseUrl } : {}),
    // 自定义头（§4.8）走 Anthropic 客户端的 defaultHeaders：SDK 顶层的 `headers`
    // 只作为**每次调用**的 run options 透传（实测不会自动带上），故不能用它。
    // 凭证头 x-api-key 由 apiKey 生成，契约与渲染两层都拒绝覆盖。
    ...(credentials.headers
      ? { clientOptions: { defaultHeaders: credentials.headers } }
      : {}),
    streaming: credentials.invocationStreaming ?? true,
    streamUsage: true,
  }, extraBody ?? {});
}
