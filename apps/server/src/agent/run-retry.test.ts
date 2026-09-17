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

  it("认证/凭据类失败不重试（实测：改名换盐后每轮被重试 10 次全是「认证失败」）", () => {
    expect(isRetryableRunFailure("认证失败，请刷新页面重新登录。")).toBe(false);
    expect(
      isRetryableRunFailure(
        "Unable to decrypt provider credentials (fail loud).",
      ),
    ).toBe(false);
    expect(isRetryableRunFailure("invalid token")).toBe(false);
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

  /**
   * 回归（GUI 全流程实测）：成功收场的一轮**没有** `run.failed`，`failureMessage` 仍是
   * undefined，而 `isRetryableRunFailure(undefined)` 按「可重试」处理 —— 于是纯对话轮次
   * 被重跑满 10 次（实测 solo 与画布助手一次消息产出 10 个 run、10 倍 token，而用户看到的
   * 回复第一次就成功了）。显式终态必须直接判否。
   */
  it("显式成功终态 → 不重试（哪怕没跑工具、没有失败原因）", () => {
    const decision = decideRunRetry({
      ...base,
      failureMessage: undefined,
      sawToolExecution: false,
      terminal: "completed",
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/成功完成/);
  });

  it("用户取消 → 不重试（否则会把刚取消的轮次顶回去）", () => {
    const decision = decideRunRetry({
      ...base,
      failureMessage: undefined,
      sawToolExecution: false,
      terminal: "canceled",
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/取消/);
  });

  it("无终态且无失败原因（流静默结束）仍按可重试处理", () => {
    const decision = decideRunRetry({
      ...base,
      failureMessage: undefined,
      sawToolExecution: false,
      terminal: undefined,
    });
    expect(decision.retry).toBe(true);
  });
});

/**
 * 服务端已判定的失败（terminal="failed"）：**不自动重试**。
 * 场景：模型只输出内部思考、没有正文也没有工具调用（实测 aiping GLM-5.3-Flash 可复现）——
 * 再跑一遍大概率还是空的，自动重试只会白烧额度。
 */
describe("空输出（服务端判定失败）不自动重试", () => {
  it("terminal=failed 时不重试，即使还没到上限、也没跑过工具", () => {
    const decision = decideRunRetry({
      attempt: 1,
      maxAttempts: 10,
      failureMessage: "模型本轮没有返回任何内容（可能只输出了内部思考或触发内容过滤）。",
      sawToolExecution: false,
      terminal: "failed",
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/空输出|已判定/);
  });
});
