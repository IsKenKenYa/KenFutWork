import type { BackgroundJob } from "@kenfutwork/shared";
import { readJobExecution } from "./job-progress.js";

const TERMINAL_CODES = new Set([
  "invalid_input",
  "unsupported",
  "unsupported_input",
  "unsupported_parameter",
  "no_output",
  "prediction_failed",
  "model_not_found",
  "unknown_model",
  "provider_not_found",
  "safety_filter",
  "provider_task_failed",
  "media_input_audio_copyright",
  "media_output_audio_copyright",
  "media_task_type_constraint",
  "media_task_type_mismatch",
  "video_job_timeout",
  "provider_config_stale",
  "media_output_missing",
  "media_output_conflict",
]);
const BALANCE_CODES = new Set([
  "insufficient_quota",
  "insufficient_balance",
  "insufficient_user_quota",
  "billing_hard_limit_reached",
  "credits_exhausted",
]);

type FailureHeaders = Headers | Record<string, unknown>;

function httpFailureStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 400 &&
    value <= 599
    ? value
    : undefined;
}

function retryAfterHeader(headers: FailureHeaders | undefined) {
  return headers instanceof Headers
    ? headers.get("retry-after")
    : headers?.["retry-after"];
}

function details(error: unknown) {
  const seen = new Set<object>();
  let current = error;
  let status: number | undefined;
  let delaySeconds: number | undefined;
  let upstreamCode: string | undefined;
  let balanceAlias = false;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const entry = current as {
      status?: unknown;
      statusCode?: unknown;
      retryAfter?: unknown;
      upstreamCode?: unknown;
      code?: unknown;
      responseHeaders?: FailureHeaders;
      response?: {
        status?: unknown;
        statusCode?: unknown;
        headers?: FailureHeaders;
      };
      cause?: unknown;
    };
    status ??=
      httpFailureStatus(entry.status) ??
      httpFailureStatus(entry.statusCode) ??
      httpFailureStatus(entry.response?.status) ??
      httpFailureStatus(entry.response?.statusCode);
    delaySeconds ??=
      retryAfterSeconds(entry.retryAfter) ??
      retryAfterSeconds(retryAfterHeader(entry.responseHeaders)) ??
      retryAfterSeconds(retryAfterHeader(entry.response?.headers));
    if (typeof entry.upstreamCode === "string" && entry.upstreamCode.trim())
      upstreamCode ??= entry.upstreamCode;
    // 通用包装码不能盖住内层供应商码；没有显式来源码时才看已知额度别名。
    balanceAlias ||=
      typeof entry.code === "string" && BALANCE_CODES.has(entry.code);
    current = entry.cause;
  }
  return {
    status,
    delaySeconds,
    balanceInsufficient:
      upstreamCode === undefined
        ? balanceAlias
        : BALANCE_CODES.has(upstreamCode),
  };
}

function retryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, date - Date.now()) / 1000
    : undefined;
}

export function classifyJobFailure(
  job: BackgroundJob,
  error: unknown,
  attempt: number,
  retryBaseDelayMs: number,
) {
  const reportedCode = (error as { code?: unknown })?.code;
  const code =
    typeof reportedCode === "string" && reportedCode
      ? reportedCode
      : "executor_error";
  const message = error instanceof Error ? error.message : String(error);
  const info = details(error);
  const execution = readJobExecution(job);
  if (info.balanceInsufficient)
    return {
      kind: "terminal" as const,
      code: "provider_balance_insufficient",
      message,
    };
  if (info.status === 401 || info.status === 403)
    return { kind: "terminal" as const, code: "provider_auth_failed", message };
  if (
    TERMINAL_CODES.has(code) ||
    (info.status !== undefined &&
      [400, 402, 404, 405, 413, 415, 422].includes(info.status))
  )
    return { kind: "terminal" as const, code, message };
  // 已发出的生成请求只有明确的限流拒绝可重发；网络/网关失败不能证明上游未受理。
  if (
    execution.phase === "submitting" &&
    info.status !== 429 &&
    code !== "input_fetch_error"
  )
    return {
      kind: "uncertain" as const,
      code: "submission_unknown",
      message: "提交结果待确认，请核对供应商记录。",
    };
  // 沿用部署的worker轮询间隔作为缺省退避基准；指数与随机抖动是调度算法，不另设业务上限。
  const delaySeconds =
    info.delaySeconds ??
    (retryBaseDelayMs / 1000) *
      2 ** Math.max(0, attempt - 1) *
      (1 + Math.random());
  return {
    kind: "retry" as const,
    code:
      execution.phase === "saving" && code === "executor_error"
        ? "media_output_save_failed"
        : execution.phase === "publishing" && code === "executor_error"
          ? "media_output_publish_failed"
          : info.status === 429
            ? "provider_rate_limited"
            : code,
    message,
    delaySeconds,
    ...(execution.phase === "submitting"
      ? { execution: { phase: "ready" as const } }
      : {}),
  };
}
