import { describe, expect, it } from "vitest";

import { dropPartialAssistantTail } from "../src/lib/run-events";

describe("重试时丢弃半截回复", () => {
  it("末尾是正在流出的 assistant 消息：丢掉它（重试整段重来）", () => {
    const messages = [
      { role: "user", text: "问题" },
      { role: "assistant", text: "半截…" },
    ];
    expect(dropPartialAssistantTail(messages)).toEqual([{ role: "user", text: "问题" }]);
  });

  it("末尾是 user（本轮还没流出任何内容）：原样返回", () => {
    const messages = [{ role: "user", text: "问题" }];
    expect(dropPartialAssistantTail(messages)).toEqual(messages);
  });

  it("空列表：原样返回（不越界）", () => {
    expect(dropPartialAssistantTail([])).toEqual([]);
  });
});
