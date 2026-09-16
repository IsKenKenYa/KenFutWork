import { describe, expect, it } from "vitest";

import { patchTargetPaths, patchTargetsOnly } from "./hunk-patch.js";

/**
 * 「暂存块」的 patch 校验：**patch 里的路径才是 git 真会动的路径**，
 * 服务端必须核对它只有声明的那个文件——否则手工拼的 patch 能把任意文件塞进索引。
 */
const HEADER = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
].join("\n");

describe("暂存块的 patch 校验", () => {
  it("提取被改的文件路径（diff --git 与 +++ 两种写法只算一份）", () => {
    expect(patchTargetPaths(`${HEADER}\n@@ -1 +1 @@\n-a\n+b\n`)).toEqual([
      "src/app.ts",
    ]);
  });

  it("重命名：b 侧路径与 a 侧不同时取 b 侧", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
    ].join("\n");
    expect(patchTargetPaths(patch)).toEqual(["new.ts"]);
  });

  it("只动声明的那个文件 → 放行", () => {
    expect(
      patchTargetsOnly(`${HEADER}\n@@ -1 +1 @@\n-a\n+b\n`, "src/app.ts"),
    ).toBe(true);
  });

  it("patch 里夹带别的文件 → 拒绝（不许拿它改索引里的其它文件）", () => {
    const sneaky = [
      HEADER,
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/.env b/.env",
      "index 3333333..4444444 100644",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-SECRET=old",
      "+SECRET=new",
    ].join("\n");
    expect(patchTargetsOnly(sneaky, "src/app.ts")).toBe(false);
  });

  it("声明的路径与 patch 不一致 → 拒绝", () => {
    expect(patchTargetsOnly(`${HEADER}\n@@ -1 +1 @@\n-a\n+b\n`, "other.ts")).toBe(
      false,
    );
  });

  it("空 patch / 认不出路径 → 拒绝（不放看不懂的东西进 git）", () => {
    expect(patchTargetsOnly("", "src/app.ts")).toBe(false);
    expect(patchTargetsOnly("@@ -1 +1 @@\n-a\n+b\n", "src/app.ts")).toBe(false);
  });
});
