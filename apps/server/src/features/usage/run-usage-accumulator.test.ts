import { describe, expect, it } from "vitest";

import { createRunUsageAccumulator } from "./run-usage-accumulator.js";

describe("runUsageAccumulator（agent 链路用量累积）", () => {
  it("update 覆盖为最新累计值，take 取出后清理", () => {
    const acc = createRunUsageAccumulator();
    acc.update("run-1", {
      inputTokens: 10,
      outputTokens: 5,
      provider: "instance",
      model: "gpt-x",
      userId: "u1",
    });
    acc.update("run-1", {
      inputTokens: 30,
      outputTokens: 20,
      provider: "instance",
      model: "gpt-x",
      userId: "u1",
    });
    expect(acc.take("run-1")).toEqual({
      inputTokens: 30,
      outputTokens: 20,
      provider: "instance",
      model: "gpt-x",
      userId: "u1",
    });
    expect(acc.take("run-1")).toBeUndefined();
    expect(acc.take("run-2")).toBeUndefined();
  });
});
