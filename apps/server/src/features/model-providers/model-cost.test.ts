import { describe, expect, it } from "vitest";

import { estimateModelCostUsd } from "./model-cost.js";

/** 用随包的真实 models.dev 目录验证估算，不打桩。 */
describe("estimateModelCostUsd", () => {
  it("目录命中：按输入、输出与缓存读取单价算出美元", () => {
    expect(
      estimateModelCostUsd("gpt-4.1", {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      }),
    ).toBeCloseTo(6, 8);
  });

  it("缓存读取 token 从普通输入里扣除，按 cache_read 单价计", () => {
    expect(
      estimateModelCostUsd("gpt-4.1", {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cachedInputTokens: 400_000,
      }),
    ).toBeCloseTo(5.4, 8);
  });

  it("未知模型返回 undefined，界面继续显示未统计", () => {
    expect(
      estimateModelCostUsd("no-such-model-in-catalog", {
        inputTokens: 100,
        outputTokens: 10,
      }),
    ).toBeUndefined();
    expect(
      estimateModelCostUsd("unknown", {
        inputTokens: 100,
        outputTokens: 10,
      }),
    ).toBeUndefined();
  });

  it("缓存数超过输入数时按输入封顶，不产生负数", () => {
    expect(
      estimateModelCostUsd("gpt-4.1", {
        inputTokens: 1_000,
        outputTokens: 0,
        cachedInputTokens: 5_000,
      }),
    ).toBeCloseTo(0.0005, 8);
  });

  it("零用量算出 0，而不是当作未上报", () => {
    expect(
      estimateModelCostUsd("gpt-4.1", { inputTokens: 0, outputTokens: 0 }),
    ).toBe(0);
  });
});
