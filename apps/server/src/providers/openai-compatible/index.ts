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
  // 自定义头经 `configuration.defaultHeaders` 交给 OpenAI 客户端（§4.8）；
  // 保留头（authorization 等）由 SDK 按 apiKey 生成，契约层与渲染层都拒绝覆盖。
  const clientOptions = {
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
    ...(credentials.headers ? { defaultHeaders: credentials.headers } : {}),
  };

  return new ChatOpenAI({
    model,
    apiKey: credentials.apiKey,
    ...(Object.keys(clientOptions).length > 0
      ? { configuration: clientOptions }
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
