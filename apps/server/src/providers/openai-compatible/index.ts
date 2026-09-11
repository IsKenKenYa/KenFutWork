import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { ChatOpenAI } from "@langchain/openai";

import { OpenAIImageProvider } from "../../generation/providers/openai-image.js";
import type { ImageProvider } from "../../generation/types.js";
import type {
  InstanceCredentials,
  InstanceImageAdapterOptions,
} from "../types.js";

/** openai-compatible 线协议适配器：聊天 + 图像（OpenAI 兼容网关，BYOK 零代码接入）。 */

export function createInstanceChatModel(
  model: string,
  credentials: InstanceCredentials,
): BaseLanguageModel {
  return new ChatOpenAI({
    model,
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl
      ? { configuration: { baseURL: credentials.baseUrl } }
      : {}),
    streaming: true,
    // 用量统计（DEC-6）：token 用量经 streamUsage 采集，落 usage 表
    streamUsage: true,
  });
}

export function createInstanceImageProvider(
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const delegate = new OpenAIImageProvider(
    options.credentials.apiKey,
    options.credentials.baseUrl,
  );
  return {
    name: "openai-compatible",
    models: options.models.map((m) => ({
      id: m.id,
      displayName: m.name,
      description: "BYOK instance model",
    })),
    generate: (params) => delegate.generate(params),
  };
}
