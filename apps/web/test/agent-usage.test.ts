import { describe, expect, it } from "vitest";

import { formatAgentUsage } from "../src/components/workbench/zcode/ToolCallBlocks/renderers/agentHelpers.js";

/** 子代理卡片用量：有数据、无数据、部分数据三种形态，缺省一律读作「未统计」。 */
describe("formatAgentUsage", () => {
  it("有数据：输入与输出都按真实读数显示", () => {
    expect(formatAgentUsage({ inputTokens: 1_200, outputTokens: 340 })).toBe(
      "用量 输入 1.2k 输出 340",
    );
  });

  it("无数据：整块缺省时显示未统计，不显示 0", () => {
    expect(formatAgentUsage(undefined)).toBe("用量 未统计");
    expect(formatAgentUsage({})).toBe("用量 未统计");
  });

  it("部分数据：已知一侧显示读数，缺的一侧显示未统计", () => {
    expect(formatAgentUsage({ inputTokens: 900 })).toBe(
      "用量 输入 900 输出 未统计",
    );
    expect(formatAgentUsage({ outputTokens: 1_000 })).toBe(
      "用量 输入 未统计 输出 1k",
    );
  });
});
