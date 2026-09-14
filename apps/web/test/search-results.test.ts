import { describe, expect, it } from "vitest";

import {
  parseSearchResultView,
  sourceHost,
} from "../src/lib/search-results.js";

/**
 * 回归：搜索结果随事件到达前端但界面不呈现（用户看不到来源）。
 * 解析要同时吃「结构化对象」与「JSON 字符串」两种形态（实时流 / 历史落库）。
 */
describe("web_search 来源解析", () => {
  const structured = {
    query: "今天天气",
    results: [
      { title: "天气网", link: "https://www.weather.com.cn/a", content: "晴" },
      { title: "", link: "https://example.com/b", content: "" },
    ],
  };

  it("结构化对象：解析标题/链接/摘要，并给出展示用主机名", () => {
    const view = parseSearchResultView("web_search", structured);
    expect(view?.query).toBe("今天天气");
    expect(view?.sources).toEqual([
      {
        title: "天气网",
        url: "https://www.weather.com.cn/a",
        snippet: "晴",
        host: "weather.com.cn",
      },
      {
        // 缺标题时回落 URL
        title: "https://example.com/b",
        url: "https://example.com/b",
        snippet: "",
        host: "example.com",
      },
    ]);
  });

  it("JSON 字符串形态同样解析（事件序列化/历史落库往返）", () => {
    const view = parseSearchResultView(
      "web_search",
      JSON.stringify(structured),
    );
    expect(view?.sources).toHaveLength(2);
  });

  it("兼容 url 字段名（部分供应商用 url 而非 link）", () => {
    const view = parseSearchResultView("web_search", {
      query: "q",
      results: [{ title: "t", url: "https://a.example/x" }],
    });
    expect(view?.sources[0]).toMatchObject({
      url: "https://a.example/x",
      host: "a.example",
    });
  });

  it("缺链接的条目被丢弃（不可点击的来源没有意义）", () => {
    const view = parseSearchResultView("web_search", {
      query: "q",
      results: [
        { title: "无链接" },
        { title: "有", link: "https://ok.example" },
      ],
    });
    expect(view?.sources.map((s) => s.url)).toEqual(["https://ok.example"]);
  });

  it("零结果仍被识别（界面显示空态，而不是回落到原始 JSON 转储）", () => {
    const view = parseSearchResultView("web_search", {
      query: "q",
      results: [],
    });
    expect(view).not.toBeNull();
    expect(view?.sources).toEqual([]);
  });

  it("非本工具/形状不符/坏 JSON 一律返回 null（交回通用渲染）", () => {
    expect(parseSearchResultView("read_file", structured)).toBeNull();
    expect(parseSearchResultView("web_search", { query: "q" })).toBeNull();
    expect(parseSearchResultView("web_search", "not-json")).toBeNull();
    expect(parseSearchResultView("web_search", null)).toBeNull();
    expect(parseSearchResultView("web_search", [1, 2])).toBeNull();
  });

  it("host 解析：去 www 前缀，非法 URL 原样返回", () => {
    expect(sourceHost("https://www.example.com/p")).toBe("example.com");
    expect(sourceHost("not-a-url")).toBe("not-a-url");
  });
});
