import { expect, it } from "vitest";
import { fileDiffDisplay, fileDiffsDisplay } from "./file-display.js";

const hunk = {
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  lines: ["-old", "+new"],
};

it("有界展示只留完整hunk，真实总counts不因截断缩水，不改canonical补丁", () => {
  const large = { ...hunk, lines: ["-before", `+${"多".repeat(800)}`] };
  const input = { filePath: "/work/a.ts", structuredPatch: [hunk, large] };
  const original = structuredClone(input);
  const budget = new TextEncoder().encode(JSON.stringify([hunk])).byteLength;
  const display = fileDiffDisplay(input, budget);
  expect(display).toEqual({
    kind: "file_diff",
    filePath: input.filePath,
    additions: 2,
    deletions: 2,
    structuredPatch: [hunk],
    truncated: true,
  });
  expect(
    new TextEncoder().encode(JSON.stringify(display.structuredPatch))
      .byteLength,
  ).toBeLessThanOrEqual(budget);
  expect(input).toEqual(original);
  expect(fileDiffDisplay(input, 0)).toMatchObject({
    structuredPatch: [],
    additions: 2,
    deletions: 2,
    truncated: true,
  });
  expect(() => fileDiffDisplay(input, Number.NaN)).toThrow("字节预算无效");
});

it("多文件预算共享，未展示项保真实路径/counts和truncated，不伪造已提交数量", () => {
  const files = ["/work/a.ts", "/work/b.ts"].map((filePath) => ({
    filePath,
    type: "update" as const,
    structuredPatch: [hunk],
    additions: 1,
    deletions: 1,
    version: "v",
  }));
  const budget =
    new TextEncoder().encode(JSON.stringify([hunk])).byteLength +
    new TextEncoder().encode("[]").byteLength;
  expect(fileDiffsDisplay(files, budget)).toEqual({
    kind: "file_diffs",
    files: [
      {
        kind: "file_diff",
        filePath: files[0]!.filePath,
        additions: 1,
        deletions: 1,
        structuredPatch: [hunk],
      },
      {
        kind: "file_diff",
        filePath: files[1]!.filePath,
        additions: 1,
        deletions: 1,
        structuredPatch: [],
        truncated: true,
      },
    ],
    truncated: true,
  });
});
