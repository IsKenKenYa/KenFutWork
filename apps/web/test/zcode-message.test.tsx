// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MessageResponse } from "@zui/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@zui/components/ai-elements/reasoning.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@zui/lib/codePreviewSettings.js";
import { describe, expect, it } from "vitest";

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
      {
        wrapper: ({ children }) => (
          <ZCodeIntlProvider initialLocale="zh-CN">
            {children}
          </ZCodeIntlProvider>
        ),
      },
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
      {
        wrapper: ({ children }) => (
          <ZCodeIntlProvider initialLocale="zh-CN">
            {children}
          </ZCodeIntlProvider>
        ),
      },
    );
    // 完成态触发器：「思考 · 持续了 N 秒」（zh-CN.ts:4484-4486）
    expect(screen.getByText("思考")).toBeTruthy();
    expect(screen.getByText(/持续了 4 秒/)).toBeTruthy();
    expect(screen.getByText("思考正文")).toBeTruthy();
  });
});
