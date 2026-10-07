/** 线协议适配器共享类型（§4.8：凭证从 ProviderInstanceConfig 解析后传入适配器）。 */
export interface InstanceCredentials {
  apiKey: string;
  baseUrl?: string | undefined;
  /**
   * 实例自定义请求头（§4.8）——**已按会话上下文渲染**（`renderInstanceHeaders`），
   * 不含占位符；保留头（authorization/content-type/host 等）不在其中。
   */
  headers?: Record<string, string> | undefined /**
   * 探测结论：网关支持 OpenAI Responses API（probe.responsesApi=true 时带出）。
   * 缺省 = 未探测或探测为不支持 → 聊天走 chat/completions（fail open）。
   */;
  responsesApi?: boolean;
  /** 用户显式选择的原生OpenAI方言；false同样权威，不参与自动回落。 */
  useResponsesApi?: boolean;
  /** 单次原生调用的SDK重试次数；连接测试按治理总尝试次数转换，运行时缺省由现有治理链控制。 */
  invocationMaxRetries?: number;
  /** 连接测试使用真实非流式调用；普通run缺省仍流式。 */
  invocationStreaming?: boolean;
}

export interface InstanceImageAdapterOptions {
  credentials: InstanceCredentials;
  /** 实例声明的模型清单（BYOK 用户自定义），id 须与生成任务 payload.model 一致。 */
  models: ReadonlyArray<{ id: string; name: string }>;
}

export interface InstanceVideoAdapterOptions
  extends InstanceImageAdapterOptions {}

/** 宿主冻结的单轮模型配置；不接受公网请求或模型文本签发。 */
export interface ModelInvocationSnapshot {
  providerId: string;
  modelId: string;
  configRevision: number;
  /** 冻结实际界面选定的OpenAI方言；缺省调用方仍可使用探测。 */
  useResponsesApi?: boolean;
  body: Record<string, unknown>;
  inputCapabilities: { image: boolean; pdf: boolean };
}
