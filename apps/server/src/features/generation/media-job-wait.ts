import {
  type BackgroundJob,
  getMediaJobErrorMessage,
} from "@kenfutwork/shared";
import { findOwnedToolInterruption } from "../../kernel/owned-tool-interruption.js";
import { describeErrorDetail } from "../../utils/error-sanitizer.js";
import { JobServiceError } from "../jobs/job-service.js";

/** 任务接纳服务的公开拒绝可直接说明；其他错误保留在诊断日志。 */
export function describeMediaJobAccessFailure(error: unknown) {
  if (findOwnedToolInterruption(error)) throw error;
  const rejected =
    error instanceof JobServiceError &&
    error.statusCode >= 400 &&
    error.statusCode < 500;
  const message = rejected
    ? error.message
    : "无法确认生成任务结果，请先查看任务记录。";
  if (!rejected)
    console.error(
      "[generation] 无法确认生成任务结果",
      describeErrorDetail(error),
    );
  return {
    summary: message,
    error: message,
    ...(rejected ? { errorCode: error.code } : {}),
    isError: true as const,
  };
}

export type MediaJobWaitIssue =
  | { kind: "waiting" }
  | { kind: "canceled" }
  | { kind: "submission_unknown" }
  | { kind: "failed"; code: string };

type JobStatus = Pick<
  BackgroundJob,
  "status" | "error_code" | "attempt_count" | "max_attempts"
>;

/** 按持久状态判断是否结束等待，不从错误正文推测受理情况。 */
export function readMediaJobWaitIssue(
  job: JobStatus,
): MediaJobWaitIssue | null {
  if (job.status === "canceled") return { kind: "canceled" };
  if (job.status === "failed" && job.error_code === "submission_unknown")
    return { kind: "submission_unknown" };
  if (
    job.status === "dead_letter" ||
    (job.status === "failed" && job.attempt_count >= job.max_attempts)
  )
    return { kind: "failed", code: job.error_code ?? "executor_error" };
  return null;
}

/** 工具正文只使用应用文案，不转交供应商错误原文。 */
export function describeMediaJobWaitIssue(issue: MediaJobWaitIssue) {
  const jobStatus = issue.kind;
  if (issue.kind === "waiting")
    return {
      jobStatus,
      summary: "等待已结束，生成任务可能仍在后台处理，请勿重复提交。",
    };
  const errorCode = issue.kind === "failed" ? issue.code : issue.kind;
  const error =
    issue.kind === "canceled"
      ? "生成任务已停止。"
      : (getMediaJobErrorMessage(errorCode) ??
        "生成失败，请检查供应商设置或任务记录。");
  return {
    jobStatus,
    errorCode,
    error,
    summary: error,
    isError: true as const,
  };
}
