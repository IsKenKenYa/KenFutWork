import { describe, expect, it } from "vitest";

import { contextUsageView, formatTokens } from "../src/lib/context-usage";

describe("formatTokens", () => {
  it("按中文习惯缩写万/亿，并去掉多余的 .0", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(614_000)).toBe("61.4万");
    expect(formatTokens(1_000_000)).toBe("100万");
    expect(formatTokens(12_000)).toBe("1.2万");
    expect(formatTokens(250_000_000)).toBe("2.5亿");
  });

  it("负数/非数当 0（不显示 NaN）", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("contextUsageView", () => {
  it("有窗口时给出容量与百分比", () => {
    const view = contextUsageView(
      { inputTokens: 614_000, outputTokens: 1200, cachedInputTokens: 613_000 },
      1_000_000,
    );
    expect(view).toMatchObject({
      hasUsage: true,
      inputLabel: "61.4万",
      windowLabel: "100万",
      percent: 61.4,
      percentLabel: "61.4%",
      cacheHitLabel: "99.8%",
      outputLabel: "1200",
    });
  });

  it("窗口未知：不给百分比（不编分母）", () => {
    const view = contextUsageView({ inputTokens: 1000, outputTokens: 10 }, null);
    expect(view.percent).toBeNull();
    expect(view.percentLabel).toBeNull();
    expect(view.inputLabel).toBe("1000");
  });

  it("上游未上报缓存：不给命中率（0% 会被读成缓存全失效）", () => {
    const view = contextUsageView(
      { inputTokens: 1000, outputTokens: 10 },
      8192,
    );
    expect(view.cacheHitLabel).toBeNull();
  });

  it("没有用量数据：整层为空态", () => {
    for (const usage of [null, undefined, { inputTokens: 0, outputTokens: 0 }]) {
      expect(contextUsageView(usage, 1_000_000).hasUsage).toBe(false);
    }
  });

  it("超过窗口时封顶 100%（不出现 137% 这种读数）", () => {
    const view = contextUsageView({ inputTokens: 1_370_000, outputTokens: 1 }, 1_000_000);
    expect(view.percent).toBe(100);
  });
});
