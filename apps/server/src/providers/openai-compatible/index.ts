import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import { ChatOpenAI } from "@langchain/openai";

import { OpenAIImageProvider } from "../../generation/providers/openai-image.js";
import type { ImageProvider } from "../../generation/types.js";
import type {
  InstanceCredentials,
  InstanceImageAdapterOptions,
} from "../types.js";

/** openai-compatible 线协议适配器：聊天 + 图像（OpenAI 兼容网关，BYOK 零代码接入）。 */

/** 探测缓存纠偏回调：运行期发现 Responses 不可用时触发（写探测缓存用）。 */
export type OnResponsesFallback = () => void;

/**
 * 「Responses 端点不可用」判定（宽松特征）：404/405 + 路径或名称含 responses。
 * 误判代价可控——回落到 chat/completions 本就是合法路径；漏判只是本次不回落。
 */
export function isResponsesUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const mentionsResponses = /\/responses\b|responses[_ ]?api/i.test(message);
  const isMissingEndpoint =
    /\b40[45]\b|not[_ ]found|not[_ ]supported|unknown[_ ]url/i.test(message);
  return mentionsResponses && isMissingEndpoint;
}

/**
 * Responses → chat/completions 自动回落（运行期无感）：
 * probe.responsesApi=true 时主用 Responses；调用失败且命中「端点不存在」特征
 * 即永久切回 completions 实例并触发缓存纠偏回调。非端点类错误（限流/余额/
 * 审核等）原样抛出，不误回落。
 */
class ResponsesFallbackChatModel extends ChatOpenAI {
  private readonly completionsDelegate: ChatOpenAI;
  private readonly onResponsesFallback: OnResponsesFallback | undefined;
  private responsesActive: boolean;

  constructor(
    fields: ConstructorParameters<typeof ChatOpenAI>[0],
    completionsDelegate: ChatOpenAI,
    onResponsesFallback?: OnResponsesFallback,
  ) {
    super(fields);
    this.completionsDelegate = completionsDelegate;
    this.onResponsesFallback = onResponsesFallback;
    // 主实例的 useResponsesApi 由调用方按探测结论设置
    this.responsesActive = this.useResponsesApi;
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    if (!this.responsesActive) {
      yield* this.completionsDelegate["_streamResponseChunks"](
        messages,
        options,
        runManager,
      );
      return;
    }
    try {
      yield* super._streamResponseChunks(messages, options, runManager);
    } catch (error) {
      if (!isResponsesUnavailable(error)) throw error;
      this.responsesActive = false;
      this.onResponsesFallback?.();
      yield* this.completionsDelegate["_streamResponseChunks"](
        messages,
        options,
        runManager,
      );
    }
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    if (!this.responsesActive) {
      return this.completionsDelegate["_generate"](
        messages,
        options,
        runManager,
      );
    }
    try {
      return await super._generate(messages, options, runManager);
    } catch (error) {
      if (!isResponsesUnavailable(error)) throw error;
      this.responsesActive = false;
      this.onResponsesFallback?.();
      return this.completionsDelegate["_generate"](
        messages,
        options,
        runManager,
      );
    }
  }
}

export function createInstanceChatModel(
  model: string,
  credentials: InstanceCredentials,
  /** 模型级请求体注入（推理参数映射 extraBody，原样并入请求体顶层）。 */
  extraBody?: Record<string, unknown>,
  onResponsesFallback?: OnResponsesFallback,
): BaseLanguageModel {
  // 自定义头经 `configuration.defaultHeaders` 交给 OpenAI 客户端（§4.8）；
  // 保留头（authorization 等）由 SDK 按 apiKey 生成，契约层与渲染层都拒绝覆盖。
  const clientOptions = {
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
    ...(credentials.headers ? { defaultHeaders: credentials.headers } : {}),
  };
  const useResponsesApi = credentials.responsesApi === true;

  const responsesModel = new ChatOpenAI({
    model,
    apiKey: credentials.apiKey,
    useResponsesApi,
    ...(extraBody ? { modelKwargs: extraBody } : {}),
    ...(Object.keys(clientOptions).length > 0
      ? { configuration: clientOptions }
      : {}),
    streaming: true,
    // 用量统计（DEC-6）：token 用量经 streamUsage 采集，落 usage 表
    streamUsage: true,
  });

  // 探测未确认支持 → 单实例直出（fail open，默认 completions）
  if (!useResponsesApi) {
    return responsesModel;
  }

  const completionsModel = new ChatOpenAI({
    model,
    apiKey: credentials.apiKey,
    ...(extraBody ? { modelKwargs: extraBody } : {}),
    ...(Object.keys(clientOptions).length > 0
      ? { configuration: clientOptions }
      : {}),
    streaming: true,
    streamUsage: true,
  });

  return new ResponsesFallbackChatModel(
    {
      model,
      apiKey: credentials.apiKey,
      useResponsesApi: true,
      ...(extraBody ? { modelKwargs: extraBody } : {}),
      ...(Object.keys(clientOptions).length > 0
        ? { configuration: clientOptions }
        : {}),
      streaming: true,
      streamUsage: true,
    },
    completionsModel,
    onResponsesFallback,
  );
}

export function createInstanceImageProvider(
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const delegate = new OpenAIImageProvider(
    options.credentials.apiKey,
    options.credentials.baseUrl,
    options.credentials.headers,
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
