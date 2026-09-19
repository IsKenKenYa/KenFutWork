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
}

export interface InstanceImageAdapterOptions {
  credentials: InstanceCredentials;
  /** 实例声明的模型清单（BYOK 用户自定义），id 须与生成任务 payload.model 一致。 */
  models: ReadonlyArray<{ id: string; name: string }>;
}

export interface InstanceVideoAdapterOptions
  extends InstanceImageAdapterOptions {}
