import { describe, expect, it } from "vitest";

import {
  hunkPatch,
  markHunkStarts,
  splitHunks,
  toDiffLines,
} from "../src/lib/git-hunks";

/**
 * 「暂存块」的 diff 切分：文件头要和块拼回去才是一份能 apply 的 patch
 * （只发块本身，git 会报「缺少文件名信息」——实测踩过）。
 */
const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " line1",
  "-old2",
  "+new2",
  " line3",
  "@@ -20,3 +20,4 @@ function tail() {",
  " line20",
  "+extra",
  " line21",
  "",
].join("\n");

describe("暂存块的 diff 切分", () => {
  it("切成文件头 + 两块", () => {
    const { fileHeader, hunks } = splitHunks(DIFF);
    expect(fileHeader.split("\n")).toEqual([
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
    ]);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.header).toBe("@@ -1,3 +1,3 @@");
    expect(hunks[1]?.header).toBe("@@ -20,3 +20,4 @@ function tail() {");
  });

  it("拼出的 patch = 文件头 + 这一块（可直接喂给 git apply）", () => {
    const { fileHeader, hunks } = splitHunks(DIFF);
    const patch = hunkPatch(fileHeader, hunks[1]!);
    expect(patch.startsWith("diff --git a/src/app.ts b/src/app.ts\n")).toBe(true);
    expect(patch).toContain("+++ b/src/app.ts\n@@ -20,3 +20,4 @@");
    expect(patch).toContain("+extra");
    // 第二块的 patch 不该带第一块的改动
    expect(patch).not.toContain("+new2");
    expect(patch.endsWith("\n")).toBe(true);
  });

  it("末行没有换行也补上（否则 git 认为 patch 被截断）", () => {
    const { fileHeader, hunks } = splitHunks(
      `${DIFF.trimEnd()}`,
    );
    const patch = hunkPatch(fileHeader, hunks[0]!);
    expect(patch.endsWith("\n")).toBe(true);
  });

  it("没有块（未跟踪文件的合成视图）：原样返回、不硬造块", () => {
    const synthetic = "+第一行\n+第二行";
    const { fileHeader, hunks } = splitHunks(synthetic);
    expect(hunks).toEqual([]);
    expect(fileHeader).toBe(synthetic);
  });

  it("行类型：meta / hunk / add / del / context 分清（上色用）", () => {
    const lines = toDiffLines(DIFF);
    const kinds = new Map(lines.map((line) => [line.text, line.kind]));
    expect(kinds.get("diff --git a/src/app.ts b/src/app.ts")).toBe("meta");
    expect(kinds.get("@@ -1,3 +1,3 @@")).toBe("hunk");
    expect(kinds.get("-old2")).toBe("del");
    expect(kinds.get("+new2")).toBe("add");
    expect(kinds.get(" line1")).toBe("context");
  });

  it("标块号：每块第一行带 hunkIndex，其余不带", () => {
    const marked = markHunkStarts(toDiffLines(DIFF));
    const withIndex = marked.filter((line) => line.hunkIndex !== undefined);
    expect(withIndex.map((line) => line.hunkIndex)).toEqual([0, 1]);
    expect(withIndex.map((line) => line.text)).toEqual([
      "@@ -1,3 +1,3 @@",
      "@@ -20,3 +20,4 @@ function tail() {",
    ]);
  });

  it("空输入不炸", () => {
    expect(splitHunks("").hunks).toEqual([]);
    expect(toDiffLines("")).toHaveLength(1);
  });
});
