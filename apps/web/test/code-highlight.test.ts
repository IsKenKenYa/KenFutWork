import { describe, expect, it } from "vitest";

import { highlightCode, languageForPath } from "../src/lib/code-highlight";

/**
 * 文件预览的高亮：**只认扩展名**、判不出来回落到纯文本、输出必须是已转义的 HTML
 * （因为界面用 dangerouslySetInnerHTML 渲染）。
 */
describe("文件预览高亮", () => {
  it("按扩展名认语言（含点开头的配置文件与无扩展名的约定文件）", () => {
    expect(languageForPath("src/app.ts")).toBe("typescript");
    expect(languageForPath("src/App.tsx")).toBe("typescript");
    expect(languageForPath("scripts/run.mjs")).toBe("javascript");
    expect(languageForPath("deploy/Dockerfile")).toBe("dockerfile");
    expect(languageForPath(".env.local")).toBe("ini");
    expect(languageForPath("README.md")).toBe("markdown");
  });

  it("认不出来返回 null（界面按纯文本显示，不硬套一个语言）", () => {
    expect(languageForPath("notes")).toBeNull();
    expect(languageForPath("data.unknownext")).toBeNull();
  });

  it("高亮输出是已转义的 HTML：喂 <script> 出来的是 &lt;script&gt;", () => {
    const html = highlightCode(
      'const a = "<script>alert(1)</script>";',
      "a.ts",
    );
    expect(html).not.toBeNull();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("认不出语言时返回 null（调用方回落纯文本）", () => {
    expect(highlightCode("hello", "notes")).toBeNull();
  });

  it("空内容不炸", () => {
    expect(highlightCode("", "a.ts")).toBe("");
  });
});
