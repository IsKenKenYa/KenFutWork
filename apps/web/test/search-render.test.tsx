import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ToolOutputRenderer } from "../src/components/chat/tool-block-view.js";

afterEach(() => {
  cleanup();
});

/**
 * 渲染层回归：联网搜索结果必须呈现为**可点击来源**（此前只显示摘要/原始 JSON，
 * 用户看不到出处）。同时锁住通用回退路径未被影响。
 */
describe("ToolOutputRenderer 的联网搜索分流", () => {
  it("web_search 输出渲染为来源列表：标题可点击、带主机名与摘要", () => {
    render(
      <ToolOutputRenderer
        toolName="web_search"
        output={{
          query: "今天天气",
          results: [
            {
              title: "中国天气网",
              link: "https://www.weather.com.cn/a",
              content: "晴，26℃",
            },
            { title: "另一个来源", link: "https://example.com/b", content: "" },
          ],
        }}
      />,
    );

    expect(screen.getByText(/搜索来源/)).toBeDefined();
    expect(screen.getByText(/今天天气/)).toBeDefined();

    const first = screen.getByRole("link", { name: "中国天气网" });
    expect(first.getAttribute("href")).toBe("https://www.weather.com.cn/a");
    // 外链属性：新开页 + noreferrer（避免把来源页带入本站会话）
    expect(first.getAttribute("target")).toBe("_blank");
    expect(first.getAttribute("rel")).toBe("noreferrer");

    expect(screen.getByText("weather.com.cn")).toBeDefined();
    expect(screen.getByText("晴，26℃")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "另一个来源" }).getAttribute("href"),
    ).toBe("https://example.com/b");
  });

  it("JSON 字符串形态（事件/历史落库往返）同样渲染来源", () => {
    render(
      <ToolOutputRenderer
        toolName="web_search"
        output={
          JSON.stringify({
            query: "q",
            results: [{ title: "T", link: "https://a.example/x" }],
          }) as unknown as Record<string, unknown>
        }
      />,
    );
    expect(screen.getByRole("link", { name: "T" })).toBeDefined();
  });

  it("零结果渲染空态文案（而不是回落到原始 JSON 转储）", () => {
    render(
      <ToolOutputRenderer
        toolName="web_search"
        output={{ query: "q", results: [] }}
      />,
    );
    expect(screen.getByText("没有返回结果")).toBeDefined();
  });

  it("非搜索工具仍走通用渲染（未误分流）", () => {
    render(
      <ToolOutputRenderer
        toolName="read_file"
        output={{ results: [{ title: "x", link: "https://a.example" }] }}
      />,
    );
    // 通用渲染展示键值，不出现「搜索来源」
    expect(screen.queryByText(/搜索来源/)).toBeNull();
    expect(screen.getByText(/输出/)).toBeDefined();
  });
});
