/**
 * Sanitize error messages before sending to the frontend.
 * Logs full error detail server-side, returns user-friendly message.
 */

const PROVIDER_PATTERN =
  /google|vertex|openai|replicate|langchain|gaxios|undici|fetch failed/i;
const DB_PATTERN =
  /supabase|postgres|pgmq|database|relation|column|constraint/i;
const AUTH_PATTERN =
  /jwt|token|unauthorized|forbidden|credential|service.account/i;
const INFRA_PATTERN =
  /econnrefused|econnreset|etimedout|dns|socket|tls|certificate/i;

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
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 5) {
    if (isClientFacing(current)) {
      const message =
        current instanceof Error ? current.message : String(current);
      if (message.trim()) return message;
    }
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return undefined;
}

export function sanitizeErrorForClient(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Log full detail server-side for debugging
  console.error("[error-sanitizer] Raw error:", raw);
  if (error instanceof Error) {
    // Log nested cause chain (LangChain wraps errors multiple levels deep)
    let cause = (error as any).cause;
    while (cause) {
      console.error("[error-sanitizer] Caused by:", cause.message ?? cause);
      cause = cause.cause;
    }
    // Log response details if present (Google API errors attach response/details)
    const errAny = error as any;
    if (errAny.response) {
      console.error(
        "[error-sanitizer] Response status:",
        errAny.response.status,
      );
      console.error(
        "[error-sanitizer] Response data:",
        JSON.stringify(
          errAny.response.data ?? errAny.response.body ?? "",
        ).substring(0, 2000),
      );
    }
    if (errAny.details) {
      console.error(
        "[error-sanitizer] Details:",
        JSON.stringify(errAny.details).substring(0, 2000),
      );
    }
    if (error.stack) {
      console.error("[error-sanitizer] Stack:", error.stack);
    }
  }

  // Map to user-friendly messages
  const clientFacing = clientFacingMessage(error);
  if (clientFacing && clientFacing.length <= 200) {
    return clientFacing;
  }
  if (PROVIDER_PATTERN.test(raw)) {
    return "AI 服务暂时不可用，请稍后重试。";
  }
  if (DB_PATTERN.test(raw)) {
    return "数据服务异常，请稍后重试。";
  }
  if (AUTH_PATTERN.test(raw)) {
    return "认证失败，请刷新页面重新登录。";
  }
  if (INFRA_PATTERN.test(raw)) {
    return "网络连接异常，请检查网络后重试。";
  }
  if (raw.includes("abort") || raw.includes("cancel")) {
    return "请求已取消。";
  }
  if (raw.length > 100) {
    // Long messages are likely stack traces or JSON errors
    return "请求处理失败，请重试。";
  }

  // Short, non-technical messages can pass through
  return "请求处理失败，请重试。";
}
