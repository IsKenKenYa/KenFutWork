import { createByteDance } from "@ai-sdk/bytedance";
import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import type { ProviderProtocol } from "@kenfutwork/shared";

/**
 * 实例 → AI SDK provider 工厂（docs/future/05 §3.4，阶段 A）。
 *
 * 只负责「连接配置 → provider 实例」的翻译：baseUrl / 解密后 apiKey / 已渲染
 * 占位符的自定义请求头原样喂给 SDK 工厂。调用方（阶段 B/C 的生成 provider）
 * 拿到的是 SDK 模型对象；本文件不接触 `experimental_*`（那在 ./video-job.ts），
 * 也不做任何协议外的参数拼装。
 *
 * BYOK 红线：apiKey 只在内存传给 SDK，不落日志、不回显。
 */

/** 生成通道实例的运行期凭证（apiKey 已由 SecretStore 解密）。 */
export interface AisdkInstanceCredentials {
  /** 实例声明的网关地址；缺省语义按协议不同（见各工厂）。 */
  baseUrl?: string;
  apiKey: string;
  /** 自定义请求头（占位符已按发送时刻上下文渲染为运行期值）。 */
  headers?: Record<string, string>;
  /** fetch 注入口（诊断代理 / 抓包测试用；生产不传，走全局 fetch）。 */
  fetch?: typeof globalThis.fetch;
}

export type AisdkFactoryErrorCode =
  | "aisdk_base_url_required"
  | "aisdk_protocol_unsupported"
  | "aisdk_kind_unsupported";

/** 工厂配置错误（fail loud，启动期/装配期就该暴露，不带原始 key）。 */
export class AisdkFactoryError extends Error {
  readonly code: AisdkFactoryErrorCode;
  constructor(code: AisdkFactoryErrorCode, message: string) {
    super(`[aisdk:${code}] ${message}`);
    this.name = "AisdkFactoryError";
    this.code = code;
  }
}

/**
 * volces 协议的缺省网关——与本仓既有实现同一处默认
 * （`generation/providers/volces-image.ts`）。@ai-sdk/bytedance 的包默认是
 * BytePlus 国际端点，**不能**静默沿用：用户按火山方舟（cn-beijing）配置的
 * 场景会直接 401。
 */
export const VOLCES_AISDK_DEFAULT_BASE_URL =
  "https://ark.cn-beijing.volces.com/api/v3";

/**
 * openai-compatible 工厂。baseURL 是 SDK 必填项：本仓该协议的实例必须声明
 * baseUrl（中转站/自建网关各不相同，没有可用的缺省值），缺失即 fail loud。
 */
export function createOpenCompatibleProvider(
  credentials: AisdkInstanceCredentials,
): OpenAICompatibleProvider<string, string, string, string> {
  if (!credentials.baseUrl) {
    throw new AisdkFactoryError(
      "aisdk_base_url_required",
      "openai-compatible 协议的实例必须声明 baseUrl（无可用缺省网关）",
    );
  }
  return createOpenAICompatible({
    name: "kenfutwork",
    baseURL: credentials.baseUrl,
    apiKey: credentials.apiKey,
    ...(credentials.headers ? { headers: credentials.headers } : {}),
    ...(credentials.fetch ? { fetch: credentials.fetch } : {}),
  });
}

/** volces（火山方舟）工厂：Seedream 图像 + Seedance 视频共用一个 provider 实例。 */
export function createVolcesProvider(credentials: AisdkInstanceCredentials) {
  return createByteDance({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl ?? VOLCES_AISDK_DEFAULT_BASE_URL,
    ...(credentials.headers ? { headers: credentials.headers } : {}),
    ...(credentials.fetch ? { fetch: credentials.fetch } : {}),
  });
}

/** AI SDK 生成模型对象（图像 v4 / 视频 v4-experimental 的宽类型）。 */
export type AisdkGenerationModel = unknown;

/**
 * 按协议分发到 AI SDK 模型对象。阶段 A 只接入 `openai-compatible`（图像）与
 * `volces`（图像 + 视频）；其余协议（google 系 / replicate / metaso / chat 三家）
 * 走既有实现或待阶段 B/C 扩展，缺路由一律 fail loud，不静默回落。
 */
export function createAisdkGenerationModel(
  protocol: ProviderProtocol,
  kind: "image" | "video",
  modelId: string,
  credentials: AisdkInstanceCredentials,
): AisdkGenerationModel {
  switch (protocol) {
    case "openai-compatible": {
      if (kind !== "image") {
        throw new AisdkFactoryError(
          "aisdk_kind_unsupported",
          "openai-compatible 协议暂只支持图像生成（视频待阶段 C 评估）",
        );
      }
      return createOpenCompatibleProvider(credentials).imageModel(modelId);
    }
    case "volces": {
      const provider = createVolcesProvider(credentials);
      return kind === "image"
        ? provider.imageModel(modelId)
        : provider.videoModel(modelId);
    }
    default:
      throw new AisdkFactoryError(
        "aisdk_protocol_unsupported",
        `协议 ${protocol} 未接入 AI SDK 生成通道（维持既有实现）`,
      );
  }
}
