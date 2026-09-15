import { describe, expect, it } from "vitest";

import {
  contextUsageView,
  formatTokens,
  usageFromEvent,
} from "../src/lib/context-usage";

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

describe("usageFromEvent（run.usage 载荷 → 页面状态）", () => {
  it("真实网关载荷（探针实测样本）映射成快照", () => {
    expect(
      usageFromEvent({
        type: "run.usage",
        runId: "run_1",
        inputTokens: 8561,
        outputTokens: 20,
        cachedInputTokens: 0,
        timestamp: "2026-09-15T17:35:54.747Z",
      }),
    ).toEqual({ inputTokens: 8561, outputTokens: 20, cachedInputTokens: 0 });
  });

  it("没有 inputTokens（老服务端不发这个事件）返回 null，不写成 0", () => {
    expect(usageFromEvent({ type: "run.usage", outputTokens: 5 })).toBeNull();
    expect(usageFromEvent(null)).toBeNull();
    expect(usageFromEvent("run.usage")).toBeNull();
  });

  it("上游未上报缓存：快照里没有 cachedInputTokens 字段", () => {
    expect(usageFromEvent({ inputTokens: 100 })).toEqual({
      inputTokens: 100,
      outputTokens: 0,
    });
  });
});

describe("窗口已知但本轮还没有用量（回归：文案不许把两件事混成一件）", () => {
  it("窗口已声明 + 无用量：windowKnown 为 true，不是「没有声明窗口」", () => {
    const view = contextUsageView(null, 1_000_000);
    expect(view.hasUsage).toBe(false);
    expect(view.windowKnown).toBe(true);
    expect(view.windowLabel).toBe("100万");
    expect(view.percent).toBeNull();
  });

  it("窗口缺失 + 无用量：windowKnown 为 false", () => {
    expect(contextUsageView(null, null).windowKnown).toBe(false);
    expect(contextUsageView(null, 0).windowKnown).toBe(false);
  });
});
