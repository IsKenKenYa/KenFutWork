import { describe, expect, it } from "vitest";

import {
  FRAMEWORK_FALLBACK_KEEP_MESSAGES,
  FRAMEWORK_FALLBACK_TRIGGER_TOKENS,
  KEEP_MESSAGES,
  MIN_TRIGGER_TOKENS,
  resolveCompactionPlan,
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
    expect(plan.keep).toEqual({ type: "messages", value: KEEP_MESSAGES });
  });

  it("只有窗口：按框架约定取 85%（PROFILE_TRIGGER）", () => {
    const plan = resolveCompactionPlan({ contextWindow: 200_000 });
    expect(plan.trigger.value).toBe(170_000);
    expect(plan.source).toBe("fraction");
  });

  it("窗口未知：用框架回退值（170k / 保留 6 条），不自己编数字", () => {
    const plan = resolveCompactionPlan({ contextWindow: null });
    expect(plan.trigger.value).toBe(FRAMEWORK_FALLBACK_TRIGGER_TOKENS);
    expect(plan.keep.value).toBe(FRAMEWORK_FALLBACK_KEEP_MESSAGES);
    expect(plan.source).toBe("fallback");
  });

  it("最大输出大于窗口（配置写错）：预留封顶到窗口，触发线落到下限而不是负数", () => {
    const plan = resolveCompactionPlan({
      contextWindow: 1000,
      maxOutputTokens: 5000,
    });
    expect(plan.trigger.value).toBe(MIN_TRIGGER_TOKENS);
    expect(plan.source).toBe("reserved-output");
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
