/**
 * Sanitize error messages before sending to the frontend.
 * Logs full error detail server-side, returns user-friendly message.
 */

const PROVIDER_PATTERN =
  /google|vertex|openai|replicate|langchain|gaxios|undici|fetch failed/i;
const DB_PATTERN =
  /supabase|postgres|pgmq|database|relation|column|constraint/i;
const AUTH_PATTERN =
  /\bjwt\b|\bunauthorized\b|\bforbidden\b|\bcredentials?\b|\bservice[.\s_-]?account\b|\b(?:invalid|expired|revoked)\s+(?:(?:access|refresh|bearer|auth(?:entication)?)\s+)?token\b|\btoken\s+(?:is\s+)?(?:invalid|expired|revoked)\b|\b(?:invalid|expired|revoked)[\s_-]+(?:api[\s_-]*key|apikey)\b|\b(?:api[\s_-]*key|apikey)\s+(?:is\s+)?(?:invalid|expired|revoked)\b/i;
const AUTH_STATUS_PATTERN =
  /\b(?:HTTP(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*401\b/i;

function hasHttp401(error: unknown): boolean {
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 5) {
    const record = current as {
      cause?: unknown;
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown; statusCode?: unknown } | null;
    };
    if (
      record.status === 401 ||
      record.statusCode === 401 ||
      record.response?.status === 401 ||
      record.response?.statusCode === 401
    )
      return true;
    current = record.cause;
    depth += 1;
  }
  return false;
}
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
  // 与客户端详情共用脱敏器，错误原文与cause不得把凭据写进日志。
  console.error("[error-sanitizer] Error:", describeErrorDetail(error, 2000));
  if (error instanceof Error) {
    const metadata = error as Error & {
      response?: { status?: unknown; data?: unknown; body?: unknown };
      details?: unknown;
    };
    if (metadata.response) {
      console.error(
        "[error-sanitizer] Response status:",
        metadata.response.status,
      );
      console.error(
        "[error-sanitizer] Response data:",
        redactSecrets(
          JSON.stringify(
            metadata.response.data ?? metadata.response.body ?? "",
          ),
        ).slice(0, 2000),
      );
    }
    if (metadata.details)
      console.error(
        "[error-sanitizer] Details:",
        redactSecrets(JSON.stringify(metadata.details)).slice(0, 2000),
      );
    if (error.stack)
      console.error(
        "[error-sanitizer] Stack:",
        redactSecrets(error.stack).slice(0, 8000),
      );
  }

  // Map to user-friendly messages
  const clientFacing = clientFacingMessage(error);
  if (clientFacing && clientFacing.length <= 200) {
    return redactSecrets(clientFacing);
  }
  const classificationDetail = describeErrorDetail(error, 2000);
  if (
    hasHttp401(error) ||
    AUTH_STATUS_PATTERN.test(classificationDetail) ||
    AUTH_PATTERN.test(classificationDetail)
  ) {
    return withRawDetail("认证失败，请在模型或工具设置中检查凭据。", error);
  }
  if (PROVIDER_PATTERN.test(raw)) {
    return withRawDetail("AI 服务暂时不可用，请稍后重试。", error);
  }
  if (DB_PATTERN.test(raw)) {
    return withRawDetail("数据服务异常，请稍后重试。", error);
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
