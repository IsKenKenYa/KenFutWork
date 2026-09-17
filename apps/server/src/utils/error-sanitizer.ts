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

/**
 * 凭证脱敏：原始错误**要进结构化日志、也要给用户看**，所以先过这一遍。
 *
 * BYOK 红线是「Key 只写不读、日志脱敏」——上游报错常把请求头里的 Key 原样回显
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

/**
 * 原始错误详情（脱敏、截断）：顶层 message + `cause` 链 + 上游 HTTP 状态。
 *
 * 存在的理由：失败原因此前只 `console.error` 到 stderr，**不落 pipeline 日志、也不给
 * 用户看**——实测「每轮 run 都失败」时只能看到笼统文案，无法回溯上游返回了什么。
 */
export function describeErrorDetail(error: unknown, maxLength = 300): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 5) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : "";
    const trimmed = message.trim();
    if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number") parts.push(`HTTP ${status}`);
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  const text = redactSecrets(parts.join(" ← ")).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function sanitizeErrorForClient(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Log full detail server-side for debugging
  console.error("[error-sanitizer] Raw error:", raw);
  if (error instanceof Error) {
    // Log nested cause chain (LangChain wraps errors multiple levels deep)
    // cause 非标准字段，按 unknown 逐层收窄读取
    let cause: unknown = (error as { cause?: unknown }).cause;
    while (cause) {
      const causeMessage = (cause as { message?: unknown }).message;
      console.error("[error-sanitizer] Caused by:", causeMessage ?? cause);
      cause = (cause as { cause?: unknown }).cause;
    }
    // Log response details if present (Google API errors attach response/details)
    const response = (
      error as {
        response?: { status?: unknown; data?: unknown; body?: unknown };
      }
    ).response;
    if (response) {
      console.error("[error-sanitizer] Response status:", response.status);
      console.error(
        "[error-sanitizer] Response data:",
        JSON.stringify(response.data ?? response.body ?? "").substring(0, 2000),
      );
    }
    if ((error as { details?: unknown }).details) {
      console.error(
        "[error-sanitizer] Details:",
        JSON.stringify((error as { details?: unknown }).details).substring(
          0,
          2000,
        ),
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
    return withRawDetail("AI 服务暂时不可用，请稍后重试。", error);
  }
  if (DB_PATTERN.test(raw)) {
    return withRawDetail("数据服务异常，请稍后重试。", error);
  }
  if (AUTH_PATTERN.test(raw)) {
    return withRawDetail("认证失败，请刷新页面重新登录。", error);
  }
  if (INFRA_PATTERN.test(raw)) {
    return withRawDetail("网络连接异常，请检查网络后重试。", error);
  }
  if (raw.includes("abort") || raw.includes("cancel")) {
    return "请求已取消。";
  }

  return withRawDetail("请求处理失败，请重试。", error);
}

/**
 * 通用文案后面挂原始错误（脱敏 + 截断）。
 *
 * 为什么挂：通用文案只说明「哪一类」，判断不了是上游 4xx、Key 失效、模型不存在还是
 * 网络不通——实测「每轮 run 都失败」时用户与运维都只能看到一句笼统话，无从下手，
 * 也没法贴给上游排查。原始错误的落点有两处：结构化日志（ws/handler 的 `run_failed`）
 * 与 `agent_runs.error_message`，两端同源，都是这里产出的字符串。
 */
function withRawDetail(generic: string, error: unknown): string {
  const detail = describeErrorDetail(error);
  // 空行分隔：前端用 markdown 渲染（单换行会被并进同一段），也便于纯文本场景阅读
  return detail ? `${generic}\n\n原始错误：${detail}` : generic;
}
