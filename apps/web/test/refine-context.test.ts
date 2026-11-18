import {
  buildRefineContext,
  VOICE_REFINE_CONTEXT_MESSAGE_CHARS,
} from "@kenfutwork/voice-ui";
import { describe, expect, it } from "vitest";

/**
 * 「想」段的指代消解上下文：单条截断、条数封顶、空条剔除。
 * 这是请求体大小的唯一闸门——不封顶就会把整段转录塞进改写请求。
 */
describe("buildRefineContext", () => {
  it("封顶到最近 6 条（契约上限），超出部分只留尾部", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      text: `第 ${index} 条`,
    }));
    const context = buildRefineContext(entries);
    expect(context).toHaveLength(6);
    expect(context[0]?.content).toBe("第 4 条");
    expect(context[5]?.content).toBe("第 9 条");
  });

  it("单条截断到上限并压平空白（不把整篇回复塞进请求）", () => {
    const long = `${"字".repeat(VOICE_REFINE_CONTEXT_MESSAGE_CHARS + 100)}`;
    const [context] = buildRefineContext([
      { role: "assistant", text: `你好\n\n   世界  ${long}` },
    ]);
    expect(context?.content.startsWith("你好 世界")).toBe(true);
    expect(context?.content).toHaveLength(VOICE_REFINE_CONTEXT_MESSAGE_CHARS);
  });

  it("空白条剔除；角色原样保留", () => {
    const context = buildRefineContext([
      { role: "user", text: "   " },
      { role: "user", text: "把按钮改成蓝色" },
      { role: "assistant", text: "已完成" },
    ]);
    expect(context).toEqual([
      { role: "user", content: "把按钮改成蓝色" },
      { role: "assistant", content: "已完成" },
    ]);
  });
});
