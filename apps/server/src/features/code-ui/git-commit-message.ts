import {
  type InstanceSettings,
  parseInstanceSpecifier,
} from "@kenfutwork/shared";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GitGenerateCommitMessageRequest } from "@zcode/shared";
import {
  createLlmRequestRetryMiddleware,
  isRetryableLlmError,
} from "../../agent/llm-retry-middleware.js";
import { instanceHeadersOption } from "../../providers/instance-headers.js";
import { resolveInstanceChatModel } from "../../providers/resolve.js";
import type { LocalActor } from "../local-instance/types.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import type { SettingsService } from "../settings/settings-service.js";

export interface GitCommitMessageGeneratorDeps {
  settings: Pick<SettingsService, "getInstanceSettings">;
  modelProviders: Pick<ModelProviderService, "resolveCredentials">;
}

export interface GitCommitMessageOutcome {
  message: string;
  providerId: string;
  model: string;
}

export type GenerateGitCommitMessage = (
  actor: LocalActor,
  instanceId: string,
  request: GitGenerateCommitMessageRequest,
  diffText: string,
) => Promise<GitCommitMessageOutcome>;

/**
 * 提交信息生成：用实例当前选定的供应商与模型跑一次单轮文本调用。
 * 直接复用 agent 侧的模型解析与治理重试，不经过 agent 会话，也不写假数据。
 */
export function createGitCommitMessageGenerator(
  deps: GitCommitMessageGeneratorDeps,
): GenerateGitCommitMessage {
  return async (actor, instanceId, request, diffText) => {
    const settings = await deps.settings.getInstanceSettings(actor, instanceId);
    const specifier = settings.defaultModel?.trim();
    if (!specifier) throw new Error("尚未选择默认模型，请到设置中选择后重试。");
    const parsed = parseInstanceSpecifier(specifier);
    if (!parsed)
      throw new Error(
        `默认模型“${specifier}”的格式不正确，请在设置中重新选择。`,
      );
    const credentials = await deps.modelProviders.resolveCredentials(
      actor,
      parsed.instanceId,
    );
    const target = credentials.models.find(
      (model) => model.id === parsed.model,
    );
    if (!target)
      throw new Error(
        `供应商“${credentials.name}”里没有模型“${parsed.model}”，请在设置中重新选择。`,
      );
    if (target.capability !== "chat")
      throw new Error(`模型“${target.id}”不支持聊天，请重新选择默认模型。`);
    if (target.enabled === false)
      throw new Error(`模型“${target.id}”已停用，请在设置中重新选择。`);
    const model = resolveInstanceChatModel(
      credentials.protocol,
      target.id,
      {
        apiKey: credentials.apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        ...(credentials.useResponsesApi === undefined
          ? {}
          : { useResponsesApi: credentials.useResponsesApi }),
        ...(credentials.responsesApi === undefined
          ? {}
          : { responsesApi: credentials.responsesApi }),
        ...instanceHeadersOption(credentials.headers, {}),
        // 关闭 SDK 自带的隐式重试（局部常量 0，不属于治理表数值）：
        // 重试次数统一由治理表驱动的中间件执行，避免两层重试相乘。
        invocationMaxRetries: 0,
        invocationStreaming: false,
      },
      {
        ...(target.extraBody ? { ...target.extraBody } : {}),
      },
    );
    const signal = requestSignal(settings);
    const messages = commitMessagePrompts(request, diffText);
    const retry = createLlmRequestRetryMiddleware({
      maxAttempts: settings.llmRequestMaxRetries,
      infinite: settings.llmInfiniteRetry,
      ...(signal ? { signal } : {}),
    });
    let response: unknown;
    try {
      const call = retry.wrapModelCall;
      if (!call) throw new Error("重试中间件缺少模型调用入口。");
      response = await call({ config: { signal } } as never, () =>
        model.invoke(messages, signal ? { signal } : {}),
      );
    } catch (error) {
      throw new Error(generationFailure(error, credentials.apiKey, signal));
    }
    const message = normalizeCommitMessage(
      messageText(response),
      settings.toolResultPruneThresholdChars,
    );
    if (!message) throw new Error("模型没有返回提交信息，请手动填写。");
    return { message, providerId: parsed.instanceId, model: parsed.model };
  };
}

function requestSignal(settings: InstanceSettings): AbortSignal | undefined {
  if (settings.agentStreamIdleTimeoutMs <= 0) return undefined;
  return AbortSignal.timeout(settings.agentStreamIdleTimeoutMs);
}

function commitMessagePrompts(
  request: GitGenerateCommitMessageRequest,
  diffText: string,
): [SystemMessage, HumanMessage] {
  const english = request.locale === "en-US";
  const scope = request.includeUnstaged
    ? english
      ? "working tree"
      : "工作区"
    : english
      ? "staged changes"
      : "暂存区";
  const system = english
    ? "You write one Git commit message. Output only the message: an imperative subject line under 72 characters, then an optional blank line and short bullet points. No explanation, no Markdown, no code fences."
    : "只写一条 Git 提交信息：首行是不超过 72 个字符的祈使句摘要，必要时空一行再写简短要点。不要解释、不要 Markdown、不要代码块、不要引号。";
  const context = request.conversationContext?.messages
    ?.map((message) => `${message.role}: ${message.content}`)
    .join("\n")
    .trim();
  const files = request.currentSessionFilePaths?.filter(Boolean) ?? [];
  const lines = [
    english ? `Changes in ${scope}:` : `当前${scope}的改动：`,
    diffText,
  ];
  if (files.length > 0)
    lines.push(
      english ? "Files touched in this session:" : "本次会话改动的文件：",
      files.join("\n"),
    );
  if (context)
    lines.push(english ? "Conversation context:" : "会话线索：", context);
  return [new SystemMessage(system), new HumanMessage(lines.join("\n\n"))];
}

/** 只保留一条提交信息：去代码围栏、统一换行，并限制在治理表给出的文本预算内。 */
function normalizeCommitMessage(text: string, maxChars: number): string {
  let value = text.replace(/\r\n/g, "\n").trim();
  value = value
    .replace(/^```[^\n]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  if (value.length > maxChars) value = value.slice(0, maxChars).trimEnd();
  return value;
}

function messageText(response: unknown): string {
  if (typeof response === "string") return response;
  const content = (response as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text ?? "")
            : "",
      )
      .join("");
  return "";
}

function generationFailure(
  error: unknown,
  apiKey: string,
  signal: AbortSignal | undefined,
): string {
  if (signal?.aborted) return "生成提交信息超时，请重试或在界面上手动填写。";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const sanitized = apiKey ? raw.split(apiKey).join("[已隐藏]") : raw;
  const detail = sanitized.trim() || "模型没有返回结果";
  const retryable = isRetryableLlmError(error) ? "网络或上游暂时不可用，" : "";
  return `生成提交信息失败：${retryable}${detail}。请在界面上手动填写。`;
}
