import { describe, expect, it } from "vitest";

import {
  describeRunFailure,
  GENERIC_RUN_FAILURE_TEXT,
} from "../src/lib/run-failure.js";

/**
 * 回归：`run.failed` 曾把服务端给的可读原因整个丢掉，只显示固定的
 * 「运行失败，请重试。」——用户因此不知道是上游停滞、要换模型，还是没绑定项目。
 */
describe("run.failed 的失败说明", () => {
  it("透出服务端 error.message（上游停滞这类原因要能读到）", () => {
    expect(
      describeRunFailure({
        type: "run.failed",
        error: {
          code: "run_failed",
          message: "模型流已 180 秒没有任何输出（上游停滞），本轮已终止。",
        },
      }),
    ).toBe("模型流已 180 秒没有任何输出（上游停滞），本轮已终止。");
  });

  it("透出「未绑定项目」这类可操作原因", () => {
    expect(
      describeRunFailure({
        error: {
          code: "run_failed",
          message:
            "canvasId is required for production (state) backend mode. Each agent run must be scoped to a project.",
        },
      }),
    ).toContain("canvasId is required");
  });

  it("原因两侧空白被裁掉", () => {
    expect(describeRunFailure({ error: { message: "  失败原因  " } })).toBe(
      "失败原因",
    );
  });

  it("缺原因/形状异常 → 回落到通用文案（不显示空白气泡）", () => {
    expect(describeRunFailure(undefined)).toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(describeRunFailure(null)).toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(describeRunFailure({})).toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(describeRunFailure({ error: {} })).toBe(GENERIC_RUN_FAILURE_TEXT);
    expect(describeRunFailure({ error: { message: "" } })).toBe(
      GENERIC_RUN_FAILURE_TEXT,
    );
    expect(describeRunFailure({ error: { message: "   " } })).toBe(
      GENERIC_RUN_FAILURE_TEXT,
    );
    expect(describeRunFailure({ error: { message: 42 } })).toBe(
      GENERIC_RUN_FAILURE_TEXT,
    );
    expect(describeRunFailure("boom")).toBe(GENERIC_RUN_FAILURE_TEXT);
  });

  it("有错误码但没文案时带上错误码（不再只说「运行失败」）", () => {
    expect(describeRunFailure({ error: { code: "run_failed" } })).toBe(
      `${GENERIC_RUN_FAILURE_TEXT}（错误码 run_failed）`,
    );
  });

  /** 服务端的「通用文案 + 原始错误」要原样进对话气泡（用户要求能看到上游原文）。 */
  it("多行原文（通用文案 + 原始错误）原样透出", () => {
    const message =
      'AI 服务暂时不可用，请稍后重试。\n\n原始错误：400 {"error":{"message":"model not found"}}';
    expect(
      describeRunFailure({ error: { code: "run_failed", message } }),
    ).toBe(message);
  });
});
