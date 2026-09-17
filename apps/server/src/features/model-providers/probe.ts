import type { ProviderProbeResult, ProviderProtocol } from "@kenfutwork/shared";

/**
 * 实例能力探测（阶段 E，docs/future/05 §6.2）：连通性 + 中转站方言四探测项。
 *
 * 探测由用户/管理员显式触发（POST probe），结果缓存到实例供运行期裁剪请求。
 * 判定口径（fail open）：false 才裁剪；true 与「未探测」都按全能力尝试。
 * fetch 可注入（抓包测试）；探测请求一律 max_tokens 收敛 + 不携带用户内容。
 */

export interface ProbeTarget {
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  /** 探测请求使用的模型名（chat 优先；无 chat 模型时连通性仍可探 /models）。 */
  model?: string;
  headers?: Record<string, string>;
}

export type ProbeFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface ProbeDraft {
  streamUsage?: boolean;
  strictToolSchema?: boolean;
  responsesApi?: boolean;
  cacheControl?: boolean;
  notes: string[];
}

const PROBE_TIMEOUT_MS = 15_000;

async function postJson(
  fetchFn: ProbeFetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; ok: boolean; json: unknown; text: string }> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应（HTML 错误页等）——保留 text 供诊断
  }
  return { status: response.status, ok: response.ok, json, text };
}

/** SSE 逐行扫描：usage 是否出现在任何 chunk 里（include_usage 判定）。 */
function sseContainsUsage(text: string): boolean {
  return /"usage"\s*:\s*\{/.test(text);
}

/** OpenAI 生态探测（openai-compatible；volces 网关兼容 chat 的也可用）。 */
async function probeOpenAiCompatible(
  fetchFn: ProbeFetch,
  target: ProbeTarget,
  draft: ProbeDraft,
): Promise<void> {
  const base = target.baseUrl.replace(/\/+$/, "");
  const headers = {
    ...(target.headers ?? {}),
    Authorization: `Bearer ${target.apiKey}`,
  };
  const model = target.model ?? "gpt-4o-mini";

  // ① include_usage（P0）：流式响应是否带 usage 统计。缺失 = 用量统计盲区。
  try {
    const result = await postJson(
      fetchFn,
      `${base}/chat/completions`,
      headers,
      {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: true,
        stream_options: { include_usage: true },
      },
    );
    if (result.ok) {
      draft.streamUsage = sseContainsUsage(result.text);
      if (!draft.streamUsage) {
        draft.notes.push(
          "stream_options.include_usage 未生效：流式响应缺 usage chunk",
        );
      }
    } else {
      draft.notes.push(`include_usage 探测请求失败：HTTP ${result.status}`);
    }
  } catch (error) {
    draft.notes.push(
      `include_usage 探测异常：${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  // ② strict tool schema：非法/严格的 strict 工具定义是否被接受。
  try {
    const result = await postJson(
      fetchFn,
      `${base}/chat/completions`,
      headers,
      {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        tools: [
          {
            type: "function",
            function: {
              name: "probe_strict",
              description: "capability probe",
              strict: true,
              parameters: {
                type: "object",
                properties: { x: { type: "string" } },
                required: ["x"],
                additionalProperties: false,
              },
            },
          },
        ],
      },
    );
    // 4xx（400/404）= 网关不接受 strict 工具定义；2xx = 接受
    draft.strictToolSchema = result.status < 400;
    if (!draft.strictToolSchema) {
      draft.notes.push(`strict tool schema 被拒绝：HTTP ${result.status}`);
    }
  } catch (error) {
    draft.notes.push(
      `strict tool schema 探测异常：${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  // ③ Responses API：POST /responses 是否存在（中转支持率低 → S3 回落判定）。
  try {
    const result = await postJson(fetchFn, `${base}/responses`, headers, {
      model,
      input: "ping",
      max_output_tokens: 16,
    });
    // 404/405 = 端点不存在；其他 4xx（如余额/参数）说明端点在
    draft.responsesApi =
      result.status < 500 && result.status !== 404 && result.status !== 405;
    if (!draft.responsesApi) {
      draft.notes.push(`Responses API 不可用：HTTP ${result.status}`);
    }
  } catch (error) {
    draft.notes.push(
      `Responses API 探测异常：${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

/** Anthropic 探测：cache_control 透传。 */
async function probeAnthropic(
  fetchFn: ProbeFetch,
  target: ProbeTarget,
  draft: ProbeDraft,
): Promise<void> {
  const base = target.baseUrl.replace(/\/+$/, "");
  const model = target.model ?? "claude-3-5-haiku-latest";
  try {
    const result = await postJson(
      fetchFn,
      `${base}/messages`,
      {
        ...(target.headers ?? {}),
        "x-api-key": target.apiKey,
        "anthropic-version": "2023-06-01",
      },
      {
        model,
        max_tokens: 1,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "ping",
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      },
    );
    draft.cacheControl = result.status < 400;
    if (!draft.cacheControl) {
      draft.notes.push(`cache_control 被拒绝：HTTP ${result.status}`);
    }
  } catch (error) {
    draft.notes.push(
      `cache_control 探测异常：${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

/** 按协议探测实例能力；各探测项独立，单项失败不影响其它项。 */
export async function probeInstance(
  fetchFn: ProbeFetch,
  target: ProbeTarget,
): Promise<ProviderProbeResult> {
  const draft: ProbeDraft = { notes: [] };
  if (target.protocol === "openai-compatible") {
    await probeOpenAiCompatible(fetchFn, target, draft);
  } else if (target.protocol === "anthropic") {
    await probeAnthropic(fetchFn, target, draft);
  } else {
    // 生成类协议（volces/replicate/metaso/google*）无中转方言面
    draft.notes.push(`协议 ${target.protocol} 无适用探测项`);
  }
  const result: ProviderProbeResult = {
    probedAt: new Date().toISOString(),
  };
  if (draft.streamUsage !== undefined) result.streamUsage = draft.streamUsage;
  if (draft.strictToolSchema !== undefined) {
    result.strictToolSchema = draft.strictToolSchema;
  }
  if (draft.responsesApi !== undefined)
    result.responsesApi = draft.responsesApi;
  if (draft.cacheControl !== undefined)
    result.cacheControl = draft.cacheControl;
  if (draft.notes.length > 0) result.notes = draft.notes;
  return result;
}
