import { describe, expect, it } from "vitest";

import { knownContextWindow, resolveContextWindow } from "./model-context-windows.js";

/**
 * 上下文窗口兜底表：**声明优先**，没声明按常见族给公开值，认不出返回 null（不编数字）。
 */
describe("上下文窗口兜底表", () => {
  it("按族认窗口（含 BYOK 的 <实例id>:<模型> 前缀写法）", () => {
    expect(knownContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(knownContextWindow("gemini-2.5-pro")).toBe(1_048_576);
    expect(knownContextWindow("glm-5.3-flash")).toBe(1_000_000);
    expect(knownContextWindow("glm-4.6")).toBe(200_000);
    expect(knownContextWindow("gpt-4o-mini")).toBe(128_000);
    expect(knownContextWindow("c0ff5970:glm-5.3-flash")).toBe(1_000_000);
  });

  it("认不出返回 null（界面按「窗口未知」处理，不编造）", () => {
    expect(knownContextWindow("my-local-model")).toBeNull();
    expect(knownContextWindow("")).toBeNull();
  });

  it("实例里声明过就用声明的（哪怕与兜底表不同）", () => {
    expect(resolveContextWindow(2_000_000, "glm-5.3-flash")).toBe(2_000_000);
    expect(resolveContextWindow(null, "glm-5.3-flash")).toBe(1_000_000);
    expect(resolveContextWindow(null, "unknown-model")).toBeNull();
  });
});
