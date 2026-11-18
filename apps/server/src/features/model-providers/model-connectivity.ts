import { randomUUID } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { isRetryableLlmError } from "../../agent/llm-retry-middleware.js";
import {
  type HeaderRenderContext,
  renderInstanceHeaders,
} from "../../providers/instance-headers.js";
import {
  resolveInstanceChatModel,
  validateInstanceModelExtraBody,
} from "../../providers/resolve.js";
import type { ResolvedInstanceCredentials } from "./model-provider-service.js";

export interface ModelConnectivityInput {
  instanceId: string;
  modelId: string;
  /** 由原生配置编译器验证的选项；禁止覆盖模型身份或凭证。 */
  extraBody?: Record<string, unknown>;
  /** 可信宿主上下文；缺省建立独立probe身份，不制造Task/Run。 */
  headerContext?: HeaderRenderContext;
}
export interface ModelConnectivityOptions {
  signal?: AbortSignal;
  timeoutMs: number | null;
  /** 总尝试次数，含首尝试；0仍只尝试一次。 */
  maxAttempts: number;
  infinite: boolean;
}
export interface ModelConnectivityResult {
  modelId: string;
  success: boolean;
  error?: { code?: string; message: string };
}

function redact(text: string, secrets: string[]): string {
  return secrets
    .filter(Boolean)
    .reduce((value, secret) => value.split(secret).join("[已隐藏]"), text);
}

function failure(
  modelId: string,
  error: unknown,
  secrets: string[],
): ModelConnectivityResult {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "instance_connectivity_failed";
  return {
    modelId,
    success: false,
    error: {
      code: redact(code, secrets),
      message: redact(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
    },
  };
}

/** 真实协议调用：有限重试交给native SDK，无限重试独立计数并服从取消/整体deadline。 */
async function invoke(
  credentials: ResolvedInstanceCredentials,
  input: ModelConnectivityInput,
  options: ModelConnectivityOptions,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const selected = credentials.models.find(
    (model) =>
      model.id === input.modelId &&
      model.capability === "chat" &&
      model.enabled !== false,
  );
  if (!selected)
    throw new Error("所选聊天模型未声明或已停用，请刷新供应商设置。");
  validateInstanceModelExtraBody(selected.extraBody);
  validateInstanceModelExtraBody(input.extraBody);
  const model = resolveInstanceChatModel(
    credentials.protocol,
    selected.id,
    {
      apiKey: credentials.apiKey,
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      ...(headers ? { headers } : {}),
      ...(credentials.useResponsesApi !== undefined
        ? { useResponsesApi: credentials.useResponsesApi }
        : {}),
      ...(credentials.responsesApi !== undefined
        ? { responsesApi: credentials.responsesApi }
        : {}),
      // 0关闭native重试以免无限循环叠加SDK次数；有限治理值含首尝试而SDK不含。
      invocationMaxRetries: options.infinite
        ? 0
        : Math.max(0, Math.floor(options.maxAttempts) - 1),
      invocationStreaming: false,
    },
    { ...selected.extraBody, ...input.extraBody },
  );
  while (true) {
    signal?.throwIfAborted();
    try {
      await model.invoke(
        [new HumanMessage("请仅回复 OK。")],
        signal ? { signal } : {},
      );
      signal?.throwIfAborted();
      return;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!options.infinite || !isRetryableLlmError(error)) throw error;
    }
  }
}

export async function testInstanceModelConnectivity(
  loadCredentials: () => Promise<ResolvedInstanceCredentials>,
  input: ModelConnectivityInput,
  options: ModelConnectivityOptions,
): Promise<ModelConnectivityResult> {
  const secrets: string[] = [];
  const deadline =
    options.timeoutMs === null
      ? undefined
      : AbortSignal.timeout(options.timeoutMs);
  const signals = [options.signal, deadline].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  try {
    if (options.infinite && !signal)
      throw new Error("无限连接重试需要取消信号或整体超时设置。");
    signal?.throwIfAborted();
    const credentials = await loadCredentials();
    secrets.push(
      credentials.apiKey,
      ...Object.values(credentials.headers ?? {}),
    );
    const probeId = randomUUID();
    const headers = renderInstanceHeaders(
      credentials.headers,
      input.headerContext ?? { sessionId: probeId, threadId: probeId },
    );
    secrets.push(...Object.values(headers ?? {}));
    await invoke(credentials, input, options, headers, signal);
    return { modelId: input.modelId, success: true };
  } catch (error) {
    return failure(
      input.modelId,
      signal?.aborted ? signal.reason : error,
      secrets,
    );
  }
}
