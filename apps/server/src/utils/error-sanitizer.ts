import { inspect } from "node:util";
import { getMediaJobErrorMessage } from "@kenfutwork/shared";
import { classifyRateLimitError } from "@langchain/core/utils/async_caller";

const PROVIDER_PATTERN =
  /google|vertex|openai|replicate|langchain|gaxios|undici|fetch failed/i;
const DB_PATTERN =
  /supabase|postgres|pgmq|database|relation|column|constraint/i;
const AUTH_PATTERN =
  /\bjwt\b|\bunauthorized\b|\bforbidden\b|\bcredentials?\b|\bservice[.\s_-]?account\b|\b(?:invalid|expired|revoked)\s+(?:(?:access|refresh|bearer|auth(?:entication)?)\s+)?token\b|\btoken\s+(?:is\s+)?(?:invalid|expired|revoked)\b|\b(?:invalid|expired|revoked)[\s_-]+(?:api[\s_-]*key|apikey)\b|\b(?:api[\s_-]*key|apikey)\s+(?:is\s+)?(?:invalid|expired|revoked)\b/i;
const AUTH_STATUS_PATTERN =
  /\b(?:HTTP(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*401\b/i;
const INFRA_PATTERN =
  /econnrefused|econnreset|etimedout|dns|socket|tls|certificate/i;

const AUTH_MESSAGE = "认证失败，请在模型或工具设置中检查凭据。";
const INPUT_MESSAGE = "供应商未接受当前输入，请检查输入和附件或更换模型。";
const PROVIDER_UNAVAILABLE_MESSAGE = "AI 服务暂时不可用，请稍后重试。";

/** 调用方只传入已审核的公开文案；原始错误经 cause 保留给诊断。 */
export class ClientFacingRunError extends Error {
  readonly exposeToClient = true;
}

const messagesByStatus: ReadonlyMap<number, string> = new Map([
  [400, INPUT_MESSAGE],
  [401, AUTH_MESSAGE],
  [403, "供应商拒绝访问，请在供应商设置中检查密钥和权限。"],
  [404, "供应商找不到模型或接口，请检查模型和供应商地址。"],
  [413, "提交内容太大，请缩短输入或减少附件后重试。"],
  [422, INPUT_MESSAGE],
  [500, PROVIDER_UNAVAILABLE_MESSAGE],
  [502, PROVIDER_UNAVAILABLE_MESSAGE],
  [503, PROVIDER_UNAVAILABLE_MESSAGE],
  [504, PROVIDER_UNAVAILABLE_MESSAGE],
]);

function* errorCauses(error: unknown): Iterable<unknown> {
  const seen = new Set<unknown>();
  let current = error;
  // LangChain 逐个中间件包装异常；深度随启用的能力而变。
  while (current != null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
}

function httpFailureMessage(error: unknown): string | undefined {
  for (const current of errorCauses(error)) {
    const record = current as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown; statusCode?: unknown } | null;
    };
    // 复用 SDK 的配额与临时限流分类，公开提示沿用媒体任务的相同原因文案。
    const rateLimit = classifyRateLimitError(current);
    if (rateLimit) {
      return getMediaJobErrorMessage(
        rateLimit.action === "stop"
          ? "provider_balance_insufficient"
          : "provider_rate_limited",
      );
    }
    const status = [
      record.status,
      record.statusCode,
      record.response?.status,
      record.response?.statusCode,
    ].find((value) => typeof value === "number" && messagesByStatus.has(value));
    if (typeof status === "number") return messagesByStatus.get(status);
  }
  return undefined;
}
/**
 * 自带面向用户文案的错误（我方显式构造）：直接透传，不套用下面的通用文案。
 *
 * 存在的理由：通用文案会把所有未知错误压成「请求处理失败，请重试。」——
 * 用户看不出发生了什么（历史上 patchToolCallsMiddleware 的内部错误就是这样
 * 变成一句无从下手的提示）。显式标记的错误带可执行信息（如「流已停滞 N 秒，
 * 请重试或换模型」），交由用户判断。
 */
function isClientFacing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { exposeToClient?: unknown }).exposeToClient === true
  );
}

/**
 * 沿 `cause` 链找第一个面向用户的错误，取其文案。
 *
 * 存在的理由：工具抛出的可读错误会被 LangChain 包一层（ToolNode 包装错误把原文
 * 放进 `cause`），而 `exposeToClient` 标记只落在最内层——只看顶层就会把「web_search
 * 请求失败（API密钥无效）」压成通用文案（GUI 实测踩中：用户看不到原因）。
 */
function clientFacingMessage(error: unknown): string | undefined {
  for (const current of errorCauses(error)) {
    if (isClientFacing(current)) {
      const message =
        current instanceof Error ? current.message : String(current);
      if (message.trim()) return message;
    }
  }
  return undefined;
}

/**
 * 原始错误只用于诊断。服务端记录和明确允许公开的提示均需隐藏凭据。
 *
 * BYOK 凭据可以在授权设置读取，日志必须脱敏——上游报错常把请求头里的 Key 原样回显
 * （`401 {"error":"invalid api key sk-..."}`），不脱敏就等于把用户凭证写进日志文件
 * 再贴到对话里。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***")
    .replace(
      /((?:api[_-]?key|apikey|access[_-]?token|token|secret|password)["'\s:=]{1,4})[A-Za-z0-9._~+/=-]{8,}/gi,
      "$1***",
    )
    .replace(
      /\b(sk|pk|rk|ghp|xox[baprs]|QC)-[A-Za-z0-9_-]{12,}/g,
      (match) => `${match.slice(0, 5)}***`,
    );
}

/** 诊断摘要保留顶层文案、cause 链和可读取的 HTTP 状态。 */
export function describeErrorDetail(error: unknown, maxLength = 300): string {
  const parts: string[] = [];
  for (const current of errorCauses(error)) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : "";
    const trimmed = message.trim();
    if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number" && !parts.includes(`HTTP ${status}`))
      parts.push(`HTTP ${status}`);
  }
  const text = redactSecrets(parts.join(" ← ")).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function inspectErrorMetadata(value: unknown): string {
  // SDK 错误可能附带循环对象或 BigInt。诊断只读摘要，不调用对象自带的转换方法。
  return redactSecrets(
    inspect(value, {
      customInspect: false,
      getters: false,
      maxStringLength: 2000,
    }),
  ).slice(0, 2000);
}

export function sanitizeErrorForClient(error: unknown, runId?: string): string {
  const label = runId ? `[error-sanitizer] Run ${runId}` : "[error-sanitizer]";
  const diagnostic = describeErrorDetail(error, 2000);
  console.error(`${label} Error:`, diagnostic);
  if (error instanceof Error) {
    const metadata = error as Error & {
      response?: { status?: unknown; data?: unknown; body?: unknown };
      details?: unknown;
    };
    if (metadata.response) {
      console.error(`${label} Response status:`, metadata.response.status);
      console.error(
        `${label} Response data:`,
        inspectErrorMetadata(metadata.response.data ?? metadata.response.body),
      );
    }
    if (metadata.details)
      console.error(
        `${label} Details:`,
        inspectErrorMetadata(metadata.details),
      );
    if (error.stack)
      console.error(
        `${label} Stack:`,
        redactSecrets(error.stack).slice(0, 8000),
      );
  }

  const clientFacing = clientFacingMessage(error);
  if (clientFacing && clientFacing.length <= 200) {
    return redactSecrets(clientFacing);
  }
  const httpMessage = httpFailureMessage(error);
  if (httpMessage) return httpMessage;
  if (AUTH_STATUS_PATTERN.test(diagnostic) || AUTH_PATTERN.test(diagnostic))
    return AUTH_MESSAGE;
  if (DB_PATTERN.test(diagnostic)) return "数据服务异常，请稍后重试。";
  if (INFRA_PATTERN.test(diagnostic)) return "网络连接异常，请检查网络后重试。";
  if (PROVIDER_PATTERN.test(diagnostic)) return PROVIDER_UNAVAILABLE_MESSAGE;
  if (error instanceof Error && error.name === "AbortError")
    return "请求已取消。";
  return "请求处理失败，请重试。";
}
