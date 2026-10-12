import { describe, expect, it } from "vitest";

import {
  FRAMEWORK_FALLBACK_TRIGGER_TOKENS,
  resolveCompactionPlan,
  resolveInputTokenLimit,
} from "./auto-compact.js";

/**
 * 压缩触发线的口径（R4-1「输出预留线」的执行面）。
 *
 * 最要紧的一条：**界面上画的那条线就是实际压缩点**——两边算的不是同一个数时，
 * 用户会按界面判断「还早」，而模型那边已经在丢历史。
 */
describe("自动压缩触发线", () => {
  it("窗口与最大输出都声明：触发线 = 窗口 − 预留输出（与上下文条同一根线）", () => {
    const plan = resolveCompactionPlan({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(plan.trigger).toEqual({ type: "tokens", value: 872_000 });
    expect(plan.source).toBe("reserved-output");
    expect(plan.keep).toEqual({ type: "messages", value: 20 });
  });

  it("只有窗口：按框架约定取 85%（PROFILE_TRIGGER）", () => {
    const plan = resolveCompactionPlan({ contextWindow: 200_000 });
    expect(plan.trigger.value).toBe(170_000);
    expect(plan.source).toBe("fraction");
  });

  it("窗口未知：默认阈值170k，近期原文保留目标为6", () => {
    const plan = resolveCompactionPlan({ contextWindow: null });
    expect(plan.trigger.value).toBe(FRAMEWORK_FALLBACK_TRIGGER_TOKENS);
    expect(plan.keep.value).toBe(6);
    expect(plan.source).toBe("fallback");
  });

  it("真实输出上限占满或超出已知窗口：拒绝虚构可用输入预算", () => {
    for (const maxOutputTokens of [1000, 5000]) {
      expect(() =>
        resolveCompactionPlan({ contextWindow: 1000, maxOutputTokens }),
      ).toThrow("输出上限已占满上下文");
    }
  });
  it("小剩余预算不被4000 floor扩大；未知窗口fallback保持不变", () => {
    expect(
      resolveCompactionPlan({ contextWindow: 8192, maxOutputTokens: 8000 })
        .trigger.value,
    ).toBe(192);
    expect(resolveCompactionPlan({ contextWindow: 1000 }).trigger.value).toBe(
      850,
    );
    expect(
      resolveCompactionPlan({ contextWindow: null, maxOutputTokens: 8000 })
        .trigger.value,
    ).toBe(170_000);
  });

  it("垃圾输入（0 / 负数 / NaN）当作未知，走回退", () => {
    for (const bad of [0, -1, Number.NaN]) {
      const plan = resolveCompactionPlan({
        contextWindow: bad,
        maxOutputTokens: bad,
      });
      expect(plan.source).toBe("fallback");
      expect(plan.trigger.value).toBe(FRAMEWORK_FALLBACK_TRIGGER_TOKENS);
    }
  });
});

it("hard input cap is separate from an earlier trigger and never invents unknown output/window", () => {
  expect(
    resolveInputTokenLimit({ contextWindow: 8192, maxOutputTokens: 8000 }),
  ).toBe(192);
  expect(
    resolveInputTokenLimit({ contextWindow: 8192, maxOutputTokens: null }),
  ).toBe(8192);
  expect(
    resolveInputTokenLimit({ contextWindow: null, maxOutputTokens: 8000 }),
  ).toBeNull();
  expect(() =>
    resolveInputTokenLimit({ contextWindow: 8192, maxOutputTokens: 8192 }),
  ).toThrow("输出上限已占满");
});
