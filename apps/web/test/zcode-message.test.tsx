// @vitest-environment jsdom
import { cleanup, render as renderReact, screen } from "@testing-library/react";
import { MessageResponse } from "@zui/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@zui/components/ai-elements/reasoning.js";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@zui/lib/codePreviewSettings.js";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

function render(ui: ReactNode) {
  return renderReact(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{ui}</TooltipProvider>
    </ZCodeIntlProvider>,
  );
}
afterEach(cleanup);

/**
 * P1 照搬接线回归（手册 §3.2-4）：@zui 原件 MessageResponse/Reasoning 在
 * 流式/静态两态的渲染冒烟。锁死两点：
 * 1. MessageResponse 消费 children（zcode 形态），markdown 正文可见；
 * 2. Reasoning 默认收起（isStreaming 时不显示正文，触发器可见）。
 */

describe("MessageResponse（@zui 原件）", () => {
  it("静态态渲染 markdown 正文（标题 + 段落）", () => {
    render(
      <MessageResponse
        theme="light"
        codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}
      >
        {"# 标题\n\n正文段落"}
      </MessageResponse>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "标题",
    );
    expect(screen.getByText("正文段落")).toBeTruthy();
  });

  it("流式态（parseIncompleteMarkdown）不抛错且已闭合段落可见", () => {
    render(
      <MessageResponse streaming theme="light">
        {"正在输出的段落"}
      </MessageResponse>,
    );
    expect(screen.getByText("正在输出的段落")).toBeTruthy();
  });
});

describe("Reasoning（@zui 原件）", () => {
  it("流式默认收起：触发器可见、正文不渲染", () => {
    render(
      <Reasoning isStreaming>
        <ReasoningTrigger streamingText="分析目录结构" />
        <ReasoningContent>{"思考正文"}</ReasoningContent>
      </Reasoning>,
    );
    // zcode zh-CN 文案（zh-CN.ts:4483）
    expect(screen.getByText("正在思考")).toBeTruthy();
    expect(screen.queryByText("思考正文")).toBeNull();
  });

  it("完成态显示思考标签，手动展开后正文可见", () => {
    render(
      <Reasoning duration={4} defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>{"思考正文"}</ReasoningContent>
      </Reasoning>,
    );
    // 完成态触发器：「思考 · 持续了 N 秒」（zh-CN.ts:4484-4486）
    expect(screen.getByText("思考")).toBeTruthy();
    expect(screen.getByText(/持续了 4 秒/)).toBeTruthy();
    expect(screen.getByText("思考正文")).toBeTruthy();
  });
});

/**
 * 动态 UI（宿主扩展，见源码清单 message.tsx 的 adaptations）：
 * ` ```viz ` 数据图表块在**完成态**交给共享组件渲染；流式态与坏 spec 落回代码块。
 * mermaid 由上游 CodeBlock 的 renderMermaid 负责，这里不重复测。
 */
describe("MessageResponse：viz 数据图表块", () => {
  const spec = JSON.stringify({
    type: "bar",
    title: "阶段耗时",
    unit: "ms",
    data: [
      { label: "转写", value: 320 },
      { label: "改写", value: 900 },
    ],
  });

  it("完成态：渲染成图表（标题 + 数值可见）", () => {
    render(
      <MessageResponse
        theme="light"
        codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}
      >
        {["```viz", spec, "```"].join("\n")}
      </MessageResponse>,
    );
    expect(screen.getByText("阶段耗时")).toBeTruthy();
    expect(screen.getByText("900ms")).toBeTruthy();
  });

  it("流式态：不升级成图（半截 JSON 必然失败，重挂载风险）", () => {
    const { container } = render(
      <MessageResponse streaming theme="light">
        {["```viz", spec, "```"].join("\n")}
      </MessageResponse>,
    );
    expect(screen.queryByRole("img", { name: "阶段耗时" })).toBeNull();
    // 回落成代码块：viz 按 JSON 高亮（没有 viz 语法，未知语言会抛未处理的 rejection）
    expect(container.querySelector('[data-language="json"]')).not.toBeNull();
  });

  it("坏 spec：落回代码块（不渲染图表、不炸消息）", () => {
    const { container } = render(
      <MessageResponse
        theme="light"
        codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}
      >
        {["```viz", "{ 坏 JSON }", "```"].join("\n")}
      </MessageResponse>,
    );
    expect(screen.queryByRole("img")).toBeNull();
    // 回落成代码块（viz → json 高亮；代码正文由异步高亮器填充，jsdom 下不等它）
    expect(container.querySelector('[data-language="json"]')).not.toBeNull();
  });
});
