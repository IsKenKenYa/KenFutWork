import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { ProviderProtocol } from "@kenfutwork/shared";

import type { ImageProvider, VideoProvider } from "../generation/types.js";
import * as anthropic from "./anthropic/index.js";
import * as gemini from "./gemini/index.js";
import * as googleImage from "./google-image/index.js";
import * as metaso from "./metaso/index.js";
import * as openaiCompatible from "./openai-compatible/index.js";
import * as replicate from "./replicate/index.js";
import type {
  InstanceCredentials,
  InstanceImageAdapterOptions,
  InstanceVideoAdapterOptions,
} from "./types.js";
import * as volces from "./volces/index.js";

/**
 * `generation` 缝的运行期适配器注册表（§4.8）：
 * 按协议存放线适配器工厂，任务执行时按用户实例（凭证 + 声明模型）解析。
 * protocol 是封闭集合——新增协议先扩 shared 契约再在这里加一行。
 */

type ChatAdapterFactory = (
  model: string,
  credentials: InstanceCredentials,
) => BaseLanguageModel;

const CHAT_ADAPTERS: Partial<Record<ProviderProtocol, ChatAdapterFactory>> = {
  "openai-compatible": openaiCompatible.createInstanceChatModel,
  anthropic: anthropic.createInstanceChatModel,
  gemini: gemini.createInstanceChatModel,
};

const IMAGE_ADAPTERS: Partial<
  Record<
    ProviderProtocol,
    (options: InstanceImageAdapterOptions) => ImageProvider
  >
> = {
  "openai-compatible": openaiCompatible.createInstanceImageProvider,
  "google-image": googleImage.createInstanceImageProvider,
  replicate: replicate.createInstanceImageProvider,
  volces: volces.createInstanceImageProvider,
};

const VIDEO_ADAPTERS: Partial<
  Record<
    ProviderProtocol,
    (options: InstanceVideoAdapterOptions) => VideoProvider
  >
> = {
  replicate: replicate.createInstanceVideoProvider,
  metaso: metaso.createInstanceVideoProvider,
};

/** 按用户实例实例化聊天模型；协议不支持聊天即 fail loud。 */
export function resolveInstanceChatModel(
  protocol: ProviderProtocol,
  model: string,
  credentials: InstanceCredentials,
): BaseLanguageModel {
  const factory = CHAT_ADAPTERS[protocol];
  if (!factory) {
    throw new Error(
      `[providers] 协议 ${protocol} 不支持聊天模型实例化（fail loud）。`,
    );
  }
  return factory(model, credentials);
}

export function resolveInstanceImageProvider(
  protocol: ProviderProtocol,
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const factory = IMAGE_ADAPTERS[protocol];
  if (!factory) {
    throw new Error(
      `[providers] 协议 ${protocol} 不支持图像生成实例化（fail loud）。`,
    );
  }
  return factory(options);
}

export function resolveInstanceVideoProvider(
  protocol: ProviderProtocol,
  options: InstanceVideoAdapterOptions,
): VideoProvider {
  const factory = VIDEO_ADAPTERS[protocol];
  if (!factory) {
    throw new Error(
      `[providers] 协议 ${protocol} 不支持视频生成实例化（fail loud）。`,
    );
  }
  return factory(options);
}
