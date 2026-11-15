import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BackgroundJob } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { classifyJobFailure } from "./job-failure.js";

const exec = promisify(execFile);
const job: BackgroundJob = {
  id: "11111111-1111-4111-8111-111111111111",
  instance_id: "22222222-2222-4222-8222-222222222222",
  created_by_client_id: "33333333-3333-4333-8333-333333333333",
  file_target: { kind: "standalone" },
  session_id: null,
  thread_id: null,
  project_id: null,
  canvas_id: null,
  queue_name: "video_generation_jobs",
  job_type: "video_generation",
  status: "running",
  payload: { _generation_execution: { phase: "submitting" } },
  result: null,
  error_code: null,
  error_message: null,
  attempt_count: 0,
  max_attempts: 3,
  provider_job_id: null,
  created_at: "2026-11-16T00:00:00.000Z",
  updated_at: "2026-11-16T00:00:00.000Z",
  started_at: null,
  completed_at: null,
  failed_at: null,
  canceled_at: null,
};

describe("媒体任务读取结构化失败", () => {
  it.each([
    { upstreamCode: "insufficient_quota" },
    { code: "insufficient_balance" },
  ])("外层通用码不覆盖供应商额度原因：%j", (facts) => {
    const sdk = Object.assign(new Error("供应商拒绝请求"), {
      status: 429,
      ...facts,
    });
    const wrapped = Object.assign(new Error("适配器请求失败", { cause: sdk }), {
      code: "api_error",
    });
    expect(classifyJobFailure(job, wrapped, 1, 1000)).toEqual({
      kind: "terminal",
      code: "provider_balance_insufficient",
      message: "适配器请求失败",
    });
  });

  it("外层成功状态和无效退避值不掩盖 SDK 响应里的临时限流", () => {
    const sdk = Object.assign(new Error("供应商临时限流"), {
      response: new Response(null, {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    });
    const wrapped = Object.assign(new Error("请求失败", { cause: sdk }), {
      status: 200,
      retryAfter: " ",
    });
    expect(classifyJobFailure(job, wrapped, 1, 1000)).toMatchObject({
      kind: "retry",
      code: "provider_rate_limited",
      delaySeconds: 7,
      execution: { phase: "ready" },
    });
  });

  it("外层有效网关故障仍保留提交结果待确认，不据内层限流重发", () => {
    const sdk = Object.assign(new Error("早先限流"), { status: 429 });
    const wrapped = Object.assign(new Error("网关断开", { cause: sdk }), {
      status: 502,
    });
    expect(classifyJobFailure(job, wrapped, 1, 1000)).toMatchObject({
      kind: "uncertain",
      code: "submission_unknown",
    });
  });

  it("遇到循环 cause 仍从已看到的供应商事实完成分类", async () => {
    // 隔离同步循环，旧代码卡住时由子进程期限回收，测试进程仍可报告失败。
    const { stdout } = await exec(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `
          import { classifyJobFailure } from ${JSON.stringify(
            new URL("./job-failure.ts", import.meta.url).href,
          )};
          const outer = new Error("包装错误");
          const inner = Object.assign(new Error("供应商拒绝", { cause: outer }), {
            statusCode: 403,
          });
          outer.cause = inner;
          process.stdout.write(JSON.stringify(classifyJobFailure(
            ${JSON.stringify(job)}, outer, 1, 1000,
          )));
        `,
      ],
      { timeout: 3000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      kind: "terminal",
      code: "provider_auth_failed",
    });
  }, 10_000);
});
