import { describe, expect, test } from "vitest";
import {
  OPEN_DESIGN_BRIDGE_SOURCE,
  buildCanvasDocument,
} from "../src/components/workbench/zcode/host/openDesignRuntime.js";
import {
  applyElementEdit,
  readElementHtml,
} from "../src/components/workbench/zcode/host/openDesignSourceEdit.js";

const SOURCE = `<!DOCTYPE html>
<html><head><title>登录</title></head>
<body><div id="app"><h1 class="t">登录</h1><p>请输入</p></div></body></html>`;

describe("buildCanvasDocument", () => {
  test("注入 base 与桥，且保留原正文", () => {
    const doc = buildCanvasDocument(
      SOURCE,
      "http://127.0.0.1:7456/api/projects/p-1/preview/tok/",
    );
    expect(doc).toContain(
      '<base data-kfw-od="base" href="http://127.0.0.1:7456/api/projects/p-1/preview/tok/">',
    );
    expect(doc).toContain("登录");
    expect(doc).toContain("请输入");
    expect(doc).toContain(OPEN_DESIGN_BRIDGE_SOURCE);
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  test("重复注入不累积：base 与桥各只有一个，且 base 在 head 最前", () => {
    const once = buildCanvasDocument(SOURCE, "http://x/preview/tok/");
    const twice = buildCanvasDocument(once, "http://y/preview/tok/");
    expect(twice.match(/data-kfw-od="base"/gu)).toHaveLength(1);
    expect(twice.match(/data-kfw-od="bridge"/gu)).toHaveLength(1);
    expect(twice).toContain('href="http://y/preview/tok/"');
    expect(twice).not.toContain("http://x/preview/tok/");
    const head = twice.slice(twice.indexOf("<head>"), twice.indexOf("</head>"));
    expect(head.indexOf("<base")).toBeLessThan(head.indexOf("<title"));
  });

  test("缺 head/body 的碎文档也能注入", () => {
    const doc = buildCanvasDocument("<p>只有正文</p>", "http://x/preview/tok/");
    expect(doc).toContain("只有正文");
    expect(doc).toContain('data-kfw-od="base"');
    expect(doc).toContain('data-kfw-od="bridge"');
  });
});

describe("源文本上的元素编辑", () => {
  test("readElementHtml 按 CSS 路径取回元素 HTML", () => {
    expect(readElementHtml(SOURCE, "#app > h1")).toBe(
      '<h1 class="t">登录</h1>',
    );
    expect(readElementHtml(SOURCE, "#missing")).toBeNull();
  });

  test("改样式写进 style 属性，其余内容一字不动", () => {
    const next = applyElementEdit(SOURCE, {
      path: "#app > h1",
      style: { color: "#ff0000", backgroundColor: "rgba(0,0,0,0)" },
    });
    expect(next).toContain('<h1 class="t" style="color: rgb(255, 0, 0);');
    expect(next).toContain("请输入");
    expect(next).toContain("<title>登录</title>");
  });

  test("替换 outerHTML：新结构落在原位，旧结构消失", () => {
    const next = applyElementEdit(SOURCE, {
      path: "#app > p",
      html: "<p><strong>必填</strong></p>",
    });
    expect(next).toContain("<strong>必填</strong>");
    expect(next).not.toContain("<p>请输入</p>");
  });

  test("路径找不到时返回 null，不猜位置写回", () => {
    expect(
      applyElementEdit(SOURCE, { path: "#app > section", html: "<x/>" }),
    ).toBeNull();
  });

  test("改过 id 的元素按新 id 找回；替换成纯文本视为无效编辑", () => {
    const renamed = applyElementEdit(SOURCE, {
      path: "#app > h1",
      html: '<h2 id="hero">注册</h2>',
    });
    expect(renamed).toContain('<h2 id="hero">注册</h2>');
    expect(renamed).not.toContain("<h1");

    expect(
      applyElementEdit(SOURCE, { path: "#app > h1", html: "   " }),
    ).toBeNull();
  });

  test("编辑不会把注入件烤进正文（源文本里没有 base/桥）", () => {
    const next = applyElementEdit(SOURCE, {
      path: "#app > h1",
      style: { color: "#123456" },
    });
    expect(next).not.toContain("data-kfw-od");
  });
});
