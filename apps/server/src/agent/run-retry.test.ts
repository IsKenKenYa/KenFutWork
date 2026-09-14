import { describe, expect, it } from "vitest";

import {
  clampMaxRunRetries,
  DEFAULT_MAX_RUN_RETRIES,
  decideRunRetry,
  isRetryableRunFailure,
  MAX_RUN_RETRIES_UPPER_BOUND,
} from "./run-retry.js";

/** 上游停滞的真实文案（stream-idle-guard 产出）。 */
const STALL =
  "模型流已 180 秒没有任何输出（上游停滞），本轮已终止。请重试或更换模型。";

describe("重试上限的收敛", () => {
  it("缺省 10；0 表示不重试", () => {
    expect(clampMaxRunRetries(undefined)).toBe(DEFAULT_MAX_RUN_RETRIES);
    expect(DEFAULT_MAX_RUN_RETRIES).toBe(10);
    expect(clampMaxRunRetries(0)).toBe(0);
  });

  it("非法/越界值被收敛（负数→0，超大→上限，小数→截断）", () => {
    expect(clampMaxRunRetries(-5)).toBe(0);
    expect(clampMaxRunRetries(9999)).toBe(MAX_RUN_RETRIES_UPPER_BOUND);
    expect(clampMaxRunRetries(3.9)).toBe(3);
    expect(clampMaxRunRetries("7")).toBe(7);
    expect(clampMaxRunRetries("abc")).toBe(DEFAULT_MAX_RUN_RETRIES);
    expect(clampMaxRunRetries(null)).toBe(DEFAULT_MAX_RUN_RETRIES);
  });
});

describe("可重试判定", () => {
  it("上游停滞可重试", () => {
    expect(isRetryableRunFailure(STALL)).toBe(true);
  });

  it("没给原因时按可重试处理（常见的是上游抖动）", () => {
    expect(isRetryableRunFailure(undefined)).toBe(true);
    expect(isRetryableRunFailure("   ")).toBe(true);
  });

  it("永久性失败不重试：未绑项目 / 未授权 / 额度", () => {
    expect(
      isRetryableRunFailure(
        "canvasId is required for production (state) backend mode. Each agent run must be scoped to a project.",
      ),
    ).toBe(false);
    expect(isRetryableRunFailure("unauthorized")).toBe(false);
    expect(isRetryableRunFailure("余额不足，请充值")).toBe(false);
  });
});

describe("重试决策", () => {
  const base = {
    attempt: 1,
    maxAttempts: 10,
    failureMessage: STALL,
    sawToolExecution: false,
  };

  it("首次失败且没跑过工具 → 重试", () => {
    expect(decideRunRetry(base)).toEqual({
      retry: true,
      reason: "第 1 次失败，准备第 2 次（上限 10）",
    });
  });

  /**
   * 最重要的一条：**已执行工具就不重试**。否则会重复写文件/重复执行命令，副作用翻倍。
   */
  it("本轮已执行工具 → 不重试（副作用安全优先）", () => {
    const decision = decideRunRetry({ ...base, sawToolExecution: true });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/副作用/);
  });

  it("达到上限即停（attempt = maxAttempts）", () => {
    const decision = decideRunRetry({ ...base, attempt: 10, maxAttempts: 10 });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/上限/);
  });

  it("上限设为 0/1（用户关掉重试）→ 永不重试", () => {
    expect(decideRunRetry({ ...base, maxAttempts: 1 }).retry).toBe(false);
    expect(decideRunRetry({ ...base, maxAttempts: 0 }).retry).toBe(false);
  });

  it("永久性失败不重试，且原因里带上原文便于排查", () => {
    const decision = decideRunRetry({
      ...base,
      failureMessage:
        "canvasId is required for production (state) backend mode.",
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/永久性失败/);
  });

  it("副作用与上限同时存在时，副作用优先判否（先说不安全的事）", () => {
    const decision = decideRunRetry({
      ...base,
      attempt: 10,
      maxAttempts: 10,
      sawToolExecution: true,
    });
    expect(decision.retry).toBe(false);
  });
});
