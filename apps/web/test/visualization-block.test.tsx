// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownRenderer } from "../src/components/chat/markdown-renderer";

/**
 * 动态 UI（Design 侧）：对话流里的 ` ```mermaid `（流程图/架构图）与 ` ```viz `（数据图表）。
 *
 * 锁的口径：
 *  - `viz` 正常渲染成图表（共享组件 @kenfutwork/ui）；
 *  - 坏 JSON / 未知类型 → **原样回落代码块**（内容不吞，消息不炸）；
 *  - 流式中（showCursor）不升级成图：半截围栏必然失败，且每个 delta 重渲染 mermaid
 *    会把主线程拖垮（Code 侧踩过 React #185）；
 *  - mermaid 渲染失败（语法错）→ 回落代码块；
 *  - 其他语言的代码块不受影响（仍是默认 `<pre><code>`）。
 */
const mermaidRender = vi.fn(async () => ({
  svg: '<svg role="img" aria-label="diagram"></svg>',
}));
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: (...args: unknown[]) => mermaidRender(...(args as [])),
  },
}));

afterEach(() => {
  cleanup();
  mermaidRender.mockClear();
  window.localStorage.clear();
});

describe("动态 UI：viz（数据图表）", () => {
  it("正常 spec：渲染成图表（标题 + 数值可见）", async () => {
    render(
      <MarkdownRenderer
        text={[
          "各阶段耗时：",
          "```viz",
          JSON.stringify({
            type: "bar",
            title: "阶段耗时",
            unit: "ms",
            data: [
              { label: "转写", value: 320 },
              { label: "改写", value: 900 },
            ],
          }),
          "```",
        ].join("\n")}
      />,
    );
    expect(await screen.findByText("阶段耗时")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "阶段耗时" })).toBeInTheDocument();
    expect(screen.getByText("900ms")).toBeInTheDocument();
  });

  it("坏 JSON / 未知类型：回落代码块（原样保留内容）", () => {
    const { container } = render(
      <MarkdownRenderer
        text={["```viz", "{ 这不是 JSON }", "```"].join("\n")}
      />,
    );
    expect(container.querySelector("pre code")).not.toBeNull();
    expect(container.textContent).toContain("{ 这不是 JSON }");
    expect(screen.queryByRole("img")).toBeNull();

    const unknown = render(
      <MarkdownRenderer
        text={[
          "```viz",
          '{"type":"radar","data":[{"label":"a","value":1}]}',
          "```",
        ].join("\n")}
      />,
    );
    expect(unknown.container.querySelector("pre code")).not.toBeNull();
  });

  it("流式中：不渲染图表，只显示代码（delta 阶段不重画）", () => {
    const { container } = render(
      <MarkdownRenderer
        showCursor
        text={[
          "```viz",
          '{"type":"line","data":[{"label":"a","value":1}]}',
          "```",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("pre code")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("动态 UI：mermaid（流程图/架构图）", () => {
  it("渲染成 SVG（走 securityLevel=strict 的渲染器）", async () => {
    render(
      <MarkdownRenderer
        text={["```mermaid", "graph TD; A-->B;", "```"].join("\n")}
      />,
    );
    await waitFor(() => expect(mermaidRender).toHaveBeenCalled());
    expect(
      await screen.findByRole("img", { name: "diagram" }),
    ).toBeInTheDocument();
  });

  it("渲染失败（语法错）：回落代码块，内容不吞", async () => {
    mermaidRender.mockRejectedValueOnce(new Error("Parse error"));
    const { container } = render(
      <MarkdownRenderer
        text={["```mermaid", "graph TD; 坏语法", "```"].join("\n")}
      />,
    );
    await waitFor(() => expect(mermaidRender).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector("pre code")).not.toBeNull(),
    );
    expect(container.textContent).toContain("坏语法");
  });
});

describe("动态 UI：其他代码块不受影响", () => {
  it("普通语言仍是默认 pre/code（不进可视化分支）", () => {
    const { container } = render(
      <MarkdownRenderer text={["```ts", "const a = 1;", "```"].join("\n")} />,
    );
    expect(container.querySelector("pre code")).not.toBeNull();
    expect(container.textContent).toContain("const a = 1;");
    expect(mermaidRender).not.toHaveBeenCalled();
  });

  it("设置 → 通用 →「对话流」关掉：块只显示代码（本机显示偏好）", () => {
    window.localStorage.setItem("kenfutwork.conversationVisuals", "off");
    const { container } = render(
      <MarkdownRenderer
        text={[
          "```viz",
          '{"type":"pie","data":[{"label":"a","value":1}]}',
          "```",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("pre code")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(mermaidRender).not.toHaveBeenCalled();
  });
});
