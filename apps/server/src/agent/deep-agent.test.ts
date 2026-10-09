import { describe, expect, it } from "vitest";

import { createStreamingChatModel } from "./deep-agent.js";

/**
 * BYOK 模型声明的 maxOutputTokens 要转发上游（ChatOpenAI maxTokens）：
 * reasoning 模型在上游默认 max_tokens 下可能把输出预算先烧在思考上，
 * 表现为「模型没有返回任何内容」。声明了就带，没声明不带（LangChain 缺省）。
 */
describe("createStreamingChatModel 的输出上限转发", () => {
  it("声明了 maxOutputTokens 就透传为 maxTokens", () => {
    const model = createStreamingChatModel(
      "openai:GLM-5.3-Flash",
      128_000,
    ) as unknown as { maxTokens?: number };
    expect(model.maxTokens).toBe(128_000);
  });

  it("未声明时不带 maxTokens（保持上游缺省）", () => {
    const model = createStreamingChatModel(
      "openai:GLM-5.3-Flash",
    ) as unknown as { maxTokens?: number };
    expect(model.maxTokens).toBeUndefined();
  });

  it("非正数视同未声明", () => {
    const model = createStreamingChatModel(
      "openai:GLM-5.3-Flash",
      0,
    ) as unknown as { maxTokens?: number };
    expect(model.maxTokens).toBeUndefined();
  });
});
