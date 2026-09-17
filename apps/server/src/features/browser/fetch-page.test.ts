import { describe, expect, it, vi } from "vitest";

import {
  BrowserFetchError,
  decodeEntities,
  extractElements,
  extractTitle,
  fetchPageSnapshot,
} from "./fetch-page.js";

/**
 * 受控网页抓取（R3-4 / R5-4 的共同底座）：只允许 http/https、拦云元数据地址、
 * 有超时与体积上限、元素提取给出「文字 + 定位提示」。
 */
describe("受控网页抓取", () => {
  it("非 http/https 与非 URL 一律拒绝（可读原因）", async () => {
    await expect(
      fetchPageSnapshot("file:///C:/Windows/win.ini"),
    ).rejects.toMatchObject({
      code: "invalid_url",
    });
    await expect(fetchPageSnapshot("不是地址")).rejects.toMatchObject({
      code: "invalid_url",
    });
  });

  it("云元数据地址直接拦下（SSRF 面收在这里）", async () => {
    await expect(
      fetchPageSnapshot("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toMatchObject({ code: "blocked_host" });
  });

  it("抓到页面：标题 + 正文 + 元素；HTTP 错误与超大可读报错", async () => {
    const html = `
      <html><head><title>演示页 &amp; 测试</title></head>
      <body>
        <h1>欢迎</h1>
        <a href="https://example.com/a">第一个链接</a>
        <button id="go">开始</button>
        <input type="text" name="q" placeholder="搜索…" />
        <img src="/x.png" alt="示例图" />
        <script>var x = 1;</script>
      </body></html>`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    const snapshot = await fetchPageSnapshot("https://example.com/", {
      fetchImpl,
    });
    expect(snapshot.title).toBe("演示页 & 测试");
    expect(snapshot.text).toContain("欢迎");
    expect(snapshot.text).not.toContain("var x = 1");
    expect(snapshot.elements).toEqual([
      { tag: "a", text: "第一个链接", hint: 'a[href="https://example.com/a"]' },
      { tag: "button", text: "开始", hint: "button#go" },
      { tag: "input", text: "搜索…", hint: 'input[type="text"][name="q"]' },
      { tag: "img", text: "示例图", hint: "img" },
      { tag: "h1", text: "欢迎", hint: "h1" },
    ]);

    const notFound = vi.fn(
      async () => new Response("no", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchPageSnapshot("https://example.com/missing", { fetchImpl: notFound }),
    ).rejects.toMatchObject({ code: "fetch_failed" });

    const huge = vi.fn(
      async () => new Response("x".repeat(1000), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchPageSnapshot("https://example.com/big", {
        fetchImpl: huge,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("元素提取：脚本/样式/注释先剥掉，上限截断", () => {
    const html =
      "<script><a href='x'>假链接</a></script><style>a{}</style><!--<a>x</a>-->" +
      "<a href='1'>真</a>";
    expect(extractElements(html)).toEqual([
      { tag: "a", text: "真", hint: 'a[href="1"]' },
    ]);
    const many = Array.from(
      { length: 10 },
      (_, i) => `<button>b${i}</button>`,
    ).join("");
    expect(extractElements(many, 3)).toHaveLength(3);
  });

  it("实体解码与标题回落（无 title 时用首个 h1）", () => {
    expect(decodeEntities("a&ensp;b&amp;c&#65;")).toBe("a b&cA");
    expect(extractTitle("<html><body><h1>回落的标题</h1></body></html>")).toBe(
      "回落的标题",
    );
  });

  it("BrowserFetchError 带 code（调用方据此挑 HTTP 状态码）", async () => {
    const error = await fetchPageSnapshot("https://169.254.169.254/").catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(BrowserFetchError);
    expect((error as BrowserFetchError).code).toBe("blocked_host");
  });
});
