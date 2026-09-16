import { describe, expect, it } from "vitest";

import { normalizeToolArgs } from "../src/lib/tool-args";

/**
 * 回归背景（2026-09-16 GUI 实测抓到的真 bug）：服务端透传的 tool.started.input
 * 是**包了一层**的节点输入，`{input: "<json 字符串>"}`，而不是逻辑参数本身。
 * 之前按逻辑形状取值 → 待办面板永不出现、子代理名回落成工具名，且完全静默。
 * 下面的样本是从真实 WS 事件里抄下来的。
 */
describe("normalizeToolArgs", () => {
  it("剥掉 {input: '<json>'} 包装（真实载荷样本）", () => {
    const real = {
      input:
        '{"todos":[{"content":"创建 kfw-s1.txt 并写入 1","status":"in_progress"},{"content":"创建 kfw-s2.txt 并写入 2","status":"pending"}]}',
    };
    expect(normalizeToolArgs(real)).toEqual({
      todos: [
        { content: "创建 kfw-s1.txt 并写入 1", status: "in_progress" },
        { content: "创建 kfw-s2.txt 并写入 2", status: "pending" },
      ],
    });
  });

  it("内层已经是对象时直接用它", () => {
    expect(normalizeToolArgs({ input: { query: "python" } })).toEqual({
      query: "python",
    });
  });

  it("逻辑形状（没有包装）原样返回", () => {
    expect(normalizeToolArgs({ todos: [] })).toEqual({ todos: [] });
    expect(normalizeToolArgs({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("工具真的带 input 参数时（外层还有别的键）不误剥", () => {
    expect(normalizeToolArgs({ input: "text", cwd: "/x" })).toEqual({
      input: "text",
      cwd: "/x",
    });
  });

  it("坏输入返回 null（不是对象 / 字符串不是 JSON）", () => {
    expect(normalizeToolArgs(undefined)).toBeNull();
    expect(normalizeToolArgs(null)).toBeNull();
    expect(normalizeToolArgs("todos")).toBeNull();
    expect(normalizeToolArgs([1, 2])).toBeNull();
    expect(normalizeToolArgs({ input: "not-json" })).toBeNull();
    expect(normalizeToolArgs({ input: "[1,2]" })).toBeNull();
  });
});
