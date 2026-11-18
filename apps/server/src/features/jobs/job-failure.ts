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

function details(error: unknown) {
  let current = error;
  let status: number | undefined;
  let retryAfter: string | undefined;
  let upstreamCode: string | undefined;
  while (current && typeof current === "object") {
    const entry = current as {
      status?: number;
      statusCode?: number;
      retryAfter?: string;
      upstreamCode?: string;
      code?: string;
      responseHeaders?: Record<string, string>;
      cause?: unknown;
    };
    status ??= entry.status ?? entry.statusCode;
    retryAfter ??= entry.retryAfter ?? entry.responseHeaders?.["retry-after"];
    upstreamCode ??= entry.upstreamCode ?? entry.code;
    current = entry.cause;
  }
  return { status, retryAfter, upstreamCode };
}

function retryAfterSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
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
  const code = (error as { code?: string })?.code ?? "executor_error";
  const message = error instanceof Error ? error.message : String(error);
  const info = details(error);
  const execution = readJobExecution(job);
  if (BALANCE_CODES.has(info.upstreamCode ?? ""))
    return {
      kind: "terminal" as const,
      code: "provider_balance_insufficient",
      message,
    };
  if (
    TERMINAL_CODES.has(code) ||
    (info.status !== undefined &&
      [400, 401, 402, 403, 404, 405, 413, 415, 422].includes(info.status))
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
    retryAfterSeconds(info.retryAfter) ??
    (retryBaseDelayMs / 1000) *
      2 ** Math.max(0, attempt - 1) *
      (1 + Math.random());
  return {
    kind: "retry" as const,
    code: info.status === 429 ? "provider_rate_limited" : code,
    message,
    delaySeconds,
    ...(execution.phase === "submitting"
      ? { execution: { phase: "ready" as const } }
      : {}),
  };
}
