import { describe, expect, it } from "vitest";

import { diffLines, summarizeDiff } from "./diff.js";

describe("diffLines（行级 LCS diff）", () => {
  it("识别新增/删除/上下文", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc");
    expect(lines).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "B" },
      { type: "context", text: "c" },
    ]);
    expect(summarizeDiff(lines)).toBe("+1 -1");
  });

  it("空输入与全等输入不产生差异", () => {
    expect(diffLines("", "")).toEqual([{ type: "context", text: "" }]);
    expect(diffLines("x", "x")).toEqual([{ type: "context", text: "x" }]);
    expect(summarizeDiff(diffLines("x", "x"))).toBe("+0 -0");
  });

  it("纯增/纯删与越界回绕", () => {
    expect(diffLines("a", "a\nb").filter((l) => l.type === "added")).toEqual([
      { type: "added", text: "b" },
    ]);
    expect(diffLines("a\nb", "a").filter((l) => l.type === "removed")).toEqual([
      { type: "removed", text: "b" },
    ]);
    // 空文件按「一个空行」计：删除空行 + 新增两行
    expect(diffLines("", "a\nb").map((l) => l.type)).toEqual([
      "removed",
      "added",
      "added",
    ]);
  });
});
